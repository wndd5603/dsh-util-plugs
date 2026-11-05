/**
 * dsh-session-network · SQLite registry (P0)
 *
 * Contract: docs/INTERFACES_v1.md §2 (+ DESIGN_v1.md §2 data model).
 * Zero dependencies: node:sqlite (Node >= 24), node:fs/path/crypto only.
 *
 * Design notes / deliberate deviations (reported to lead in the task packet):
 * - `migrations/0001_init` is embedded as `MIGRATIONS` in this file: the write
 *   scope only allows the five listed files, so no `migrations/` directory was
 *   created. `MIGRATIONS[0].name === '0001_init'` keeps the contract name.
 * - The database file is `<dataDir>/network.db` (DESIGN §1).
 * - `heartbeats` follows DESIGN §2 columns `(session_id, bucket, at)`, stored as
 *   one latest row per session (PK session_id); `bucket` is a coarse recency
 *   label computed at write time. This reconciles DESIGN §2 with INTERFACES §2
 *   (`recordHeartbeat(sessionId, at)` / `listStaleSessions(now, bucketMs)`).
 * - Extra (non-breaking) exports: `tx`, `dbStats`, `integrityCheck`,
 *   `tableCounts`, `listMeetings`, `addMeetingParticipant`, `dbPathFor`.
 * - `openDb` accepts optional `{ bus yTimeoutMs, shared, create }` used by the
 *   CLI/tests; contract defaults are unchanged (`readonly=false`, timeout 5000).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const DB_FILE_NAME = 'network.db'
export const SCHEMA_VERSION = 2
export const DEFAULT_BUSY_TIMEOUT_MS = 5000
export const ALIAS_MAX_LENGTH = 16

/** Typed error so callers (CLI/tools) can degrade without parsing messages. */
export class DbError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.cause = options.cause
    this.dbPath = options.dbPath
    this.sqliteCode = options.sqliteCode
  }
}

const SQLITE_CODES = Object.freeze({
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  11: 'SQLITE_CORRUPT',
  14: 'SQLITE_CANTOPEN',
  19: 'SQLITE_CONSTRAINT',
  26: 'SQLITE_NOTADB',
  275: 'SQLITE_CONSTRAINT',
  787: 'SQLITE_CONSTRAINT',
  1299: 'SQLITE_CONSTRAINT',
  1555: 'SQLITE_CONSTRAINT',
  2067: 'SQLITE_CONSTRAINT',
})

