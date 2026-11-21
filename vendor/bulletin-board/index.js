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
  // P2-2: alias ownership follows the host alias route (sessionDirectory), not
  // a bare header string. When the host exposes no directory the store denies
  // alias-only authority; operators can still override.
  const resolveAlias = alias => {
    try { return ctx.get?.('sessionDirectory')?.resolve?.(alias) ?? null } catch { return null }
  }
  const store = createStore(process.env.DSH_BULLETIN_DB || undefined, { resolveAlias })
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
    + 'may update it (others get FORBIDDEN). status=completed is assignee-only (the creator cannot bypass '
    + 'bulletin_task_complete) and completed is only reachable from pending/in_progress/blocked/suspended; '
    + 'status=terminated on an assigned task is assignee-only and terminated is only reachable from an active state; '
    + 'assignee changes require a danger-full-access operator. expectedRevision enables '
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
    + 'claim on behalf of another session/alias (FORBIDDEN); an alias pre-assigned task may only be claimed by the '
    + 'session its host alias route points at; an operator may delegate.', {
    taskId: str('Task id.'), assigneeSession: str('Optional explicit session id (operator only; a non-self value is rejected).'),
    assigneeAlias: str('Optional alias (operator only; a non-self value is rejected).'),
  }, ['taskId']), async (args, exec) => {
    const a = actor(exec)
    return store.claimTask(args.taskId, { session: args.assigneeSession ?? a.session, alias: args.assigneeAlias ?? a.alias }, exec, { operator: isOperator(exec) })
  })

  register(describe('bulletin_task_complete', 'Mark a task completed with artifact evidence. Only the assignee (or, for legacy unassigned '
    + 'tasks, the creator) may complete it; danger-full-access operators may override. Evidence {artifactId, sha256 (64 hex), checkResult} is required.', {
    taskId: str('Task id.'),
    evidence: {
      type: 'object',
      description: 'Completion evidence; required. sha256 must be a 64-char hex digest.',
      properties: {
        artifactId: str('Artifact identifier/path/hash key.'),
        sha256: str('SHA-256 of the artifact (64 hex chars).'),
        checkResult: str('Human/machine-readable verification result, e.g. PASS or a check summary.'),
      },
      required: ['artifactId', 'sha256', 'checkResult'],
      additionalProperties: false,
    },
  }, ['taskId', 'evidence']),
  async (args, exec) => store.completeTask(args.taskId, exec, { operator: isOperator(exec), evidence: args.evidence }))

  register(describe('bulletin_digest', 'Read-only recall digest of tasks related to the caller (assignee, workspace, '
    + 'or explicit session/alias) that are blocked or stale. Stale is an SLA measured from updated_at; the board has '
    + 'no dueAt and none is fabricated. completed/terminated tasks never match. Without an explicit SLA the default '
    + 'staleAfterHours=24 is applied, so a caller does not need to remember an SLA; with updatedBefore/staleAfterHours '
    + 'the result is blocked OR stale, and status narrows it. New filters AND with the legacy session/alias/workspace OR scope.', {
    session: str('Optional session id; defaults to caller.'), alias: str('Optional alias.'), workspace: str('Optional workspace.'),
    status: statusProp, boardId: str('Optional board id filter.'),
    assignee: str('Optional assignee filter; matches assignee session or alias.'),
    updatedBefore: str('Optional ISO timestamp: only tasks whose updated_at is strictly before it. Mutually exclusive with staleAfterHours.'),
    staleAfterHours: num('Optional SLA in hours based on updated_at: tasks not updated for more than this many hours count as stale. Mutually exclusive with updatedBefore.'),
  }), async (args, exec) => {
    const a = actor(exec)
    const hasExplicitSla = args.updatedBefore !== undefined || args.staleAfterHours !== undefined
    const staleAfterHours = hasExplicitSla ? args.staleAfterHours : 24
    const tasks = store.digest({
      session: args.session ?? a.session,
      alias: args.alias ?? a.alias,
      workspace: args.workspace ?? a.cwd,
      status: args.status,
      boardId: args.boardId,
      assignee: args.assignee,
      updatedBefore: args.updatedBefore,
      staleAfterHours,
    })
    return {
      ok: true,
      tasks,
      matched: tasks.length,
      staleAfterHours: staleAfterHours ?? null,
      asOf: new Date().toISOString(),
      empty: tasks.length === 0,
      emptyReason: tasks.length === 0 ? 'no-blocked-or-stale-tasks-for-scope' : null,
    }
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
      // R1: one read transaction keeps the board page, task page and full
      // status aggregate on the same snapshot, so counts always sum to
      // tasksTotal even while another session writes.
      store.db.exec('BEGIN')
      try {
        const boardsPage = store.listBoardsPage({ limit: 100 })
        const tasksPage = store.listTasksPage({ limit: 500 })
        // Counts are a full-table aggregate, not a filter over the first
        // 500-row snapshot. `tasks` stays the bounded first page, and
        // tasksTruncated tells the caller to page the rest via Remote.tasks().
        const counts = Object.fromEntries(STATUSES.map(status => [status, 0]))
        for (const row of store.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all()) {
          if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.n)
        }
        return {
          boards: boardsPage.boards,
          tasks: tasksPage.tasks,
          boardsTotal: boardsPage.total,
          tasksTotal: tasksPage.total,
          tasksLimit: tasksPage.limit,
          tasksOffset: tasksPage.offset,
          tasksTruncated: tasksPage.hasMore,
          counts,
        }
      } finally {
        store.db.exec('COMMIT')
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
