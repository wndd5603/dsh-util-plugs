// DSH bulletin board / task board host plugin. One SQLite board shared by all
// sessions; every write records the caller session as actor.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createStore, STATUSES } from './src/store.js'

export const inject = ['tools', 'agents']

const REMOTE_SERVICE_KEY = 'bulletinBoardRemote'
const REMOTE_NAMESPACE = 'bulletinBoard'
const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const REMOTE_METHODS = Object.freeze([
  Object.freeze({ method: 'overview', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'boards', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'tasks', invocation: Object.freeze({ kind: 'direct' }) }),
])

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}
const describe = (name, description, properties, required = []) => ({
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  output: jsonOutput,
  presentCall: () => ({ card: 'generic', title: name, kind: 'read' }),
})
const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const arr = description => ({ type: 'array', items: { type: 'string' }, description })
const statusProp = { type: 'string', enum: STATUSES, description: 'Task/board status.' }
const actor = exec => {
  const session = exec?.agent?.session
  return { session: session?.id ?? null, alias: session?.header?.alias ?? null, cwd: session?.header?.cwd ?? null }
}
const fileTime = file => {
  try { return statSync(file).mtimeMs } catch { return 0 }
}
const readProgress = (dir) => {
  const out = []
  let names = []
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')) } catch { return out }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      out.push({ file, ...raw })
    } catch { /* ignore malformed progress */ }
  }
  return out
}
const classifyProgress = ({ progress, live, now, staleMs }) => {
  if (progress === undefined) return live ? 'starting' : 'unknown'
  if (progress.state === 'failed') return 'failed'
  if (progress.state === 'completed' || progress.state === 'done') return 'completed'
  const updatedAt = Date.parse(progress.heartbeatAt ?? progress.updatedAt ?? '') || fileTime(progress.file)
  if (updatedAt > 0 && now - updatedAt > staleMs) return 'stalled'
  if (live) return 'running'
  return 'inactive'
}

