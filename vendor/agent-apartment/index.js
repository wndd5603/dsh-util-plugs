// DSH Agent Apartment host plugin: centralized agent homes, leases, teams,
// task-role bindings, experience and root backup/migration.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApartment, getActiveRoot, setActiveRoot } from './src/store.js'
import { boolean, number, objectSchema, string } from './lib/standard-schema.js'

export const inject = ['tools']

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
  const apartment = createApartment({ root })
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
      return { from, to, counts: copied, sourceCounts: { agents: source.agents, teams: source.teams }, restartRequired: true, verify }
    } finally {
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  register(desc('apartment_status', 'Read apartment root, counts and verify summary.'), async () => ({ ...apartment.status(), verify: apartment.verify() }))
  register(desc('apartment_agent_register', 'Create/update an agent home (AGENTS.md, skills, tools).', {
    id: str('Optional stable id.'), name: str('Agent name.'), capabilities: arr('Capabilities.'),
  }, ['name']), async args => apartment.registerAgent(args))
  register(desc('apartment_agent_list', 'List apartment agents.'), async () => ({ agents: apartment.listAgents() }))
  register(desc('apartment_team_create', 'Create a team decoupled from workspace.', {
    id: str('Optional id.'), name: str('Team name.'), purpose: str('Purpose.'), workspace: str('Optional associated workspace.'),
  }, ['name']), async args => apartment.createTeam(args))
  register(desc('apartment_team_member_add', 'Add an agent to a team with a role (many-to-many).', {
    teamId: str('Team id.'), agentId: str('Agent id.'), role: str('Role.'),
  }, ['teamId', 'agentId', 'role']), async args => apartment.addMember(args))
  register(desc('apartment_team_member_remove', 'Remove a team membership.', {
    teamId: str('Team id.'), agentId: str('Agent id.'), role: str('Role.'),
  }, ['teamId', 'agentId', 'role']), async args => apartment.removeMember(args))
  register(desc('apartment_team_list', 'List teams and memberships.', { teamId: str('Optional team id.') }), async args => ({
    teams: apartment.listTeams(), memberships: apartment.listMemberships(args.teamId),
  }))
  register(desc('apartment_lease', 'Allocate a per-task work directory to an agent.', {
    agentId: str('Agent id.'), workspace: str('Workspace path.'), taskId: str('Optional task id.'), ttlMs: num('Lease TTL ms.'),
  }, ['agentId', 'workspace']), async args => apartment.claimLease(args))
  register(desc('apartment_lease_release', 'Release a lease.', { leaseId: str('Lease id.') }, ['leaseId']), async args => apartment.releaseLease(args.leaseId))
  register(desc('apartment_lease_list', 'List leases.', { agentId: str('Optional agent id.') }), async args => ({ leases: apartment.listLeases(args.agentId) }))
  register(desc('apartment_lease_reap', 'Expire leases whose TTL has passed.'), async () => apartment.reapExpired())
  register(desc('apartment_task_role_assign', 'Bind an agent/team to a role on one task.', {
    taskId: str('Task id.'), agentId: str('Agent id.'), teamId: str('Optional team id.'), role: str('Role.'),
  }, ['taskId', 'agentId', 'role']), async args => apartment.assignTaskRole(args))
  register(desc('apartment_task_role_list', 'List task-role bindings.', { taskId: str('Optional task id.') }), async args => ({ roles: apartment.listTaskRoles(args.taskId) }))
  register(desc('apartment_experience_record', 'Record reusable experience for an agent.', {
    agentId: str('Agent id.'), taskId: str('Optional task id.'), summary: str('Summary.'), skills: arr('Skills.'), outcome: str('Outcome.'),
  }, ['agentId', 'summary']), async args => apartment.recordExperience(args))
  register(desc('apartment_experience_list', 'List experience entries.', { agentId: str('Optional agent id.') }), async args => ({ experiences: apartment.listExperiences(args.agentId) }))
  register(desc('apartment_import_legacy', 'Read team/members/*/AGENTS.md into agent homes + memberships (read-only import).', { workspace: str('Workspace root.') }, ['workspace']), async args => apartment.importLegacy(args.workspace))
  register(desc('apartment_backup', 'Create a backup snapshot with manifest/sha256.', { label: str('Optional label.') }), async args => apartment.backup(args.label ?? 'manual'))
  register(desc('apartment_restore', 'Restore agents/work from a backup directory (creates a pre-restore safety backup).', { from: str('Backup directory.') }, ['from']), async (args, exec) => { assertOperator(exec); return apartment.restoreFrom(args.from) })
  register(desc('apartment_verify', 'Verify agent homes and AGENTS.md.'), async () => apartment.verify())
  register(desc('apartment_set_root', 'Switch apartment root pointer (empty/new root); migration should be used to copy data.', { root: str('New absolute root.') }, ['root']), async (args, exec) => {
    assertOperator(exec)
    const next = setActiveRoot(args.root)
    return { ...next, restartRequired: true }
  })
  register(desc('apartment_migrate', 'Copy apartment data to a new root, write pointer; requires restart.', { to: str('Target absolute root.') }, ['to']), async (args, exec) => { assertOperator(exec); return migrate(args.to) })

  class AgentApartmentRemote {
    status() { return { ...apartment.status(), verify: apartment.verify() } }
    setRoot(root) { assertRemoteOperator(); const next = setActiveRoot(root); return { ...next, restartRequired: true } }
    migrate(to) { assertRemoteOperator(); return migrate(to) }
    backup(label) { return apartment.backup(label ?? 'manual') }
    restore(from) { assertRemoteOperator(); return apartment.restoreFrom(from) }
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
      return { section, items: rows.slice(offset, offset + limit), total: rows.length, limit, offset, counts: apartment.status(), verify: apartment.verify() }
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
