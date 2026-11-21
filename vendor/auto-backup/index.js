/**
 * dsh-auto-backup —— R1 原型：写文件前自动备份（宿主插件，零 npm 依赖）
 *
 * 设计目标（Lead 批准的 6 条要求）：
 *  1. 隔离位置：本原型位于项目 team/members/dsh-bridge/，未安装到全局
 *  2. 路径白名单：只备份项目工作区内指定目录/扩展名的源文件
 *  3. 排除：file_backups/、.git/、node_modules/、team/pipe2/{inbox,ack,cursor,tmp,_archive}、~/.dsh、系统临时区
 *  4. 保留：每文件最近 N 份（默认 30），超出淘汰最旧；命名兼容 `_改前_<批次>_<ts>_<文件名>`
 *  5. 不阻断：备份失败只 WARN，永不阻止写入
 *  6. 幂等：同文件同内容不重复备份（sha256 比对最近一份）
 *
 * 挂载方式（未来，需 Lead/作者批准后）：
 *   cordis.patch.yml: { name: '<路径>/index.js', config: { projectRoot, include, exclude, ... } }
 *
 * 钩子：`tools/pre-execute`（waterfall）。命中 write/edit 时先备份目标文件再 next()。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { boolean, number, string, stringArray, any, defaultsOf, objectSchema, fieldDocs } from './lib/standard-schema.js'

export const inject = ['tools']

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1 + native Schemastery graph, so
 * the Web settings form can project it). Defaults are the single source of
 * truth; `cordis.patch.yml` only lists deviations.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Enforce pre-write backups. false = keep the status tool only (no hook).', volatile: true }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  projectRoot: string('', {
    description: 'Absolute project root to protect. Empty = resolve per call from the session workspace (recommended). Backups outside the resolved root are refused.',
  }),
  backupDir: string('file_backups', { description: 'Backup directory, relative to the project root (must stay inside it).', volatile: true }),
  batch: string('auto', { description: 'Batch tag used in backup file names.' }),
  include: any(null, { description: 'Array of {dir, ext[]} include rules. null = generic source/doc extensions anywhere in the root.' }),
  excludeDirs: stringArray(['file_backups', '.git', 'node_modules', 'team/pipe2/inbox', 'team/pipe2/ack', 'team/pipe2/cursor', 'team/pipe2/tmp', 'team/pipe2/_archive', 'backup', '.vs', 'images'], { description: 'Directories (relative) never backed up.' }),
  toolNames: stringArray(['write', 'edit'], { description: 'Tools whose target file is backed up before execution.' }),
  bashToolNames: stringArray(['bash', 'pwsh', 'shell', 'cmd'], { description: 'Shell tools whose write commands are detected and WARNed (cannot be backed up before execution).' }),
  keepPerFile: number(30, { description: 'Legacy retention hint. Snapshots are never deleted: this only sizes the plain (uncompressed) window for small files.', int: true, min: 1 }),
  largeFileBytes: number(131072, { description: 'Files at/above this size use largeRetention as their plain window (default 128 KB).', int: true, min: 1 }),
  largeRetention: number(5, { description: 'Plain-window size per large file.', int: true, min: 1 }),
  largeWarnBytes: number(131072, { description: 'WARN once when a backed-up file is at/above this size.', int: true, min: 1 }),
  keepUncompressedPerFile: number(5, { description: 'Newest N snapshots per file stay plain for fast diff; older ones are gzipped, never deleted.', int: true, min: 1 }),
  compressWhenFilesOver: number(400, { description: 'When total snapshots exceed this count, gzip the oldest plain snapshots until back under it.', int: true, min: 1 }),
  compressWhenTotalMBOver: number(200, { description: 'When total backup size exceeds this many MB, gzip the oldest plain snapshots until back under it.', min: 1 }),
  allowDelete: boolean(false, { description: 'Allow physical deletion of snapshots. Default false: the hook never deletes and the compact tool only compresses unless this is true.', volatile: true }),
  maxTotalMB: number(800, { description: 'Hard size ceiling in MB. Above it snapshots are compressed first; with allowDelete:false nothing is deleted, only WARNed.', min: 1 }),
  fileOverrides: any(null, { description: 'Per-basename plain-window overrides: { "doc/*.md": {keep: 10}, "*": {keepIfLargerThanKB: 512, keep: 5} }.' }),
}, { description: 'Automatic pre-write backup configuration.', schemaVersion: 1 })

/** 默认：备份项目根内常见的源码/文档扩展名（与具体项目无关）。 */
const DEFAULT_INCLUDE = [
  { dir: '', ext: ['.md', '.txt', '.lua', '.json', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.yml', '.yaml'] },
]

/** 默认排除：备份目录自身/版本库/依赖/消息流/临时区/系统目录。 */
const DEFAULT_EXCLUDE_DIRS = [
  'file_backups',
  '.git',
  'node_modules',
  'team/pipe2/inbox',
  'team/pipe2/ack',
  'team/pipe2/cursor',
  'team/pipe2/tmp',
  'team/pipe2/_archive',
  'backup',
  '.vs',
  'images',
]

const DEFAULT_TOOLS = ['write', 'edit']

/**
 * 路径归一化：`\` → `/`，并去掉全部尾随 `/`。
 * 线性扫描（while/slice）实现，避免 `/\/+$/` 在超长输入上的多项式回溯
 * （CodeQL js/polynomial-redos）。
 */
export function normalize(value) {
  const slashed = String(value).replace(/\\/g, '/')
  let end = slashed.length
  while (end > 0 && slashed[end - 1] === '/') end -= 1
  return slashed.slice(0, end)
}

/**
 * 命令行 token 清理：去掉前导 `=`/`@` 和尾随 `,`/`:`。
 * 与旧 `replace(/^[=@]+/).replace(/[,:]+$/)` 语义一致，但为线性扫描，
 * 不做回溯（CodeQL js/polynomial-redos）。
 */
export function cleanToken(token) {
  let start = 0
  let end = token.length
  while (start < end && (token[start] === '=' || token[start] === '@')) start += 1
  while (end > start && (token[end - 1] === ',' || token[end - 1] === ':')) end -= 1
  return token.slice(start, end)
}

/** glob → 正则：`*` 不跨 `/`，`**` 跨目录，`?` 单字符（用于 fileOverrides 的路径规则）。 */
function globToRegExp(pattern) {
  let regex = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        regex += '.*'
        index += 1
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      regex += '\\' + char
    } else {
      regex += char
    }
  }
  return new RegExp('^' + regex + '$')
}

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch { return undefined }
}

