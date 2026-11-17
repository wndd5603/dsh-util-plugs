// DSH Agent Apartment host plugin: centralized agent homes, leases, teams,
// task-role bindings, experience and root backup/migration.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApartment, getActiveRoot, setActiveRoot } from './src/store.js'
import { buildBindingCandidates, buildBindingList, buildCollaborationBrief, buildDriftReport, COLLAB_ERROR_CODES, lookupBulletinTask } from './src/collab.js'
import { createCollabInjector } from './src/inject.js'
import { boolean, number, objectSchema, string } from './lib/standard-schema.js'

// Public constants for callers/tests that need the P0 collaboration contract.
export { COLLAB_ERROR_CODES, MAX_ALIAS_LENGTH } from './src/collab.js'

export const inject = ['tools', 'agents']

const REMOTE_SERVICE_KEY = 'agentApartmentRemote'
const REMOTE_NAMESPACE = 'agentApartment'
const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const REMOTE_METHODS = [
  { method: 'status', invocation: { kind: 'direct' } },
  { method: 'setRoot', invocation: { kind: 'direct' } },
  { method: 'migrate', invocation: { kind: 'direct' } },
  { method: 'backup', invocation: { kind: 'direct' } },
  { method: 'restore', invocation: { kind: 'direct' } },
  { method: 'verify', invocation: { kind: 'direct' } },
  { method: 'data', invocation: { kind: 'direct' } },
]

export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register apartment tools.' }),
  root: string('', {
    description: 'Apartment root. Empty = $DSH_HOME/apartment; a runtime pointer written by apartment_set_root/migrate wins.',
    volatile: true,
  }),
  backupKeep: number(5, { description: 'Number of backup snapshots to retain.', int: true, min: 1, max: 100 }),
  backupMaxAgeDays: number(8, { description: 'Maximum age in days of the latest normal backup before apartment_backup_verify reports it stale.', int: true, min: 1, max: 365 }),
  briefInjection: boolean(true, { description: 'Inject one collaboration-brief line once per bound session on agent/pre-step.' }),
}, { description: 'Centralized Agent Apartment configuration.', schemaVersion: 1 })

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

