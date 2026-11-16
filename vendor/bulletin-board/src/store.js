// DSH bulletin board: boards + tasks shared across sessions/agents.
// Zero npm dependencies: node:sqlite only.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const STATUSES = ['pending', 'in_progress', 'blocked', 'suspended', 'completed', 'terminated']
const now = () => new Date().toISOString()
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const dbPathDefault = () => join(dshHome(), 'bulletin-board', 'board.sqlite')
const json = value => JSON.stringify(value ?? null)
const parse = text => {
  try { return JSON.parse(text) } catch { return null }
}
const newId = prefix => prefix + '-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8)

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  workspace TEXT, owner_session TEXT, owner_alias TEXT,
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
  labels TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', assignee_session TEXT, assignee_alias TEXT,
  workspace TEXT, priority INTEGER NOT NULL DEFAULT 0, depends_on TEXT, related_tasks TEXT,
  blocked_reason TEXT, metadata TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_session, assignee_alias, status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace, status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT
);
`
function open(dbPath = dbPathDefault()) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  return db
}
function rowBoard(row) {
  return row === undefined ? null : {
    id: row.id, title: row.title, description: row.description, workspace: row.workspace,
    ownerSession: row.owner_session, ownerAlias: row.owner_alias, status: row.status,
    priority: row.priority, labels: parse(row.labels) ?? [], createdAt: row.created_at,
    updatedAt: row.updated_at, revision: row.revision,
  }
}
function rowTask(row) {
  return row === undefined ? null : {
    id: row.id, boardId: row.board_id, title: row.title, description: row.description,
    status: row.status, assigneeSession: row.assignee_session, assigneeAlias: row.assignee_alias,
    workspace: row.workspace, priority: row.priority, dependsOn: parse(row.depends_on) ?? [],
    relatedTasks: parse(row.related_tasks) ?? [], blockedReason: row.blocked_reason,
    metadata: parse(row.metadata) ?? {}, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
  }
}
function assertStatus(status) {
  if (status !== undefined && !STATUSES.includes(status)) throw new Error('invalid status: ' + status)
}
export function createStore(dbPath) {
  const db = open(dbPath)
  const actorOf = (exec) => {
    const s = exec?.agent?.session
    return s?.id ?? null
  }
  const event = (actor, action, entity, entityId, detail) => db.prepare(
    'INSERT INTO events (at, actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)',
  ).run(now(), actor, action, entity, entityId, detail === undefined ? null : json(detail))
  return {
    db,
    close: () => db.close(),
    createBoard(input, exec) {
      const id = newId('board')
      const at = now()
      const status = input.status ?? 'pending'
      assertStatus(status)
      db.prepare(`INSERT INTO boards (id,title,description,workspace,owner_session,owner_alias,status,priority,labels,created_at,updated_at,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(
        id, input.title, input.description ?? null, input.workspace ?? null,
        actorOf(exec), input.ownerAlias ?? null, status, Number(input.priority ?? 0),
        json(input.labels ?? []), at, at,
      )
      event(actorOf(exec), 'board.create', 'board', id)
      return rowBoard(db.prepare('SELECT * FROM boards WHERE id=?').get(id))
    },
    listBoards(query = {}) {
      const where = []
      const values = []
      if (query.status !== undefined) { where.push('status = ?'); values.push(query.status) }
      if (query.workspace !== undefined) { where.push('workspace = ?'); values.push(query.workspace) }
      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200)
      const rows = db.prepare('SELECT * FROM boards' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC LIMIT ?').all(...values, limit)
      return rows.map(rowBoard)
    },
    getBoard(id) {
      return rowBoard(db.prepare('SELECT * FROM boards WHERE id=?').get(id))
    },
    addTask(boardId, input, exec) {
      if (db.prepare('SELECT id FROM boards WHERE id=?').get(boardId) === undefined) throw new Error('board not found: ' + boardId)
      const status = input.status ?? 'pending'
      assertStatus(status)
      const id = newId('task')
      const at = now()
      db.prepare(`INSERT INTO tasks (id,board_id,title,description,status,assignee_session,assignee_alias,workspace,priority,depends_on,related_tasks,blocked_reason,metadata,created_by,created_at,updated_at,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
        id, boardId, input.title, input.description ?? null, status,
        input.assigneeSession ?? null, input.assigneeAlias ?? null,
        input.workspace ?? null, Number(input.priority ?? 0),
        json(input.dependsOn ?? []), json(input.relatedTasks ?? []),
        input.blockedReason ?? null, json(input.metadata ?? {}), actorOf(exec), at, at,
      )
      event(actorOf(exec), 'task.add', 'task', id, { boardId })
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    getTask(id) { return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)) },
    listTasks(query = {}) {
      const where = []
      const values = []
      for (const [col, key] of [['board_id', 'boardId'], ['status', 'status'], ['workspace', 'workspace'], ['assignee_session', 'assigneeSession'], ['assignee_alias', 'assigneeAlias']]) {
        if (query[key] !== undefined) { where.push(col + ' = ?'); values.push(query[key]) }
      }
      const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500)
      const rows = db.prepare('SELECT * FROM tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY priority DESC, updated_at DESC LIMIT ?').all(...values, limit)
      return rows.map(rowTask)
    },
    updateTask(id, patch, exec) {
      const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      if (existing === undefined) throw new Error('task not found: ' + id)
      assertStatus(patch.status)
      const fields = []
      const values = []
      const allowed = {
        title: 'title', description: 'description', status: 'status', assigneeSession: 'assignee_session',
        assigneeAlias: 'assignee_alias', workspace: 'workspace', priority: 'priority',
        blockedReason: 'blocked_reason',
      }
      for (const [key, col] of Object.entries(allowed)) {
        if (patch[key] !== undefined) { fields.push(col + ' = ?'); values.push(patch[key]) }
      }
      for (const [key, col] of [['dependsOn', 'depends_on'], ['relatedTasks', 'related_tasks'], ['metadata', 'metadata']]) {
        if (patch[key] !== undefined) { fields.push(col + ' = ?'); values.push(json(patch[key])) }
      }
      if (fields.length === 0) return rowTask(existing)
      fields.push('updated_at = ?', 'revision = revision + 1')
      values.push(now(), id)
      db.prepare('UPDATE tasks SET ' + fields.join(', ') + ' WHERE id=?').run(...values)
      event(actorOf(exec), 'task.update', 'task', id, patch)
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    claimTask(id, assignee, exec) {
      const result = db.prepare(`UPDATE tasks SET status='in_progress', assignee_session=?, assignee_alias=?, updated_at=?, revision=revision+1
        WHERE id=? AND status='pending' AND (assignee_session IS NULL OR assignee_session='')`).run(
        assignee.session ?? actorOf(exec), assignee.alias ?? null, now(), id,
      )
      if (result.changes === 0) throw new Error('task is not claimable (not pending or already assigned)')
      event(actorOf(exec), 'task.claim', 'task', id, assignee)
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    completeTask(id, exec) {
      const result = db.prepare(`UPDATE tasks SET status='completed', updated_at=?, revision=revision+1 WHERE id=?`).run(now(), id)
      if (result.changes === 0) throw new Error('task not found: ' + id)
      event(actorOf(exec), 'task.complete', 'task', id)
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    digest(query = {}) {
      const clauses = []
      const values = []
      if (query.session) { clauses.push('assignee_session = ?'); values.push(query.session) }
      if (query.alias) { clauses.push('assignee_alias = ?'); values.push(query.alias) }
      if (query.workspace) { clauses.push('workspace = ?'); values.push(query.workspace) }
      if (clauses.length === 0) return []
      const rows = db.prepare('SELECT * FROM tasks WHERE ' + clauses.join(' OR ') + ' ORDER BY priority DESC, updated_at DESC LIMIT 200').all(...values)
      return rows.map(rowTask)
    },
  }
}