function wrapDbError(error, fallback = 'SQLITE_ERROR', extra = {}) {
  if (error instanceof DbError) return error
  const sqliteCode = error?.errcode ?? error?.sqliteCode
  const code = SQLITE_CODES[sqliteCode] ?? fallback
  return new DbError(code, `${code}: ${error?.message ?? String(error)}`, {
    cause: error,
    sqliteCode,
    ...extra,
  })
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** Normalize an `at` timestamp (number ms | Date | ISO string) to integer ms. */
export function toMs(at, fallback = Date.now()) {
  if (typeof at === 'number' && Number.isFinite(at)) return Math.trunc(at)
  if (at instanceof Date && Number.isFinite(at.getTime())) return at.getTime()
  if (typeof at === 'string' && at.trim() !== '') {
    const parsed = Date.parse(at)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function shortIdOf(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

/** Coarse recency bucket used by DESIGN §2 heartbeats / §8 lastSeenBucket. */
export function lastSeenBucketOf(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'unknown'
  const age = Math.max(0, now - at)
  if (age < 5 * 60_000) return '<5m'
  if (age < 60 * 60_000) return '1h'
  if (age < 24 * 60 * 60_000) return '24h'
  return 'older'
}

export function dbPathFor(dataDir) {
  return dataDir === ':memory:' ? ':memory:' : join(String(dataDir), DB_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Schema · migrations/0001_init (10 tables + indexes + append-only audit)
// ---------------------------------------------------------------------------

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: '0001_init',
    sql: `
CREATE TABLE IF NOT EXISTS migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  manifest_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  short_id            TEXT,
  display_name        TEXT,
  role_name           TEXT,
  agent_preset        TEXT,
  workspace_path_hash TEXT,
  first_seen          INTEGER NOT NULL,
  last_seen           INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','idle','inactive','stale','archived')),
  kind                TEXT,
  parent_session_id   TEXT,
  deleted_at          INTEGER,
  briefed_at          INTEGER,
  brief_reason        TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_short     ON sessions(short_id);
CREATE INDEX IF NOT EXISTS ix_sessions_status    ON sessions(status, last_seen);
CREATE INDEX IF NOT EXISTS ix_sessions_briefed   ON sessions(briefed_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_display_name
  ON sessions(display_name) WHERE display_name IS NOT NULL;   -- D22: displayName 全局唯一

CREATE TABLE IF NOT EXISTS aliases (
  alias         TEXT PRIMARY KEY
                CHECK (alias = lower(alias) AND length(alias) BETWEEN 1 AND 16
                       AND alias NOT GLOB '*[^a-z0-9-]*' AND alias GLOB '[a-z]*'),
  session_id    TEXT REFERENCES sessions(session_id) ON UPDATE CASCADE ON DELETE SET NULL,
  root_name     TEXT,
  role_name     TEXT,
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','legacy','retired','reserved')),
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_aliases_session ON aliases(session_id);
CREATE INDEX IF NOT EXISTS ix_aliases_status  ON aliases(status);

CREATE TABLE IF NOT EXISTS heartbeats (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  bucket     TEXT NOT NULL DEFAULT 'unknown'
             CHECK (bucket IN ('<5m','1h','24h','older','unknown')),
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_heartbeats_at ON heartbeats(at);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  title      TEXT,
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','r1','r2','final','cancelled')),
  convener   TEXT,
  created_at INTEGER NOT NULL,
  deadline   INTEGER,
  dir_path   TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_meetings_status ON meetings(status, updated_at);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role       TEXT,
  ack_state  TEXT NOT NULL DEFAULT 'pending'
             CHECK (ack_state IN ('pending','ack','absent','unacked')),
  PRIMARY KEY (meeting_id, session_id)
);
CREATE INDEX IF NOT EXISTS ix_participants_session ON meeting_participants(session_id);

CREATE TABLE IF NOT EXISTS messages (
  meeting_id  TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  msg_id      TEXT NOT NULL,
  from_alias  TEXT,
  to_alias    TEXT,
  at          INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  body_len    INTEGER NOT NULL CHECK (body_len >= 0),
  dedupe_key  TEXT UNIQUE,
  PRIMARY KEY (meeting_id, msg_id)
);
CREATE INDEX IF NOT EXISTS ix_messages_meeting ON messages(meeting_id, at);

CREATE TABLE IF NOT EXISTS agv_asks (
  workspace_hash TEXT PRIMARY KEY,
  asked_at       INTEGER NOT NULL,
  answer         TEXT,
  skipped        INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0,1)),
  auto           INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1))
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  actor     TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  result    TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at    ON audit_log(at);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_log(actor, at);
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
  BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
  BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`,
  }),
  Object.freeze({
    version: 2,
    name: '0002_briefed',
    // R3-new-agent P0: injection idempotency key moves from a session-log marker
    // to durable DB fields. New databases already get the columns from 0001;
    // this migration adds them idempotently to existing databases.
    ensure: db => {
      ensureColumn(db, 'sessions', 'briefed_at', 'INTEGER')
      ensureColumn(db, 'sessions', 'brief_reason', 'TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS ix_sessions_briefed ON sessions(briefed_at);')
    },
  }),
])

/** Add one column to an existing table when it is missing (SQLite has no IF NOT EXISTS for columns). */
function ensureColumn(db, table, column, sqlType) {
  const columns = all(db, `PRAGMA table_info(${table})`).map(row => String(row.name))
  if (columns.includes(column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType};`)
  return true
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

const sharedDbs = new Map()

function connectionKey(dbPath, readonly) {
  return `${readonly ? 'ro' : 'rw'}|${process.platform === 'win32' ? dbPath.toLowerCase() : dbPath}`
}

function applyPragmas(db, { readonly, busyTimeoutMs }) {
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`)
  } catch (error) {
    throw wrapDbError(error, 'SQLITE_PRAGMA')
  }
  if (!readonly) {
    try {
      db.prepare('PRAGMA journal_mode = WAL').get()
      db.exec('PRAGMA synchronous = NORMAL;')
    } catch (error) {
      throw wrapDbError(error, 'SQLITE_PRAGMA')
    }
  }
  try {
    db.exec('PRAGMA foreign_keys = ON;')
  } catch {
    // foreign_keys is best-effort; corruption/incompatibility is reported by integrityCheck
  }
}

/**
 * Open (and by default auto-migrate) the registry database.
 * @param {{dataDir: string, readonly?: boolean, busyTimeoutMs?: number, shared?: boolean, create?: boolean}} options
 * @returns {DatabaseSync}
 */
export function openDb({ dataDir, readonly = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, shared = true, create = true } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new DbError('DB_INVALID_DATA_DIR', 'openDb requires a non-empty dataDir string')
  }
  const dbPath = dbPathFor(dataDir)
  const key = connectionKey(dbPath, readonly)
  if (shared && sharedDbs.has(key)) {
    const existing = sharedDbs.get(key)
    if (existing !== undefined) return existing
  }
  const memory = dbPath === ':memory:'
  if (!memory) {
    if (!existsSync(dbPath)) {
      if (readonly || create === false) {
        throw new DbError('DB_NOT_FOUND', `database not found: ${dbPath}`, { dbPath })
      }
      try {
        mkdirSync(dataDir, { recursive: true })
      } catch (error) {
        throw wrapDbError(error, 'DB_MKDIR_FAILED', { dbPath })
      }
    }
  }
  let db
  try {
    db = new DatabaseSync(dbPath, readonly ? { readOnly: true, timeout: busyTimeoutMs } : { timeout: busyTimeoutMs })
  } catch (error) {
    throw wrapDbError(error, 'DB_OPEN_FAILED', { dbPath })
  }
  try {
    applyPragmas(db, { readonly, busyTimeoutMs })
    if (!readonly) { migrate(db); ensureSessionMetaColumns(db) }
  } catch (error) {
    try { db.close() } catch { /* best effort */ }
    throw wrapDbError(error, 'DB_OPEN_FAILED', { dbPath })
  }
  if (shared && !memory) sharedDbs.set(key, db)
  currentDb = db
  return db
}