function sha256Buffer(buffer) {
  try {
    return createHash('sha256').update(buffer).digest('hex')
  } catch { return undefined }
}

function timestamp() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  const millis = String(date.getMilliseconds()).padStart(3, '0')
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '_'
    + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds()) + millis
}

/**
 * 备份管理器（纯逻辑，可在宿主外单测）。
 * @param config {{
 *   projectRoot: string, backupDir?: string, include?: Array<{dir:string,ext:string[]}>,
 *   excludeDirs?: string[], toolNames?: string[], keepPerFile?: number, batch?: string,
 *   logger?: { warn: (message: string) => void }
 * }}
 */
export function createBackupManager(config) {
  const projectRoot = resolve(String(config.projectRoot ?? ''))
  if (config.projectRoot === undefined || String(config.projectRoot).trim() === '') throw new Error('createBackupManager: projectRoot is required')
  const backupDir = (() => {
    const raw = typeof config.backupDir === 'string' && config.backupDir.length > 0 ? config.backupDir : 'file_backups'
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw)
    const rel = relative(projectRoot, candidate)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('backupDir must stay inside projectRoot: ' + raw)
    }
    return candidate
  })()
  const include = Array.isArray(config.include) && config.include.length > 0 ? config.include : DEFAULT_INCLUDE
  const excludeDirs = Array.isArray(config.excludeDirs) ? config.excludeDirs : DEFAULT_EXCLUDE_DIRS
  const toolNames = new Set(Array.isArray(config.toolNames) && config.toolNames.length > 0 ? config.toolNames : DEFAULT_TOOLS)
  const bashToolNames = new Set(Array.isArray(config.bashToolNames) && config.bashToolNames.length > 0
    ? config.bashToolNames
    : ['bash', 'pwsh', 'shell', 'cmd'])
  const keepPerFile = Number.isFinite(config.keepPerFile) && config.keepPerFile > 0 ? config.keepPerFile : 30
  // 分级明文窗口：大文件的明文份数更少（更早压缩），但都不删除
  const largeFileBytes = Number.isFinite(config.largeFileBytes) && config.largeFileBytes > 0
    ? config.largeFileBytes
    : 128 * 1024
  const largeRetention = Number.isFinite(config.largeRetention) && config.largeRetention > 0
    ? config.largeRetention
    : 5
  const largeWarnBytes = Number.isFinite(config.largeWarnBytes) && config.largeWarnBytes > 0
    ? config.largeWarnBytes
    : 128 * 1024
  /** 每文件保留明文份数（更新的明文，旧的压缩；永不删除）。 */
  const keepUncompressedPerFile = Number.isFinite(config.keepUncompressedPerFile) && config.keepUncompressedPerFile > 0
    ? Math.trunc(config.keepUncompressedPerFile)
    : 5
  const compressWhenFilesOver = Number.isFinite(config.compressWhenFilesOver) && config.compressWhenFilesOver > 0
    ? Math.trunc(config.compressWhenFilesOver)
    : 400
  const compressWhenTotalMBOver = Number.isFinite(config.compressWhenTotalMBOver) && config.compressWhenTotalMBOver > 0
    ? config.compressWhenTotalMBOver
    : 200
  const allowDelete = config.allowDelete === true
  // 硬上限：超过先压缩；allowDelete=false 时只 WARN
  const maxTotalMB = Number.isFinite(config.maxTotalMB) && config.maxTotalMB > 0 ? config.maxTotalMB : 800
  const batch = (typeof config.batch === 'string' && config.batch.trim().length > 0 ? config.batch.trim() : 'auto')
    .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  // 单文件保留覆盖，优先级：精确 → glob → '*' 兜底
  //   { 'doc/开发任务规划v2.md': { keep: 2 },
  //     'lua_scripts/*.lua': { keep: 10 },
  //     '*': { keepIfLargerThanKB: 512, keep: 5 } }
  const exactOverrides = new Map()
  const globOverrides = []
  let starOverride
  if (config.fileOverrides !== null && typeof config.fileOverrides === 'object') {
    for (const [key, value] of Object.entries(config.fileOverrides)) {
      if (value === null || typeof value !== 'object') continue
      const normalizedKey = normalize(key)
      if (normalizedKey === '*') { starOverride = value; continue }
      if (normalizedKey.includes('*') || normalizedKey.includes('?')) {
        globOverrides.push({ regex: globToRegExp(normalizedKey), value })
        continue
      }
      exactOverrides.set(normalizedKey, value)
    }
  }
  const logger = config.logger
  const warn = (message) => {
    try { if (typeof logger?.warn === 'function') logger.warn(message) } catch { /* logger must never break backup */ }
  }
  /** 大文件 WARN 去重（每个文件只提醒一次）。 */
  const largeWarned = new Set()
  /** bash 检测 WARN 去重（同一命令+目标只提醒一次）。 */
  const bashWarned = new Set()

  /** 相对项目根的 normalized 路径；越界/绝对外部路径返回 undefined。 */
  function relativeInside(targetPath) {
    const absolute = isAbsolute(targetPath) ? resolve(targetPath) : resolve(projectRoot, targetPath)
    const rel = normalize(relative(projectRoot, absolute))
    if (rel.startsWith('..') || rel === '' || isAbsolute(rel)) return undefined
    return rel
  }

  function inExcludedDir(rel) {
    for (const dir of excludeDirs) {
      const normalizedDir = normalize(dir)
      if (rel === normalizedDir || rel.startsWith(normalizedDir + '/')) return true
    }
    return false
  }

  function isIncluded(rel) {
    const name = basename(rel).toLowerCase()
    for (const entry of include) {
      const dir = normalize(entry.dir)
      const exts = Array.isArray(entry.ext) ? entry.ext.map(value => value.toLowerCase()) : []
      // dir === '' means "anywhere in the project root" (generic default).
      const inDir = dir === '' || rel === dir || rel.startsWith(dir + '/')
      if (!inDir) continue
      if (exts.length === 0) return true
      if (exts.some(ext => name.endsWith(ext))) return true
    }
    return false
  }

  /** 是否需要备份（不做 IO 写入）。 */
  function shouldBackup(targetPath) {
    const rel = relativeInside(targetPath)
    if (rel === undefined) return { backup: false, reason: 'outside-project' }
    if (inExcludedDir(rel)) return { backup: false, reason: 'excluded-dir' }
    if (!isIncluded(rel)) return { backup: false, reason: 'not-included' }
    const absolute = join(projectRoot, rel)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return { backup: false, reason: 'not-a-file' }
    return { backup: true, relative: rel, absolute }
  }

  const SNAPSHOT_PREFIX = '_改前_'
  const SNAPSHOT_RE = /^_改前_(.+?)_(\d{8}_\d{9})(?:_(\d+))?_(.+?)(\.gz)?$/
  // Pre-redesign names use second precision; hand-made ones may use an ISO date,
  // and some drop the date/time separator entirely (`20261116133341`).
  // A stamp is followed by a basename (`_AGENTS.md`), only an extension
  // (`…_20261017_160939.lua`), a collision counter, or the end of the name.
  const LEGACY_STAMP_RE = /_(?:(\d{4}-\d{2}-\d{2})[_-]?(\d{6})|(\d{8})[_-]?(\d{6}))(?:_(\d+))?(?=_|\.|$)/g

  /** `2026-10-17` + `155816` → `20261017_155816000` so every stamp sorts the same way. */
  function normalizeLegacyStamp(datePart, timePart) {
    return datePart.replace(/-/g, '') + '_' + (timePart + '000').slice(0, 9)
  }

  /** Millisecond stamp for a snapshot whose name carries no usable timestamp. */
  function stampFromMtime(mtimeMs) {
    const when = new Date(mtimeMs)
    const pad = (value, size) => String(value).padStart(size, '0')
    return String(when.getFullYear()) + pad(when.getMonth() + 1, 2) + pad(when.getDate(), 2) + '_'
      + pad(when.getHours(), 2) + pad(when.getMinutes(), 2) + pad(when.getSeconds(), 2)
      + pad(when.getMilliseconds(), 3)
  }

  /**
   * Classify one directory entry; null when it is not a snapshot at all.
   *
   * kind: `current` — millisecond stamp written by this hook;
   *       `legacy`  — older stamp format, still parseable;
   *       `unknown` — a `_改前_` file whose name has no recognisable stamp.
   *
   * Every kind counts toward totals and the global thresholds (compression is
   * per file, so it never needs a parseable name). Parsing only makes a snapshot
   * addressable by file name (history/show) and comparable by stamp.
   */
  function classifySnapshotEntry(entry) {
    const match = SNAPSHOT_RE.exec(entry)
    if (match !== null) {
      return {
        kind: 'current',
        batch: match[1],
        stamp: match[2],
        collision: match[3] === undefined ? 1 : Number(match[3]),
        file: match[4],
        compressed: match[5] === '.gz',
      }
    }
    if (!entry.startsWith(SNAPSHOT_PREFIX)) return null
    const compressed = entry.endsWith('.gz')
    const stem = compressed ? entry.slice(0, -3) : entry
    if (stem.length <= SNAPSHOT_PREFIX.length) return null
    // Take the LAST stamp-looking group so a date inside the batch tag cannot win.
    let stamp = null
    let collision = 1
    let batch = null
    let file = null
    LEGACY_STAMP_RE.lastIndex = 0
    for (let found = LEGACY_STAMP_RE.exec(stem); found !== null; found = LEGACY_STAMP_RE.exec(stem)) {
      const isoDate = found[1]
      const isoTime = found[2]
      stamp = isoDate !== undefined
        ? normalizeLegacyStamp(isoDate, isoTime)
        : normalizeLegacyStamp(found[3], found[4])
      collision = found[5] === undefined ? 1 : Number(found[5])
      batch = stem.slice(SNAPSHOT_PREFIX.length, found.index)
      const rest = stem.slice(found.index + found[0].length).replace(/^_/, '')
      // Only an extension left ⇒ the original basename is not recoverable.
      file = rest === '' || rest.startsWith('.') ? null : rest
    }
    if (stamp === null) return { kind: 'unknown', batch: null, stamp: null, collision: 1, file: null, compressed }
    return { kind: 'legacy', batch, stamp, collision, file, compressed }
  }

  /** Does this snapshot belong to the given basename? */
  function snapshotIsFor(snapshot, name) {
    if (snapshot.file !== null) return snapshot.file === name
    const stem = snapshot.compressed === true ? snapshot.entry.slice(0, -3) : snapshot.entry
    return stem.endsWith('_' + name)
  }

  /** Snapshot list for one target (plain + .gz), newest first. */
  function existingBackups(absolute) {
    if (!existsSync(backupDir)) return []
    const name = basename(absolute)
    const out = []
    for (const file of allBackupFiles()) {
      if (!snapshotIsFor(file, name)) continue
      out.push({
        entry: file.entry, path: file.path, mtime: file.mtime, size: file.size,
        compressed: file.compressed, stamp: file.stamp, collision: file.collision, kind: file.kind,
      })
    }
    return out.sort((left, right) => {
      if (left.stamp !== right.stamp) return right.stamp.localeCompare(left.stamp)
      if (left.collision !== right.collision) return right.collision - left.collision
      return right.mtime - left.mtime
    })
  }

  /**
   * Every snapshot (plain + .gz) in the backup dir, newest first.
   * Includes legacy and unparseable `_改前_` names: the totals and the global
   * thresholds must see the whole directory, not just what this hook wrote.
   * `stampSource` is `mtime` when the name carries no usable timestamp.
   */
  function allBackupFiles() {
    if (!existsSync(backupDir)) return []
    const files = []
    for (const entry of readdirSync(backupDir)) {
      const parsed = classifySnapshotEntry(entry)
      if (parsed === null) continue
      const absolute = join(backupDir, entry)
      try {
        const info = statSync(absolute)
        if (!info.isFile()) continue
        files.push({
          entry, path: absolute, mtime: info.mtimeMs, size: info.size,
          compressed: parsed.compressed, file: parsed.file, kind: parsed.kind,
          collision: parsed.collision,
          stamp: parsed.stamp === null ? stampFromMtime(info.mtimeMs) : parsed.stamp,
          stampSource: parsed.stamp === null ? 'mtime' : 'name',
        })
      } catch { /* skip */ }
    }
    return files.sort((left, right) => {
      if (left.stamp !== right.stamp) return right.stamp.localeCompare(left.stamp)
      return right.mtime - left.mtime
    })
  }

  /** Read one snapshot, transparently decompressing .gz. */
  function readSnapshot(snapshot) {
    const raw = readFileSync(snapshot.path)
    return snapshot.compressed === true ? gunzipSync(raw) : raw
  }

  function totalBackupMB() {
    return allBackupFiles().reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)
  }

  /**
   * How many snapshots of this file stay PLAIN (uncompressed) for fast diff.
   * Snapshots beyond this window are gzipped, never deleted.
   * Priority: exact → glob → '*' → size tier, capped by keepUncompressedPerFile.
   */
  function plainWindowFor(size, relative) {
    const cap = value => Math.min(keepUncompressedPerFile, value)
    if (relative !== undefined) {
      const normalized = normalize(relative)
      const exact = exactOverrides.get(normalized)
      if (exact !== undefined && Number.isFinite(exact.keep) && exact.keep > 0) return cap(exact.keep)
      for (const rule of globOverrides) {
        if (rule.regex.test(normalized) && Number.isFinite(rule.value.keep) && rule.value.keep > 0) return cap(rule.value.keep)
      }
      if (starOverride !== undefined && Number.isFinite(starOverride.keep) && starOverride.keep > 0) {
        const minBytes = Number.isFinite(starOverride.keepIfLargerThanKB) ? starOverride.keepIfLargerThanKB * 1024 : 0
        if (size >= minBytes) return cap(starOverride.keep)
      }
    }
    return cap(size >= largeFileBytes ? largeRetention : keepPerFile)
  }

  /** 执行备份；返回 { ok, path?, skipped?, reason? }，永不抛出。 */
  function backup(targetPath) {
    try {
      const decision = shouldBackup(targetPath)
      if (!decision.backup) return { ok: false, skipped: true, reason: decision.reason }
      const { absolute } = decision
      const size = statSync(absolute).size
      const latest = existingBackups(absolute)[0]
      if (latest !== undefined) {
        const currentHash = sha256(absolute)
        const latestHash = sha256Buffer(readSnapshot(latest))
        if (currentHash !== undefined && currentHash === latestHash) {
          return { ok: true, skipped: true, reason: 'identical' }
        }
      }
      mkdirSync(backupDir, { recursive: true })
      const target = join(backupDir, '_改前_' + batch + '_' + timestamp() + '_' + basename(absolute))
      let finalPath = target
      let index = 2
      while (existsSync(finalPath)) {
        finalPath = target + '.' + index
        index += 1
      }
      copyFileSync(absolute, finalPath)
      // 账本：每次真实备份追加一行（JSONL），便于审计/精确 join；失败不影响备份
      try {
        appendFileSync(join(backupDir, '.backup_index.jsonl'), JSON.stringify({
          at: new Date().toISOString(),
          source: decision.relative,
          backup: basename(finalPath),
          sha256: sha256(finalPath),
          size,
          batch,
        }) + '\n', 'utf8')
      } catch (error) {
        warn('[auto-backup] index write failed: ' + String(error))
      }
      prune(absolute, size, decision.relative)
      // 大文件提醒（每文件一次）：提醒"这个文件很大"，但快照仍然保留
      if (size >= largeWarnBytes && !largeWarned.has(absolute)) {
        largeWarned.add(absolute)
        warn('[auto-backup] 大文件 WARN：' + decision.relative + '（' + (size / 1024).toFixed(0)
          + 'KB ≥ ' + (largeWarnBytes / 1024).toFixed(0) + 'KB），明文窗口已缩小；历史快照会压缩保留，不删除')
      }
      const compacted = compactGlobal()
      if (compacted.compressed > 0) {
        warn('[auto-backup] 备份总量/数量超阈值：已压缩最旧 ' + compacted.compressed + ' 份快照（保留全部历史，不删除）')
      }
      if (compacted.overLimit === true && compacted.deleted === 0) {
        warn('[auto-backup] 备份总量仍超过硬上限 ' + maxTotalMB + 'MB：allowDelete=false，未删除任何快照')
      }
      return { ok: true, path: finalPath, size }
    } catch (error) {
      warn('[auto-backup] backup failed for ' + String(targetPath) + ': ' + String(error))
      return { ok: false, reason: 'error' }
    }
  }

  /** Gzip one plain snapshot in place (never deletes). Returns true on success. */
  function compressOne(snapshot) {
    if (snapshot.compressed === true) return false
    try {
      const raw = readFileSync(snapshot.path)
      const gzPath = snapshot.path + '.gz'
      let finalPath = gzPath
      let index = 2
      while (existsSync(finalPath)) { finalPath = gzPath + '.' + index; index += 1 }
      writeFileSync(finalPath, gzipSync(raw, { level: 9 }))
      // Only remove the plain file AFTER the .gz is durable: same bytes survive.
      unlinkSync(snapshot.path)
      return true
    } catch (error) {
      warn('[auto-backup] compress failed for ' + snapshot.entry + ': ' + String(error))
      return false
    }
  }

  /** Compress this file's snapshots beyond its plain window. */
  function prune(absolute, size, relative) {
    try {
      const limit = plainWindowFor(size ?? statSync(absolute).size, relative)
      const backups = existingBackups(absolute)
      for (const stale of backups.slice(limit)) compressOne(stale)
    } catch (error) {
      warn('[auto-backup] compact failed: ' + String(error))
    }
  }

  /**
   * Global compaction: keep every snapshot, gzip the oldest plain ones until
   * the PLAIN budget (`compressWhenFilesOver`) and the total-size budget
   * (`compressWhenTotalMBOver`) are both satisfied. Compression does not lower
   * the file count, so the count budget must be measured on plain snapshots.
   *
   * Runs over the WHOLE backup directory (current + legacy + unparseable names):
   * a budget computed on a subset silently never fires, which is exactly the
   * failure mode a project with mostly pre-redesign names would hit.
   * Physical deletion only when allowDelete.
   */
  function compactGlobal() {
    let compressed = 0
    let deleted = 0
    try {
      const snapshots = allBackupFiles()
      const plain = () => allBackupFiles().filter(file => file.compressed !== true)
      const sizeMB = () => allBackupFiles().reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)
      const overLimit = () => plain().length > compressWhenFilesOver || sizeMB() > compressWhenTotalMBOver
      while (overLimit()) {
        const oldest = plain().pop()
        if (oldest === undefined) break
        if (compressOne(oldest)) { compressed += 1; continue }
        break
      }
      // Hard ceiling: compress first; delete only when the operator opted in.
      if (sizeMB() > maxTotalMB) {
        if (allowDelete) {
          for (const file of allBackupFiles()) {
            if (sizeMB() <= maxTotalMB) break
            try { unlinkSync(file.path); deleted += 1 } catch { /* best effort */ }
          }
        } else {
          return { compressed, deleted, overLimit: true, snapshots: snapshots.length }
        }
      }
      return { compressed, deleted, overLimit: false, snapshots: snapshots.length }
    } catch (error) {
      warn('[auto-backup] global compaction failed: ' + String(error))
      return { compressed, deleted, overLimit: false, snapshots: 0 }
    }
  }

  /**
   * 方案 A：检测 bash/pwsh 命令里"疑似写入白名单文件"的路径（只 WARN，不备份）。
   * 返回 [{ relative, absolute }]（去重）。
   */
  function detectBashWrite(toolName, args) {
    if (!bashToolNames.has(toolName)) return []
    if (args === null || typeof args !== 'object') return []
    const command = typeof args.command === 'string' ? args.command : (typeof args.script === 'string' ? args.script : undefined)
    if (command === undefined || command.length === 0) return []
    // 只对"可能是写操作"的命令做检测，降低误报
    const writeish = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bsed\b[^|;]*\s-\w*i|\bSet-Content\b|\bAdd-Content\b|\bWriteAllText\b|\bwriteFileSync\b|\bcopyFileSync\b|\brenameSync\b|\bunlinkSync\b)/i
    if (!writeish.test(command)) return []
    // 提取候选路径 token（含 / 或 \ 或常见扩展名）
    const tokens = command.match(/[^\s"'|;&<>()]+/g) ?? []
    const hits = []
    const seen = new Set()
    for (const token of tokens) {
      const cleaned = cleanToken(token)
      if (cleaned.length === 0) continue
      if (!/[\\/]/.test(cleaned) && !/\.(?:lua|md|js|mjs|json|ts|css|html)$/i.test(cleaned)) continue
      const decision = shouldBackup(cleaned)
      if (decision.backup && !seen.has(decision.relative)) {
        seen.add(decision.relative)
        hits.push({ relative: decision.relative, absolute: decision.absolute })
      }
    }
    return hits
  }

  /** 从工具调用参数里取目标路径（write/edit 的常见字段）。 */
  function targetFromArguments(toolName, args) {
    if (!toolNames.has(toolName)) return undefined
    if (args === null || typeof args !== 'object') return undefined
    const candidates = [args.path, args.file_path, args.filePath, args.filename]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
    return undefined
  }

  return {
    shouldBackup, backup, prune, compactGlobal, compressOne, readSnapshot, targetFromArguments, detectBashWrite,
    backupDir, projectRoot, keepPerFile, largeFileBytes, largeRetention, maxTotalMB,
    keepUncompressedPerFile, compressWhenFilesOver, compressWhenTotalMBOver, allowDelete,
    existingBackups, totalBackupMB, allBackupFiles,
    /** Aggregate facts for the read-only status tool. */
    stats() {
      const files = allBackupFiles()
      const plain = files.filter(file => file.compressed !== true)
      const bytes = files.reduce((sum, file) => sum + file.size, 0)
      const totalMB = bytes / (1024 * 1024)
      const formatCounts = { current: 0, legacy: 0, unknown: 0 }
      for (const file of files) formatCounts[file.kind] = (formatCounts[file.kind] ?? 0) + 1
      // Independent on-disk count so "what the tools see" can be compared with
      // "what is actually in the directory" instead of trusting our own parser.
      let scannedOnDisk = 0
      try {
        if (existsSync(backupDir)) {
          for (const entry of readdirSync(backupDir)) {
            if (!entry.startsWith(SNAPSHOT_PREFIX)) continue
            try { if (statSync(join(backupDir, entry)).isFile()) scannedOnDisk += 1 } catch { /* skip */ }
          }
        }
      } catch { /* ignore */ }
      return {
        count: files.length,
        plainCount: plain.length,
        compressedCount: files.length - plain.length,
        totalMB: Math.round(totalMB * 100) / 100,
        formatCounts,
        unparsedCount: formatCounts.unknown,
        statsCrossCheck: {
          scannedOnDisk,
          counted: files.length,
          matchesDisk: scannedOnDisk === files.length,
          note: 'scannedOnDisk counts every `_改前_` file in backupDir; counted is what the tools see. They must match.',
        },
        thresholds: {
          plainCountBudget: compressWhenFilesOver,
          totalMBBudget: compressWhenTotalMBOver,
          overPlainBudget: plain.length > compressWhenFilesOver,
          overTotalMBBudget: totalMB > compressWhenTotalMBOver,
        },
        compressionPolicy: 'snapshots are never deleted by default; older ones are gzipped',
      }
    },
  }
}

