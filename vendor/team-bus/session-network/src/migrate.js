/**
 * dsh-session-network · data-directory migration state machine (P0)
 *
 * Contract: docs/INTERFACES_v1.md §7 (`data migrate`), ROLLBACK_v1.md 场景 D,
 * FALSIFY_v1 F11 (dry-run zero-write / interruption rollback / EPERM / EXDEV).
 *
 * Flow (apply): checkpoint WAL → VACUUM INTO staging dir → verify staging DB
 * (quick_check + user_version + table counts) → copy non-DB files → write
 * MIGRATION.json → atomic rename staging→target → move old dir to trash (EPERM
 * degrades to `applied-trash-pending`, never hard-deletes) → return manifest.
 *
 * All filesystem operations go through an injectable `fs` facade so tests can
 * simulate EPERM/EXDEV deterministically; production uses node:fs directly.
 * Non-contract extra: `trashSourceDir`, `updateMigrationRecord`, `planMigration`.
 */
import fsDefault from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DB_FILE_NAME, closeDb, dbStats, integrityCheck, openDb, tableCounts } from './db.js'

export const MIGRATION_FILE = 'MIGRATION.json'
export const TRASH_DIR_NAME = '.session-network-trash'
export const MIGRATION_SCHEMA_VERSION = 1

export function fsFacade(overrides = {}) {
  return {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    ...overrides,
  }
}

function toIso(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now())
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function stamp(now) {
  return toIso(now).replace(/[-:.TZ]/g, '').slice(0, 17)
}

function sha256File(file, fs) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

export function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return resolve(value.trim())
}

function samePath(left, right) {
  if (left === null || right === null) return false
  const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  return normalize(left) === normalize(right)
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isDirectory(path, fs) {
  try { return fs.statSync(path).isDirectory() } catch { return false }
}

function isDbFile(name) {
  return name === DB_FILE_NAME || name === DB_FILE_NAME + '-wal' || name === DB_FILE_NAME + '-shm'
}

function listDir(path, fs) {
  try { return fs.readdirSync(path) } catch { return [] }
}

function dirIsEmpty(path, fs) {
  return listDir(path, fs).length === 0
}

function copyDirRecursive(source, target, fs) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of listDir(source, fs)) {
    const sourcePath = join(source, entry)
    const targetPath = join(target, entry)
    const stats = fs.statSync(sourcePath)
    if (stats.isDirectory()) copyDirRecursive(sourcePath, targetPath, fs)
    else fs.copyFileSync(sourcePath, targetPath)
  }
}

/** rename with EXDEV fallback (copy+verify+remove) and EPERM surface. */
function movePath(source, target, fs) {
  try {
    fs.renameSync(source, target)
    return { moved: true, via: 'rename' }
  } catch (error) {
    if (error?.code === 'EXDEV') {
      copyDirRecursive(source, target, fs)
      fs.rmSync(source, { recursive: true, force: true })
      return { moved: true, via: 'copy' }
    }
    throw error
  }
}