function ensureSessionMetaColumns(db) {
  const info = all(db, "PRAGMA table_info(sessions)")
  const names = new Set(info.map(row => row.name))
  if (!names.has('kind')) db.exec('ALTER TABLE sessions ADD COLUMN kind TEXT;')
  if (!names.has('parent_session_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;')
}

export function closeDb(db) {
  if (db === null || db === undefined) return false
  let closed = false
  try {
    db.close()
    closed = true
  } catch {
    closed = false
  }
  for (const [key, value] of sharedDbs) {
    if (value === db) sharedDbs.delete(key)
  }
  return closed
}

/** Run `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back on any throw. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw wrapDbError(error, 'SQLITE_TX_FAILED')
  }
}

// ---------------------------------------------------------------------------
// Statement cache (per connection) + tiny helpers
// ---------------------------------------------------------------------------

const statementCache = new WeakMap()

function statement(db, sql) {
  let cache = statementCache.get(db)
  if (cache === undefined) {
    cache = new Map()
    statementCache.set(db, cache)
  }
  let prepared = cache.get(sql)
  if (prepared === undefined) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

function run(db, sql, params = []) {
  try {
    return statement(db, sql).run(...params)
  } catch (error) {
    throw wrapDbError(error)
  }
}

function get(db, sql, params = []) {
  try {
    return statement(db, sql).get(...params)
  } catch (error) {
    throw wrapDbError(error)
  }
}

function all(db, sql, params = []) {
  try {
    return statement(db, sql).all(...params)
  } catch (error) {
    throw wrapDbError(error)
  }
}

// ---------------------------------------------------------------------------
// Migration runner (idempotent; failures throw DbError('MIGRATION_FAILED'))
// ---------------------------------------------------------------------------

export function migrate(db) {
  let applied = []
  try {
    const hasTable = get(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'")
    if (hasTable === undefined) applied = []
    else applied = all(db, 'SELECT version FROM migrations ORDER BY version').map(row => row.version)
  } catch (error) {
    throw wrapDbError(error, 'MIGRATION_READ_FAILED')
  }
  for (const migration of MIGRATIONS) {
    if (applied.includes(migration.version)) continue
    try {
      tx(db, () => {
        if (typeof migration.sql === 'string') db.exec(migration.sql)
        if (typeof migration.ensure === 'function') migration.ensure(db)
        run(db, 'INSERT INTO migrations (version, applied_at, manifest_json) VALUES (?, ?, ?)', [
          migration.version,
          Date.now(),
          JSON.stringify({
            name: migration.name,
            ...(migration.name === '0001_init'
              ? {
                tables: [
                  'migrations', 'sessions', 'aliases', 'heartbeats', 'meetings',
                  'meeting_participants', 'messages', 'agv_asks', 'settings', 'audit_log',
                ],
                indexes: 17,
              }
              : { columns: ['sessions.briefed_at', 'sessions.brief_reason'] }),
          }),
        ])
      })
    } catch (error) {
      throw wrapDbError(error, 'MIGRATION_FAILED')
    }
    applied.push(migration.version)
  }
  try {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  } catch (error) {
    throw wrapDbError(error, 'MIGRATION_PRAGMA_FAILED')
  }
  return { schemaVersion: SCHEMA_VERSION, applied }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function upsertSession({ sessionId, shortId, displayName, roleName, agentPreset, workspacePathHash, status = 'active', kind = undefined, parentSessionId = undefined, at } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new DbError('SESSION_INVALID', 'upsertSession requires sessionId')
  }
  const db = openSharedRequired()
  const sid = sessionId.trim()
  const now = toMs(at)
  return tx(db, () => {
    run(db, `INSERT INTO sessions
               (session_id, short_id, display_name, role_name, agent_preset, workspace_path_hash, first_seen, last_seen, status, kind, parent_session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               short_id = COALESCE(excluded.short_id, sessions.short_id),
               display_name = COALESCE(excluded.display_name, sessions.display_name),
               role_name = COALESCE(excluded.role_name, sessions.role_name),
               agent_preset = COALESCE(excluded.agent_preset, sessions.agent_preset),
               workspace_path_hash = COALESCE(excluded.workspace_path_hash, sessions.workspace_path_hash),
               last_seen = excluded.last_seen,
               status = excluded.status,
               kind = COALESCE(excluded.kind, sessions.kind),
               parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id)`, [
      sid, shortId ?? shortIdOf(sid), displayName ?? null, roleName ?? null,
      agentPreset ?? null, workspacePathHash ?? null, now, now, status,
      typeof kind === 'string' ? kind : null,
      typeof parentSessionId === 'string' ? parentSessionId : null,
    ])
    return get(db, 'SELECT * FROM sessions WHERE session_id = ?', [sid])
  })
}

export function listSessions() {
  return all(openSharedRequired(), 'SELECT * FROM sessions ORDER BY last_seen DESC')
}

export function getSession(sessionId) {
  return get(openSharedRequired(), 'SELECT * FROM sessions WHERE session_id = ?', [String(sessionId)])
}

/** R3-new-agent P0: durable injection idempotency key (replaces session-log marker). */
export function markBriefed({ sessionId, at, reason = null } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new DbError('SESSION_INVALID', 'markBriefed requires sessionId')
  }
  const db = openSharedRequired()
  const sid = sessionId.trim()
  const now = toMs(at)
  return tx(db, () => {
    const exists = get(db, 'SELECT session_id FROM sessions WHERE session_id = ?', [sid])
    if (exists === undefined) {
      run(db, `INSERT INTO sessions (session_id, short_id, first_seen, last_seen, status) VALUES (?, ?, ?, ?, 'active')`, [
        sid, shortIdOf(sid), now, now,
      ])
    }
    run(db, 'UPDATE sessions SET briefed_at = ?, brief_reason = ? WHERE session_id = ?', [
      now, reason === null || reason === undefined ? null : String(reason), sid,
    ])
    return getSessionBriefInternal(db, sid)
  })
}

