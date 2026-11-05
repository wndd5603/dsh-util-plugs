#!/usr/bin/env node
/**
 * dsh-session-network CLI (P0) — contract: docs/INTERFACES_v1.md §7.
 *
 * Commands (every command prints JSON; mutating commands default to dry-run or
 * require explicit flags as documented below):
 *   session-network doctor
 *   session-network data status
 *   session-network data set-dir <abs> [--dry-run|--apply --ack]
 *   session-network data migrate [--from A --to B] [--dry-run|--apply] [--switch]
 *   session-network data rollback [id] [--dry-run|--apply] [--no-switch]
 *   session-network data backups
 *   session-network config get [key]
 *   session-network config set <key> <value> [--dry-run|--apply]
 *
 * Global flags: --profile <dir>  --data-dir <dir>  --json (always on)  --help
 * Safety: `doctor`/`status`/`backups`/`get` are read-only (no mkdir, no DB
 * writes). `set-dir`/`migrate`/`rollback` require `--apply`; `set-dir` also
 * requires `--ack`. `config set` applies unless `--dry-run`.
 *
 * Non-contract extras reported to lead: `--switch` (update config dataDir after
 * migrate), `data rollback` alias, `runCli(argv, opts)` export for tests.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, configPath, readConfig, resolveDataDir, writeConfig } from '../src/config.js'
import { closeDb, dbStats, openDb, SCHEMA_VERSION } from '../src/db.js'
import { MIGRATION_FILE, TRASH_DIR_NAME, migrateDataDir, planMigration, readMigrationRecord, rollbackMigration } from '../src/migrate.js'

const BOOLEAN_FLAGS = new Set(['dry-run', 'apply', 'ack', 'json', 'pretty', 'help', 'switch', 'no-switch', 'create'])
const VALUE_FLAGS = new Set(['profile', 'data-dir', 'from', 'to', 'rollback', 'key', 'value', 'limit'])

export function resolveProfileDir({ env = process.env, profile } = {}) {
  if (typeof profile === 'string' && profile.trim() !== '') return resolve(profile.trim())
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.trim() !== '') return resolve(env.DSH_PROFILE_DIR.trim())
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(env.USERPROFILE ?? env.HOME ?? homedir(), '.dsh')
  return join(home, 'profiles', typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== '' ? env.DSH_PROFILE : 'web')
}

export function parseArgs(argv = []) {
  const flags = {}
  const positional = []
  const errors = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index])
    if (token === '-h' || token === '-?') { flags.help = true; continue }
    if (!token.startsWith('--')) { positional.push(token); continue }
    const key = token.slice(2)
    if (key === '') { errors.push('empty flag'); continue }
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue }
    if (VALUE_FLAGS.has(key)) {
      const value = argv[index + 1]
      if (value === undefined || String(value).startsWith('--')) { errors.push(`--${key} requires a value`); continue }
      flags[key] = String(value)
      index += 1
      continue
    }
    errors.push(`unknown flag: ${token}`)
  }
  return { flags, positional, errors }
}

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return { exists: false, value: null }
    return { exists: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { exists: true, value: null, error: String(error?.message ?? error) }
  }
}

function readState(dataDir) {
  const file = join(dataDir, 'state.json')
  const parsed = readJsonFile(file)
  let autoInject = null
  if (parsed.value !== null && typeof parsed.value === 'object') {
    const enabled = parsed.value?.autoInject?.enabled
    if (enabled === true) autoInject = true
    else if (enabled === false) autoInject = false
  }
  return { path: file, exists: parsed.exists, autoInject, error: parsed.error ?? null }
}

function dbInfo(dataDir) {
  const path = join(dataDir, 'network.db')
  const walPath = path + '-wal'
  const shmPath = path + '-shm'
  const walExisted = existsSync(walPath)
  const shmExisted = existsSync(shmPath)
  const info = { path, exists: existsSync(path), bytes: null, walBytes: null, healthy: null, userVersion: null, journalMode: null, tables: null, integrity: null, error: null, schemaVersion: SCHEMA_VERSION }
  if (!info.exists) return info
  try {
    info.bytes = statSync(path).size
    info.walBytes = walExisted ? statSync(walPath).size : 0
  } catch (error) {
    info.error = String(error?.message ?? error)
  }
  let db
  try {
    db = openDb({ dataDir, readonly: true, shared: false, create: false })
    const stats = dbStats(db, { dataDir })
    info.userVersion = stats.userVersion
    info.journalMode = stats.journalMode
    info.tables = stats.tables
    info.integrity = stats.integrity
    info.healthy = stats.integrity === true
    closeDb(db)
    db = undefined
  } catch (error) {
    info.healthy = false
    info.error = String(error?.code ?? error?.message ?? error)
  } finally {
    if (db !== undefined) { try { closeDb(db) } catch { /* ignore */ } }
    // A read-only probe of a WAL database may create empty -wal/-shm sidecars.
    // Remove only the ones this read path created (M1: doctor/status write nothing).
    if (!walExisted) { try { rmSync(walPath, { force: true }) } catch { /* ignore */ } }
    if (!shmExisted) { try { rmSync(shmPath, { force: true }) } catch { /* ignore */ } }
  }
  return info
}

