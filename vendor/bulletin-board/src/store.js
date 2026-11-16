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
/** Coded error so tools can return a stable CONFLICT/FORBIDDEN/INVALID_ARGUMENT contract. */
const codedError = (code, message, extra = {}) => {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

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
  const actorAliasOf = (exec) => {
    const header = exec?.agent?.session?.header ?? {}
    return header.alias ?? exec?.agent?.alias ?? null
  }
  // P1-1: updateTask must enforce the same owner boundary as completeTask.
  // A normal caller may only mutate a task it owns (assignee, or legacy
  // alias-assignee) or created; danger-full-access operators may override.
  const isTaskOwner = (existing, exec) => {
    const caller = actorOf(exec)
    const callerAlias = actorAliasOf(exec)
    const assigneeSession = typeof existing.assignee_session === 'string' && existing.assignee_session !== ''
      ? existing.assignee_session : null
    if (assigneeSession !== null) {
      if (caller !== null && caller === assigneeSession) return true
    } else {
      const assigneeAlias = typeof existing.assignee_alias === 'string' && existing.assignee_alias !== ''
        ? existing.assignee_alias : null
      if (assigneeAlias !== null && callerAlias !== null && callerAlias === assigneeAlias) return true
    }
    const createdBy = typeof existing.created_by === 'string' && existing.created_by !== '' ? existing.created_by : null
    return createdBy !== null && caller !== null && caller === createdBy
  }
  // Operator delegation is explicit; a normal caller always claims as itself.
  const calledSession = (operator, requested, caller) => (operator && requested !== null ? requested : caller)
  const calledAlias = (operator, requested, callerAlias) => (operator && requested !== null ? requested : callerAlias)
  const clampInt = (value, fallback, min, max) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback
  }
  const offsetOf = value => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
  }
  const textOf = value => (typeof value === 'string' ? value.trim().slice(0, 200) : '')
  const likeOf = text => '%' + String(text).replace(/[\\%_]/g, character => '\\' + character) + '%'
  const boardFilterOf = (query = {}) => {
    const where = []
    const values = []
    if (query.status !== undefined) { where.push('status = ?'); values.push(query.status) }
    if (query.workspace !== undefined) { where.push('workspace = ?'); values.push(query.workspace) }
    const keyword = textOf(query.query)
    if (keyword !== '') {
      const like = likeOf(keyword)
      where.push("(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR workspace LIKE ? ESCAPE '\\')")
      values.push(like, like, like, like)
    }
    return { clause: where.length === 0 ? '' : ' WHERE ' + where.join(' AND '), values }
  }
  const taskFilterOf = (query = {}) => {
    const where = []
    const values = []
    for (const [col, key] of [['board_id', 'boardId'], ['status', 'status'], ['workspace', 'workspace'], ['assignee_session', 'assigneeSession'], ['assignee_alias', 'assigneeAlias']]) {
      if (query[key] !== undefined) { where.push(col + ' = ?'); values.push(query[key]) }
    }
    const keyword = textOf(query.query)
    if (keyword !== '') {
      const like = likeOf(keyword)
      where.push("(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'"
        + " OR blocked_reason LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'"
        + " OR assignee_alias LIKE ? ESCAPE '\\' OR assignee_session LIKE ? ESCAPE '\\'"
        + " OR workspace LIKE ? ESCAPE '\\' OR depends_on LIKE ? ESCAPE '\\'"
        + " OR related_tasks LIKE ? ESCAPE '\\' OR created_by LIKE ? ESCAPE '\\')")
      values.push(like, like, like, like, like, like, like, like, like, like, like)
    }
    return { clause: where.length === 0 ? '' : ' WHERE ' + where.join(' AND '), values }
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
      const { clause, values } = boardFilterOf(query)
      const limit = clampInt(query.limit, 50, 1, 200)
      const offset = offsetOf(query.offset)
      const rows = db.prepare('SELECT * FROM boards' + clause
        + ' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?').all(...values, limit, offset)
      return rows.map(rowBoard)
    },
    /** Paginated board read; listBoards(query) keeps the legacy array shape. */
    listBoardsPage(query = {}) {
      const { clause, values } = boardFilterOf(query)
      const limit = clampInt(query.limit, 50, 1, 200)
      const offset = offsetOf(query.offset)
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM boards' + clause).get(...values)?.n ?? 0)
      const rows = db.prepare('SELECT * FROM boards' + clause
        + ' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?').all(...values, limit, offset)
      return { boards: rows.map(rowBoard), total, limit, offset, hasMore: offset + rows.length < total }
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
      const { clause, values } = taskFilterOf(query)
      const limit = clampInt(query.limit, 100, 1, 500)
      const offset = offsetOf(query.offset)
      const rows = db.prepare('SELECT * FROM tasks' + clause
        + ' ORDER BY priority DESC, updated_at DESC, id ASC LIMIT ? OFFSET ?').all(...values, limit, offset)
      return rows.map(rowTask)
    },
    /** Paginated task query; listTasks(query) keeps the legacy array shape. */
    listTasksPage(query = {}) {
      const { clause, values } = taskFilterOf(query)
      const limit = clampInt(query.limit, 100, 1, 500)
      const offset = offsetOf(query.offset)
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM tasks' + clause).get(...values)?.n ?? 0)
      const rows = db.prepare('SELECT * FROM tasks' + clause
        + ' ORDER BY priority DESC, updated_at DESC, id ASC LIMIT ? OFFSET ?').all(...values, limit, offset)
      return { tasks: rows.map(rowTask), total, limit, offset, hasMore: offset + rows.length < total }
    },
    updateTask(id, patch = {}, exec, options = {}) {
      const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      if (existing === undefined) throw codedError('NOT_FOUND', 'task not found: ' + id)
      if (options.operator !== true && !isTaskOwner(existing, exec)) {
        throw codedError('FORBIDDEN', 'updateTask: only the assignee, creator, or an operator may update this task')
      }
      assertStatus(patch.status)
      // Q3-A optimistic concurrency: expectedRevision is optional, but every
      // update is still a CAS on the revision read above. The legacy client
      // therefore cannot silently overwrite a newer write either.
      let expected = null
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== null) {
        const wanted = Number(patch.expectedRevision)
        if (!Number.isInteger(wanted) || wanted < 1) {
          throw codedError('INVALID_ARGUMENT', 'expectedRevision must be a positive integer')
        }
        expected = wanted
      }
      if (expected !== null && expected !== Number(existing.revision)) {
        throw codedError('CONFLICT', `revision mismatch: expected ${expected}, current ${existing.revision}`, {
          taskCode: 'CONFLICT', currentRevision: Number(existing.revision), currentTask: rowTask(existing),
        })
      }
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
      values.push(now(), id, existing.revision)
      const result = db.prepare('UPDATE tasks SET ' + fields.join(', ') + ' WHERE id=? AND revision=?').run(...values)
      if (result.changes === 0) {
        const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
        throw codedError('CONFLICT', 'revision changed concurrently', {
          taskCode: 'CONFLICT', currentRevision: current === undefined ? null : Number(current.revision), currentTask: rowTask(current),
        })
      }
      event(actorOf(exec), 'task.update', 'task', id, patch)
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    claimTask(id, assignee = {}, exec = {}, options = {}) {
      const caller = actorOf(exec)
      const callerAlias = actorAliasOf(exec)
      const operator = options.operator === true
      const requestedSession = typeof assignee?.session === 'string' && assignee.session.trim() !== ''
        ? assignee.session.trim() : null
      const requestedAlias = typeof assignee?.alias === 'string' && assignee.alias.trim() !== ''
        ? assignee.alias.trim() : null
      if (!operator) {
        if (caller === null) throw codedError('FORBIDDEN', 'claimTask: caller session is unavailable')
        if (requestedSession !== null && requestedSession !== caller) {
          throw codedError('FORBIDDEN', 'claimTask: a session may only claim a task for itself')
        }
        if (requestedAlias !== null && requestedAlias !== callerAlias) {
          throw codedError('FORBIDDEN', 'claimTask: a session may only claim a task under its own alias')
        }
      }
      const result = db.prepare(`UPDATE tasks SET status='in_progress', assignee_session=?, assignee_alias=?, updated_at=?, revision=revision+1
        WHERE id=? AND status='pending' AND (assignee_session IS NULL OR assignee_session='')`).run(
        calledSession(operator, requestedSession, caller), calledAlias(operator, requestedAlias, callerAlias), now(), id,
      )
      if (result.changes === 0) {
        throw codedError('CONFLICT', 'task is not claimable (not pending or already assigned)', { taskCode: 'CONFLICT' })
      }
      event(actorOf(exec), 'task.claim', 'task', id, { session: calledSession(operator, requestedSession, caller), alias: calledAlias(operator, requestedAlias, callerAlias) })
      return rowTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    },
    completeTask(id, exec = {}, options = {}) {
      const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      if (existing === undefined) throw codedError('NOT_FOUND', 'task not found: ' + id)
      const caller = actorOf(exec)
      const callerAlias = actorAliasOf(exec)
      if (options.operator !== true) {
        if (typeof existing.assignee_session === 'string' && existing.assignee_session !== '') {
          if (caller === null || existing.assignee_session !== caller) {
            throw codedError('FORBIDDEN', 'completeTask: only the assignee may complete this task')
          }
        } else if (typeof existing.assignee_alias === 'string' && existing.assignee_alias !== '') {
          if (callerAlias === null || existing.assignee_alias !== callerAlias) {
            throw codedError('FORBIDDEN', 'completeTask: only the assignee may complete this task')
          }
        } else if (typeof existing.created_by === 'string' && existing.created_by !== '') {
          if (caller === null || existing.created_by !== caller) {
            throw codedError('FORBIDDEN', 'completeTask: only the creator or an operator may complete an unassigned task')
          }
        } else {
          throw codedError('FORBIDDEN', 'completeTask: task has no owner; an operator must complete it')
        }
      }
      const result = db.prepare(`UPDATE tasks SET status='completed', updated_at=?, revision=revision+1
        WHERE id=? AND revision=?`).run(now(), id, existing.revision)
      if (result.changes === 0) {
        const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
        throw codedError('CONFLICT', 'revision changed concurrently', {
          taskCode: 'CONFLICT', currentRevision: current === undefined ? null : Number(current.revision), currentTask: rowTask(current),
        })
      }
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