function getSessionBriefInternal(db, sessionId) {
  const row = get(db, 'SELECT session_id, briefed_at, brief_reason FROM sessions WHERE session_id = ?', [sessionId])
  if (row === undefined) {
    return { sessionId: String(sessionId), briefed: false, briefedAt: null, briefReason: null }
  }
  return { sessionId: row.session_id, briefed: row.briefed_at !== null, briefedAt: row.briefed_at, briefReason: row.brief_reason }
}

export function isBriefed(sessionId) {
  const row = get(openSharedRequired(), 'SELECT briefed_at FROM sessions WHERE session_id = ?', [String(sessionId)])
  return row !== undefined && row.briefed_at !== null && row.briefed_at !== undefined
}

export function getSessionBrief(sessionId) {
  return getSessionBriefInternal(openSharedRequired(), String(sessionId))
}

export function markSessionStale(sessionId, at) {
  const db = openSharedRequired()
  const now = toMs(at)
  const result = run(db, "UPDATE sessions SET status = 'stale', last_seen = ? WHERE session_id = ?", [now, String(sessionId)])
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Helpers used before module-level connection binding is available.
// All exported query/write functions accept an optional trailing `db` argument
// (non-contract, non-breaking) OR operate on the shared connection opened by
// the current dataDir when one is registered through `openDb`.
// ---------------------------------------------------------------------------

let currentDb

/** Bind the shared connection used by contract-level query helpers. */
export function useDb(db) {
  currentDb = db
  return currentDb
}

function openSharedRequired() {
  if (currentDb === undefined || currentDb === null) {
    throw new DbError('DB_NOT_BOUND', 'no shared db bound; call openDb()/useDb() first')
  }
  return currentDb
}

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIAS_RE = /^[a-z][a-z0-9-]{0,15}$/

export function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new DbError('ALIAS_INVALID', `invalid alias (lowercase kebab, <=${ALIAS_MAX_LENGTH} chars): ${JSON.stringify(alias)}`)
  }
  return alias
}

export function upsertAlias({ alias, sessionId, rootName, roleName, status = 'active', supersededBy, at } = {}) {
  const normalized = validateAlias(typeof alias === 'string' ? alias.trim().toLowerCase() : alias)
  const db = openSharedRequired()
  const now = toMs(at)
  return tx(db, () => {
    run(db, `INSERT INTO aliases (alias, session_id, root_name, role_name, created_at, status, superseded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(alias) DO UPDATE SET
               session_id = excluded.session_id,
               root_name = excluded.root_name,
               role_name = excluded.role_name,
               status = excluded.status,
               superseded_by = excluded.superseded_by`, [
      normalized, sessionId ?? null, rootName ?? null, roleName ?? null, now, status, supersededBy ?? null,
    ])
    return get(db, 'SELECT * FROM aliases WHERE alias = ?', [normalized])
  })
}

export function resolveAlias(alias) {
  if (typeof alias !== 'string') return undefined
  return get(openSharedRequired(), 'SELECT * FROM aliases WHERE alias = ?', [alias.trim().toLowerCase()])
}

export function listAliases() {
  return all(openSharedRequired(), 'SELECT * FROM aliases ORDER BY created_at DESC')
}

export function listAliasesForSession(sessionId) {
  return all(openSharedRequired(), 'SELECT * FROM aliases WHERE session_id = ? ORDER BY created_at ASC, alias ASC', [String(sessionId)])
}

/**
 * Remove one alias owned by the given session (host-native directory remove).
 * Returns true only when an alias row was deleted; a foreign/missing alias is
 * left untouched (least privilege, no hijack).
 */
export function removeAlias({ alias, sessionId } = {}) {
  const normalized = validateAlias(typeof alias === 'string' ? alias.trim().toLowerCase() : alias)
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return false
  const db = openSharedRequired()
  const result = run(db, 'DELETE FROM aliases WHERE alias = ? AND session_id = ?', [normalized, sid])
  return Number(result.changes ?? 0) > 0
}

/**
 * Guarded alias registration for the `alias_register` tool (F22):
 * - idempotent when the same alias is already active for this session;
 * - rename limit `maxRenames` (default 2 => the 3rd rename is rejected);
 * - previous active alias becomes `legacy` with `superseded_by` (still resolvable >=72h);
 * - alias is globally unique: taking another session's alias is `ALIAS_TAKEN`;
 * - `dryRun` computes the same preview without any DB write;
 * - one transaction writes the alias change + append-only audit row.
 * @returns {{ok: true, alias: string, sessionId: string, changed: boolean, renameCount: number, history: Array, wouldWrite: boolean, supersedes?: string}}
 */
