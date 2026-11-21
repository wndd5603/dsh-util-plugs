// SQLite-backed message store for the universal DSH session message bus.
// No npm dependencies: node:sqlite (Node >= 24) and node:fs only.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  from_session  TEXT,
  from_alias    TEXT,
  from_display  TEXT,
  to_session    TEXT NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  dedupe_key    TEXT,
  nonce         TEXT,
  forced        INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  test          INTEGER NOT NULL DEFAULT 0,
  project_scope TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to_at ON messages(to_session, at);
CREATE INDEX IF NOT EXISTS idx_messages_sha ON messages(to_session, sha256, at);
CREATE INDEX IF NOT EXISTS idx_messages_key ON messages(to_session, dedupe_key, at);

CREATE TABLE IF NOT EXISTS deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      TEXT,
  at              TEXT NOT NULL,
  from_session    TEXT,
  from_alias      TEXT,
  from_display    TEXT,
  to_session      TEXT NOT NULL,
  subject         TEXT,
  body_bytes      INTEGER,
  body_sha256     TEXT,
  lightweight     INTEGER NOT NULL DEFAULT 1,
  duplicate       INTEGER NOT NULL DEFAULT 0,
  suppressed      INTEGER NOT NULL DEFAULT 0,
  delivered       INTEGER NOT NULL DEFAULT 0,
  existing_id     TEXT,
  existing_at     TEXT,
  dedupe_key      TEXT,
  dedupe_window_ms INTEGER,
  priority        INTEGER NOT NULL DEFAULT 0,
  forced          INTEGER NOT NULL DEFAULT 0,
  test            INTEGER NOT NULL DEFAULT 0,
  coalesced       INTEGER NOT NULL DEFAULT 0,
  resumed         INTEGER NOT NULL DEFAULT 0,
  caller_alias    TEXT,
  impersonation   INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  -- Q2-A additive delivery contract (NULL on pre-Q2 rows; no backfill/write).
  target_state    TEXT,
  delivery_state  TEXT,
  reason_code     TEXT,
  route_source    TEXT,
  successor_session_id TEXT,
  expires_at      TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_to_at ON deliveries(to_session, at);
CREATE INDEX IF NOT EXISTS idx_deliveries_dup ON deliveries(duplicate, to_session, at);

CREATE TABLE IF NOT EXISTS read_state (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
);

-- One envelope per (target session, message) even across retries: delivered_at
-- is set when the wake envelope is handed to the transport; consumed_at when
-- the target reads/acks the body. A consumed pair is never re-enveloped.
CREATE TABLE IF NOT EXISTS envelope_state (
  to_session  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  delivered_at TEXT,
  consumed_at TEXT,
  PRIMARY KEY (to_session, message_id)
);

