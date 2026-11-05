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
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  enabled: boolean(true, { description: 'Enforce pre-write backups. false = keep the status tool only (no hook).' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  projectRoot: string('', {
    description: 'Absolute project root to protect. Empty = resolve per call from the session workspace (recommended). Backups outside the resolved root are refused.',
  }),
  backupDir: string('file_backups', { description: 'Backup directory, relative to the project root (must stay inside it).' }),
  batch: string('auto', { description: 'Batch tag used in backup file names.' }),
  include: any(null, { description: 'Array of {dir, ext[]} include rules. null = generic source/doc extensions anywhere in the root.' }),
  excludeDirs: stringArray(['file_backups', '.git', 'node_modules', 'team/pipe2/inbox', 'team/pipe2/ack', 'team/pipe2/cursor', 'team/pipe2/tmp', 'team/pipe2/_archive', 'backup', '.vs', 'images'], { description: 'Directories (relative) never backed up.' }),
  toolNames: stringArray(['write', 'edit'], { description: 'Tools whose target file is backed up before execution.' }),
  bashToolNames: stringArray(['bash', 'pwsh', 'shell', 'cmd'], { description: 'Shell tools whose write commands are detected and WARNed (cannot be backed up before execution).' }),
  keepPerFile: number(30, { description: 'Retention per file (small files).', int: true, min: 1 }),
  largeFileBytes: number(524288, { description: 'Files at/above this size use largeRetention.', int: true, min: 1 }),
  largeRetention: number(5, { description: 'Retention per large file.', int: true, min: 1 }),
  largeWarnBytes: number(262144, { description: 'WARN once when a backed-up file is at/above this size.', int: true, min: 1 }),
  maxTotalMB: number(800, { description: 'Total backup size cap in MB; oldest `_改前_` files are pruned above it.', min: 1 }),
  fileOverrides: any(null, { description: 'Per-path retention overrides: { "doc/*.md": {keep: 10}, "*": {keepIfLargerThanKB: 512, keep: 5} }.' }),
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

function normalize(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '')
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
  // 分级保留：大文件只留少量（用户 2026-10-24 要求）
  const largeFileBytes = Number.isFinite(config.largeFileBytes) && config.largeFileBytes > 0
    ? config.largeFileBytes
    : 512 * 1024
  const largeRetention = Number.isFinite(config.largeRetention) && config.largeRetention > 0
    ? config.largeRetention
    : 5
  const largeWarnBytes = Number.isFinite(config.largeWarnBytes) && config.largeWarnBytes > 0
    ? config.largeWarnBytes
    : 256 * 1024
  // 备份总量上限（MB），超限淘汰最旧 _改前_ 文件；绝不碰 归档_* 目录
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

  /** 该文件已有的备份列表（新→旧）。 */
  function existingBackups(absolute) {
    if (!existsSync(backupDir)) return []
    const name = basename(absolute)
    const prefix = '_改前_'
    const suffix = '_' + name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const collisionSuffix = new RegExp('_' + escaped + '\\.\\d+$')
    return readdirSync(backupDir)
      .filter(entry => entry.startsWith(prefix) && (entry.endsWith(suffix) || collisionSuffix.test(entry)))
      .map(entry => ({ entry, path: join(backupDir, entry), mtime: statSync(join(backupDir, entry)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)
  }

  /** 备份目录内所有 `_改前_` 文件（新→旧）；排除 归档_* 等非本工具产物。 */
  function allBackupFiles() {
    if (!existsSync(backupDir)) return []
    const files = []
    for (const entry of readdirSync(backupDir)) {
      if (!entry.startsWith('_改前_')) continue
      const absolute = join(backupDir, entry)
      try {
        const info = statSync(absolute)
        if (!info.isFile()) continue
        files.push({ entry, path: absolute, mtime: info.mtimeMs, size: info.size })
      } catch { /* skip */ }
    }
    return files.sort((left, right) => right.mtime - left.mtime)
  }

  function totalBackupMB() {
    return allBackupFiles().reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)
  }

  /** 单文件保留份数：精确 → glob → '*' 兜底 → 大小分级默认。 */
  function retentionFor(size, relative) {
    if (relative !== undefined) {
      const normalized = normalize(relative)
      const exact = exactOverrides.get(normalized)
      if (exact !== undefined && Number.isFinite(exact.keep) && exact.keep > 0) return exact.keep
      for (const rule of globOverrides) {
        if (rule.regex.test(normalized) && Number.isFinite(rule.value.keep) && rule.value.keep > 0) return rule.value.keep
      }
      if (starOverride !== undefined && Number.isFinite(starOverride.keep) && starOverride.keep > 0) {
        const minBytes = Number.isFinite(starOverride.keepIfLargerThanKB) ? starOverride.keepIfLargerThanKB * 1024 : 0
        if (size >= minBytes) return starOverride.keep
      }
    }
    return size >= largeFileBytes ? largeRetention : keepPerFile
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
        const latestHash = sha256(latest.path)
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
      // 大文件提醒（每文件一次）：提醒"这个文件很大，考虑降低备份频次"
      if (size >= largeWarnBytes && !largeWarned.has(absolute)) {
        largeWarned.add(absolute)
        warn('[auto-backup] 大文件 WARN：' + decision.relative + '（' + (size / 1024).toFixed(0)
          + 'KB ≥ ' + (largeWarnBytes / 1024).toFixed(0) + 'KB），建议降低备份频次或加入低保留名单')
      }
      // 总量上限：超限淘汰最旧 _改前_ 文件（绝不删 归档_*）
      const overMB = totalBackupMB() - maxTotalMB
      if (overMB > 0) {
        const removed = enforceTotalLimit(overMB)
        warn('[auto-backup] 备份总量超限（上限 ' + maxTotalMB + 'MB）：已淘汰最旧 ' + removed + ' 份备份')
      }
      return { ok: true, path: finalPath, size }
    } catch (error) {
      warn('[auto-backup] backup failed for ' + String(targetPath) + ': ' + String(error))
      return { ok: false, reason: 'error' }
    }
  }

  /** 保留最近 N 份（大文件按 largeRetention），淘汰最旧。 */
  function prune(absolute, size, relative) {
    try {
      const limit = retentionFor(size ?? statSync(absolute).size, relative)
      const backups = existingBackups(absolute)
      for (const stale of backups.slice(limit)) {
        try { unlinkSync(stale.path) } catch { /* best effort */ }
      }
    } catch (error) {
      warn('[auto-backup] prune failed: ' + String(error))
    }
  }

  /** 按总量上限淘汰最旧备份，返回淘汰份数。 */
  function enforceTotalLimit(overMB) {
    let removed = 0
    let remainingMB = overMB
    for (const file of allBackupFiles()) {
      if (remainingMB <= 0) break
      try {
        unlinkSync(file.path)
        removed += 1
        remainingMB -= file.size / (1024 * 1024)
      } catch { /* best effort */ }
    }
    return removed
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
      const cleaned = token.replace(/^[=@]+/, '').replace(/[,:]+$/, '')
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
    shouldBackup, backup, prune, targetFromArguments, detectBashWrite,
    backupDir, projectRoot, keepPerFile, largeFileBytes, largeRetention, maxTotalMB, existingBackups, totalBackupMB,
    /** Aggregate facts for the read-only status tool. */
    stats() {
      const files = allBackupFiles()
      return { count: files.length, totalMB: Math.round(files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024) * 100) / 100 }
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
  const counters = { backups: 0, identical: 0, errors: 0, lastBackupAt: null, lastBackup: null }
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
      + 'CAPABILITY_AUDIT.md.',
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
        counters: { ...counters },
        config: { defaults: defaultsOf(Config), fields: fieldDocs(Config) },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Auto-backup status', kind: 'read' }),
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
      counters.errors += 1
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