function atomicWriteJson(file, value, fs) {
  fs.mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readMigrationRecord(dataDir, { fs = fsFacade() } = {}) {
  const file = join(dataDir, MIGRATION_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function updateMigrationRecord(dataDir, patch, { fs = fsFacade() } = {}) {
  const current = readMigrationRecord(dataDir, { fs })
  if (current === null) return null
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  atomicWriteJson(join(dataDir, MIGRATION_FILE), next, fs)
  return next
}

function sourceStats(from, fs, warnings) {
  const dbPath = join(from, DB_FILE_NAME)
  const walPath = dbPath + '-wal'
  const shmPath = dbPath + '-shm'
  const walExisted = fs.existsSync(walPath)
  const shmExisted = fs.existsSync(shmPath)
  const stats = {
    dbPath,
    exists: fs.existsSync(dbPath),
    bytes: null,
    walBytes: null,
    sha256: null,
    userVersion: null,
    tables: null,
    integrity: null,
  }
  if (stats.exists) {
    try { stats.bytes = fs.statSync(dbPath).size } catch { /* ignore */ }
    try { stats.walBytes = walExisted ? fs.statSync(walPath).size : 0 } catch { /* ignore */ }
    stats.sha256 = sha256File(dbPath, fs)
    let db
    try {
      db = openDb({ dataDir: from, readonly: true, shared: false, create: false })
      stats.userVersion = dbStats(db).userVersion
      stats.tables = tableCounts(db)
      stats.integrity = integrityCheck(db).ok
      closeDb(db)
      db = undefined
    } catch (error) {
      warnings.push('source-db-readonly: ' + String(error?.code ?? error?.message ?? error))
    } finally {
      if (db !== undefined) { try { closeDb(db) } catch { /* ignore */ } }
      // A read-only connection to a WAL database may create empty -wal/-shm
      // sidecars; remove only the ones we created so dry-run stays zero-write.
      if (!walExisted) { try { fs.rmSync(walPath, { force: true }) } catch { /* ignore */ } }
      if (!shmExisted) { try { fs.rmSync(shmPath, { force: true }) } catch { /* ignore */ } }
    }
  }
  return stats
}

/** Pure plan for `data migrate --dry-run` (no writes anywhere). */
export function planMigration({ from, to, trashDir, now = new Date(), fs = fsFacade() } = {}) {
  const warnings = []
  const source = normalizePath(from)
  const target = normalizePath(to)
  const plan = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    generatedAt: toIso(now),
    mode: 'dry-run',
    dryRun: true,
    from: source,
    to: target,
    trashDir: null,
    blocked: false,
    code: null,
    warnings,
    source: null,
    targetInfo: null,
  }
  if (source === null || target === null) {
    plan.blocked = true
    plan.code = 'INVALID_ARGS'
    warnings.push('from/to 必须是绝对或可解析路径')
    return plan
  }
  if (samePath(source, target)) {
    plan.blocked = true
    plan.code = 'SAME_PATH'
    warnings.push('from 与 to 相同')
    return plan
  }
  if (isInside(source, target)) {
    plan.blocked = true
    plan.code = 'TARGET_INSIDE_SOURCE'
    warnings.push('目标目录不能位于源目录内')
    return plan
  }
  plan.trashDir = normalizePath(trashDir) ?? join(dirname(target), TRASH_DIR_NAME)
  if (!isDirectory(source, fs)) {
    plan.blocked = true
    plan.code = 'SOURCE_MISSING'
    warnings.push('源数据目录不存在：' + source)
    return plan
  }
  plan.source = sourceStats(source, fs, warnings)
  if (!plan.source.exists) {
    plan.blocked = true
    plan.code = 'SOURCE_DB_MISSING'
    warnings.push('源目录缺少 ' + DB_FILE_NAME + '：' + source)
  }
  plan.targetInfo = {
    exists: fs.existsSync(target),
    empty: fs.existsSync(target) ? (isDirectory(target, fs) ? dirIsEmpty(target, fs) : false) : true,
    parentExists: fs.existsSync(dirname(target)),
  }
  if (plan.targetInfo.exists && !plan.targetInfo.empty) {
    plan.blocked = true
    plan.code = 'TARGET_NOT_EMPTY'
    warnings.push('目标目录已存在且非空：' + target)
  }
  return plan
}

function verifyStagedDb(stagingDir, warnings) {
  let db
  const result = { ok: false, userVersion: null, tables: null, integrity: null }
  try {
    db = openDb({ dataDir: stagingDir, shared: false })
    result.userVersion = dbStats(db).userVersion
    result.tables = tableCounts(db)
    result.integrity = integrityCheck(db).ok
    result.ok = result.integrity === true
    if (!result.ok) warnings.push('staging integrity_check 未通过')
  } catch (error) {
    warnings.push('staging-open: ' + String(error?.code ?? error?.message ?? error))
  } finally {
    if (db !== undefined) { try { closeDb(db) } catch { /* ignore */ } }
  }
  return result
}

/**
 * Execute a data-directory migration.
 * @param {{from?: string, to?: string, mode?: 'dry-run'|'apply', trashDir?: string,
 *   moveSourceToTrash?: boolean, now?: Date, fs?: object}} options
 */
export function migrateDataDir({ from, to, mode = 'dry-run', trashDir, moveSourceToTrash = true, now = new Date(), fs = fsFacade() } = {}) {
  const plan = planMigration({ from, to, trashDir, now, fs })
  if (mode !== 'apply') return { ok: !plan.blocked, ...plan }
  if (plan.blocked) return { ok: false, mode: 'apply', dryRun: false, from: plan.from, to: plan.to, code: plan.code, warnings: plan.warnings }
  const warnings = [...plan.warnings]
  const source = plan.from
  const target = plan.to
  const trashRoot = plan.trashDir
  const tmpDir = `${target}.tmp-${process.pid}-${stamp(now)}`
  const manifest = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    from: source,
    to: target,
    trashDir: trashRoot,
    source: plan.source,
    targetInfo: plan.targetInfo,
    startedAt: toIso(now),
  }
  let sourceDb
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    // 1) checkpoint WAL, then VACUUM INTO staging (contract: only VACUUM INTO copy)
    sourceDb = openDb({ dataDir: source, shared: false })
    try { sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch (error) { warnings.push('wal-checkpoint: ' + String(error?.message ?? error)) }
    const stagedDb = join(tmpDir, DB_FILE_NAME)
    const escaped = stagedDb.replace(/'/g, "''")
    sourceDb.exec(`VACUUM INTO '${escaped}';`)
    closeDb(sourceDb)
    sourceDb = undefined
    // 2) verify staged copy
    const verified = verifyStagedDb(tmpDir, warnings)
    if (!verified.ok) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      return { ok: false, mode: 'apply', dryRun: false, from: source, to: target, code: 'STAGING_VERIFY_FAILED', warnings, manifest }
    }
    // 3) copy non-DB side files (state.json etc.)
    for (const entry of listDir(source, fs)) {
      if (isDbFile(entry)) continue
      const fromPath = join(source, entry)
      const toPath = join(tmpDir, entry)
      const stats = fs.statSync(fromPath)
      if (stats.isDirectory()) copyDirRecursive(fromPath, toPath, fs)
      else fs.copyFileSync(fromPath, toPath)
    }
    // 4) staging record + atomic rename
    const stagedRecord = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      state: moveSourceToTrash ? 'applying' : 'applied',
      from: source,
      to: target,
      trashPath: null,
      sourceKept: !moveSourceToTrash,
      createdAt: toIso(now),
      manifest,
    }
    atomicWriteJson(join(tmpDir, MIGRATION_FILE), stagedRecord, fs)
    if (fs.existsSync(target)) {
      if (!isDirectory(target, fs) || !dirIsEmpty(target, fs)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
        return { ok: false, mode: 'apply', dryRun: false, from: source, to: target, code: 'TARGET_NOT_EMPTY', warnings }
      }
      fs.rmSync(target, { recursive: true, force: true })
    }
    movePath(tmpDir, target, fs)
    // 5) move old dir to trash (EPERM degrades to pending, never hard delete)
    let state = 'applied'
    let trashPath = null
    if (moveSourceToTrash) {
      state = 'applied-trash-pending'
      try {
        fs.mkdirSync(trashRoot, { recursive: true })
        const destination = join(trashRoot, basename(source) + '-' + stamp(now))
        movePath(source, destination, fs)
        trashPath = destination
        state = 'applied'
      } catch (error) {
        if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
          warnings.push('source-trash-' + error.code + ': 旧目录暂无法移入 trash（' + source + '），稍后重试 trashSourceDir')
          try {
            fs.mkdirSync(trashRoot, { recursive: true })
            const destination = join(trashRoot, basename(source) + '-' + stamp(now))
            movePath(source, destination, fs)
            trashPath = destination
            state = 'applied'
          } catch (retryError) {
            warnings.push('source-trash-retry-failed: ' + String(retryError?.code ?? retryError?.message ?? retryError))
          }
        } else {
          warnings.push('source-trash-failed: ' + String(error?.code ?? error?.message ?? error))
        }
      }
    }
    const finalRecord = {
      ...stagedRecord,
      state,
      trashPath,
      sourceKept: state !== 'applied',
      completedAt: new Date().toISOString(),
    }
    updateMigrationRecord(target, finalRecord, { fs })
    return { ok: true, mode: 'apply', dryRun: false, state, from: source, to: target, trashPath, sourceKept: state !== 'applied', warnings, manifest: { ...manifest, staged: verified } }
  } catch (error) {
    if (sourceDb !== undefined) { try { closeDb(sourceDb) } catch { /* ignore */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return {
      ok: false, mode: 'apply', dryRun: false, from: source, to: target,
      code: error?.code ?? 'MIGRATION_FAILED',
      message: String(error?.message ?? error),
      warnings, manifest,
    }
  }
}

/** Move a migrated-away source directory into trash (idempotent helper). */
export function trashSourceDir({ from, trashDir, now = new Date(), fs = fsFacade() } = {}) {
  const source = normalizePath(from)
  if (source === null || !isDirectory(source, fs)) return { ok: false, code: 'SOURCE_MISSING', source }
  const root = normalizePath(trashDir) ?? join(dirname(source), TRASH_DIR_NAME)
  try {
    fs.mkdirSync(root, { recursive: true })
    const destination = join(root, basename(source) + '-' + stamp(now))
    movePath(source, destination, fs)
    return { ok: true, source, trashPath: destination }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'TRASH_FAILED', source, message: String(error?.message ?? error) }
  }
}

