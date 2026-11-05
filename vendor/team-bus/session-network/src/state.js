/**
 * Runtime state for dsh-session-network: `<dataDir>/state.json`.
 *
 * Contract: INTERFACES_v1 §1 (state shape) and §3 (this module). The switch is
 * runtime state, not plugin config, so it can be flipped without a host restart
 * or HMR reconcile. Every read is fail-safe and never throws:
 *   - missing file  -> `{ schemaVersion: 1, autoInject: { enabled: false }, lastError }`
 *   - corrupt read  -> the same fail-safe "closed" state plus `lastError`
 * Writes are atomic (unique tmp file in the same directory + rename) and use
 * mode 0o600 (best-effort on Windows, which only models the read-only bit).
 *
 * @module @local/dsh-session-network/state
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const STATE_FILE_NAME = 'state.json'
export const STATE_SCHEMA_VERSION = 1
export const STATE_FILE_MODE = 0o600

/** Cache entries are valid for this long when the on-disk fingerprint is unchanged. */
export const STATE_CACHE_TTL_MS = 1000

/** @typedef {{ schemaVersion: number, autoInject: { enabled: boolean }, updatedAt: string | null, lastError: string | null }} NetworkState */

/** Resolved path -> cached, validated state. */
const readCache = new Map()

/** True when `value` is a plain non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Build the fail-safe state returned for missing/corrupt/invalid input. */
function failSafeState(lastError) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    autoInject: { enabled: false },
    updatedAt: null,
    lastError: lastError === null ? null : String(lastError),
  }
}

/** Deep-clone a state value so callers cannot mutate the cache. */
function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    autoInject: { enabled: state.autoInject.enabled },
    updatedAt: state.updatedAt,
    lastError: state.lastError,
  }
}

/**
 * Validate a persisted state document and normalize it to the v1 shape.
 * Validation is strict on the fields this module owns: a boolean switch.
 * @param {unknown} parsed - result of JSON.parse.
 * @returns {NetworkState} normalized state; throws when the document is invalid.
 */
function normalizeState(parsed) {
  if (!isPlainObject(parsed)) throw new TypeError('state document must be an object')
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported state schemaVersion: ${String(parsed.schemaVersion)}`)
  }
  const autoInject = parsed.autoInject
  if (!isPlainObject(autoInject) || typeof autoInject.enabled !== 'boolean') {
    throw new TypeError('state.autoInject.enabled must be a boolean')
  }
  const updatedAt = parsed.updatedAt === undefined || parsed.updatedAt === null
    ? null
    : typeof parsed.updatedAt === 'string' ? parsed.updatedAt : (() => { throw new TypeError('state.updatedAt must be a string or null') })()
  const lastError = parsed.lastError === undefined || parsed.lastError === null
    ? null
    : typeof parsed.lastError === 'string' ? parsed.lastError : (() => { throw new TypeError('state.lastError must be a string or null') })()
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    autoInject: { enabled: autoInject.enabled },
    updatedAt,
    lastError,
  }
}

/** Require a usable dataDir for paths; throws a clear TypeError otherwise. */
function assertDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('dsh-session-network state: dataDir must be a non-empty string')
  }
  return resolve(dataDir.trim())
}

/**
 * Absolute state file path for a data directory.
 * @param {string} dataDir - plugin data directory (created on write).
 * @returns {string} absolute `<dataDir>/state.json`.
 */
export function statePath(dataDir) {
  return join(assertDataDir(dataDir), STATE_FILE_NAME)
}

/** Remove every cached read; used by tests and by writers that must force a re-read. */
export function clearStateCache() {
  readCache.clear()
}

/** Cache one validated state for the current on-disk fingerprint. */
function remember(file, state) {
  try {
    const stat = statSync(file)
    readCache.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readAt: Date.now(),
      state: cloneState(state),
    })
  } catch {
    readCache.delete(file)
  }
}

/**
 * Read the runtime state. Never throws; missing, unreadable, or malformed state
 * yields the fail-safe disabled state with a `lastError` string.
 * A same-fingerprint read is served from a <=1s mtime cache.
 * @param {string} dataDir - plugin data directory.
 * @returns {NetworkState} cloned state (safe to mutate by callers).
 */
export function readState(dataDir) {
  let file
  try {
    file = statePath(dataDir)
  } catch (error) {
    return failSafeState(`invalid dataDir: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const stat = statSync(file)
    const cached = readCache.get(file)
    const now = Date.now()
    if (cached !== undefined
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && now - cached.readAt <= STATE_CACHE_TTL_MS) {
      return cloneState(cached.state)
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const state = normalizeState(parsed)
    remember(file, state)
    return cloneState(state)
  } catch (error) {
    readCache.delete(file)
    if (isAbsent(error)) return failSafeState(`state file missing: ${file}`)
    return failSafeState(`state unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** True for ENOENT / ENOTDIR style absence. */
function isAbsent(error) {
  return error !== null && typeof error === 'object'
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Atomically persist the runtime state. The current readable state is used as
 * the base; `patch.autoInject.enabled` and `patch.lastError` are the supported
 * fields. Creates the data directory when missing.
 * @param {string} dataDir - plugin data directory.
 * @param {{ autoInject?: { enabled?: boolean }, lastError?: string | null }} [patch]
 * @returns {NetworkState} the persisted, normalized state.
 * @throws {TypeError} invalid dataDir, patch, or enabled value.
 */
export function writeState(dataDir, patch = {}) {
  const file = statePath(dataDir)
  if (!isPlainObject(patch)) throw new TypeError('dsh-session-network state: patch must be an object')
  const patchEnabled = isPlainObject(patch.autoInject) ? patch.autoInject.enabled : undefined
  if (patchEnabled !== undefined && typeof patchEnabled !== 'boolean') {
    throw new TypeError('dsh-session-network state: autoInject.enabled must be a boolean')
  }
  if (patch.lastError !== undefined && patch.lastError !== null && typeof patch.lastError !== 'string') {
    throw new TypeError('dsh-session-network state: lastError must be a string or null')
  }

  const current = readState(dataDir)
  const next = {
    schemaVersion: STATE_SCHEMA_VERSION,
    autoInject: { enabled: patchEnabled === undefined ? current.autoInject.enabled : patchEnabled },
    updatedAt: new Date().toISOString(),
    lastError: patch.lastError === undefined ? null : patch.lastError,
  }

  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  let fd
  try {
    fd = openSync(tmp, 'wx', STATE_FILE_MODE)
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`, null, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, file)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw error
  }
  // Directory fsync is best-effort: Windows cannot open directories for fsync.
  try {
    const dirFd = openSync(dirname(file), 'r')
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } catch { /* not supported on every platform */ }

  remember(file, next)
  return cloneState(next)
}

/**
 * Set the runtime `autoInject.enabled` switch atomically.
 * @param {string} dataDir - plugin data directory.
 * @param {boolean} enabled - new switch value.
 * @returns {NetworkState} the persisted state.
 */
export function setAutoInject(dataDir, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('dsh-session-network state: enabled must be a boolean')
  }
  return writeState(dataDir, { autoInject: { enabled } })
}

/**
 * Read the runtime switch. Missing/corrupt state is fail-safe disabled.
 * @param {string} dataDir - plugin data directory.
 * @returns {boolean} whether first-turn injection is enabled.
 */
export function isAutoInjectEnabled(dataDir) {
  return readState(dataDir).autoInject.enabled === true
}

/** Internal cleanup helper used by tests to remove leftover cache entries. */
export function _forgetStateCacheForTests(dataDir) {
  try {
    readCache.delete(statePath(dataDir))
  } catch { /* ignore */ }
}