export function registerAliasGuarded({
  alias,
  sessionId,
  rootName = null,
  roleName = null,
  displayName = null,
  supersedes = null,
  maxRenames = 2,
  dryRun = false,
  at,
} = {}) {
  const normalized = validateAlias(typeof alias === 'string' ? alias.trim().toLowerCase() : alias)
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') throw new DbError('SESSION_NOT_FOUND', 'registerAliasGuarded requires sessionId')
  const db = openSharedRequired()
  const now = toMs(at)
  const supersedesValue = typeof supersedes === 'string' && supersedes.trim() !== '' ? supersedes.trim().toLowerCase() : null
  const limit = Math.max(0, Math.trunc(maxRenames))

  const inspect = () => {
    const session = get(db, 'SELECT session_id FROM sessions WHERE session_id = ?', [sid])
    if (session === undefined) throw new DbError('SESSION_NOT_FOUND', `session not found: ${sid}`)
    const existing = get(db, 'SELECT * FROM aliases WHERE alias = ?', [normalized])
    if (existing !== undefined && existing.session_id !== sid) {
      throw new DbError('ALIAS_TAKEN', `alias already bound to another session: ${normalized}`)
    }
    const rows = all(db, 'SELECT * FROM aliases WHERE session_id = ? ORDER BY created_at ASC, alias ASC', [sid])
    const history = rows.map(row => ({
      alias: row.alias,
      status: row.status,
      createdAt: row.created_at,
      supersededBy: row.superseded_by,
    }))
    const activeRow = rows.find(row => row.status === 'active') ?? null
    const changed = activeRow?.alias !== normalized
    const currentRenames = Math.max(0, rows.length - 1)
    if (!changed) {
      return { changed: false, currentRenames, history, activeRow, supersededAlias: null, renameCount: currentRenames }
    }
    let supersededAlias = activeRow?.alias ?? null
    if (supersedesValue !== null) {
      const supersededRow = get(db, 'SELECT * FROM aliases WHERE alias = ?', [supersedesValue])
      if (supersededRow === undefined || supersededRow.session_id !== sid) {
        throw new DbError('SUPERSEDES_NOT_FOUND', `supersedes alias not found for session: ${supersedesValue}`)
      }
      supersededAlias = supersedesValue
    }
    const isRename = activeRow !== null || supersedesValue !== null
    if (isRename && currentRenames >= limit) {
      throw new DbError('RENAME_LIMIT', `rename limit reached for session ${sid} (max ${maxRenames} renames)`)
    }
    return {
      changed: true,
      currentRenames,
      history,
      activeRow,
      supersededAlias,
      renameCount: isRename ? currentRenames + 1 : currentRenames,
    }
  }

  const preview = () => {
    const state = inspect()
    return {
      ok: true,
      alias: normalized,
      sessionId: sid,
      changed: state.changed,
      renameCount: state.renameCount,
      history: state.history,
      wouldWrite: dryRun !== true && state.changed,
      ...(state.changed && state.supersededAlias !== null ? { supersedes: state.supersededAlias } : {}),
    }
  }

  if (dryRun === true) return preview()

  const write = () => {
    const state = inspect()
    const result = {
      ok: true,
      alias: normalized,
      sessionId: sid,
      changed: state.changed,
      renameCount: state.renameCount,
      history: state.history,
      wouldWrite: false,
      ...(state.changed && state.supersededAlias !== null ? { supersedes: state.supersededAlias } : {}),
    }
    if (!state.changed) return result
    const meta = {
      alias: normalized,
      changed: true,
      renameCount: state.renameCount,
      supersedes: state.supersededAlias,
      hasRoot: rootName !== null,
      hasRole: roleName !== null,
    }
    assertAuditMetaSafe(meta)
    if (state.supersededAlias !== null) {
      run(db, "UPDATE aliases SET status = 'legacy', superseded_by = ? WHERE alias = ? AND session_id = ?", [normalized, state.supersededAlias, sid])
    }
    run(db, `INSERT INTO aliases (alias, session_id, root_name, role_name, created_at, status, superseded_by)
             VALUES (?, ?, ?, ?, ?, 'active', NULL)
             ON CONFLICT(alias) DO UPDATE SET
               session_id = excluded.session_id,
               root_name = excluded.root_name,
               role_name = excluded.role_name,
               status = 'active',
               superseded_by = NULL`, [normalized, sid, rootName, roleName, now])
    const actorValue = normalizeAuditActor({ sessionId: sid, displayName, roleName })
    run(db, 'INSERT INTO audit_log (at, actor, action, target, result, meta_json) VALUES (?, ?, ?, ?, ?, ?)', [
      now, actorValue, 'alias_register', normalized, 'ok', JSON.stringify(meta),
    ])
    const freshRows = all(db, 'SELECT * FROM aliases WHERE session_id = ? ORDER BY created_at ASC, alias ASC', [sid])
    result.history = freshRows.map(row => ({ alias: row.alias, status: row.status, createdAt: row.created_at, supersededBy: row.superseded_by }))
    return result
  }

  try {
    return tx(db, write)
  } catch (error) {
    const wrapped = wrapDbError(error, 'ALIAS_ERROR')
    if (wrapped.code === 'SQLITE_CONSTRAINT') {
      throw new DbError('ALIAS_TAKEN', `alias became unavailable during registration: ${normalized}`, { cause: error })
    }
    throw wrapped
  }
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

export function recordHeartbeat(sessionId, at) {
  const db = openSharedRequired()
  const ts = toMs(at)
  const bucket = lastSeenBucketOf(ts, Date.now())
  return tx(db, () => {
    run(db, `INSERT INTO heartbeats (session_id, bucket, at) VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET bucket = excluded.bucket, at = excluded.at`, [String(sessionId), bucket, ts])
    run(db, 'UPDATE sessions SET last_seen = ? WHERE session_id = ?', [ts, String(sessionId)])
    return { sessionId: String(sessionId), bucket, at: ts }
  })
}

const HEARTBEAT_STATUSES = new Set(['active', 'idle', 'inactive', 'stale', 'archived'])

/**
 * One-row heartbeat upsert for `agent/pre-step` (game ACCEPT-02 P1-4).
 * `heartbeats` has a FK to `sessions`, so an unregistered session is first added
 * as a minimal row; repeated calls update the same row (`session_id` is PK)
 * instead of appending history. Status is advisory and enum-checked.
 * @param {{sessionId: string, at?: number|Date|string, status?: string}} input
 * @returns {{sessionId: string, bucket: string, at: number, status?: string}}
 */
export function upsertHeartbeat({ sessionId, at, status = undefined } = {}) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') throw new DbError('HEARTBEAT_INVALID', 'upsertHeartbeat requires sessionId')
  const now = toMs(at)
  const explicitStatus = typeof status === 'string' && HEARTBEAT_STATUSES.has(status.trim()) ? status.trim() : undefined
  const db = openSharedRequired()
  const existing = get(db, 'SELECT session_id FROM sessions WHERE session_id = ?', [sid])
  if (existing === undefined) {
    upsertSession({ sessionId: sid, status: explicitStatus ?? 'active', at: now })
  }
  const row = recordHeartbeat(sid, now)
  if (explicitStatus !== undefined) {
    try {
      run(openSharedRequired(), 'UPDATE sessions SET status = ? WHERE session_id = ?', [explicitStatus, sid])
    } catch { /* status is advisory */ }
    return { ...row, status: explicitStatus }
  }
  return row
}

