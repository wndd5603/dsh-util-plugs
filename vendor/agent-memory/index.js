// dsh-agent-memory: persistent, project-scoped memory for DSH agents.
// SQLite WAL, zero npm dependencies; tools only (no automatic context injection).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
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
  UNIQUE(scope, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_at);
`
const now = () => new Date().toISOString()
const tagsOf = value => Array.isArray(value) ? value.filter(tag => typeof tag === 'string') : []
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

export function apply(ctx) {
  const file = dbPath()
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(schema)
  ctx.effect(() => () => db.close())
  const register = (descriptor, execute) => ctx.tools.register({ ...descriptor, execute })
  const sessionOf = exec => exec?.agent?.session?.id ?? null

  register(desc('memory_remember', 'Persist one durable memory (upsert by scope+key). Quality is advisory and never blocks a write.', {
    scope: str('project | agent | global (default project).'),
    key: str('Optional stable key; same scope+key updates instead of duplicating.'),
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

  register(desc('memory_search', 'Search durable memories by LIKE over content/key/tags.', {
    query: str('Search text; empty lists recent.'), scope: str('Optional scope filter.'), limit: num('Max rows (default 20).'),
  }), async args => {
    const query = String(args.query ?? '').trim()
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
    const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
    const rows = scope === null
      ? db.prepare("SELECT * FROM memories WHERE content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?").all(like, like, like, limit)
      : db.prepare("SELECT * FROM memories WHERE scope=? AND (content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?").all(scope, like, like, like, limit)
    return { ok: true, memories: rows.map(row => ({ ...row, tags: safeTags(row.tags) })) }
  })

  register(desc('memory_list', 'List durable memories, newest first.', {
    scope: str('Optional scope filter.'), limit: num('Max rows (default 50).'),
  }), async args => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 50
    const rows = scope === null
      ? db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM memories WHERE scope=? ORDER BY updated_at DESC LIMIT ?').all(scope, limit)
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

  register(desc('memory_forget', 'Delete one memory by id.', { id: str('Memory id.') }, ['id']), async args => {
    db.prepare('DELETE FROM memories WHERE id=?').run(args.id)
    return { ok: true, deleted: args.id }
  })

  register(desc('memory_status', 'Read memory DB location and counts.'), async () => ({
    ok: true, dbPath: file,
    count: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
    scopes: db.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all(),
  }))
}

function safeTags(value) {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