export function apply(ctx) {
  const store = createStore(process.env.DSH_BULLETIN_DB || undefined)
  ctx.effect(() => () => store.close())

  const isOperator = exec => {
    try {
      const policy = ctx.get?.('sandboxPolicy')
      const resolved = policy?.resolve?.({ session: exec?.agent?.session })
      return resolved?.mode === 'danger-full-access'
    } catch {
      return false
    }
  }

  const register = (descriptor, execute) => ctx.tools.register({ ...descriptor, execute })

  register(describe('bulletin_board_create', 'Create a bulletin board / task board.', {
    title: str('Board title.'), description: str('Optional description.'),
    workspace: str('Associated workspace path.'), priority: num('Priority (higher first).'),
    labels: arr('Labels.'),
  }, ['title']), async (args, exec) => {
    const a = actor(exec)
    return store.createBoard({ ...args, workspace: args.workspace ?? a.cwd, ownerSession: a.session }, exec)
  })

  register(describe('bulletin_board_list', 'List bulletin boards.', {
    status: statusProp, workspace: str('Filter by workspace.'),
    query: str('Keyword search over id/title/description/workspace.'),
    limit: num('Max rows (1-200).'), offset: num('Row offset (default 0).'),
  }), async (args) => store.listBoardsPage(args))

  register(describe('bulletin_board_get', 'Read one bulletin board.', {
    boardId: str('Board id.'), taskLimit: num('Task rows to return (1-500, default 500).'),
    taskOffset: num('Task row offset (default 0).'),
  }, ['boardId']), async args => {
    const board = store.getBoard(args.boardId)
    if (board === null) throw new Error('board not found: ' + args.boardId)
    const page = store.listTasksPage({
      boardId: args.boardId,
      limit: args.taskLimit ?? 500,
      offset: args.taskOffset ?? 0,
    })
    return {
      board,
      tasks: page.tasks,
      taskTotal: page.total,
      taskOffset: page.offset,
      taskLimit: page.limit,
      tasksTruncated: page.hasMore,
    }
  })

  register(describe('bulletin_task_add', 'Add a task to a board.', {
    boardId: str('Board id.'), title: str('Task title.'), description: str('Optional description.'),
    status: statusProp, assigneeSession: str('Assigned session id.'), assigneeAlias: str('Assigned alias.'),
    workspace: str('Associated workspace.'), priority: num('Priority.'), dependsOn: arr('Dependency task ids.'),
    relatedTasks: arr('Related task ids.'), metadata: { type: 'object', additionalProperties: true, description: 'Free metadata.' },
  }, ['boardId', 'title']), async (args, exec) => {
    const a = actor(exec)
    return store.addTask(args.boardId, { ...args, workspace: args.workspace ?? a.cwd }, exec)
  })

  register(describe('bulletin_task_update', 'Update a task; only the assignee, creator, or a danger-full-access operator '
    + 'may update it (others get FORBIDDEN). status transitions are validated. expectedRevision enables '
    + 'optimistic concurrency: a stale or mismatched revision returns CONFLICT with currentRevision.', {
    taskId: str('Task id.'), title: str('Title.'), description: str('Description.'), status: statusProp,
    assigneeSession: str('Assigned session id.'), assigneeAlias: str('Assigned alias.'), workspace: str('Workspace.'),
    priority: num('Priority.'), dependsOn: arr('Dependency ids.'), relatedTasks: arr('Related ids.'),
    blockedReason: str('Reason when status=blocked.'), metadata: { type: 'object', additionalProperties: true },
    expectedRevision: num('Optional current revision; mismatch returns CONFLICT.'),
  }, ['taskId']), async (args, exec) => store.updateTask(args.taskId, args, exec, { operator: isOperator(exec) }))

  register(describe('bulletin_task_list', 'Query tasks by board/status/workspace/assignee.', {
    boardId: str('Board id.'), status: statusProp, workspace: str('Workspace.'),
    assigneeSession: str('Session id.'), assigneeAlias: str('Alias.'),
    query: str('Keyword search over id/title/description/blockedReason/metadata/assignee/workspace/dependencies/createdBy.'),
    limit: num('Max rows (1-500).'), offset: num('Row offset (default 0).'),
  }), async args => store.listTasksPage(args))

  register(describe('bulletin_task_claim', 'Atomically claim a pending task for the caller. A normal caller may not '
    + 'claim on behalf of another session/alias (FORBIDDEN); an operator may delegate.', {
    taskId: str('Task id.'), assigneeSession: str('Optional explicit session id (operator only; a non-self value is rejected).'),
    assigneeAlias: str('Optional alias (operator only; a non-self value is rejected).'),
  }, ['taskId']), async (args, exec) => {
    const a = actor(exec)
    return store.claimTask(args.taskId, { session: args.assigneeSession ?? a.session, alias: args.assigneeAlias ?? a.alias }, exec, { operator: isOperator(exec) })
  })

  register(describe('bulletin_task_complete', 'Mark a task completed. Only the assignee (or, for legacy unassigned '
    + 'tasks, the creator) may complete it; danger-full-access operators may override.', { taskId: str('Task id.') }, ['taskId']),
  async (args, exec) => store.completeTask(args.taskId, exec, { operator: isOperator(exec) }))

  register(describe('bulletin_digest', 'Tasks related to the caller: assignee, workspace, or explicit session/alias.', {
    session: str('Optional session id; defaults to caller.'), alias: str('Optional alias.'), workspace: str('Optional workspace.'),
  }), async (args, exec) => {
    const a = actor(exec)
    return { tasks: store.digest({ session: args.session ?? a.session, alias: args.alias ?? a.alias, workspace: args.workspace ?? a.cwd }) }
  })

  // Heartbeat read model for Lead orchestration: subagents write
  // team/progress/<sessionId>.json periodically; this tool combines it with the
  // live agent roster and a stale threshold so "silent but working" is not
  // mistaken for "stuck".
  register(describe('agent_progress', 'Classify subagents as starting/running/stalled/inactive/failed from live agents + team/progress heartbeat files.', {
    workspace: str('Workspace root; progress files are read from <workspace>/team/progress/*.json.'),
    sessionId: str('Optional single session id filter.'),
    staleMs: num('No-heartbeat threshold in ms (default 300000).'),
  }), async (args, exec) => {
    const a = actor(exec)
    const root = args.workspace ?? a.cwd
    const now = Date.now()
    const staleMs = Number.isFinite(Number(args.staleMs)) ? Math.max(1000, Number(args.staleMs)) : 300000
    let agents = []
    try {
      const service = ctx.get?.('agents')
      agents = typeof service?.list === 'function' ? service.list() : []
    } catch { agents = [] }
    const live = new Map(agents.map(agent => [agent?.session?.id, agent?.status ?? 'running']))
    const progress = root === null || root === undefined ? [] : readProgress(join(root, 'team', 'progress'))
    const bySession = new Map(progress.filter(p => typeof p.sessionId === 'string').map(p => [p.sessionId, p]))
    const ids = new Set([...live.keys(), ...bySession.keys()])
    if (typeof args.sessionId === 'string' && args.sessionId !== '') ids.add(args.sessionId)
    const items = [...ids].filter(Boolean).map(sessionId => {
      const p = bySession.get(sessionId)
      const state = classifyProgress({ progress: p, live: live.has(sessionId), now, staleMs })
      return {
        sessionId,
        state,
        live: live.has(sessionId),
        agentStatus: live.get(sessionId) ?? null,
        phase: p?.phase ?? null,
        step: p?.step ?? null,
        note: p?.note ?? null,
        heartbeatAt: p?.heartbeatAt ?? p?.updatedAt ?? null,
        progressFile: p?.file ?? null,
      }
    })
    return { ok: true, workspace: root, staleMs, items, counts: Object.fromEntries(['running', 'starting', 'stalled', 'inactive', 'failed', 'completed', 'unknown'].map(state => [state, items.filter(i => i.state === state).length])) }
  })

  // Read-only Web Remote for the Agent Network console section.
  class BulletinBoardRemote {
    overview() {
      const boardsPage = store.listBoardsPage({ limit: 100 })
      const tasksPage = store.listTasksPage({ limit: 500 })
      return {
        boards: boardsPage.boards,
        tasks: tasksPage.tasks,
        boardsTotal: boardsPage.total,
        tasksTotal: tasksPage.total,
        counts: Object.fromEntries(STATUSES.map(s => [s, tasksPage.tasks.filter(t => t.status === s).length])),
      }
    }
    boards(query) { return store.listBoardsPage(query ?? {}) }
    tasks(query) { return store.listTasksPage(query ?? {}) }
  }
  Object.defineProperty(BulletinBoardRemote.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
    configurable: true, enumerable: false, value: Object.freeze({ version: 1, methods: REMOTE_METHODS }),
  })
  const remote = new BulletinBoardRemote()
  Object.defineProperty(remote, 'typertRemote', {
    configurable: false, enumerable: true, writable: false,
    value: Object.freeze({ service: remote, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE }),
  })
  try {
    if (typeof ctx.provide === 'function') ctx.provide(REMOTE_SERVICE_KEY, remote)
  } catch { /* older host without provide: tools still work */ }
}