export function listStaleSessions(now = Date.now(), bucketMs = 60 * 60_000) {
  const db = openSharedRequired()
  const threshold = toMs(now) - Math.max(0, Number(bucketMs) || 0)
  const rows = all(db, `SELECT s.*, h.at AS heartbeat_at
                        FROM sessions s LEFT JOIN heartbeats h ON h.session_id = s.session_id
                        WHERE COALESCE(h.at, s.last_seen) < ?
                          AND s.status NOT IN ('archived','stale')
                        ORDER BY COALESCE(h.at, s.last_seen) ASC`, [threshold])
  return rows.map(row => ({ ...row, staleForMs: toMs(now) - (row.heartbeat_at ?? row.last_seen) }))
}

// ---------------------------------------------------------------------------
// AGENTS.md ask state
// ---------------------------------------------------------------------------

export function recordAgvAsk({ workspaceHash, answer = null, skipped = false, auto = false, at } = {}) {
  if (typeof workspaceHash !== 'string' || workspaceHash.trim() === '') {
    throw new DbError('AGV_INVALID', 'recordAgvAsk requires workspaceHash')
  }
  const db = openSharedRequired()
  const now = toMs(at)
  return tx(db, () => {
    run(db, `INSERT INTO agv_asks (workspace_hash, asked_at, answer, skipped, auto) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace_hash) DO UPDATE SET
               asked_at = excluded.asked_at, answer = excluded.answer,
               skipped = excluded.skipped, auto = excluded.auto`, [
      workspaceHash.trim(), now, answer === null || answer === undefined ? null : String(answer),
      skipped ? 1 : 0, auto ? 1 : 0,
    ])
    return get(db, 'SELECT * FROM agv_asks WHERE workspace_hash = ?', [workspaceHash.trim()])
  })
}

export function getAgvAsk(workspaceHash) {
  return get(openSharedRequired(), 'SELECT * FROM agv_asks WHERE workspace_hash = ?', [String(workspaceHash)])
}

/**
 * R3-new-agent P0: one-shot claim for the AGENTS.md question.
 * Concurrent sub-sessions/forks call this first; only the winner (changes>0)
 * may ask/create. Losers must treat it as already asked (fail-open).
 * @returns {boolean} true when this caller won the claim.
 */
export function claimAgvAsk(workspaceHash, at = Date.now()) {
  if (typeof workspaceHash !== 'string' || workspaceHash.trim() === '') {
    throw new DbError('AGV_INVALID', 'claimAgvAsk requires workspaceHash')
  }
  const db = openSharedRequired()
  const info = run(db, `INSERT INTO agv_asks (workspace_hash, asked_at, answer, skipped, auto)
                        VALUES (?, ?, NULL, 0, 0)
                        ON CONFLICT(workspace_hash) DO NOTHING`, [workspaceHash.trim(), toMs(at)])
  return info.changes > 0
}

// ---------------------------------------------------------------------------
// Audit (append-only; enforced by triggers)
// Fixed actor shape (R3-game M2): { sessionId, displayName, roleName? }; alias is not an audit anchor.
// meta must not contain bodies or PII (keys are validated; callers normalized).
// ---------------------------------------------------------------------------

const FORBIDDEN_META_KEYS = new Set([
  'body', 'content', 'text', 'message', 'messages', 'cwd', 'title', 'subject',
  'email', 'phone', 'author', 'username', 'realname', 'name', 'address', 'idcard', 'token', 'secret',
])