export function apply(ctx, config) {
  const cfg = config ?? {}
  if (cfg.enabled === false) return
  const root = getActiveRoot(typeof cfg.root === 'string' && cfg.root !== '' ? cfg.root : undefined)
  const apartment = createApartment({
    root,
    backupKeep: cfg.backupKeep,
    backupMaxAgeMs: typeof cfg.backupMaxAgeDays === 'number' ? cfg.backupMaxAgeDays * 24 * 60 * 60 * 1000 : undefined,
  })
  // A root pointer move is only fully effective after the Host restarts and
  // reopens the apartment at the new root. Until then every write is blocked so
  // no data can fork into the old root; reads stay available.
  let migrationPending = false
  let pendingRoot = null
  const markMigrationPending = target => { migrationPending = true; pendingRoot = target }
  const assertWritable = action => {
    if (!migrationPending) return
    const error = new Error('apartment: ' + action + ' is blocked because the apartment root moved to '
      + (pendingRoot ?? 'a new root') + '; restart the DSH Host before writing')
    error.code = 'APARTMENT_RESTART_REQUIRED'
    error.pendingRoot = pendingRoot
    throw error
  }
  const lifecycle = () => ({ migrationPending, pendingRoot, restartRequired: migrationPending })
  const register = (descriptor, execute) => ctx.tools.register({ ...descriptor, execute })
  ctx.effect(() => () => apartment.close())
  const assertOperator = (exec) => {
    let mode
    try {
      mode = ctx.get?.('sandboxPolicy')?.resolve?.({ session: exec?.agent?.session })?.mode
    } catch { mode = undefined }
    if (mode !== 'danger-full-access') {
      const error = new Error('apartment: operator-only action requires danger-full-access')
      error.code = 'APARTMENT_OPERATOR_REQUIRED'
      throw error
    }
  }
  const assertRemoteOperator = () => {
    if (process.env.DSH_APARTMENT_ALLOW_WEB_MUTATION !== 'true') {
      const error = new Error('apartment: Web mutation is read-only by default; use apartment_* tools or set DSH_APARTMENT_ALLOW_WEB_MUTATION=true')
      error.code = 'APARTMENT_WEB_READ_ONLY'
      throw error
    }
    let mode
    try { mode = ctx.get?.('sandboxPolicy')?.resolve?.({})?.mode } catch { mode = undefined }
    if (mode !== 'danger-full-access') {
      const error = new Error('apartment: remote mutation requires a danger-full-access operator session')
      error.code = 'APARTMENT_OPERATOR_REQUIRED'
      throw error
    }
  }
  const codedError = (code, message) => {
    const error = new Error(message)
    error.code = code
    return error
  }
  const callerSessionId = exec => {
    const session = exec?.agent?.session
    for (const value of [session?.id, session?.sessionId, exec?.agent?.sessionId, exec?.session?.id]) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return null
  }
  const profileDir = (() => {
    try {
      const dir = ctx.get?.('profileContext')?.dir
      if (typeof dir === 'string' && dir.trim() !== '') return dir.trim()
    } catch { /* profile context is optional */ }
    return typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.trim() !== ''
      ? process.env.DSH_PROFILE_DIR.trim()
      : undefined
  })()
  const resolveLiveSession = sessionId => {
    try {
      return ctx.get?.('agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }
  // Read-only source for onboarding candidates. ctx.agents.list() is the live
  // registry; a missing service is an empty list, never a write. A throwing
  // registry is surfaced by buildBindingCandidates as a warning.
  const listLiveSessions = () => {
    const agents = ctx.get?.('agents')
    if (agents === null || agents === undefined || typeof agents.list !== 'function') return []
    const listed = agents.list()
    return Array.isArray(listed) ? listed : []
  }
  const optionalText = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const assertAgentExists = agentId => {
    if (agentId === undefined || !apartment.listAgents().some(row => row.id === agentId)) {
      throw codedError(COLLAB_ERROR_CODES.AGENT_NOT_FOUND, 'apartment: agent not found: ' + (agentId ?? '<empty>'))
    }
  }
  const assertTeamExists = teamId => {
    if (teamId !== undefined && !apartment.listTeams().some(row => row.id === teamId)) {
      throw codedError(COLLAB_ERROR_CODES.TEAM_NOT_FOUND, 'apartment: team not found: ' + teamId)
    }
  }
  /**
   * P1 cross-store task check. A readable bulletin DB is authoritative: an
   * unknown task is TASK_NOT_FOUND. An unavailable store fails closed with
   * TASK_STORE_UNAVAILABLE unless the caller explicitly opts into an
   * unverified write with allowUnverified=true.
   */
  const resolveTaskTarget = ({ taskId, boardId, allowUnverified }) => {
    const checked = lookupBulletinTask(taskId)
    if (!checked.available) {
      if (allowUnverified !== true) {
        const error = codedError(
          COLLAB_ERROR_CODES.TASK_STORE_UNAVAILABLE,
          'apartment: bulletin task store unavailable; pass allowUnverified=true to write without verifying task ' + taskId,
        )
        error.reason = checked.reason ?? null
        throw error
      }
      return { taskId, boardId: optionalText(boardId) ?? null, verified: false }
    }
    if (checked.task === null) {
      throw codedError(COLLAB_ERROR_CODES.TASK_NOT_FOUND, 'apartment: task not found: ' + taskId)
    }
    // E1: an explicit boardId must agree with the authoritative bulletin row.
    // A mismatch is refused before any write instead of silently forking scope.
    const explicitBoardId = optionalText(boardId)
    if (explicitBoardId !== undefined && checked.task.boardId !== null && explicitBoardId !== checked.task.boardId) {
      const error = codedError(
        COLLAB_ERROR_CODES.TASK_BOARD_MISMATCH,
        'apartment: boardId ' + explicitBoardId + ' does not match the bulletin task board '
          + checked.task.boardId + ' for task ' + taskId,
      )
      error.taskId = taskId
      error.boardId = explicitBoardId
      error.taskBoardId = checked.task.boardId
      throw error
    }
    // An omitted boardId is backfilled from the verified task; an explicit
    // matching boardId is preserved for caller-scoped filtering.
    return { taskId, boardId: explicitBoardId ?? checked.task.boardId ?? null, verified: true }
  }
  /**
   * A caller may bind/unbind its own session; any other session id is an
   * operator action. The caller's own session still has to resolve live.
   */
  const assertSessionPermission = (requestedSessionId, exec) => {
    const caller = callerSessionId(exec)
    if (requestedSessionId === null) return caller
    if (caller !== null && requestedSessionId === caller) return requestedSessionId
    assertOperator(exec)
    return requestedSessionId
  }
  const migrate = (toArg) => {
    const from = apartment.root
    const to = resolve(toArg)
    if (to === from) throw new Error('target equals current apartment root')
    const source = apartment.status()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const staging = `${to}.staging-${stamp}`
    mkdirSync(staging, { recursive: true })
    const countDb = (dir) => {
      const file = join(dir, 'apartment.sqlite')
      if (!existsSync(file)) return { agents: 0, teams: 0 }
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const count = table => {
          try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) } catch { return 0 }
        }
        return { agents: count('agents'), teams: count('teams') }
      } finally { db.close() }
    }
    try {
      apartment.checkpoint?.()
      for (const dir of ['agents', 'work', 'manifests', 'backups']) {
        if (existsSync(join(from, dir))) cpSync(join(from, dir), join(staging, dir), { recursive: true })
      }
      if (existsSync(join(from, 'apartment.sqlite'))) cpSync(join(from, 'apartment.sqlite'), join(staging, 'apartment.sqlite'))
      const stagedDbPath = join(staging, 'apartment.sqlite')
      if (existsSync(stagedDbPath)) {
        const stagedDb = new DatabaseSync(stagedDbPath)
        try {
          const rows = stagedDb.prepare('SELECT id FROM agents').all()
          const update = stagedDb.prepare('UPDATE agents SET home=? WHERE id=?')
          for (const row of rows) update.run(join(to, 'agents', row.id), row.id)
        } finally { stagedDb.close() }
      }
      const staged = countDb(staging)
      if (source.agents > 0 && staged.agents < source.agents) throw new Error(`migration verify failed: agents ${staged.agents}/${source.agents}`)
      if (source.teams > 0 && staged.teams < source.teams) throw new Error(`migration verify failed: teams ${staged.teams}/${source.teams}`)
      mkdirSync(to, { recursive: true })
      for (const dir of ['agents', 'work', 'manifests', 'backups']) {
        if (existsSync(join(staging, dir))) cpSync(join(staging, dir), join(to, dir), { recursive: true })
      }
      if (existsSync(join(staging, 'apartment.sqlite'))) cpSync(join(staging, 'apartment.sqlite'), join(to, 'apartment.sqlite'))
      const copied = countDb(to)
      if (copied.agents < source.agents || copied.teams < source.teams) throw new Error(`migration verify failed at target: ${JSON.stringify(copied)}`)
      const targetApartment = createApartment({ root: to })
      const verify = targetApartment.verify()
      targetApartment.close()
      setActiveRoot(to)
      markMigrationPending(to)
      return { from, to, counts: copied, sourceCounts: { agents: source.agents, teams: source.teams }, restartRequired: true, migrationPending: true, pendingRoot: to, verify }
    } finally {
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  register(desc('apartment_status', 'Read apartment root, counts and verify summary.'), async () => ({ ...apartment.status(), verify: apartment.verify(), ...lifecycle() }))
  register(desc('apartment_agent_register', 'Create/update an agent home (AGENTS.md, skills, tools).', {
    id: str('Optional stable id.'), name: str('Agent name.'), capabilities: arr('Capabilities.'),
  }, ['name']), async args => { assertWritable('apartment_agent_register'); return apartment.registerAgent(args) })
  register(desc('apartment_agent_list', 'List apartment agents.'), async () => ({ agents: apartment.listAgents() }))
  register(desc('apartment_agent_bind', 'Bind an agent to a session (defaults to the caller); binding another session needs danger-full-access.', {
    agentId: str('Agent id.'),
    sessionId: str('Session id; defaults to the caller session.'),
    isPrimary: { type: 'boolean', description: 'Mark this binding as the agent primary; clears the previous primary.' },
  }, ['agentId']), async (args, exec) => {
    assertWritable('apartment_agent_bind')
    const requested = optionalText(args?.sessionId)
    const sessionId = assertSessionPermission(requested ?? null, exec)
    if (sessionId === null) throw codedError(COLLAB_ERROR_CODES.SESSION_NOT_FOUND, 'apartment: no session to bind')
    const agentId = optionalText(args?.agentId)
    if (agentId === undefined || !apartment.listAgents().some(row => row.id === agentId)) {
      throw codedError(COLLAB_ERROR_CODES.AGENT_NOT_FOUND, 'apartment: agent not found: ' + (agentId ?? '<empty>'))
    }
    const liveSession = resolveLiveSession(sessionId)
    if (liveSession === undefined || liveSession === null) {
      throw codedError(COLLAB_ERROR_CODES.SESSION_NOT_FOUND, 'apartment: session not found: ' + sessionId)
    }
    return apartment.bindAgentSession({
      agentId,
      sessionId,
      isPrimary: typeof args?.isPrimary === 'boolean' ? args.isPrimary : undefined,
    })
  })
  register(desc('apartment_agent_unbind', 'Remove an agent/session binding (defaults to the caller session).', {
    agentId: str('Agent id.'),
    sessionId: str('Session id; defaults to the caller session.'),
  }, ['agentId']), async (args, exec) => {
    assertWritable('apartment_agent_unbind')
    const agentId = optionalText(args?.agentId)
    if (agentId === undefined) throw codedError(COLLAB_ERROR_CODES.AGENT_NOT_FOUND, 'apartment: agentId is required')
    const requested = optionalText(args?.sessionId)
    const sessionId = assertSessionPermission(requested ?? null, exec)
    if (sessionId === null) throw codedError(COLLAB_ERROR_CODES.SESSION_NOT_FOUND, 'apartment: no session to unbind')
    return apartment.unbindAgentSession({ agentId, sessionId })
  })
  register(desc('apartment_binding_list', 'Read-only: list agent/session bindings with session-network aliases and routeResolvable.', {
    agentId: str('Optional agent id filter.'),
  }), async args => buildBindingList({ apartment, agentId: optionalText(args?.agentId), profileDir }))
  register(desc('apartment_binding_candidates', 'Read-only: list unbound live/idle sessions and unbound agents with candidate matches (exact/normalized/name-only/ambiguous); never binds, writes aliases or routes.', {}), async () => buildBindingCandidates({
    apartment,
    listLiveSessions,
    profileDir,
  }))
  register(desc('apartment_bind_drift_check', 'Read-only: compare bindings with agents, live sessions and network aliases; reports issues, never fixes.'), async () => buildDriftReport({
    apartment,
    resolveSession: resolveLiveSession,
    profileDir,
  }))
  register(desc('apartment_collaboration_brief', 'Read-only aggregated collaboration brief for a session (defaults to the caller).', {
    sessionId: str('Session id; defaults to the caller session.'),
    taskId: str('Optional task id filter for task roles and assigned tasks.'),
    boardId: str('Optional bulletin board id filter for assigned tasks.'),
  }), async (args, exec) => {
    const requested = optionalText(args?.sessionId) ?? callerSessionId(exec)
    if (requested === null) {
      return {
        ok: false, code: COLLAB_ERROR_CODES.UNBOUND_SESSION, sessionId: null, agentId: null,
        warnings: [], asOf: new Date().toISOString(), text: '',
      }
    }
    return buildCollaborationBrief({
      apartment,
      sessionId: requested,
      taskId: optionalText(args?.taskId),
      boardId: optionalText(args?.boardId),
      profileDir,
    })
  })
  register(desc('apartment_team_create', 'Create a team decoupled from workspace.', {
    id: str('Optional id.'), name: str('Team name.'), purpose: str('Purpose.'), workspace: str('Optional associated workspace.'),
  }, ['name']), async args => { assertWritable('apartment_team_create'); return apartment.createTeam(args) })
  register(desc('apartment_team_member_add', 'Add an agent to a team with a role (many-to-many).', {
    teamId: str('Team id.'), agentId: str('Agent id.'), role: str('Role.'),
  }, ['teamId', 'agentId', 'role']), async args => { assertWritable('apartment_team_member_add'); return apartment.addMember(args) })
  register(desc('apartment_team_member_remove', 'Remove a team membership.', {
    teamId: str('Team id.'), agentId: str('Agent id.'), role: str('Role.'),
  }, ['teamId', 'agentId', 'role']), async args => { assertWritable('apartment_team_member_remove'); return apartment.removeMember(args) })
  register(desc('apartment_team_list', 'List teams and memberships.', { teamId: str('Optional team id.') }), async args => ({
    teams: apartment.listTeams(), memberships: apartment.listMemberships(args.teamId),
  }))
  register(desc('apartment_lease', 'Allocate a per-task work directory to an agent.', {
    agentId: str('Agent id.'), workspace: str('Workspace path.'), taskId: str('Optional task id.'), ttlMs: num('Lease TTL ms.'),
  }, ['agentId', 'workspace']), async args => { assertWritable('apartment_lease'); return apartment.claimLease(args) })
  register(desc('apartment_lease_release', 'Release a lease.', { leaseId: str('Lease id.') }, ['leaseId']), async args => { assertWritable('apartment_lease_release'); return apartment.releaseLease(args.leaseId) })
  register(desc('apartment_lease_list', 'List leases.', { agentId: str('Optional agent id.') }), async args => ({ leases: apartment.listLeases(args.agentId) }))
  register(desc('apartment_lease_reap', 'Expire leases whose TTL has passed.'), async () => { assertWritable('apartment_lease_reap'); return apartment.reapExpired() })
  register(desc('apartment_task_role_assign', 'Bind an agent/team to a role on one task (operator-only: requires danger-full-access); validates agent/team and verifies the task and board in bulletin unless allowUnverified.', {
    taskId: str('Task id.'),
    agentId: str('Agent id.'),
    teamId: str('Optional team id.'),
    boardId: str('Optional bulletin board id; must match the verified task board and is derived from the task when omitted.'),
    role: str('Role.'),
    allowUnverified: { type: 'boolean', description: 'Allow writing when the bulletin task store is unavailable (never when it is readable and the task is missing).' },
  }, ['taskId', 'agentId', 'role']), async (args, exec) => {
    assertOperator(exec)
    assertWritable('apartment_task_role_assign')
    const taskId = optionalText(args?.taskId)
    if (taskId === undefined) throw codedError('INVALID_ARGUMENT', 'apartment: taskId is required')
    const agentId = optionalText(args?.agentId)
    assertAgentExists(agentId)
    const teamId = optionalText(args?.teamId)
    assertTeamExists(teamId)
    const target = resolveTaskTarget({
      taskId,
      boardId: args?.boardId,
      allowUnverified: args?.allowUnverified === true,
    })
    return apartment.assignTaskRole({
      taskId,
      agentId,
      teamId: teamId ?? null,
      boardId: target.boardId,
      verified: target.verified,
      role: args?.role,
    })
  })
  register(desc('apartment_task_role_list', 'List task-role bindings; filters: taskId/agentId/teamId/boardId.', {
    taskId: str('Optional task id filter.'),
    agentId: str('Optional agent id filter.'),
    teamId: str('Optional team id filter.'),
    boardId: str('Optional board id filter.'),
  }), async args => ({
    roles: apartment.listTaskRoles({
      taskId: optionalText(args?.taskId),
      agentId: optionalText(args?.agentId),
      teamId: optionalText(args?.teamId),
      boardId: optionalText(args?.boardId),
    }),
  }))
  register(desc('apartment_team_task_list', 'Read-only: derive a team task list from task_roles (deduped), with roles and agents.', {
    teamId: str('Team id.'),
    boardId: str('Optional board id filter.'),
  }, ['teamId']), async args => apartment.listTeamTasks({
    teamId: optionalText(args?.teamId),
    boardId: optionalText(args?.boardId),
  }))
  register(desc('apartment_experience_record', 'Record reusable experience for an agent; taskId and outcome are required and the task is verified in bulletin unless allowUnverified.', {
    agentId: str('Agent id.'),
    taskId: str('Task id (required).'),
    summary: str('Summary.'),
    skills: arr('Skills.'),
    outcome: str('Outcome (required).'),
    allowUnverified: { type: 'boolean', description: 'Allow writing when the bulletin task store is unavailable.' },
  }, ['agentId', 'taskId', 'summary', 'outcome']), async args => {
    assertWritable('apartment_experience_record')
    const agentId = optionalText(args?.agentId)
    assertAgentExists(agentId)
    const taskId = optionalText(args?.taskId)
    if (taskId === undefined) throw codedError(COLLAB_ERROR_CODES.EXPERIENCE_FIELDS_REQUIRED, 'apartment: experience taskId is required')
    const outcome = optionalText(args?.outcome)
    if (outcome === undefined) throw codedError(COLLAB_ERROR_CODES.EXPERIENCE_FIELDS_REQUIRED, 'apartment: experience outcome is required')
    const summary = optionalText(args?.summary)
    if (summary === undefined) throw codedError(COLLAB_ERROR_CODES.EXPERIENCE_FIELDS_REQUIRED, 'apartment: experience summary is required')
    resolveTaskTarget({ taskId, allowUnverified: args?.allowUnverified === true })
    return apartment.recordExperience({
      agentId,
      taskId,
      summary,
      skills: Array.isArray(args?.skills) ? args.skills : [],
      outcome,
    })
  })
  register(desc('apartment_experience_list', 'List experience entries.', { agentId: str('Optional agent id.') }), async args => ({ experiences: apartment.listExperiences(args.agentId) }))
  register(desc('apartment_import_legacy', 'Read team/members/*/AGENTS.md into agent homes + memberships (imports write homes/roster).', { workspace: str('Workspace root.') }, ['workspace']), async args => { assertWritable('apartment_import_legacy'); return apartment.importLegacy(args.workspace) })
  register(desc('apartment_backup', 'Create a backup snapshot with manifest/sha256.', { label: str('Optional label.') }), async args => { assertWritable('apartment_backup'); return apartment.backup(args.label ?? 'manual') })
  register(desc('apartment_restore', 'Restore agents/work from a backup directory (creates a pre-restore safety backup).', {
    from: str('Backup directory.'),
    allowCrossRoot: { type: 'boolean', description: 'Allow a backup whose manifest.root differs from the current root.' },
  }, ['from']), async (args, exec) => {
    assertOperator(exec)
    assertWritable('apartment_restore')
    const result = apartment.restoreFrom(args.from, { allowCrossRoot: args.allowCrossRoot === true })
    // P2-3: the restored DB only becomes live on the next host start (the
    // pending DB replaces apartment.sqlite there). Until then the old DB is
    // still writable, so gate writes exactly like a migration.
    markMigrationPending(apartment.root)
    return { ...result, restartRequired: true, migrationPending: true, pendingRoot: apartment.root }
  })
  register(desc('apartment_verify', 'Verify agent homes and AGENTS.md (not backups; use apartment_backup_verify).'), async () => apartment.verify())
  register(desc('apartment_backup_verify', 'Verify backup manifest/sha256 integrity and the age of the latest normal backup (read-only).', {
    maxAgeDays: num('Optional maximum age in days for the latest normal backup; defaults to backupMaxAgeDays.'),
  }), async args => apartment.verifyBackups({ maxAgeDays: args?.maxAgeDays }))
  register(desc('apartment_set_root', 'Switch apartment root pointer (empty/new root); migration should be used to copy data.', { root: str('New absolute root.') }, ['root']), async (args, exec) => {
    assertOperator(exec)
    assertWritable('apartment_set_root')
    const next = setActiveRoot(args.root)
    markMigrationPending(next.root)
    return { ...next, restartRequired: true, migrationPending: true, pendingRoot: next.root }
  })
  register(desc('apartment_migrate', 'Copy apartment data to a new root, write pointer; requires restart.', { to: str('Target absolute root.') }, ['to']), async (args, exec) => {
    assertOperator(exec)
    assertWritable('apartment_migrate')
    return migrate(args.to)
  })

  // P0 auto-recall: one line, once per (process-local) session, only when the
  // session is bound. Any read failure injects an explicit unavailable warning;
  // all failures are fail-open and never block the pre-step.
  const injector = createCollabInjector({
    enabled: cfg.briefInjection !== false,
    logger: ctx.logger,
    getBrief: sessionId => buildCollaborationBrief({ apartment, sessionId, profileDir }),
  })
  try {
    if (typeof ctx.on === 'function') ctx.on('agent/pre-step', injector.handler)
  } catch (error) {
    try { ctx.logger?.warn?.('apartment: collaboration brief injection unavailable (fail-open)', error) } catch { /* best effort */ }
  }

  class AgentApartmentRemote {
    status() { return { ...apartment.status(), verify: apartment.verify(), ...lifecycle() } }
    setRoot(root) {
      assertRemoteOperator()
      assertWritable('setRoot')
      const next = setActiveRoot(root)
      markMigrationPending(next.root)
      return { ...next, restartRequired: true, migrationPending: true, pendingRoot: next.root }
    }
    migrate(to) { assertRemoteOperator(); assertWritable('migrate'); return migrate(to) }
    backup(label) { assertWritable('backup'); return apartment.backup(label ?? 'manual') }
    restore(from, options) {
      assertRemoteOperator()
      assertWritable('restore')
      // Accept both restore(from, {allowCrossRoot}) and restore({from, allowCrossRoot}).
      const args = from !== null && typeof from === 'object' ? from : null
      const source = args === null ? from : args.from
      const allowCrossRoot = (args === null ? options?.allowCrossRoot : args.allowCrossRoot) === true
      // P2-3: same restart gate as the tool path.
      const result = apartment.restoreFrom(source, { allowCrossRoot })
      markMigrationPending(apartment.root)
      return { ...result, restartRequired: true, migrationPending: true, pendingRoot: apartment.root }
    }
    verify() { return apartment.verify() }
    data(query) {
      const section = typeof query?.section === 'string' ? query.section : 'agents'
      const q = typeof query?.query === 'string' ? query.query.trim().toLowerCase() : ''
      const limit = Number.isFinite(Number(query?.limit)) ? Math.max(1, Math.min(100, Math.trunc(Number(query.limit)))) : 20
      const offset = Number.isFinite(Number(query?.offset)) ? Math.max(0, Math.trunc(Number(query.offset))) : 0
      const match = value => q === '' || String(value ?? '').toLowerCase().includes(q)
      let rows
      const agentDetail = row => {
        const home = join(apartment.root, 'agents', row.id)
        const readList = dir => {
          try { return readdirSync(join(home, dir)).slice(0, 100) } catch { return [] }
        }
        let agentsMd = null
        try { agentsMd = readFileSync(join(home, 'AGENTS.md'), 'utf8').slice(0, 4000) } catch { /* optional */ }
        return { ...row, resolvedHome: home, agentsMd, skills: readList('skills'), tools: readList('tools') }
      }
      if (section === 'agents') rows = apartment.listAgents().filter(row => match(row.id) || match(row.name) || match(row.home) || match(row.status)).map(agentDetail)
      else if (section === 'teams') rows = apartment.listTeams().filter(row => match(row.id) || match(row.name) || match(row.purpose))
      else if (section === 'leases') rows = apartment.listLeases().filter(row => match(row.agent_id) || match(row.workspace) || match(row.state))
      else if (section === 'roles') rows = apartment.listTaskRoles().filter(row => match(row.task_id) || match(row.agent_id) || match(row.role))
      else if (section === 'experiences') rows = apartment.listExperiences().filter(row => match(row.agent_id) || match(row.summary) || match(row.outcome))
      else if (section === 'backups') rows = apartment.listBackups?.() ?? []
      else rows = []
      return { section, items: rows.slice(offset, offset + limit), total: rows.length, limit, offset, counts: apartment.status(), verify: apartment.verify(), ...lifecycle() }
    }
  }
  Object.defineProperty(AgentApartmentRemote.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
    configurable: true, enumerable: false, value: Object.freeze({ version: 1, methods: REMOTE_METHODS }),
  })
  const remote = new AgentApartmentRemote()
  Object.defineProperty(remote, 'typertRemote', {
    configurable: false, enumerable: true, writable: false,
    value: Object.freeze({ service: remote, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE }),
  })
  try { if (typeof ctx.provide === 'function') ctx.provide(REMOTE_SERVICE_KEY, remote) } catch { /* tools still work */ }
}
