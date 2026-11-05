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
  error           TEXT
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

export function openMessageStore(dbPath) {
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

  const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (id, at, from_session, from_alias, from_display, to_session, subject,
      body, bytes, sha256, dedupe_key, nonce, forced, priority, test, project_scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const stmtInsertDelivery = db.prepare(`
    INSERT INTO deliveries (message_id, at, from_session, from_alias, from_display, to_session, subject,
      body_bytes, body_sha256, lightweight, duplicate, suppressed, delivered, existing_id, existing_at,
      dedupe_key, dedupe_window_ms, priority, forced, test, coalesced, resumed, caller_alias, impersonation, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  const insertMessage = (m) => {
    stmtInsertMessage.run(
      m.id, m.at, m.fromSession ?? null, m.fromAlias ?? null, m.fromDisplay ?? null,
      m.toSession, m.subject ?? '', m.body, m.bytes, m.sha256,
      m.dedupeKey ?? null, m.nonce ?? null, m.forced ? 1 : 0, m.priority ? 1 : 0,
      m.test ? 1 : 0, m.projectScope ?? null, nowIso(),
    )
    return m
  }

  const insertDelivery = (d) => {
    stmtInsertDelivery.run(
      d.messageId ?? null, d.at ?? nowIso(), d.fromSession ?? null, d.fromAlias ?? null, d.fromDisplay ?? null,
      d.toSession, d.subject ?? '', d.bodyBytes ?? null, d.bodySha256 ?? null,
      d.lightweight === false ? 0 : 1, d.duplicate ? 1 : 0, d.suppressed ? 1 : 0, d.delivered ? 1 : 0,
      d.existingId ?? null, d.existingAt ?? null, d.dedupeKey ?? null, d.dedupeWindowMs ?? null,
      d.priority ? 1 : 0, d.forced ? 1 : 0, d.test ? 1 : 0, d.coalesced ? 1 : 0,
      d.resumed ? 1 : 0, d.callerAlias ?? null, d.impersonation ? 1 : 0, d.error ?? null,
    )
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
  const messageFilter = ({ toSession, since, readBy, unreadOnly, keyword } = {}) => {
    const clauses = []
    const params = []
    if (toSession) { clauses.push('m.to_session = ?'); params.push(toSession) }
    if (since) { clauses.push('m.at >= ?'); params.push(since) }
    if (readBy) {
      clauses.push('(r.read_at IS NOT NULL OR r.read_at IS NULL)')
    }
    if (unreadOnly && readBy) clauses.push('r.read_at IS NULL')
    const term = typeof keyword === 'string' ? keyword.trim() : ''
    if (term !== '') {
      const like = '%' + term.replace(/[%_]/gu, match => '\\' + match) + '%'
      clauses.push("(m.subject LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\' OR m.from_display LIKE ? ESCAPE '\\' OR m.id LIKE ? ESCAPE '\\')")
      params.push(like, like, like, like)
    }
    return { clauses, params }
  }

  const listMessages = ({ toSession, readBy, unreadOnly, since, keyword, limit = 20, offset = 0 } = {}) => {
    const { clauses, params } = messageFilter({ toSession, since, readBy, unreadOnly, keyword })
    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''
    const sql = `SELECT m.*, ${readBy ? 'r.read_at' : 'NULL'} AS read_at
      FROM messages m
      ${readBy ? 'LEFT JOIN read_state r ON r.message_id = m.id AND r.session_id = ?' : ''}
      ${where}
      ORDER BY m.at DESC LIMIT ? OFFSET ?`
    const bound = readBy ? [readBy, ...params, limit, offset] : [...params, limit, offset]
    return db.prepare(sql).all(...bound)
  }

  /** Total matching rows for one list/search query (pagination). */
  const countMessages = ({ toSession, readBy, unreadOnly, since, keyword } = {}) => {
    const { clauses, params } = messageFilter({ toSession, since, readBy, unreadOnly, keyword })
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

  const listSuppressed = ({ toSession, since, limit = 20 } = {}) => {
    const clauses = ['duplicate = 1', 'suppressed = 1']
    const params = []
    if (toSession) { clauses.push('to_session = ?'); params.push(toSession) }
    if (since) { clauses.push('at >= ?'); params.push(since) }
    return db.prepare(`SELECT * FROM deliveries WHERE ${clauses.join(' AND ')} ORDER BY at DESC LIMIT ?`)
      .all(...params, limit)
  }

  /** Undelivered stored messages for one session, oldest first (auto-resume flush). */
  const pendingDeliveries = (toSession, limit = 50) => db.prepare(`
    SELECT d.id AS delivery_id, d.message_id, d.to_session, d.from_display, d.at AS delivery_at,
           m.at AS message_at, m.subject, m.bytes, m.sha256
    FROM deliveries d JOIN messages m ON m.id = d.message_id
    WHERE d.to_session = ? AND d.delivered = 0 AND d.suppressed = 0 AND d.message_id IS NOT NULL
    ORDER BY d.id ASC LIMIT ?`).all(String(toSession), Math.max(1, Math.min(200, Math.trunc(limit))))

  const markDeliveryDelivered = (deliveryId) => {
    const result = db.prepare("UPDATE deliveries SET delivered = 1, error = NULL WHERE id = ?").run(deliveryId)
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

  /** Row counts for the read-only status tool (single cheap query batch). */
  const counts = () => {
    const one = (sql) => {
      const row = db.prepare(sql).get()
      return row === undefined || row === null ? 0 : Number(Object.values(row)[0])
    }
    return {
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      deliveries: one('SELECT COUNT(*) AS n FROM deliveries'),
      suppressedDeliveries: one('SELECT COUNT(*) AS n FROM deliveries WHERE suppressed = 1'),
      readState: one('SELECT COUNT(*) AS n FROM read_state'),
      routes: one('SELECT COUNT(*) AS n FROM routes'),
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
    db, dbPath,
    insertMessage, insertDelivery, findDuplicate, getMessage, listMessages, countMessages,
    deleteMessage, listSuppressed,
    pendingDeliveries, markDeliveryDelivered,
    markRead, getReadAt, upsertRoute, resolveRoute, listRoutes, counts, purge,
    envelopeState, markEnvelopeDelivered, markEnvelopeConsumed, envelopeCounts,
    databaseFacts, checkpoint,
    close: () => { try { db.close() } catch { /* already closed */ } },
  }
}

export function sha256Of(body) {
  return createHash('sha256').update(String(body), 'utf8').digest('hex')
}