/**
 * Roll a completed migration back: current dataDir goes to trash, original data
 * is restored from trash (or from the still-present source directory).
 */
export function rollbackMigration({ dataDir, trashDir, now = new Date(), fs = fsFacade() } = {}) {
  const current = normalizePath(dataDir)
  if (current === null) return { ok: false, code: 'INVALID_ARGS', message: 'dataDir is required' }
  const record = readMigrationRecord(current, { fs })
  if (record === null) return { ok: false, code: 'NO_MIGRATION_RECORD', message: 'MIGRATION.json not found in ' + current }
  if (record.state === 'rolled-back') return { ok: false, code: 'ALREADY_ROLLED_BACK', record }
  if (record.state !== 'applied' && record.state !== 'applied-trash-pending' && record.state !== 'applying') {
    return { ok: false, code: 'NOT_ROLLABLE', state: record.state, record }
  }
  const from = normalizePath(record.from)
  if (from === null) return { ok: false, code: 'INVALID_RECORD', message: 'MIGRATION.json missing from', record }
  const root = normalizePath(trashDir) ?? normalizePath(record.trashDir) ?? join(dirname(current), TRASH_DIR_NAME)
  const sourceDir = record.trashPath !== null && record.trashPath !== undefined && fs.existsSync(record.trashPath)
    ? resolve(record.trashPath)
    : (isDirectory(from, fs) && !samePath(from, current) ? from : null)
  if (sourceDir === null) {
    return { ok: false, code: 'SOURCE_FOR_ROLLBACK_MISSING', message: '找不到可回滚的旧目录（trash 与 from 均不存在）', record }
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    const aside = join(root, basename(current) + '-rollback-' + stamp(now))
    movePath(current, aside, fs)
    const targetDir = samePath(from, current) ? current : from
    if (!samePath(sourceDir, targetDir)) movePath(sourceDir, targetDir, fs)
    const rollbackRecord = {
      ...record,
      state: 'rolled-back',
      rolledBackAt: new Date().toISOString(),
      restoredFrom: sourceDir,
      movedTo: aside,
    }
    atomicWriteJson(join(targetDir, MIGRATION_FILE), rollbackRecord, fs)
    let integrity = null
    let db
    try {
      db = openDb({ dataDir: targetDir, readonly: true, shared: false, create: false })
      integrity = integrityCheck(db).ok
      closeDb(db)
      db = undefined
    } catch (error) {
      integrity = null
    } finally {
      if (db !== undefined) { try { closeDb(db) } catch { /* ignore */ } }
    }
    return { ok: true, state: 'rolled-back', restoredFrom: sourceDir, restoredTo: targetDir, movedTo: aside, integrity, record: rollbackRecord }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'ROLLBACK_FAILED', message: String(error?.message ?? error), record }
  }
}

export default {
  MIGRATION_FILE,
  TRASH_DIR_NAME,
  planMigration,
  migrateDataDir,
  rollbackMigration,
  trashSourceDir,
  readMigrationRecord,
  updateMigrationRecord,
}