/** Resolve the workspace directory the calling session is bound to, defensively. */
function sessionWorkspace(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim()
  } catch { /* fall through */ }
  return null
}

/**
 * 宿主插件入口：在写类工具执行前备份目标文件；对 bash 写入只做 WARN 检测（方案 A）。
 *
 * Project root resolution (V3): explicit `config.projectRoot` wins; otherwise the
 * root is resolved per call from the calling session's workspace. When neither is
 * available the plugin goes **inactive** (WARN once + status reason) instead of
 * silently falling back to the host process cwd — this was V1/A3.
 */
export function apply(ctx, config, deps = {}) {
  const cfg = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  const managers = new Map()
  /** 同一命令+目标只提醒一次（apply 作用域）。 */
  const bashWarned = new Set()
  /** Counters are per project root: one host process serves several workspaces. */
  const countersByRoot = new Map()
  const emptyCounters = () => ({ backups: 0, identical: 0, errors: 0, lastBackupAt: null, lastBackup: null })
  const countersFor = (root) => {
    if (root === null) return emptyCounters()
    let value = countersByRoot.get(root)
    if (value === undefined) {
      value = emptyCounters()
      countersByRoot.set(root, value)
    }
    return value
  }
  let inactiveReason = null
  let resolvedLast = { root: null, source: 'unavailable' }
  let hookRegistered = false

  const rootFor = (agent) => {
    if (typeof cfg.projectRoot === 'string' && cfg.projectRoot.trim() !== '') {
      return { root: cfg.projectRoot.trim(), source: 'config' }
    }
    const fromSession = sessionWorkspace(agent)
    if (fromSession !== null) return { root: fromSession, source: 'session' }
    try {
      const fromService = ctx.get?.('workingDirectory')?.get?.(agent?.session)
      if (typeof fromService === 'string' && fromService.trim() !== '') return { root: fromService.trim(), source: 'session-service' }
    } catch { /* fall through */ }
    return { root: null, source: 'unavailable' }
  }

  const managerFor = (root) => {
    let manager = managers.get(root)
    if (manager === undefined) {
      manager = deps.manager ?? createBackupManager({ ...cfg, projectRoot: root, logger: ctx.logger })
      managers.set(root, manager)
    }
    return manager
  }

  const markInactive = (reason) => {
    if (inactiveReason === reason) return
    inactiveReason = reason
    ctx.logger.warn('[auto-backup] inactive: ' + reason)
  }

  // ---- read-only status tool (registered even when the hook is disabled) ----
  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') ctx.tools.register({
    name: 'auto_backup_status',
    description:
      'Read-only status of the pre-write auto-backup hook: enabled flag, effective configuration, how the project '
      + 'root was resolved (config / session workspace / unavailable), the backup directory and its totals, '
      + 'inactive reason when no root is available, and counters. Use it to verify the hook actually protects the '
      + 'current workspace before relying on file_backups. Capability index: skill("team-bootstrap") §2 / '
      + 'capability audit.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const resolved = rootFor(exec?.agent)
      resolvedLast = resolved
      let manager = null
      let stats = null
      try {
        if (resolved.root !== null) {
          manager = managerFor(resolved.root)
          stats = manager.stats()
        }
      } catch (error) {
        stats = { error: String(error) }
      }
      const counters = countersFor(resolved.root)
      return {
        ok: true,
        plugin: 'dsh-auto-backup',
        version: PLUGIN_VERSION,
        enabled: cfg.enabled !== false,
        hookRegistered,
        root: { path: resolved.root, source: resolved.source },
        inactiveReason: resolved.root === null ? 'no projectRoot configured and no session workspace (hook is a no-op)' : inactiveReason,
        backupDir: manager === null ? null : manager.backupDir,
        backupStats: stats,
        backupStatsScope: 'all `_改前_*` snapshots in backupDir (every batch, every name format, plain + .gz)',
        counters: { ...counters },
        countersScope: 'this-host-process since start, for THIS project root only (never another workspace)',
        summary: {
          onDisk: typeof stats?.count === 'number' ? stats.count : null,
          processBackups: counters.backups,
          lastProcessBackupAt: counters.lastBackupAt,
          note: 'backupStats is the historical disk total for this root; counters only count this process. A null lastProcessBackupAt does not mean no historical backups.',
        },
        config: { defaults: defaultsOf(Config), fields: fieldDocs(Config) },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Auto-backup status', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'auto_backup_compact',
    description:
      '⚠ Scope: this workspace file_backups; reversible: yes (compression only keeps every snapshot); '
      + 'precondition: dryRun:false requires confirm:"COMPACT". '
      + 'Gzip the oldest plain snapshots beyond the per-file plain window and the global count/size thresholds. '
      + 'Nothing is deleted unless the operator set allowDelete:true and passes mode:"delete".',
    parameters: {
      type: 'object',
      properties: {
        keepPerFile: { type: 'number', description: 'Plain (uncompressed) snapshots to keep per file (default: manager.keepUncompressedPerFile).' },
        mode: { type: 'string', enum: ['compress', 'delete'], description: 'Default "compress": gzip only. "delete" also requires allowDelete:true.' },
        dryRun: { type: 'boolean', description: 'Default true; false requires confirm:"COMPACT".' },
        confirm: { type: 'string', description: 'Must be exactly "COMPACT" when dryRun:false.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}, exec = {}) {
      const resolved = rootFor(exec?.agent)
      if (resolved.root === null) return { ok: false, code: 'NO_ROOT', message: 'no projectRoot and no session workspace' }
      const manager = managerFor(resolved.root)
      const keep = Number.isFinite(Number(args.keepPerFile)) && Number(args.keepPerFile) > 0
        ? Math.trunc(Number(args.keepPerFile))
        : manager.keepUncompressedPerFile
      const mode = args.mode === 'delete' ? 'delete' : 'compress'
      const dryRun = args.dryRun !== false
      if (!dryRun && args.confirm !== 'COMPACT') {
        return { ok: false, code: 'CONFIRM_REQUIRED', message: 'compact requires confirm:"COMPACT" when dryRun:false' }
      }
      if (mode === 'delete' && manager.allowDelete !== true) {
        return { ok: false, code: 'DELETE_DISABLED', message: 'mode:"delete" requires config allowDelete:true; default keeps every snapshot' }
      }
      // Group snapshots by basename (backup names preserve only the basename).
      // Unparseable names get their own group so the per-file window never
      // treats unrelated files as one history.
      const groups = new Map()
      const formatCounts = { current: 0, legacy: 0, unknown: 0 }
      for (const file of manager.allBackupFiles()) {
        formatCounts[file.kind] = (formatCounts[file.kind] ?? 0) + 1
        const key = file.file === null ? '~' + file.entry : file.file
        const list = groups.get(key) ?? []
        list.push(file)
        groups.set(key, list)
      }
      const plan = []
      let compressed = 0
      let deleted = 0
      for (const [file, list] of groups) {
        const sorted = [...list].sort((a, b) => (b.stamp ?? '').localeCompare(a.stamp ?? ''))
        const plain = sorted.filter(item => item.compressed !== true)
        for (const stale of plain.slice(keep)) {
          plan.push({ file, entry: stale.entry, size: stale.size, kind: stale.kind, action: 'compress' })
          if (!dryRun && manager.compressOne(stale)) compressed += 1
        }
        if (mode === 'delete') {
          for (const stale of sorted.filter(item => item.compressed === true)) {
            plan.push({ file, entry: stale.entry, size: stale.size, kind: stale.kind, action: 'delete' })
          }
        }
      }
      return {
        ok: true,
        dryRun,
        mode,
        keepPerFile: keep,
        backupDir: manager.backupDir,
        formatCounts,
        wouldChange: plan.length,
        compressed,
        deleted,
        grouping: 'basename',
        groupingCaveat: 'Snapshots preserve only the basename, so files with the same basename in different directories share one group.',
        files: plan.slice(0, 50),
        filesShown: Math.min(50, plan.length),
        filesTotal: plan.length,
        truncated: plan.length > 50,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Compact auto-backups', kind: 'write' }),
  })

  ctx.tools.register({
    name: 'auto_backup_history',
    description:
      'Read-only: list `_改前_` snapshots for one file (plain and .gz), newest first, so changes between any two '
      + 'versions can be derived. Snapshots are never deleted by the hook; older ones are gzipped.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Basename or workspace-relative path of the backed-up file (e.g. lua_scripts/levels.lua).' },
        limit: { type: 'number', description: 'Max rows (default 30, max 200).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}, exec = {}) {
      const resolved = rootFor(exec?.agent)
      if (resolved.root === null) return { ok: false, code: 'NO_ROOT', message: 'no projectRoot and no session workspace' }
      const manager = managerFor(resolved.root)
      const raw = typeof args.file === 'string' ? args.file.trim() : ''
      if (raw === '') return { ok: false, code: 'INVALID_ARGUMENT', message: 'file is required' }
      const name = basename(raw)
      const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Math.trunc(Number(args.limit)))) : 30
      const rows = manager.existingBackups(join(resolved.root, name)).slice(0, limit)
      return {
        ok: true,
        file: name,
        backupDir: manager.backupDir,
        total: manager.existingBackups(join(resolved.root, name)).length,
        returned: rows.length,
        snapshots: rows.map(row => ({
          entry: row.entry,
          stamp: row.stamp,
          compressed: row.compressed === true,
          size: row.size,
          path: row.path,
        })),
        note: 'Use auto_backup_show to read one snapshot; .gz is decompressed transparently.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Auto-backup history', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'auto_backup_show',
    description:
      'Read-only: return one `_改前_` snapshot content (decompressing .gz) for diffing against the current file. '
      + 'Bounded to 200 KB of decoded text.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Basename or workspace-relative path of the backed-up file.' },
        stamp: { type: 'string', description: 'Snapshot stamp from auto_backup_history (default: newest).' },
        maxChars: { type: 'number', description: 'Max decoded characters to return (default 20000, max 200000).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}, exec = {}) {
      const resolved = rootFor(exec?.agent)
      if (resolved.root === null) return { ok: false, code: 'NO_ROOT', message: 'no projectRoot and no session workspace' }
      const manager = managerFor(resolved.root)
      const raw = typeof args.file === 'string' ? args.file.trim() : ''
      if (raw === '') return { ok: false, code: 'INVALID_ARGUMENT', message: 'file is required' }
      const name = basename(raw)
      const snapshots = manager.existingBackups(join(resolved.root, name))
      if (snapshots.length === 0) return { ok: false, code: 'NOT_FOUND', file: name, message: 'no snapshot for this file' }
      const wanted = typeof args.stamp === 'string' ? args.stamp.trim() : ''
      const snapshot = wanted === '' ? snapshots[0] : snapshots.find(row => row.stamp === wanted)
      if (snapshot === undefined) return { ok: false, code: 'NOT_FOUND', file: name, stamp: wanted, message: 'no snapshot with that stamp' }
      const maxChars = Number.isFinite(Number(args.maxChars)) ? Math.max(1, Math.min(200000, Math.trunc(Number(args.maxChars)))) : 20000
      const buffer = manager.readSnapshot(snapshot)
      const text = buffer.toString('utf8')
      return {
        ok: true,
        file: name,
        entry: snapshot.entry,
        stamp: snapshot.stamp,
        compressed: snapshot.compressed === true,
        size: snapshot.size,
        chars: text.length,
        truncated: text.length > maxChars,
        content: text.slice(0, maxChars),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Show auto-backup snapshot', kind: 'read' }),
  })

  if (cfg.enabled === false) {
    ctx.logger.info('[auto-backup] v' + PLUGIN_VERSION + ' disabled by config (enabled=false); status tool only')
    return
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const resolved = rootFor(exec.agent)
      resolvedLast = resolved
      if (resolved.root === null) {
        markInactive('no projectRoot configured and no session workspace; write is not backed up')
        return next()
      }
      if (inactiveReason !== null) {
        inactiveReason = null
        ctx.logger.info('[auto-backup] active again for root=' + resolved.root + ' (source=' + resolved.source + ')')
      }
      const manager = managerFor(resolved.root)
      const counters = countersFor(resolved.root)
      const target = manager.targetFromArguments(exec.name, exec.arguments)
      if (target !== undefined) {
        const result = manager.backup(target)
        if (result.ok === true && result.skipped !== true) {
          counters.backups += 1
          counters.lastBackupAt = new Date().toISOString()
          counters.lastBackup = result.path ?? null
        } else if (result.skipped === true && result.reason === 'identical') {
          counters.identical += 1
        } else if (result.ok === false && result.reason === 'error') {
          counters.errors += 1
        }
      } else {
        // 方案 A：bash/pwsh 里疑似写入白名单文件 ⇒ 只 WARN（无法在写入前拦截）
        const hits = manager.detectBashWrite(exec.name, exec.arguments)
        for (const hit of hits) {
          const key = exec.name + ':' + hit.relative
          if (bashWarned.has(key)) continue
          bashWarned.add(key)
          ctx.logger.warn('[auto-backup] ⚠ 检测到 ' + exec.name + ' 可能写入 ' + hit.relative
            + '（未经 auto-backup；如为源码修改请改用 write/edit 或先手动备份）')
        }
      }
    } catch (error) {
      countersFor(null).errors += 1
      ctx.logger.warn('[auto-backup] hook error: ' + String(error))
    }
    return next()
  })
  hookRegistered = true
  ctx.logger.info('[auto-backup] v' + PLUGIN_VERSION + ' ready (projectRoot='
    + (typeof cfg.projectRoot === 'string' && cfg.projectRoot.trim() !== '' ? cfg.projectRoot : 'auto:session-workspace')
    + ', backupDir=' + cfg.backupDir + ', keepPerFile=' + cfg.keepPerFile
    + ', largeFile=' + cfg.largeFileBytes + 'B/' + cfg.largeRetention + '份'
    + ', maxTotal=' + cfg.maxTotalMB + 'MB)')
}
