// dsh-agent-memory: persistent, project-scoped memory for DSH agents.
// SQLite WAL, zero npm dependencies; tools only (no automatic context injection).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const inject = ['tools']

const dbPath = () => process.env.DSH_MEMORY_DB || join(
  process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory', 'memory.sqlite',
)
const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  key TEXT,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_session TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_by TEXT,
  UNIQUE(scope, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_at);
`
const now = () => new Date().toISOString()
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const tagsOf = value => Array.isArray(value) ? value.filter(tag => typeof tag === 'string') : []

// Digest contract: counts only. Latest-key entries are capped to 3-5 so the
// optional pre-step summary stays inside a two-line budget.
const STALE_DAYS = 90
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000
const DIGEST_MIN_KEYS = 3
const DIGEST_MAX_KEYS = 5
const DIGEST_SOURCE_KIND = 'agent-memory-digest'
const DIGEST_SOURCE_VERSION = 1
const digestKeyLimit = value => {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.max(DIGEST_MIN_KEYS, Math.min(DIGEST_MAX_KEYS, Math.trunc(number)))
    : DIGEST_MAX_KEYS
}
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
const desc = (name, description, properties = {}, required = []) => ({
  name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  output,
  presentCall: () => ({ card: 'generic', title: name, kind: 'read' }),
})
const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const arr = description => ({ type: 'array', items: { type: 'string' }, description })

// M1 memory content standard. Validation is advisory: memory_remember never
// rejects a write because of quality issues (old free-form rows already exist).
const KEY_SEGMENT_RE = /^[a-z0-9._-]+$/
const HEADER_LABELS = ['project', 'workspace', 'domain', 'updated']
const REQUIRED_TAGS = ['project', 'domain', 'kind']
const PERSONAL_PATH_RE = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s]+|\/(?:home|Users)\/[^/\s]+)/
const HEADER_RE = label => new RegExp(`\\b${label}\\s*=\\s*[^\\s|\\]]`, 'i')
const FIELD_RE = label => new RegExp(`^[\\t ]*(?:${label})[\\t ]*[:：]`, 'im')

const hasField = (content, labels) => labels.some(label => FIELD_RE(label).test(content))

export function validateMemory({ scope = 'project', key, content, tags } = {}) {
  const issues = []
  const warnings = []
  const add = (bucket, code, message) => bucket.push({ code, message })
  const scopeValue = typeof scope === 'string' && scope.trim() !== '' ? scope.trim().toLowerCase() : 'project'
  const keyValue = typeof key === 'string' ? key.trim() : ''
  const text = typeof content === 'string' ? content.trim() : ''
  const tagList = Array.isArray(tags)
    ? tags.filter(tag => typeof tag === 'string').map(tag => tag.trim().toLowerCase()).filter(Boolean)
    : []

  if (keyValue === '') {
    if (scopeValue === 'project') add(issues, 'KEY_MISSING', 'project-scope memories require a key')
    else add(warnings, 'KEY_MISSING', 'key is recommended even for non-project scopes')
  } else {
    const segments = keyValue.split('/')
    if (segments.length < 2 || segments.length > 5) {
      add(issues, 'KEY_SEGMENTS', `key must have 2–5 segments, got ${segments.length}`)
    }
    if (segments.some(segment => !KEY_SEGMENT_RE.test(segment))) {
      add(issues, 'KEY_CHARSET', 'key may only contain lowercase a-z, 0-9, ".", "_", "-" and "/"')
    }
    if (segments.length >= 2 && segments.length <= 5 && segments.length !== 3) {
      add(warnings, 'KEY_PREFER_THREE_SEGMENTS', 'prefer 3 segments: <project>/<domain>/<topic>')
    }
  }

  const missingHeader = HEADER_LABELS.filter(label => !HEADER_RE(label).test(text))
  if (missingHeader.length > 0) {
    add(issues, 'HEADER_MISSING', `missing header field(s): ${missingHeader.join(', ')} (project=/workspace=/domain=/updated=)`)
  }
  const updated = text.match(/\bupdated\s*=\s*([^\s|\]]+)/i)
  if (updated !== null && !/^\d{4}-\d{2}-\d{2}$/.test(updated[1])) {
    add(warnings, 'HEADER_UPDATED_FORMAT', 'updated= should be YYYY-MM-DD')
  }

  if (!hasField(text, ['What'])) add(issues, 'FIELD_MISSING_WHAT', 'missing What: line')
  if (!hasField(text, ['Why'])) add(issues, 'FIELD_MISSING_WHY', 'missing Why: line')
  if (!hasField(text, ['Where', 'Evidence', 'Where/Evidence', 'Evidence/Where'])) {
    add(issues, 'FIELD_MISSING_EVIDENCE', 'missing Where: or Evidence: line')
  }
  if (!hasField(text, ['Status', 'Decision', 'Status/Decision', 'Decision/Status'])) {
    add(issues, 'FIELD_MISSING_STATUS', 'missing Status: or Decision: line')
  }
  if (!hasField(text, ['Next'])) add(issues, 'FIELD_MISSING_NEXT', 'missing Next: line')

  if (text.length < 80) add(issues, 'CONTENT_TOO_SHORT', `content must be 80–8000 characters, got ${text.length}`)
  else if (text.length > 8000) add(issues, 'CONTENT_TOO_LONG', `content must be 80–8000 characters, got ${text.length}`)

  for (const tag of REQUIRED_TAGS) {
    if (!tagList.includes(tag)) add(warnings, 'TAG_MISSING', `missing tag: ${tag}`)
  }

  if (/\bsk-[A-Za-z0-9_-]{8,}/.test(text)) {
    add(issues, 'SENSITIVE_TOKEN', 'content looks like it contains an API token (sk-)')
  }
  if (/\bghp_[A-Za-z0-9]{10,}/.test(text)) {
    add(issues, 'SENSITIVE_TOKEN', 'content looks like it contains a GitHub token (ghp_)')
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) {
    add(issues, 'SENSITIVE_PRIVATE_KEY', 'content looks like it contains a private key')
  }
  if (PERSONAL_PATH_RE.test(text)) {
    add(warnings, 'PERSONAL_PATH', 'content contains a personal filesystem path; use <workspace>/<home> placeholders')
  }

  const hasHeader = missingHeader.length < HEADER_LABELS.length
  const hasStructuredField = hasField(text, ['What', 'Why', 'Where', 'Evidence', 'Status', 'Decision', 'Next'])
  if (!hasHeader && !hasStructuredField) {
    add(warnings, 'LEGACY_FORMAT', 'free-form legacy content; prefer the standard header + What/Why/Where|Evidence/Status|Decision/Next template')
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    score: Math.max(0, 100 - issues.length * 20 - warnings.length * 5),
  }
}

/**
 * Read-only digest over the memories table.
 *
 * Returns counts only: total, per-scope counts, the latest 3-5 non-empty keys
 * (with updated_at), issue rows, warning-only rows and rows older than 90 days.
 * `issueCount` and `warningCount` are disjoint row buckets and match
 * memory_quality's `summary.errors` / `summary.warnings`. No row content is
 * returned and no INSERT/UPDATE/DELETE is issued.
 */
export function buildMemoryDigest(db, { scope = null, limit = DIGEST_MAX_KEYS, nowMs = Date.now() } = {}) {
  const scopeFilter = typeof scope === 'string' && scope.trim() !== '' ? scope.trim() : null
  const keysLimit = digestKeyLimit(limit)
  const clock = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const rows = scopeFilter === null
    ? db.prepare('SELECT scope, key, content, tags, updated_at FROM memories ORDER BY updated_at DESC, rowid DESC').all()
    : db.prepare('SELECT scope, key, content, tags, updated_at FROM memories WHERE scope=? ORDER BY updated_at DESC, rowid DESC').all(scopeFilter)
  let issueCount = 0
  let warningCount = 0
  let staleCount = 0
  for (const row of rows) {
    const quality = validateMemory({ scope: row.scope, key: row.key, content: row.content, tags: safeTags(row.tags) })
    if (quality.issues.length > 0) issueCount += 1
    else if (quality.warnings.length > 0) warningCount += 1
    const updatedAt = Date.parse(row.updated_at)
    if (Number.isFinite(updatedAt) && clock - updatedAt > STALE_MS) staleCount += 1
  }
  const scopes = scopeFilter === null
    ? db.prepare('SELECT scope, COUNT(*) AS count FROM memories GROUP BY scope ORDER BY count DESC, scope ASC').all()
    : db.prepare('SELECT scope, COUNT(*) AS count FROM memories WHERE scope=? GROUP BY scope ORDER BY count DESC, scope ASC').all(scopeFilter)
  const latestKeys = scopeFilter === null
    ? db.prepare("SELECT key, updated_at FROM memories WHERE key IS NOT NULL AND key <> '' ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(keysLimit)
    : db.prepare("SELECT key, updated_at FROM memories WHERE scope=? AND key IS NOT NULL AND key <> '' ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(scopeFilter, keysLimit)
  return {
    total: rows.length,
    scopes: scopes.map(row => ({ scope: row.scope, count: Number(row.count) })),
    latestKeys: latestKeys.map(row => ({ key: row.key, updated_at: row.updated_at })),
    issueCount,
    warningCount,
    staleCount,
  }
}

/** One sourced user message for the once-per-session digest. */
function createDigestMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: DIGEST_SOURCE_KIND, version: DIGEST_SOURCE_VERSION }),
  })
}

/**
 * True when a message is this plugin's digest. The text-prefix fallback makes
 * dedupe survive a host that strips `source` from committed messages.
 */
export function isMemoryDigestMessage(message) {
  if (!isPlainObject(message)) return false
  if (isPlainObject(message.source) && message.source.kind === DIGEST_SOURCE_KIND) return true
  return Array.isArray(message.content) && message.content.some(part =>
    isPlainObject(part) && part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('[memory-digest]'))
}

/** Render at most two lines from a digest summary; never includes content. */
export function formatMemoryDigest(summary) {
  if (!isPlainObject(summary) || !(Number(summary.total) > 0)) return ''
  const scopes = Array.isArray(summary.scopes) ? summary.scopes : []
  const shownScopes = scopes.slice(0, 4).map(item => `${item.scope} ${Number(item.count)}`).join(', ')
  const extraScopes = scopes.length > 4 ? ` +${scopes.length - 4} more` : ''
  const keys = (Array.isArray(summary.latestKeys) ? summary.latestKeys : [])
    .slice(0, 3)
    .map(item => String(item.key ?? '').slice(0, 40))
    .filter(Boolean)
    .join(', ')
  const line1 = `[memory-digest] ${Number(summary.total)} memories`
    + (shownScopes === '' ? '' : ` (${shownScopes}${extraScopes})`)
    + (keys === '' ? '' : `; latest keys: ${keys}`)
    + '.'
  const line2 = `[memory-digest] quality: ${Number(summary.issueCount) || 0} issue rows, `
    + `${Number(summary.warningCount) || 0} warning-only rows; stale >${STALE_DAYS}d: ${Number(summary.staleCount) || 0}. `
    + 'Read-only: memory_digest / memory_quality.'
  return line1 + '\n' + line2
}

/**
 * Build the optional `agent/pre-step` listener.
 *
 * Injects at most one two-line digest per session (process-local Set of
 * session ids, plus a committed-message marker check). A new handler instance
 * - host restart/resume - recomputes once. Delegates to `next()` first, skips
 * reject decisions, and swallows all of its own failures (fail-open).
 */
export function createMemoryDigestPreStepHandler(options = {}) {
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({})
  const buildDigest = typeof options.buildDigest === 'function' ? options.buildDigest : () => null
  const logger = options.logger
  // Session ids (not object identities): one injection per session per process.
  // A new handler instance after host restart/resume recomputes once.
  let injectedSessionIds = new Set()

  async function handler(first, next) {
    // Downstream failures belong to downstream; never swallow them.
    const decision = typeof next === 'function' ? await next() : first
    try {
      const config = getConfig() ?? {}
      if (config.digestInjection === false) return decision
      if (!isPlainObject(first) || !isPlainObject(first.agent) || !Array.isArray(first.messages)) return decision
      if (isPlainObject(decision) && decision.kind === 'reject') return decision
      if (first.step !== undefined && first.step !== 1) return decision
      const session = isPlainObject(first.agent.session) ? first.agent.session : undefined
      if (session === undefined || typeof session.id !== 'string' || session.id === '') return decision
      const downstreamMessages = Array.isArray(decision?.messages) ? decision.messages : []
      if (first.messages.some(isMemoryDigestMessage) || downstreamMessages.some(isMemoryDigestMessage)) {
        injectedSessionIds.add(session.id)
        return decision
      }
      if (injectedSessionIds.has(session.id)) return decision
      const summary = buildDigest()
      if (!isPlainObject(summary) || !(Number(summary.total) > 0)) return decision
      const text = formatMemoryDigest(summary)
      if (text === '') return decision
      injectedSessionIds.add(session.id)
      try {
        logger?.info?.('[agent-memory] digest injected session=' + session.id + ' total=' + Number(summary.total))
      } catch { /* logging is best-effort */ }
      return {
        ...(isPlainObject(decision) ? decision : {}),
        messages: [...downstreamMessages, createDigestMessage(text)],
      }
    } catch (error) {
      try { logger?.warn?.('[agent-memory] digest injection failed (fail-open): ' + String(error)) } catch { /* best effort */ }
      return decision
    }
  }

  return {
    handler,
    dispose() { injectedSessionIds = new Set() },
  }
}

export function apply(ctx, config) {
  const cfg = isPlainObject(config) ? config : {}
  const file = dbPath()
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(schema)
  {
    const columns = db.prepare('PRAGMA table_info(memories)').all()
    if (!columns.some(column => column.name === 'superseded_by')) {
      db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT')
    }
  }
  ctx.effect(() => () => db.close())
  const register = (descriptor, execute) => ctx.tools.register({ ...descriptor, execute })
  const sessionOf = exec => exec?.agent?.session?.id ?? null
  const isOperator = exec => {
    try {
      const policy = ctx.get?.('sandboxPolicy')
      const resolved = policy?.resolve?.({ session: exec?.agent?.session })
      return resolved?.mode === 'danger-full-access'
    } catch {
      return false
    }
  }

  register(desc('memory_remember', 'Persist one durable memory (upsert by scope+key). Quality is advisory and never blocks a write. For a 100 score: header lines project/workspace/domain/updated, three sections What/Why/Where|Evidence/Status|Next, and literal tags ["project","domain","kind"] (domain-specific values do not satisfy these literal tags).', {
    scope: str('project | agent | global (default project).'),
    key: str('Optional stable key; same scope+key updates instead of duplicating. Charset per segment: lowercase a-z, 0-9, ".", "_", "-" joined by "/" (2-5 segments; 3 is preferred: <project>/<domain>/<topic>). A non-conforming key (e.g. Chinese characters, uppercase, spaces) is accepted but lowers the quality score and reports KEY_CHARSET / KEY_SEGMENTS.'),
    content: str('Memory text. Prefer the M1 standard header + What/Why/Where|Evidence/Status|Decision/Next.'),
    tags: arr('Optional tags; prefer project/domain/kind.'),
  }, ['content']), async (args, exec) => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : 'project'
    const key = typeof args.key === 'string' && args.key !== '' ? args.key : null
    const content = String(args.content ?? '').trim()
    if (content === '') throw new Error('content is required')
    const tagList = tagsOf(args.tags)
    const tags = JSON.stringify(tagList)
    const quality = validateMemory({ scope, key, content, tags: tagList })
    const existing = key === null ? undefined : db.prepare('SELECT id FROM memories WHERE scope=? AND key=?').get(scope, key)
    if (existing !== undefined) {
      db.prepare('UPDATE memories SET content=?, tags=?, source_session=?, updated_at=? WHERE id=?').run(content, tags, sessionOf(exec), now(), existing.id)
      return { ok: true, id: existing.id, updated: true, quality }
    }
    const id = 'mem-' + randomUUID().slice(0, 8)
    db.prepare('INSERT INTO memories (id,scope,key,content,tags,source_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, scope, key, content, tags, sessionOf(exec), now(), now())
    return { ok: true, id, updated: false, quality }
  })

  register(desc('memory_supersede', 'Create a replacement memory and mark the old one superseded. The old row is retained for audit; default search/list hide it.', {
    id: str('Memory id to supersede.'), content: str('Replacement memory text.'), tags: { type: 'array', items: { type: 'string' }, description: 'Optional replacement tags.' },
  }, ['id', 'content']), async (args, exec) => {
    const old = db.prepare('SELECT * FROM memories WHERE id=?').get(args.id)
    if (old === undefined) return { ok: false, code: 'NOT_FOUND', message: 'memory not found: ' + args.id }
    if (old.superseded_by !== null && old.superseded_by !== undefined) return { ok: false, code: 'CONFLICT', message: 'memory already superseded by ' + old.superseded_by }
    const content = String(args.content ?? '')
    if (content.trim() === '') return { ok: false, code: 'INVALID_ARGUMENT', message: 'content is required' }
    const id = 'mem-' + randomUUID().slice(0, 8)
    const key = typeof old.key === 'string' && old.key !== '' ? old.key + '#superseded-' + id : null
    const tags = JSON.stringify(Array.isArray(args.tags) ? args.tags : safeTags(old.tags))
    db.prepare('INSERT INTO memories (id,scope,key,content,tags,source_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, old.scope, key, content, tags, sessionOf(exec), now(), now())
    db.prepare('UPDATE memories SET superseded_by=? WHERE id=?').run(id, old.id)
    return { ok: true, id, superseded: old.id, key, supersededBy: id }
  })

  register(desc('memory_search', 'Search durable memories by LIKE over content/key/tags. Superseded rows are hidden unless includeSuperseded=true.', {
    query: str('Search text; empty lists recent.'), scope: str('Optional scope filter.'), includeSuperseded: { type: 'boolean', description: 'Include superseded rows (default false).' }, limit: num('Max rows (default 20).'),
  }), async args => {
    const query = String(args.query ?? '').trim()
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
    const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
    const include = args.includeSuperseded === true
    const active = include ? '1=1' : 'superseded_by IS NULL'
    const rows = scope === null
      ? db.prepare(`SELECT * FROM memories WHERE ${active} AND (content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`).all(like, like, like, limit)
      : db.prepare(`SELECT * FROM memories WHERE scope=? AND ${active} AND (content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`).all(scope, like, like, like, limit)
    return { ok: true, memories: rows.map(row => ({ ...row, tags: safeTags(row.tags) })) }
  })

  register(desc('memory_list', 'List durable memories, newest first. Superseded rows are hidden unless includeSuperseded=true.', {
    scope: str('Optional scope filter.'), includeSuperseded: { type: 'boolean', description: 'Include superseded rows (default false).' }, limit: num('Max rows (default 50).'),
  }), async args => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 50
    const active = args.includeSuperseded === true ? '1=1' : 'superseded_by IS NULL'
    const rows = scope === null
      ? db.prepare(`SELECT * FROM memories WHERE ${active} ORDER BY updated_at DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM memories WHERE scope=? AND ${active} ORDER BY updated_at DESC LIMIT ?`).all(scope, limit)
    return { ok: true, memories: rows.map(row => ({ ...row, tags: safeTags(row.tags) })) }
  })

  register(desc('memory_quality', 'Read-only memory quality audit against the M1 content standard; never writes to the DB.', {
    scope: str('Optional scope filter.'), limit: num('Max rows returned (default 50, max 200).'),
  }), async args => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 50
    const rows = scope === null
      ? db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all()
      : db.prepare('SELECT * FROM memories WHERE scope=? ORDER BY updated_at DESC').all(scope)
    const checkedAt = now()
    const audited = rows.map(row => {
      const quality = validateMemory({ scope: row.scope, key: row.key, content: row.content, tags: safeTags(row.tags) })
      return { id: row.id, key: row.key, score: quality.score, issues: quality.issues, warnings: quality.warnings }
    })
    // Row buckets are disjoint: compliant (no issues/warnings), warnings-only, and errors (>=1 issue).
    const summary = {
      total: audited.length,
      compliant: audited.filter(row => row.issues.length === 0 && row.warnings.length === 0).length,
      warnings: audited.filter(row => row.issues.length === 0 && row.warnings.length > 0).length,
      errors: audited.filter(row => row.issues.length > 0).length,
    }
    return { ok: true, scope, checkedAt, summary, rows: audited.slice(0, limit) }
  })

  register(desc('memory_digest', 'Read-only memory digest: total/scopes/latestKeys/issueCount(rows with issues)/'
    + 'warningCount(warning-only rows)/staleCount(>90d). Returns counts and key/updated_at only, never memory '
    + 'content; never writes to the DB and never fixes rows.', {
    scope: str('Optional scope filter.'),
    limit: num(`Number of latest keys to include, clamped to ${DIGEST_MIN_KEYS}-${DIGEST_MAX_KEYS} (default ${DIGEST_MAX_KEYS}).`),
  }), async args => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    return {
      ok: true,
      scope,
      checkedAt: now(),
      summary: buildMemoryDigest(db, { scope, limit: args.limit }),
    }
  })

  register(desc('memory_forget', '⚠ Scope: one durable memory (all sessions using it); irreversible: yes; precondition: operator allowForget:true + confirm:"FORGET". Delete one memory by id; appends an audit row.', {
    id: str('Memory id.'), confirm: str('Must be exactly "FORGET".'),
  }, ['id', 'confirm']), async (args, exec) => {
    if (cfg.allowForget !== true || !isOperator(exec)) {
      return { ok: false, code: 'FORBIDDEN', message: 'memory_forget requires operator policy and allowForget:true' }
    }
    if (args.confirm !== 'FORGET') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'memory_forget requires confirm:"FORGET"' }
    }
    const row = db.prepare('SELECT id,scope,key,source_session FROM memories WHERE id=?').get(args.id)
    if (row === undefined) return { ok: false, code: 'NOT_FOUND', message: 'memory not found: ' + args.id }
    const deleted = db.prepare('DELETE FROM memories WHERE id=?').run(args.id).changes
    try {
      appendFileSync(join(dirname(file), 'forget-audit.jsonl'), JSON.stringify({
        at: now(), actor: sessionOf(exec), id: row.id, scope: row.scope, key: row.key, sourceSession: row.source_session,
      }) + '\n', 'utf8')
    } catch { /* audit must not resurrect a deleted memory */ }
    return { ok: deleted > 0, deleted: args.id, audit: 'forget-audit.jsonl' }
  })

  register(desc('memory_status', 'Read memory DB location and counts.'), async () => ({
    ok: true, dbPath: file,
    count: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
    scopes: db.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all(),
    digest: {
      injection: cfg.digestInjection !== false,
      staleDays: STALE_DAYS,
      latestKeys: DIGEST_MAX_KEYS,
      allowForget: cfg.allowForget === true,
    },
  }))

  // Optional first-step recall: distinct source marker/text prefix from the
  // workbench brief, so the two never suppress each other; the workbench brief
  // never carries memory counts.
  if (cfg.digestInjection !== false && typeof ctx.on === 'function') {
    const digestHandler = createMemoryDigestPreStepHandler({
      getConfig: () => cfg,
      buildDigest: () => buildMemoryDigest(db, { limit: DIGEST_MAX_KEYS }),
      logger: ctx.logger,
    })
    try {
      const disposeDigest = ctx.on('agent/pre-step', digestHandler.handler)
      if (typeof disposeDigest === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposeDigest)
      ctx.logger?.info?.('[agent-memory] digest injection enabled (once per session)')
    } catch (error) {
      digestHandler.dispose()
      try { ctx.logger?.warn?.('[agent-memory] digest injection listener unavailable: ' + String(error)) } catch { /* best effort */ }
    }
  }
}

function safeTags(value) {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