CREATE TABLE IF NOT EXISTS routes (
  alias        TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  display_name TEXT,
  updated_at   TEXT NOT NULL
);
`

const nowIso = () => new Date().toISOString()

/**
 * Q2-A read-side compatibility: derive a stable delivery state for rows written
 * before the new columns existed. Never throws, never mutates the DB.
 */
function deriveDeliveryState(row) {
  if (row === undefined || row === null) return null
  if (row.suppressed === 1) return 'suppressed'
  if (row.delivered === 1) return 'delivered'
  if (row.delivery_state === 'expired') return 'expired'
  if (typeof row.delivery_state === 'string' && row.delivery_state !== '') return row.delivery_state
  const error = String(row.error ?? '')
  if (/not found|archived|no-preset|unreadable/iu.test(error)) return 'undeliverable'
  return 'queued'
}

function deriveReasonCode(row) {
  if (row === undefined || row === null) return null
  if (row.suppressed === 1) return 'duplicate-suppressed'
  if (row.delivered === 1) return 'recipient-live'
  if (typeof row.reason_code === 'string' && row.reason_code !== '') return row.reason_code
  const error = String(row.error ?? '')
  if (/not found|SessionPersistenceNotFoundError/iu.test(error)) return 'session-not-found'
  if (/archived/iu.test(error)) return 'recipient-archived'
  if (/no-preset/iu.test(error)) return 'resume-no-preset'
  if (/rate-limited/iu.test(error)) return 'resume-rate-limited'
  if (/autoResume-disabled/iu.test(error)) return 'auto-resume-disabled'
  if (/unreadable/iu.test(error)) return 'session-unreadable'
  return row.delivered === 1 ? 'recipient-live' : 'resume-failed'
}

// Q2-A additive delivery columns. When an old DB refuses ALTER (locked,
// read-only, exotic SQLite build), the store degrades to the legacy delivery
// schema instead of failing to open; reads still classify old rows on the fly.
const Q2_DELIVERY_COLUMNS = [
  ['target_state', 'TEXT'],
  ['delivery_state', 'TEXT'],
  ['reason_code', 'TEXT'],
  ['route_source', 'TEXT'],
  ['successor_session_id', 'TEXT'],
  ['expires_at', 'TEXT'],
  ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_attempt_at', 'TEXT'],
]

/** Public, read-only delivery view shared by message_queue/status/audit. */
export function deliveryView(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id === undefined || row.id === null ? null : String(row.id),
    state: deriveDeliveryState(row),
    targetState: row.target_state ?? null,
    reasonCode: deriveReasonCode(row),
    delivered: row.delivered === 1,
    error: row.error ?? null,
    expiresAt: row.expires_at ?? null,
    attempts: Number(row.attempt_count ?? 0),
    successorSessionId: row.successor_session_id ?? null,
  }
}


export function openMessageStore(dbPath, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // Host DB stays in $DSH_HOME; WAL + NORMAL is the durability/latency default
  // for the ephemeral host transport. checkpoint() is exposed for status/ops.
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
  } catch { /* PRAGMA is best-effort on older SQLite builds */ }
  db.exec(SCHEMA)

  // Q2-A: additive columns for existing DBs. No row/data migration: old rows
  // keep NULL and are classified on read. ALTER TABLE is best-effort: if the DB
  // refuses it (lock, read-only, exotic SQLite) the store degrades to the
  // legacy delivery schema instead of failing to open. Every delivery statement
  // below is selected from the columns that actually exist.
  const columnsOf = (table) => {
    try { return db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name) } catch { return [] }
  }
  const allowAlter = options.alterDeliveryColumns !== false
  const deliveryAlterErrors = []
  for (const [column, definition] of Q2_DELIVERY_COLUMNS) {
    if (columnsOf('deliveries').includes(column)) continue
    if (!allowAlter) {
      deliveryAlterErrors.push({ column, message: 'ALTER skipped (alterDeliveryColumns=false)' })
      continue
    }
    try { db.exec('ALTER TABLE deliveries ADD COLUMN ' + column + ' ' + definition) } catch (error) {
      deliveryAlterErrors.push({ column, message: String(error?.message ?? error) })
    }
  }
  const deliveryColumns = new Set(columnsOf('deliveries'))
  const missingDeliveryColumns = Q2_DELIVERY_COLUMNS.map(([column]) => column).filter(column => !deliveryColumns.has(column))
  const deliverySchemaDegraded = missingDeliveryColumns.length > 0
  const deliverySchema = Object.freeze({
    degraded: deliverySchemaDegraded,
    columns: Object.freeze([...deliveryColumns]),
    missing: Object.freeze(missingDeliveryColumns),
    alterErrors: Object.freeze(deliveryAlterErrors.map(entry => Object.freeze({ ...entry }))),
  })
  if (!deliverySchemaDegraded) {
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_state ON deliveries(delivery_state, expires_at)')
    } catch { /* index is an optimization only */ }
  }

  const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (id, at, from_session, from_alias, from_display, to_session, subject,
      body, bytes, sha256, dedupe_key, nonce, forced, priority, test, project_scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const stmtInsertDelivery = deliverySchemaDegraded
    ? db.prepare(`
      INSERT INTO deliveries (message_id, at, from_session, from_alias, from_display, to_session, subject,
        body_bytes, body_sha256, lightweight, duplicate, suppressed, delivered, existing_id, existing_at,
        dedupe_key, dedupe_window_ms, priority, forced, test, coalesced, resumed, caller_alias, impersonation, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    : db.prepare(`
      INSERT INTO deliveries (message_id, at, from_session, from_alias, from_display, to_session, subject,
        body_bytes, body_sha256, lightweight, duplicate, suppressed, delivered, existing_id, existing_at,
        dedupe_key, dedupe_window_ms, priority, forced, test, coalesced, resumed, caller_alias, impersonation, error,
        target_state, delivery_state, reason_code, route_source, successor_session_id, expires_at, attempt_count, last_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  const insertMessage = (m) => {
    stmtInsertMessage.run(
      m.id, m.at, m.fromSession ?? null, m.fromAlias ?? null, m.fromDisplay ?? null,
      m.toSession, m.subject ?? '', m.body, m.bytes, m.sha256,
      m.dedupeKey ?? null, m.nonce ?? null, m.forced ? 1 : 0, m.priority ? 1 : 0,
      m.test ? 1 : 0, m.projectScope ?? null, nowIso(),
    )
    return m
  }

  const deliveryBaseArgs = (d) => [
    d.messageId ?? null, d.at ?? nowIso(), d.fromSession ?? null, d.fromAlias ?? null, d.fromDisplay ?? null,
    d.toSession, d.subject ?? '', d.bodyBytes ?? null, d.bodySha256 ?? null,
    d.lightweight === false ? 0 : 1, d.duplicate ? 1 : 0, d.suppressed ? 1 : 0, d.delivered ? 1 : 0,
    d.existingId ?? null, d.existingAt ?? null, d.dedupeKey ?? null, d.dedupeWindowMs ?? null,
    d.priority ? 1 : 0, d.forced ? 1 : 0, d.test ? 1 : 0, d.coalesced ? 1 : 0,
    d.resumed ? 1 : 0, d.callerAlias ?? null, d.impersonation ? 1 : 0, d.error ?? null,
  ]

  const insertDelivery = (d) => {
    const args = deliveryBaseArgs(d)
    if (!deliverySchemaDegraded) {
      // Q2-A columns are present; persist the full delivery contract.
      args.push(
        d.targetState ?? null, d.deliveryState ?? null, d.reasonCode ?? null, d.routeSource ?? null,
        d.successorSessionId ?? null, d.expiresAt ?? null,
        Number.isFinite(Number(d.attemptCount)) ? Math.max(0, Math.trunc(Number(d.attemptCount))) : 0,
        d.lastAttemptAt ?? null,
      )
    }
    // Degraded mode writes only legacy columns; deriveDeliveryState classifies
    // the row from delivered/suppressed/error instead of the missing columns.
    stmtInsertDelivery.run(...args)
  }

  const findDuplicate = ({ toSession, fromSession, bodySha256, dedupeKey, windowMs, nowMs = Date.now() }) => {
    if (!(windowMs > 0)) return undefined
    const since = new Date(nowMs - windowMs).toISOString()
    const row = db.prepare(`
      SELECT * FROM messages
      WHERE to_session = ? AND at >= ?
        AND (sha256 = ? OR (? IS NOT NULL AND dedupe_key = ?))
        AND (? IS NULL OR from_session = ?)
      ORDER BY at DESC LIMIT 1
    `).get(toSession, since, bodySha256, dedupeKey ?? null, dedupeKey ?? null, fromSession ?? null, fromSession ?? null)
    return row ?? undefined
  }

  const getMessage = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id)

  /** Shared WHERE builder for list/search/count (task-95 web message center). */
  const messageFilter = ({ toSession, since, readBy, unreadOnly, keyword, undeliveredOnly } = {}) => {
    const clauses = []
    const params = []
    if (toSession) { clauses.push('m.to_session = ?'); params.push(toSession) }
    if (since) { clauses.push('m.at >= ?'); params.push(since) }
    if (readBy) {
      clauses.push('(r.read_at IS NOT NULL OR r.read_at IS NULL)')
    }
    if (unreadOnly && readBy) clauses.push('r.read_at IS NULL')
    // Q2-A: latest delivery is stored/undelivered (queued or undeliverable),
    // never a suppressed duplicate. Excludes delivered messages.
    if (undeliveredOnly) {
      clauses.push(`EXISTS (SELECT 1 FROM deliveries d
        WHERE d.message_id = m.id
          AND d.id = (SELECT MAX(d2.id) FROM deliveries d2 WHERE d2.message_id = m.id)
          AND d.delivered = 0 AND d.suppressed = 0)`)
    }
    const term = typeof keyword === 'string' ? keyword.trim() : ''
    if (term !== '') {
      const like = '%' + term.replace(/[%_]/gu, match => '\\' + match) + '%'
      clauses.push("(m.subject LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\' OR m.from_display LIKE ? ESCAPE '\\' OR m.id LIKE ? ESCAPE '\\')")
      params.push(like, like, like, like)
    }
    return { clauses, params }
  }

  const listMessages = ({ toSession, readBy, unreadOnly, since, keyword, undeliveredOnly, limit = 20, offset = 0 } = {}) => {
    const { clauses, params } = messageFilter({ toSession, since, readBy, unreadOnly, keyword, undeliveredOnly })
    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''
    const sql = `SELECT m.*, ${readBy ? 'r.read_at' : 'NULL'} AS read_at
      FROM messages m
      ${readBy ? 'LEFT JOIN read_state r ON r.message_id = m.id AND r.session_id = ?' : ''}
      ${where}
      ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`
    const bound = readBy ? [readBy, ...params, limit, offset] : [...params, limit, offset]
    return db.prepare(sql).all(...bound)
  }

  /** Total matching rows for one list/search query (pagination). */
  const countMessages = ({ toSession, readBy, unreadOnly, since, keyword, undeliveredOnly } = {}) => {
    const { clauses, params } = messageFilter({ toSession, since, readBy, unreadOnly, keyword, undeliveredOnly })
    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''
    const sql = `SELECT COUNT(*) AS n FROM messages m
      ${readBy ? 'LEFT JOIN read_state r ON r.message_id = m.id AND r.session_id = ?' : ''}
      ${where}`
    const bound = readBy ? [readBy, ...params] : params
    const row = db.prepare(sql).get(...bound)
    return row === undefined || row === null ? 0 : Number(row.n)
  }

  /**
   * Delete one message and its delivery/read-state rows. This is the web UI's
   * single-message delete; operator bulk `purge` above keeps its own semantics.
   * @param {string} id - message id.
   * @returns {boolean} whether a message row was removed.
   */
  const deleteMessage = (id) => {
    if (typeof id !== 'string' || id === '') return false
    const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(id)
    if (existing === undefined || existing === null) return false
    db.prepare('DELETE FROM read_state WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM envelope_state WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM deliveries WHERE message_id = ?').run(id)
    const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  const suppressedFilter = ({ toSession, since } = {}) => {
    const clauses = ['duplicate = 1', 'suppressed = 1']
    const params = []
    if (toSession) { clauses.push('to_session = ?'); params.push(toSession) }
    if (since) { clauses.push('at >= ?'); params.push(since) }
    return { where: clauses.join(' AND '), params }
  }

  const listSuppressed = ({ toSession, since, limit = 20, offset = 0 } = {}) => {
    const { where, params } = suppressedFilter({ toSession, since })
    return db.prepare(`SELECT * FROM deliveries WHERE ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, Math.max(0, Math.trunc(Number(offset) || 0)))
  }

  /** Total matching suppressed/dedupe rows (pagination companion of listSuppressed). */
  const countSuppressed = ({ toSession, since } = {}) => {
    const { where, params } = suppressedFilter({ toSession, since })
    const row = db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE ${where}`).get(...params)
    return row === undefined || row === null ? 0 : Number(row.n)
  }

  /** Latest delivery row per message id (Q2-A queue view; no body selected). */
  const latestDeliveries = (messageIds) => {
    const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter(id => typeof id === 'string' && id !== ''))]
    const map = new Map()
    if (ids.length === 0) return map
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT d.* FROM deliveries d
      WHERE d.id IN (SELECT MAX(d2.id) FROM deliveries d2 WHERE d2.message_id IN (${placeholders}) GROUP BY d2.message_id)`)
      .all(...ids)
    for (const row of rows) map.set(row.message_id, row)
    return map
  }

  /** Undelivered stored messages for one session, oldest first (auto-resume flush). */
  const pendingDeliveries = (toSession, limit = 50) => db.prepare(`
    SELECT d.id AS delivery_id, d.message_id, d.to_session, d.from_session, d.from_display, d.at AS delivery_at,
           m.at AS message_at, m.subject, m.bytes, m.sha256
    FROM deliveries d JOIN messages m ON m.id = d.message_id
    WHERE d.to_session = ? AND d.delivered = 0 AND d.suppressed = 0 AND d.message_id IS NOT NULL
    ORDER BY d.id ASC LIMIT ?`).all(String(toSession), Math.max(1, Math.min(200, Math.trunc(limit))))

  const stmtMarkDeliveryDelivered = deliverySchemaDegraded
    ? db.prepare('UPDATE deliveries SET delivered = 1, error = NULL WHERE id = ?')
    : db.prepare(`UPDATE deliveries SET delivered = 1, error = NULL,
      delivery_state = 'delivered', reason_code = 'recipient-live', expires_at = NULL,
      attempt_count = attempt_count + 1, last_attempt_at = ? WHERE id = ?`)

  const markDeliveryDelivered = (deliveryId) => {
    const result = deliverySchemaDegraded
      ? stmtMarkDeliveryDelivered.run(deliveryId)
      : stmtMarkDeliveryDelivered.run(nowIso(), deliveryId)
    return Number(result.changes ?? 0) > 0
  }

  const markRead = (sessionId, messageId, at = nowIso()) => {
    db.prepare(`INSERT INTO read_state (session_id, message_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id, message_id) DO UPDATE SET read_at = excluded.read_at`)
      .run(sessionId, messageId, at)
    return at
  }

  /** Existing read receipt timestamp for one session/message pair (or null). */
  const getReadAt = (sessionId, messageId) => {
    const row = db.prepare('SELECT read_at FROM read_state WHERE session_id = ? AND message_id = ?')
      .get(sessionId, messageId)
    return row === undefined || row === null ? null : row.read_at
  }

  const upsertRoute = (alias, sessionId, displayName = null) => {
    db.prepare(`INSERT INTO routes (alias, session_id, display_name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET session_id = excluded.session_id,
        display_name = COALESCE(excluded.display_name, routes.display_name), updated_at = excluded.updated_at`)
      .run(alias, sessionId, displayName, nowIso())
  }

  const resolveRoute = (alias) => db.prepare('SELECT * FROM routes WHERE alias = ?').get(alias)

  const listRoutes = () => db.prepare('SELECT * FROM routes ORDER BY alias').all()

  /** Delete old rows in chunks (SQLite has a bound-variable limit). */
  const chunkedDelete = (sqlTemplate, ids) => {
    const chunkSize = 500
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      db.prepare(sqlTemplate.replace('?', placeholders)).run(...chunk)
    }
  }

  /**
   * Operator purge: delete messages (and their deliveries/read state) older than
   * `before` (ISO), or everything when `all` is true.
   * @returns {{messages: number, all: boolean, before: string | null}}
   */
  const purge = ({ before = null, all = false } = {}) => {
    if (all === true) {
      const messages = db.prepare('DELETE FROM messages').run().changes
      db.prepare('DELETE FROM deliveries').run()
      db.prepare('DELETE FROM read_state').run()
      db.prepare('DELETE FROM envelope_state').run()
      return { messages: Number(messages), all: true, before: null }
    }
    if (typeof before !== 'string' || before === '') return { messages: 0, all: false, before: null }
    const ids = db.prepare('SELECT id FROM messages WHERE at < ?').all(before).map(row => row.id)
    if (ids.length === 0) return { messages: 0, all: false, before }
    chunkedDelete('DELETE FROM messages WHERE id IN (?)', ids)
    chunkedDelete('DELETE FROM deliveries WHERE message_id IN (?)', ids)
    chunkedDelete('DELETE FROM read_state WHERE message_id IN (?)', ids)
    chunkedDelete('DELETE FROM envelope_state WHERE message_id IN (?)', ids)
    return { messages: ids.length, all: false, before }
  }

  /**
   * Absence detection: distinct messages that still have a non-suppressed
   * delivery for the target and no read_state row for that same target.
   * A message counts once no matter how many delivery rows it has; a
   * suppressed (dedupe) delivery never counts. Read-only; never throws.
   * @param {string | null} [toSession] - target session; null/undefined = all sessions.
   * @returns {{unread: number, oldestAt: string | null}}
   */
  const unreadSummary = (toSession = null) => {
    const summary = { unread: 0, oldestAt: null }
    try {
      const scoped = typeof toSession === 'string' && toSession.length > 0
      const row = db.prepare(`
        SELECT COUNT(DISTINCT d.to_session || ':' || d.message_id) AS n, MIN(d.at) AS oldest_at
        FROM deliveries d
        WHERE d.suppressed = 0 AND d.message_id IS NOT NULL
          ${scoped ? 'AND d.to_session = ?' : ''}
          AND NOT EXISTS (
            SELECT 1 FROM read_state r
            WHERE r.session_id = d.to_session AND r.message_id = d.message_id
          )`).get(...(scoped ? [toSession] : []))
      summary.unread = row === undefined || row === null ? 0 : Number(row.n)
      summary.oldestAt = row?.oldest_at ?? null
    } catch { /* status/reminder reads must never fail */ }
    return summary
  }

  /**
   * Q2-A pending inventory: stored messages whose latest delivery is neither
   * delivered nor a suppressed duplicate. Read-only; no state rewriting.
   * A non-empty `toSession` scopes the summary to one target (P0-1); the
   * unscoped call is exactly the status tool's `counts().pending`.
   * `unread` is additive (absence detection) and does not change total/queued/
   * undeliverable/expired, which keep their delivery-state meanings.
   * @param {string | null} [toSession] - optional target session id.
   * @returns {{total: number, unread: number, queued: number, undeliverable: number, expired: number, oldestAt: string | null, byReason: Record<string, number>}}
   */
  const pendingSummary = (toSession = null) => {
    const pending = { total: 0, unread: 0, queued: 0, undeliverable: 0, expired: 0, oldestAt: null, byReason: {} }
    try {
      // Read the Q2-A columns only when they exist; a degraded (legacy) schema
      // classifies rows from error/delivered/suppressed instead of failing.
      const stateColumn = deliveryColumns.has('delivery_state') ? 'd.delivery_state' : 'NULL AS delivery_state'
      const reasonColumn = deliveryColumns.has('reason_code') ? 'd.reason_code' : 'NULL AS reason_code'
      const scoped = typeof toSession === 'string' && toSession.length > 0
      const rows = db.prepare(`SELECT d.id, d.at, d.delivered, d.suppressed, ${stateColumn}, ${reasonColumn},
        d.error FROM deliveries d
        WHERE d.delivered = 0 AND d.suppressed = 0 AND d.message_id IS NOT NULL
          ${scoped ? 'AND d.to_session = ?' : ''}
          AND d.id = (SELECT MAX(d2.id) FROM deliveries d2 WHERE d2.message_id = d.message_id)`
      ).all(...(scoped ? [toSession] : []))
      for (const row of rows) {
        const state = deriveDeliveryState(row)
        const reason = deriveReasonCode(row)
        pending.total += 1
        if (state === 'undeliverable') pending.undeliverable += 1
        if (state === 'queued') pending.queued += 1
        if (state === 'expired') { pending.expired += 1; pending.undeliverable += 1 }
        if (pending.oldestAt === null || String(row.at) < pending.oldestAt) pending.oldestAt = row.at ?? null
        if (reason !== null) pending.byReason[reason] = (pending.byReason[reason] ?? 0) + 1
      }
    } catch { /* best effort: status must never fail because of the pending view */ }
    pending.unread = unreadSummary(toSession).unread
    return pending
  }

  /** Row counts for the read-only status tool (single cheap query batch). */
  const counts = () => {
    const one = (sql) => {
      const row = db.prepare(sql).get()
      return row === undefined || row === null ? 0 : Number(Object.values(row)[0])
    }
    const pending = pendingSummary()
    return {
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      deliveries: one('SELECT COUNT(*) AS n FROM deliveries'),
      suppressedDeliveries: one('SELECT COUNT(*) AS n FROM deliveries WHERE suppressed = 1'),
      undeliveredDeliveries: one('SELECT COUNT(*) AS n FROM deliveries WHERE delivered = 0 AND suppressed = 0 AND message_id IS NOT NULL'),
      readState: one('SELECT COUNT(*) AS n FROM read_state'),
      unread: pending.unread,
      routes: one('SELECT COUNT(*) AS n FROM routes'),
      pending,
    }
  }

  const envelopeCounts = () => {
    const one = (sql) => {
      const row = db.prepare(sql).get()
      return row === undefined || row === null ? 0 : Number(Object.values(row)[0])
    }
    return {
      envelopes: one('SELECT COUNT(*) AS n FROM envelope_state'),
      consumedEnvelopes: one('SELECT COUNT(*) AS n FROM envelope_state WHERE consumed_at IS NOT NULL'),
    }
  }

  /**
   * Envelope counts for ONE recipient. `envelopeCounts()` is global, so comparing
   * it with a per-session unread count looks contradictory ("0 unread but N
   * unconsumed") — this is the comparable number.
   */
  const envelopeCountsFor = (toSession) => {
    const session = String(toSession ?? '')
    if (session === '') return { sessionId: null, envelopes: 0, consumedEnvelopes: 0 }
    const one = (sql) => {
      const row = db.prepare(sql).get(session)
      return row === undefined || row === null ? 0 : Number(Object.values(row)[0])
    }
    return {
      sessionId: session,
      envelopes: one('SELECT COUNT(*) AS n FROM envelope_state WHERE to_session = ?'),
      consumedEnvelopes: one('SELECT COUNT(*) AS n FROM envelope_state WHERE to_session = ? AND consumed_at IS NOT NULL'),
    }
  }

  const envelopeState = (toSession, messageId) => {
    const row = db.prepare('SELECT * FROM envelope_state WHERE to_session = ? AND message_id = ?')
      .get(String(toSession), String(messageId))
    return row === undefined || row === null ? null : row
  }
  const markEnvelopeDelivered = (toSession, messageId) => {
    const at = nowIso()
    db.prepare(`INSERT INTO envelope_state (to_session, message_id, delivered_at)
      VALUES (?, ?, ?)
      ON CONFLICT(to_session, message_id) DO UPDATE SET delivered_at = COALESCE(envelope_state.delivered_at, excluded.delivered_at)`)
      .run(String(toSession), String(messageId), at)
    return envelopeState(toSession, messageId)
  }
  const markEnvelopeConsumed = (toSession, messageId) => {
    const at = nowIso()
    db.prepare(`INSERT INTO envelope_state (to_session, message_id, delivered_at, consumed_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT(to_session, message_id) DO UPDATE SET consumed_at = COALESCE(envelope_state.consumed_at, excluded.consumed_at)`)
      .run(String(toSession), String(messageId), at)
    return envelopeState(toSession, messageId)
  }

  /** Host DB facts for message_bus_status: WAL/checkpoint state, no secrets. */
  const databaseFacts = () => {
    let journalMode = null
    let pageCount = null
    let wal = null
    try { journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '') } catch { /* ignore */ }
    try { pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0) } catch { /* ignore */ }
    try {
      const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      wal = row === undefined || row === null ? null : { ...row }
    } catch { /* ignore */ }
    return { dbPath, journalMode, ephemeral: dbPath === ':memory:', pageCount, wal, checkpoint: 'PRAGMA wal_checkpoint(TRUNCATE)' }
  }
  const checkpoint = () => {
    try { return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() ?? null } catch { return null }
  }

  return {
    db, dbPath, deliverySchema,
    insertMessage, insertDelivery, findDuplicate, getMessage, listMessages, countMessages,
    deleteMessage, listSuppressed, countSuppressed, latestDeliveries,
    pendingDeliveries, markDeliveryDelivered, deliveryView,
    markRead, getReadAt, upsertRoute, resolveRoute, listRoutes, counts, pendingSummary, unreadSummary, purge,
    envelopeState, markEnvelopeDelivered, markEnvelopeConsumed, envelopeCounts, envelopeCountsFor,
    databaseFacts, checkpoint,
    close: () => { try { db.close() } catch { /* already closed */ } },
  }
}

export function sha256Of(body) {
  return createHash('sha256').update(String(body), 'utf8').digest('hex')
}