function readPresets(profileDir) {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return { source: 'missing', file, selectedDefault: null, default: null }
  try {
    const text = readFileSync(file, 'utf8')
    const selected = text.match(/selectedDefault:\s*['"]?([A-Za-z0-9_-]+)/)
    const fallback = text.match(/\bdefault:\s*['"]?([A-Za-z0-9_-]+)/)
    return { source: 'profile-cordis.patch.yml', file, selectedDefault: selected?.[1] ?? null, default: fallback?.[1] ?? null }
  } catch (error) {
    return { source: 'unreadable', file, selectedDefault: null, default: null, error: String(error?.message ?? error) }
  }
}

function listDirSafe(path) {
  try {
    return readdirSync(path).map(name => {
      const full = join(path, name)
      let bytes = null
      let directory = false
      let mtime = null
      try {
        const stats = statSync(full)
        directory = stats.isDirectory()
        bytes = stats.size
        mtime = stats.mtime.toISOString()
      } catch { /* ignore */ }
      return { name, path: full, directory, bytes, mtime }
    }).sort((left, right) => String(right.mtime).localeCompare(String(left.mtime)))
  } catch {
    return []
  }
}

function backupSummary(dataDir, migrationRecord) {
  const candidates = [
    { kind: 'data-trash', path: join(dataDir, 'trash') },
    { kind: 'sibling-trash', path: join(dirname(dataDir), TRASH_DIR_NAME) },
  ]
  if (typeof migrationRecord?.trashPath === 'string') candidates.push({ kind: 'migration-trash', path: migrationRecord.trashPath })
  const seen = new Set()
  const roots = []
  for (const candidate of candidates) {
    const key = guessPathKey(candidate.path)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    roots.push({ ...candidate, exists: existsSync(candidate.path), entries: candidate.path !== undefined ? listDirSafe(candidate.path) : [] })
  }
  return { roots, count: roots.reduce((sum, root) => sum + root.entries.length, 0) }
}

function guessPathKey(path) {
  return typeof path === 'string' && path !== '' ? (process.platform === 'win32' ? path.toLowerCase() : path) : null
}

function migrationInfo(dataDir) {
  const file = join(dataDir, MIGRATION_FILE)
  const record = existsSync(file) ? readMigrationRecord(dataDir) : null
  return { path: file, exists: existsSync(file), record, parseable: record !== null }
}

function baseContext(flags, env) {
  const profileDir = resolveProfileDir({ env, profile: flags.profile })
  const { config, source, path: cfgPath, error } = readConfig(profileDir)
  const dataDirFlag = flags['data-dir']
  const dataDir = typeof dataDirFlag === 'string' && dataDirFlag.trim() !== ''
    ? resolve(dataDirFlag.trim())
    : resolveDataDir(profileDir, config)
  // "default" means the profile-bound default path, independent of any custom
  // config.dataDir (needed for the X2 dataDirAck WARN decision).
  const defaultDataDir = join(profileDir, 'data', 'session-network')
  return {
    profileDir,
    config,
    configSource: source,
    configPath: cfgPath,
    configError: error ?? null,
    dataDir,
    defaultDataDir,
    isDefaultDataDir: guessPathKey(dataDir) === guessPathKey(defaultDataDir),
    warnings: [],
  }
}

function doctor(flags, env, now) {
  const context = baseContext(flags, env)
  const state = readState(context.dataDir)
  const db = dbInfo(context.dataDir)
  const migration = migrationInfo(context.dataDir)
  const presets = readPresets(context.profileDir)
  const backups = backupSummary(context.dataDir, migration.record)
  const warnings = [...context.warnings]
  const ackRaw = context.config?.dataDirAck
  const ackConfigured = ackRaw !== null && typeof ackRaw === 'object'
    ? { acknowledgedAt: ackRaw.acknowledgedAt ?? null, dir: ackRaw.dir ?? null }
    : { acknowledgedAt: null, dir: null }
  const ackOk = typeof ackConfigured.acknowledgedAt === 'string' && ackConfigured.acknowledgedAt !== ''
    && typeof ackConfigured.dir === 'string' && guessPathKey(ackConfigured.dir) === guessPathKey(context.dataDir)
  if (!existsSync(context.dataDir)) warnings.push('dataDir 不存在（doctor 不会创建）：' + context.dataDir)
  if (!context.isDefaultDataDir && ackOk === false) warnings.push('dataDir 为自定义路径但未 ack（config.dataDirAck）；请用 data set-dir <abs> --apply --ack 确认')
  if (ackConfigured.dir !== null && guessPathKey(ackConfigured.dir) !== guessPathKey(context.dataDir)) warnings.push('config.dataDirAck.dir 与当前 dataDir 不一致（可能从旧路径迁移后未重新 ack）')
  if (db.exists && db.healthy === false) warnings.push('DB 不可读/损坏：' + db.error)
  if (migration.exists && !migration.parseable) warnings.push('MIGRATION.json 无法解析')
  if (context.configError !== null) warnings.push('config 回退默认值：' + context.configError)
  if (presets.selectedDefault === null && presets.default === null) warnings.push('未在 profile patch 中读到 agent-preset-registry 默认预设（仅提示）')
  return {
    ok: true,
    command: 'doctor',
    generatedAt: now.toISOString(),
    schemaVersion: SCHEMA_VERSION,
    profile: { dir: context.profileDir, configPath: context.configPath, configExists: existsSync(context.configPath), configSource: context.configSource },
    dataDir: { path: context.dataDir, exists: existsSync(context.dataDir), isDefault: context.isDefaultDataDir, defaultPath: context.defaultDataDir, ack: { ...ackConfigured, ok: ackOk } },
    db,
    state,
    migration,
    presets,
    backups,
    warnings,
  }
}

function dataStatus(flags, env, now) {
  const context = baseContext(flags, env)
  const db = dbInfo(context.dataDir)
  const migration = migrationInfo(context.dataDir)
  const state = readState(context.dataDir)
  return {
    ok: true,
    command: 'data.status',
    generatedAt: now.toISOString(),
    profile: { dir: context.profileDir, configPath: context.configPath, configSource: context.configSource },
    dataDir: { path: context.dataDir, exists: existsSync(context.dataDir), isDefault: context.isDefaultDataDir },
    db,
    state,
    migration,
    backups: backupSummary(context.dataDir, migration.record),
  }
}

function requireApply(flags, command) {
  if (flags.apply === true) return null
  return { ok: false, command, code: 'DRY_RUN_DEFAULT', message: '默认 dry-run；确认后加 --apply', dryRun: true }
}

function dataSetDir(flags, env, now) {
  const context = baseContext(flags, env)
  const targetValue = flags.value ?? flags.to
  if (typeof targetValue !== 'string' || targetValue.trim() === '') {
    return { ok: false, command: 'data.set-dir', code: 'INVALID_ARGS', message: '用法：data set-dir <abs> [--dry-run|--apply --ack]' }
  }
  if (!isAbsolute(targetValue.trim())) {
    return {
      ok: false,
      command: 'data.set-dir',
      code: 'RELATIVE_PATH_REJECTED',
      message: 'data set-dir 只接受绝对路径（相对路径会被 cwd 隐式改变含义）：' + targetValue,
    }
  }
  const target = resolve(targetValue.trim())
  const current = context.dataDir
  const preview = { ok: true, command: 'data.set-dir', dryRun: true, generatedAt: now.toISOString(), profileDir: context.profileDir, configPath: context.configPath, currentDataDir: current, targetDataDir: target, samePath: guessPathKey(target) === guessPathKey(current) }
  if (guessPathKey(target) === guessPathKey(current)) return { ...preview, ok: false, code: 'SAME_PATH', message: '目标与当前 dataDir 相同' }
  if (flags['dry-run'] === true || flags.apply !== true) {
    if (flags.apply !== true) preview.message = 'dry-run（加 --apply --ack 才会写 config）'
    return preview
  }
  if (flags.ack !== true) return { ok: false, command: 'data.set-dir', code: 'ACK_REQUIRED', message: '--apply 需要同时加 --ack 确认' }
  try {
    const written = writeConfig(context.profileDir, {
      dataDir: target,
      dataDirAck: { acknowledgedAt: now.toISOString(), dir: target },
    })
    return {
      ok: true,
      command: 'data.set-dir',
      dryRun: false,
      generatedAt: now.toISOString(),
      profileDir: context.profileDir,
      configPath: written.path,
      previousDataDir: current,
      dataDir: target,
      dataDirAck: { acknowledgedAt: now.toISOString(), dir: target },
      note: '配置已写入（含 dataDirAck）；数据迁移请用 data migrate',
    }
  } catch (error) {
    return { ok: false, command: 'data.set-dir', code: 'CONFIG_WRITE_FAILED', message: String(error?.message ?? error) }
  }
}

function dataMigrate(flags, env, now) {
  const context = baseContext(flags, env)
  const command = 'data.migrate'
  const from = typeof flags.from === 'string' ? resolve(flags.from) : context.dataDir
  if (flags.rollback !== undefined && flags.rollback !== true) {
    return dataRollback({ ...flags, rollback: flags.rollback }, env, now)
  }
  const to = typeof flags.to === 'string' ? resolve(flags.to) : null
  if (to === null) return { ok: false, command, code: 'INVALID_ARGS', message: '用法：data migrate [--from A --to B] [--dry-run|--apply]' }
  if (flags.apply !== true) {
    const plan = planMigration({ from, to, now })
    return { ok: !plan.blocked, command, mode: 'dry-run', dryRun: true, generatedAt: now.toISOString(), plan, hints: ['dry-run 零写入；确认后加 --apply'] }
  }
  const result = migrateDataDir({ from, to, mode: 'apply', now, moveSourceToTrash: true })
  let switched = null
  if (result.ok === true && flags.switch === true) {
    try {
      const written = writeConfig(context.profileDir, { dataDir: to })
      switched = { ok: true, configPath: written.path, dataDir: to }
    } catch (error) {
      switched = { ok: false, code: 'CONFIG_WRITE_FAILED', message: String(error?.message ?? error) }
    }
  }
  return { command, ...result, switched, hints: result.ok === true && flags.switch !== true ? ['用 data set-dir <new> --apply --ack 或 --switch 切换配置指针'] : [] }
}

function dataRollback(flags, env, now) {
  const context = baseContext(flags, env)
  const command = 'data.rollback'
  const record = readMigrationRecord(context.dataDir)
  if (flags.apply !== true) {
    return { ok: record !== null, command, mode: 'dry-run', dryRun: true, generatedAt: now.toISOString(), dataDir: context.dataDir, record, hints: ['默认 dry-run；确认后加 --apply'] }
  }
  const result = rollbackMigration({ dataDir: context.dataDir, now })
  let switched = null
  if (result.ok === true && flags['no-switch'] !== true) {
    const restored = result.restoredTo ?? result.restoredFrom
    if (typeof restored === 'string' && guessPathKey(restored) !== guessPathKey(context.dataDir)) {
      try {
        const written = writeConfig(context.profileDir, { dataDir: restored })
        switched = { ok: true, configPath: written.path, dataDir: restored }
      } catch (error) {
        switched = { ok: false, code: 'CONFIG_WRITE_FAILED', message: String(error?.message ?? error) }
      }
    }
  }
  return { command, ...result, switched }
}

function dataBackups(flags, env, now) {
  const context = baseContext(flags, env)
  const migration = migrationInfo(context.dataDir)
  return {
    ok: true,
    command: 'data.backups',
    generatedAt: now.toISOString(),
    dataDir: context.dataDir,
    migration,
    backups: backupSummary(context.dataDir, migration.record),
    readOnly: true,
  }
}

function getDotPath(object, key) {
  return String(key).split('.').reduce((current, part) => (current !== null && typeof current === 'object' ? current[part] : undefined), object)
}

function setDotPath(object, key, value) {
  const parts = String(key).split('.')
  const next = structuredClone(object)
  let cursor = next
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
  return next
}

function keyExists(config, key) {
  return getDotPath(config, key) !== undefined
}

function parseConfigValue(raw) {
  try { return JSON.parse(raw) } catch { return raw }
}

function configCommand(flags, env, now) {
  const context = baseContext(flags, env)
  const action = flags.action
  const command = 'config.get'
  const key = flags.key
  if (action === 'get') {
    const value = key === undefined ? context.config : getDotPath(context.config, key)
    return { ok: true, command, generatedAt: now.toISOString(), configPath: context.configPath, source: context.configSource, key: key ?? null, value: value === undefined ? null : value }
  }
  if (action === 'set') {
    if (typeof key !== 'string' || key.trim() === '') return { ok: false, command: 'config.set', code: 'INVALID_ARGS', message: '用法：config set <key> <value>' }
    if (flags.value === undefined) return { ok: false, command: 'config.set', code: 'INVALID_ARGS', message: '缺少 value' }
    if (!keyExists(DEFAULT_CONFIG, key)) return { ok: false, command: 'config.set', code: 'CONFIG_KEY_UNKNOWN', message: '未知配置键（拒绝写入以免拼写错误）：' + key }
    const value = parseConfigValue(flags.value)
    const previous = getDotPath(context.config, key)
    const patch = setDotPath(context.config, key, value)
    if (flags['dry-run'] === true) {
      return { ok: true, command: 'config.set', dryRun: true, generatedAt: now.toISOString(), configPath: context.configPath, key, previous, next: patch, hints: ['dry-run；去掉 --dry-run 即写入'] }
    }
    try {
      const written = writeConfig(context.profileDir, patch)
      return { ok: true, command: 'config.set', dryRun: false, generatedAt: now.toISOString(), configPath: written.path, key, previous, dataDir: written.config.dataDir ?? null }
    } catch (error) {
      return { ok: false, command: 'config.set', code: 'CONFIG_WRITE_FAILED', message: String(error?.message ?? error) }
    }
  }
  return { ok: false, command: 'config', code: 'INVALID_ARGS', message: '用法：config get [key] | config set <key> <value>' }
}

function usageLines() {
  return [
    'session-network doctor',
    'session-network data status',
    'session-network data set-dir <abs> [--dry-run|--apply --ack]',
    'session-network data migrate [--from A --to B] [--dry-run|--apply] [--switch]',
    'session-network data rollback [id] [--dry-run|--apply] [--no-switch]',
    'session-network data backups',
    'session-network config get [key]',
    'session-network config set <key> <value> [--dry-run]',
  ]
}

/** Help is a successful request: JSON payload + exit 0 (verify M1 requirement). */
function helpResult() {
  return {
    ok: true,
    command: 'help',
    usage: usageLines(),
    globalFlags: ['--profile <dir>', '--data-dir <dir>', '--json', '--help', '-h'],
    hint: '使用 --help/-h 或无参数查看；所有命令输出 JSON；变更类命令默认 dry-run（set-dir/migrate/rollback 需 --apply，set-dir 另需 --ack）',
  }
}

function unknownCommandResult(command, detail) {
  return {
    ok: false,
    command,
    code: 'UNKNOWN_COMMAND',
    message: detail ?? ('unknown command: ' + String(command)),
    usage: usageLines(),
    exitCode: 2,
  }
}

/** Dispatch one CLI invocation. Returns `{ok, command, exitCode}` (JSON-ready). */
export async function runCli(argv = [], { env = process.env, cwd = process.cwd(), now = new Date() } = {}) {
  const { flags, positional, errors } = parseArgs(argv)
  const command = positional[0] ?? null
  const sub = positional[1] ?? null
  const startedAt = now instanceof Date ? now : new Date(now)
  if (flags.help === true) return { ...helpResult(), exitCode: 0 }
  if (command === null || command === 'help') return { ...helpResult(), exitCode: 0 }
  if (errors.length > 0) return { ok: false, command, code: 'INVALID_FLAGS', message: errors.join('; '), exitCode: 2 }
  try {
    if (command === 'doctor') return { ...doctor(flags, env, startedAt), exitCode: 0 }
    if (command === 'data') {
      if (sub === 'status') return { ...dataStatus(flags, env, startedAt), exitCode: 0 }
      if (sub === 'set-dir') {
        const result = dataSetDir({ ...flags, value: positional[2], to: positional[2] }, env, startedAt)
        return { ...result, exitCode: result.ok === true ? 0 : 1 }
      }
      if (sub === 'migrate') {
        const result = dataMigrate(flags, env, startedAt)
        return { ...result, exitCode: result.ok === true ? 0 : 1 }
      }
      if (sub === 'rollback') {
        const result = dataRollback(flags, env, startedAt)
        return { ...result, exitCode: result.ok === true ? 0 : 1 }
      }
      if (sub === 'backups') return { ...dataBackups(flags, env, startedAt), exitCode: 0 }
      return unknownCommandResult('data', sub === null ? 'data 需要子命令（status|set-dir|migrate|rollback|backups）' : 'unknown data subcommand: ' + sub)
    }
    if (command === 'config') {
      const result = configCommand({ ...flags, action: sub, key: positional[2], value: positional[3] }, env, startedAt)
      return { ...result, exitCode: result.ok === true ? 0 : 1 }
    }
    return unknownCommandResult(command)
  } catch (error) {
    return {
      ok: false,
      command,
      code: error?.code ?? 'CLI_ERROR',
      message: String(error?.message ?? error),
      exitCode: 1,
    }
  }
}

export function formatOutput(result) {
  return JSON.stringify(result, null, 2) + '\n'
}

const isMain = typeof process !== 'undefined' && process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  runCli(process.argv.slice(2), { env: process.env, cwd: process.cwd() })
    .then(result => {
      process.stdout.write(formatOutput(result))
      process.exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0
    })
    .catch(error => {
      process.stdout.write(formatOutput({ ok: false, command: 'cli', code: 'CLI_CRASH', message: String(error?.message ?? error), exitCode: 1 }))
      process.exitCode = 1
    })
}
