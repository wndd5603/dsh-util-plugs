// DSH bulletin board / task board host plugin. One SQLite board shared by all
// sessions; every write records the caller session as actor.
import { createStore, STATUSES } from './src/store.js'

export const inject = ['tools']

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

export function apply(ctx) {
  const store = createStore(process.env.DSH_BULLETIN_DB || undefined)
  ctx.effect(() => () => store.close())

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
    status: statusProp, workspace: str('Filter by workspace.'), limit: num('Max rows (1-200).'),
  }), async (args) => ({ boards: store.listBoards(args) }))

  register(describe('bulletin_board_get', 'Read one bulletin board.', { boardId: str('Board id.') }, ['boardId']), async args => {
    const board = store.getBoard(args.boardId)
    if (board === null) throw new Error('board not found: ' + args.boardId)
    return { board, tasks: store.listTasks({ boardId: args.boardId, limit: 500 }) }
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

  register(describe('bulletin_task_update', 'Update a task; status transitions are validated.', {
    taskId: str('Task id.'), title: str('Title.'), description: str('Description.'), status: statusProp,
    assigneeSession: str('Assigned session id.'), assigneeAlias: str('Assigned alias.'), workspace: str('Workspace.'),
    priority: num('Priority.'), dependsOn: arr('Dependency ids.'), relatedTasks: arr('Related ids.'),
    blockedReason: str('Reason when status=blocked.'), metadata: { type: 'object', additionalProperties: true },
  }, ['taskId']), async (args, exec) => store.updateTask(args.taskId, args, exec))

  register(describe('bulletin_task_list', 'Query tasks by board/status/workspace/assignee.', {
    boardId: str('Board id.'), status: statusProp, workspace: str('Workspace.'),
    assigneeSession: str('Session id.'), assigneeAlias: str('Alias.'), limit: num('Max rows (1-500).'),
  }), async args => ({ tasks: store.listTasks(args) }))

  register(describe('bulletin_task_claim', 'Atomically claim a pending task for the caller.', {
    taskId: str('Task id.'), assigneeSession: str('Optional explicit session id.'), assigneeAlias: str('Optional alias.'),
  }, ['taskId']), async (args, exec) => {
    const a = actor(exec)
    return store.claimTask(args.taskId, { session: args.assigneeSession ?? a.session, alias: args.assigneeAlias ?? a.alias }, exec)
  })

  register(describe('bulletin_task_complete', 'Mark a task completed.', { taskId: str('Task id.') }, ['taskId']), async (args, exec) => store.completeTask(args.taskId, exec))

  register(describe('bulletin_digest', 'Tasks related to the caller: assignee, workspace, or explicit session/alias.', {
    session: str('Optional session id; defaults to caller.'), alias: str('Optional alias.'), workspace: str('Optional workspace.'),
  }), async (args, exec) => {
    const a = actor(exec)
    return { tasks: store.digest({ session: args.session ?? a.session, alias: args.alias ?? a.alias, workspace: args.workspace ?? a.cwd }) }
  })
}