function normalizeAuditActor(actor) {
  if (actor === null || actor === undefined) return null
  if (typeof actor === 'object' && !Array.isArray(actor)) {
    return JSON.stringify({
      sessionId: typeof actor.sessionId === 'string' ? actor.sessionId : null,
      displayName: typeof actor.displayName === 'string' ? actor.displayName : null,
      roleName: typeof actor.roleName === 'string' ? actor.roleName : null,
    })
  }
  return String(actor)
}

function parseAuditActor(value) {
  if (typeof value !== 'string') return value
  if (!value.startsWith('{')) return value
  try {
    const parsed = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && ('sessionId' in parsed || 'displayName' in parsed || 'roleName' in parsed)) {
      return { sessionId: parsed.sessionId ?? null, displayName: parsed.displayName ?? null, roleName: parsed.roleName ?? null }
    }
  } catch { /* keep raw */ }
  return value
}

function assertAuditMetaSafe(meta) {
  if (meta === null || meta === undefined || typeof meta !== 'object') return
  const walk = (value, path) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return }
    if (value === null || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_META_KEYS.has(String(key).toLowerCase())) {
        throw new DbError('AUDIT_META_FORBIDDEN', `audit meta must not contain body/PII key: ${path}${key}`)
      }
      walk(nested, `${path}${key}.`)
    }
  }
  walk(meta, '')
}

export function insertAudit({ at, actor = null, action, target = null, result = 'ok', meta = null } = {}) {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new DbError('AUDIT_INVALID', 'insertAudit requires action')
  }
  assertAuditMetaSafe(meta)
  const actorValue = normalizeAuditActor(actor)
  const metaJson = meta === null || meta === undefined ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta))
  const db = openSharedRequired()
  const info = run(db, 'INSERT INTO audit_log (at, actor, action, target, result, meta_json) VALUES (?, ?, ?, ?, ?, ?)', [
    toMs(at), actorValue, action.trim(), target === null ? null : String(target), String(result), metaJson,
  ])
  return { id: Number(info.lastInsertRowid), at: toMs(at), actor: parseAuditActor(actorValue), action, target, result }
}

export function queryAudit({ limit = 100, actor, action, since } = {}) {
  const db = openSharedRequired()
  const clauses = []
  const params = []
  if (actor !== undefined) { clauses.push('actor LIKE ?'); params.push(`%${String(actor)}%`) }
  if (action !== undefined) { clauses.push('action = ?'); params.push(String(action)) }
  if (since !== undefined) { clauses.push('at >= ?'); params.push(toMs(since)) }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = all(db, `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`, [...params, Math.max(1, Math.trunc(limit))])
  return rows.map(row => ({
    ...row,
    actor: parseAuditActor(row.actor),
    meta: row.meta_json === null ? null : safeJsonParse(row.meta_json),
  }))
}

