// DSH bulletin board: boards + tasks shared across sessions/agents.
// Zero npm dependencies: node:sqlite only.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const STATUSES = ['pending', 'in_progress', 'blocked', 'suspended', 'completed', 'terminated']
// P2-1: completed is reachable only from an active state. `terminated` (and an
// already-`completed` task) cannot be completed again.
export const COMPLETABLE_STATUSES = ['pending', 'in_progress', 'blocked', 'suspended']
// P2-3: terminated is a terminal write too; only an active task may be
// terminated (never a completed or already-terminated one).
export const TERMINABLE_STATUSES = ['pending', 'in_progress', 'blocked', 'suspended']
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
export function createStore(dbPath, options = {}) {
  const db = open(dbPath)
  const actorOf = (exec) => {
    const s = exec?.agent?.session
    return s?.id ?? null
  }
  const actorAliasOf = (exec) => {
    const header = exec?.agent?.session?.header ?? {}
    return header.alias ?? exec?.agent?.alias ?? null
  }
  // P2-2: an alias is a route key, not proof of ownership. `resolveAlias` is
  // wired to the host sessionDirectory; without a resolvable route an
  // alias-only assignment grants no authority (only an operator can act).
  const aliasRouteSession = (alias) => {
    if (typeof options.resolveAlias !== 'function' || typeof alias !== 'string' || alias === '') return null
    let route
    try { route = options.resolveAlias(alias) } catch { return null }
    if (route === null || route === undefined) return null
    const sessionId = typeof route.sessionId === 'string' ? route.sessionId
      : typeof route.session_id === 'string' ? route.session_id : null
    return sessionId === '' ? null : sessionId
  }
  // P1-1: the assignee boundary is shared by completeTask and
  // updateTask(status=completed); creator ownership is deliberately excluded.
  const isAssignee = (existing, exec) => {
    const caller = actorOf(exec)
    const callerAlias = actorAliasOf(exec)
    const assigneeSession = typeof existing.assignee_session === 'string' && existing.assignee_session !== ''
      ? existing.assignee_session : null
    if (assigneeSession !== null) return caller !== null && caller === assigneeSession
    const assigneeAlias = typeof existing.assignee_alias === 'string' && existing.assignee_alias !== ''
      ? existing.assignee_alias : null
    if (assigneeAlias === null || callerAlias === null || callerAlias !== assigneeAlias) return false
    return caller !== null && aliasRouteSession(assigneeAlias) === caller
  }
  // P1-1: updateTask must enforce the same owner boundary as completeTask.
  // A normal caller may only mutate a task it owns (assignee, or a
  // route-verified legacy alias-assignee) or created; operators may override.
  const isTaskOwner = (existing, exec) => {
    if (isAssignee(existing, exec)) return true
    const caller = actorOf(exec)
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
  // P1-4: digest SLA filters are measured from updated_at. The board schema has
  // no due date, so none is invented here.
  const instantOf = value => {
    if (value === undefined || value === null || value === '') return null
    const parsed = typeof value === 'number' ? value : Date.parse(String(value))
    if (!Number.isFinite(parsed)) {
      throw codedError('INVALID_ARGUMENT', 'updatedBefore must be a parseable ISO timestamp')
    }
    return new Date(parsed).toISOString()
  }
  const hoursOf = value => {
    if (value === undefined || value === null || value === '') return null
    const hours = Number(value)
    if (!Number.isFinite(hours) || hours <= 0) {
      throw codedError('INVALID_ARGUMENT', 'staleAfterHours must be a positive number of hours')
    }
    return hours
  }
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
  // P1-4: blocked/stale recall digest. Read-only; the legacy
  // session/alias/workspace scope stays OR (unchanged), while every new filter
  // is an additional AND. `bulletin_task_list` keeps using taskFilterOf.
  const digestFilterOf = (query = {}) => {
    const status = typeof query.status === 'string' && query.status !== '' ? query.status : null
    if (status !== null) assertStatus(status)
    const before = instantOf(query.updatedBefore)
    const staleHours = hoursOf(query.staleAfterHours)
    if (before !== null && staleHours !== null) {
      throw codedError('INVALID_ARGUMENT', 'updatedBefore and staleAfterHours are mutually exclusive')
    }
    const threshold = before !== null ? before
      : staleHours !== null ? new Date(Date.now() - staleHours * 3600000).toISOString() : null
    const scope = []
    const values = []
    if (query.session) { scope.push('assignee_session = ?'); values.push(query.session) }
    if (query.alias) { scope.push('assignee_alias = ?'); values.push(query.alias) }
    if (query.workspace) { scope.push('workspace = ?'); values.push(query.workspace) }
    if (scope.length === 0) return null
    // Terminal tasks are never recalled, even when old. `blocked` is
    // non-terminal, so the blocked branch remains; the stale branch explicitly
    // excludes both terminal states.
    if (status === 'completed' || status === 'terminated') return null
    const where = ['(' + scope.join(' OR ') + ')']
    if (status === 'blocked') {
      where.push('status = ?')
      values.push('blocked')
      if (threshold !== null) { where.push('updated_at < ?'); values.push(threshold) }
    } else if (status !== null) {
      // A non-blocked status is only interesting when it is stale; without an
      // SLA there is no blocked-or-stale hit to return.
      if (threshold === null) return null
      where.push('status = ?')
      values.push(status)
      where.push('updated_at < ?')
      values.push(threshold)
    } else if (threshold === null) {
      where.push("status = 'blocked'")
    } else {
      where.push("(status = 'blocked' OR (updated_at < ? AND status NOT IN ('completed','terminated')))")
      values.push(threshold)
    }
    if (typeof query.boardId === 'string' && query.boardId !== '') {
      where.push('board_id = ?')
      values.push(query.boardId)
    }
    const assignee = typeof query.assignee === 'string' ? query.assignee.trim() : ''
    if (assignee !== '') {
      where.push('(assignee_session = ? OR assignee_alias = ?)')
      values.push(assignee, assignee)
    }
    return { clause: where.join(' AND '), values }
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
      const operator = options.operator === true
      if (!operator && !isTaskOwner(existing, exec)) {
        throw codedError('FORBIDDEN', 'updateTask: only the assignee, creator, or an operator may update this task')
      }
      assertStatus(patch.status)
      // P1-1: creator ownership is not a completion bypass. `status=completed`
      // follows the same assignee-only boundary as completeTask.
      if (patch.status === 'completed' && !operator && !isAssignee(existing, exec)) {
        throw codedError('FORBIDDEN', 'updateTask: status=completed is assignee-only; claim the task first or ask an operator to override')
      }
      // P1-1: reassignment is an explicit operator action, so a creator cannot
      // hand a task to another session as a completion shortcut.
      if (!operator && (patch.assigneeSession !== undefined || patch.assigneeAlias !== undefined)) {
        throw codedError('FORBIDDEN', 'updateTask: assignee changes require a danger-full-access operator')
      }
      // P2-3 (CR3 final): a creator may not terminate an assignee's claimed
      // task (task-board DoS). Terminal writes on an assigned task follow the
      // same assignee boundary as completion; an operator can still override.
      const assigned = (typeof existing.assignee_session === 'string' && existing.assignee_session !== '')
        || (typeof existing.assignee_alias === 'string' && existing.assignee_alias !== '')
      if (patch.status === 'terminated' && !operator && assigned && !isAssignee(existing, exec)) {
        throw codedError('FORBIDDEN', 'updateTask: status=terminated on an assigned task is assignee-only; ask an operator to override')
      }
      // P2-3: minimal state matrix for the other terminal state.
      if (patch.status === 'terminated' && !TERMINABLE_STATUSES.includes(existing.status)) {
        throw codedError('CONFLICT', 'invalid status transition: ' + existing.status + ' -> terminated', {
          taskCode: 'CONFLICT', currentStatus: existing.status, currentTask: rowTask(existing),
        })
      }
      // P2-1: completed is only reachable from an active state.
      if (patch.status === 'completed' && !COMPLETABLE_STATUSES.includes(existing.status)) {
        throw codedError('CONFLICT', 'invalid status transition: ' + existing.status + ' -> completed', {
          taskCode: 'CONFLICT', currentStatus: existing.status, currentTask: rowTask(existing),
        })
      }
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
      const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      if (existing === undefined) throw codedError('NOT_FOUND', 'task not found: ' + id)
      if (existing.status !== 'pending') {
        throw codedError('CONFLICT', 'task is not claimable (not pending or already assigned)', { taskCode: 'CONFLICT' })
      }
      const assignedSession = typeof existing.assignee_session === 'string' && existing.assignee_session !== ''
        ? existing.assignee_session : null
      const assignedAlias = typeof existing.assignee_alias === 'string' && existing.assignee_alias !== ''
        ? existing.assignee_alias : null
      if (assignedSession !== null) {
        throw codedError('CONFLICT', 'task is not claimable (already assigned to a session)', { taskCode: 'CONFLICT' })
      }
      // P2-2 (CR3 final): an alias pre-assignment is a reservation, not a free
      // task. A normal caller may claim it only when its own alias is that
      // alias AND the host route still resolves that alias to this session;
      // otherwise arbitrary sessions could steal alias-assigned work.
      if (!operator && assignedAlias !== null) {
        if (callerAlias === null || callerAlias !== assignedAlias) {
          throw codedError('FORBIDDEN', 'claimTask: task is pre-assigned to another alias', { taskCode: 'FORBIDDEN' })
        }
        if (caller === null || aliasRouteSession(assignedAlias) !== caller) {
          throw codedError('FORBIDDEN', 'claimTask: alias route does not resolve to the caller', { taskCode: 'FORBIDDEN' })
        }
      }
      // The WHERE still guards every mutable precondition and pins the revision,
      // so an update/claim cannot slip between the checks above and this write.
      const aliasGuard = operator
        ? ''
        : " AND (assignee_alias IS NULL OR assignee_alias='' OR assignee_alias=?)"
      const params = [
        calledSession(operator, requestedSession, caller),
        calledAlias(operator, requestedAlias, callerAlias),
        now(), id, existing.revision,
      ]
      if (!operator) params.push(requestedAlias ?? callerAlias ?? '')
      const result = db.prepare(`UPDATE tasks SET status='in_progress', assignee_session=?, assignee_alias=?, updated_at=?, revision=revision+1
        WHERE id=? AND revision=? AND status='pending'
          AND (assignee_session IS NULL OR assignee_session='')${aliasGuard}`).run(...params)
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
          // P2-2: the alias must resolve to this caller through the host route.
          const routeSession = aliasRouteSession(existing.assignee_alias)
          if (callerAlias === null || existing.assignee_alias !== callerAlias
            || caller === null || routeSession !== caller) {
            throw codedError('FORBIDDEN', 'completeTask: only the route-verified assignee may complete this task')
          }
        } else if (typeof existing.created_by === 'string' && existing.created_by !== '') {
          if (caller === null || existing.created_by !== caller) {
            throw codedError('FORBIDDEN', 'completeTask: only the creator or an operator may complete an unassigned task')
          }
        } else {
          throw codedError('FORBIDDEN', 'completeTask: task has no owner; an operator must complete it')
        }
      }
      // P2-1: terminated/completed tasks cannot transition to completed again.
      if (!COMPLETABLE_STATUSES.includes(existing.status)) {
        throw codedError('CONFLICT', 'invalid status transition: ' + existing.status + ' -> completed', {
          taskCode: 'CONFLICT', currentStatus: existing.status, currentTask: rowTask(existing),
        })
      }
      const result = db.prepare(`UPDATE tasks SET status='completed', updated_at=?, revision=revision+1
        WHERE id=? AND revision=? AND status IN (?,?,?,?)`).run(now(), id, existing.revision, ...COMPLETABLE_STATUSES)
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
      const filter = digestFilterOf(query)
      if (filter === null) return []
      const rows = db.prepare('SELECT * FROM tasks WHERE ' + filter.clause
        + ' ORDER BY priority DESC, updated_at DESC, id ASC LIMIT 200').all(...filter.values)
      return rows.map(rowTask)
    },
  }
}
