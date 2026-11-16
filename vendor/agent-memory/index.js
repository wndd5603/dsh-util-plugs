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

export function apply(ctx) {
  const file = dbPath()
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(schema)
  ctx.effect(() => () => db.close())
  const register = (descriptor, execute) => ctx.tools.register({ ...descriptor, execute })
  const sessionOf = exec => exec?.agent?.session?.id ?? null

  register(desc('memory_remember', 'Persist one durable memory (upsert by scope+key).', {
    scope: str('project | agent | global (default project).'),
    key: str('Optional stable key; same scope+key updates instead of duplicating.'),
    content: str('Memory text.'),
    tags: arr('Optional tags.'),
  }, ['content']), async (args, exec) => {
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : 'project'
    const key = typeof args.key === 'string' && args.key !== '' ? args.key : null
    const content = String(args.content ?? '').trim()
    if (content === '') throw new Error('content is required')
    const tags = JSON.stringify(tagsOf(args.tags))
    const existing = key === null ? undefined : db.prepare('SELECT id FROM memories WHERE scope=? AND key=?').get(scope, key)
    if (existing !== undefined) {
      db.prepare('UPDATE memories SET content=?, tags=?, source_session=?, updated_at=? WHERE id=?').run(content, tags, sessionOf(exec), now(), existing.id)
      return { ok: true, id: existing.id, updated: true }
    }
    const id = 'mem-' + randomUUID().slice(0, 8)
    db.prepare('INSERT INTO memories (id,scope,key,content,tags,source_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, scope, key, content, tags, sessionOf(exec), now(), now())
    return { ok: true, id, updated: false }
  })

  register(desc('memory_search', 'Search durable memories by LIKE over content/key/tags.', {
    query: str('Search text; empty lists recent.'), scope: str('Optional scope filter.'), limit: num('Max rows (default 20).'),
  }), async args => {
    const query = String(args.query ?? '').trim()
    const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
    const like = '%' + query + '%'
    const rows = scope === null
      ? db.prepare('SELECT * FROM memories WHERE content LIKE ? OR key LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT ?').all(like, like, like, limit)
      : db.prepare('SELECT * FROM memories WHERE scope=? AND (content LIKE ? OR key LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC LIMIT ?').all(scope, like, like, like, limit)
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