function safeJsonParse(text) {
  try { return JSON.parse(text) } catch { return text }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function setSetting(key, valueJson) {
  if (typeof key !== 'string' || key.trim() === '') throw new DbError('SETTING_INVALID', 'setSetting requires key')
  const raw = typeof valueJson === 'string' ? valueJson : JSON.stringify(valueJson)
  const db = openSharedRequired()
  return tx(db, () => {
    run(db, `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [key.trim(), raw, Date.now()])
    return get(db, 'SELECT * FROM settings WHERE key = ?', [key.trim()])
  })
}

export function getSetting(key) {
  const row = get(openSharedRequired(), 'SELECT * FROM settings WHERE key = ?', [String(key)])
  if (row === undefined) return undefined
  return { ...row, value: safeJsonParse(row.value_json) }
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

const MEETING_STATUSES = new Set(['open', 'r1', 'r2', 'final', 'cancelled'])

export function createMeeting({ meetingId, title = null, convener = null, dirPath = null, deadline = null, at } = {}) {
  if (typeof meetingId !== 'string' || meetingId.trim() === '') {
    throw new DbError('MEETING_INVALID', 'createMeeting requires meetingId')
  }
  const db = openSharedRequired()
  const now = toMs(at)
  return tx(db, () => {
    const existing = get(db, 'SELECT * FROM meetings WHERE meeting_id = ?', [meetingId.trim()])
    if (existing !== undefined) throw new DbError('MEETING_EXISTS', `meeting already exists: ${meetingId}`)
    run(db, `INSERT INTO meetings (meeting_id, title, status, convener, created_at, deadline, dir_path, updated_at)
             VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`, [
      meetingId.trim(), title === null ? null : String(title), convener === null ? null : String(convener),
      now, deadline === null ? null : toMs(deadline), dirPath === null ? null : String(dirPath), now,
    ])
    return get(db, 'SELECT * FROM meetings WHERE meeting_id = ?', [meetingId.trim()])
  })
}

export function setMeetingStatus(meetingId, status) {
  if (!MEETING_STATUSES.has(status)) throw new DbError('MEETING_INVALID', `invalid meeting status: ${status}`)
  const db = openSharedRequired()
  const result = run(db, 'UPDATE meetings SET status = ?, updated_at = ? WHERE meeting_id = ?', [status, Date.now(), String(meetingId)])
  return result.changes > 0
}

export function addMeetingParticipant({ meetingId, sessionId, role = null, ackState = 'pending' } = {}) {
  const db = openSharedRequired()
  return tx(db, () => {
    run(db, `INSERT INTO meeting_participants (meeting_id, session_id, role, ack_state) VALUES (?, ?, ?, ?)
             ON CONFLICT(meeting_id, session_id) DO UPDATE SET role = excluded.role, ack_state = excluded.ack_state`, [
      String(meetingId), String(sessionId), role === null ? null : String(role), ackState,
    ])
    return get(db, 'SELECT * FROM meeting_participants WHERE meeting_id = ? AND session_id = ?', [String(meetingId), String(sessionId)])
  })
}

export function addMeetingMessage({ meetingId, msgId, fromAlias = null, toAlias = null, at, bodySha256, bodyLen, dedupeKey = null } = {}) {
  if (typeof meetingId !== 'string' || typeof msgId !== 'string') {
    throw new DbError('MESSAGE_INVALID', 'addMeetingMessage requires meetingId and msgId')
  }
  if (typeof bodySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(bodySha256)) {
    throw new DbError('MESSAGE_INVALID', 'bodySha256 must be a 64-char hex digest')
  }
  const len = Number(bodyLen)
  if (!Number.isFinite(len) || len < 0) throw new DbError('MESSAGE_INVALID', 'bodyLen must be a non-negative number')
  const db = openSharedRequired()
  const now = toMs(at)
  return tx(db, () => {
    if (dedupeKey !== null && dedupeKey !== undefined) {
      const duplicate = get(db, 'SELECT meeting_id, msg_id FROM messages WHERE dedupe_key = ?', [String(dedupeKey)])
      if (duplicate !== undefined) return { inserted: false, deduped: true, msgId: duplicate.msg_id, meetingId: duplicate.meeting_id }
    }
    const existing = get(db, 'SELECT * FROM messages WHERE meeting_id = ? AND msg_id = ?', [meetingId, msgId])
    if (existing !== undefined) return { inserted: false, deduped: false, msgId, meetingId }
    try {
      run(db, `INSERT INTO messages (meeting_id, msg_id, from_alias, to_alias, at, body_sha256, body_len, dedupe_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        meetingId, msgId, fromAlias, toAlias, now, String(bodySha256).toLowerCase(), Math.trunc(len),
        dedupeKey === null || dedupeKey === undefined ? null : String(dedupeKey),
      ])
    } catch (error) {
      const wrapped = wrapDbError(error, 'MESSAGE_INSERT_FAILED')
      if (wrapped.code === 'SQLITE_CONSTRAINT' && dedupeKey !== null && dedupeKey !== undefined) {
        const duplicate = get(db, 'SELECT meeting_id, msg_id FROM messages WHERE dedupe_key = ?', [String(dedupeKey)])
        if (duplicate !== undefined) return { inserted: false, deduped: true, msgId: duplicate.msg_id, meetingId: duplicate.meeting_id }
      }
      throw wrapped
    }
    return { inserted: true, deduped: false, msgId, meetingId }
  })
}

export function listMeetingMessages(meetingId) {
  return all(openSharedRequired(), 'SELECT * FROM messages WHERE meeting_id = ? ORDER BY at ASC, msg_id ASC', [String(meetingId)])
}

export function listMeetings() {
  const db = openSharedRequired()
  return all(db, `SELECT m.*, (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id = m.meeting_id) AS participants
                  FROM meetings m ORDER BY m.created_at DESC`)
}

// ---------------------------------------------------------------------------
// Diagnostics (CLI / doctor)
// ---------------------------------------------------------------------------

export function tableCounts(db) {
  const tables = ['sessions', 'aliases', 'heartbeats', 'meetings', 'meeting_participants', 'messages', 'agv_asks', 'settings', 'migrations', 'audit_log']
  const counts = {}
  for (const table of tables) {
    try {
      counts[table] = Number(get(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0)
    } catch {
      counts[table] = null
    }
  }
  return counts
}

export function integrityCheck(db) {
  try {
    const rows = all(db, 'PRAGMA quick_check')
    const messages = rows.map(row => String(Object.values(row)[0] ?? ''))
    const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok'
    return { ok, results: messages }
  } catch (error) {
    return { ok: false, results: [], error: wrapDbError(error, 'SQLITE_INTEGRITY').message }
  }
}

export function dbStats(db, { dataDir } = {}) {
  const path = dbPathFor(dataDir ?? ':memory:')
  const stats = {
    path,
    readonly: false,
    userVersion: null,
    journalMode: null,
    busTimeoutMs: null,
    bytes: null,
    walBytes: null,
    tables: {},
    integrity: null,
  }
  try { stats.userVersion = Number(get(db, 'PRAGMA user_version')?.user_version ?? 0) } catch { /* ignore */ }
  try { stats.journalMode = get(db, 'PRAGMA journal_mode')?.journal_mode ?? null } catch { /* ignore */ }
  try { stats.busTimeoutMs = Number(get(db, 'PRAGMA busy_timeout')?.timeout ?? 0) } catch { /* ignore */ }
  try { stats.tables = tableCounts(db) } catch { /* ignore */ }
  try { stats.integrity = integrityCheck(db).ok } catch { /* ignore */ }
  if (path !== ':memory:') {
    try { stats.bytes = statSync(path).size } catch { stats.bytes = null }
    try { stats.walBytes = existsSync(path + '-wal') ? statSync(path + '-wal').size : 0 } catch { stats.walBytes = null }
  }
  return stats
}
