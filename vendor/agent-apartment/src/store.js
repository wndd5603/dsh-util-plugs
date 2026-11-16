// dsh-agent-apartment core: filesystem apartment + SQLite roster/teams/roles.
// Zero npm dependencies.
import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const now = () => new Date().toISOString()
const sha256 = text => createHash('sha256').update(text).digest('hex')
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const defaultRoot = () => join(dshHome(), 'apartment')
const pointerPath = () => join(dshHome(), 'apartment-root.json')
const readPointer = () => {
  try { return JSON.parse(readFileSync(pointerPath(), 'utf8')).root } catch { return undefined }
}
const activeRoot = configured => {
  const pointer = readPointer()
  return typeof pointer === 'string' && pointer !== '' ? pointer : (configured || defaultRoot())
}
const safeJoin = (root, ...parts) => {
  const target = resolve(root, ...parts)
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep)) throw new Error('path escapes apartment root: ' + target)
  return target
}
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
const ensureLayout = root => {
  for (const dir of ['agents', 'work', 'backups', 'manifests', 'teams']) mkdirSync(join(root, dir), { recursive: true })
  return root
}
const schema = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, home TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  capabilities TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace TEXT NOT NULL, work_dir TEXT NOT NULL,
  task_id TEXT, state TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT, workspace TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  team_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (team_id, agent_id, role)
);
CREATE TABLE IF NOT EXISTS task_roles (
  task_id TEXT NOT NULL, agent_id TEXT NOT NULL, team_id TEXT, role TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (task_id, agent_id, role)
);
CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, summary TEXT NOT NULL,
  skills TEXT, outcome TEXT, created_at TEXT NOT NULL
);
`
export function createApartment({ root, dbPath } = {}) {
  const resolvedRoot = ensureLayout(resolve(root || defaultRoot()))
  const db = new DatabaseSync(dbPath || join(resolvedRoot, 'apartment.sqlite'))
  db.exec(schema)
  const reapExpired = () => {
    const result = db.prepare("UPDATE leases SET state='expired' WHERE state='active' AND expires_at IS NOT NULL AND expires_at < ?").run(now())
    return { expired: result.changes }
  }
  const status = () => {
    reapExpired()
    return {
      root: resolvedRoot,
      agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      teams: db.prepare('SELECT COUNT(*) AS n FROM teams').get().n,
      leases: db.prepare("SELECT COUNT(*) AS n FROM leases WHERE state='active'").get().n,
      taskRoles: db.prepare('SELECT COUNT(*) AS n FROM task_roles').get().n,
      experiences: db.prepare('SELECT COUNT(*) AS n FROM experiences').get().n,
    }
  }
  return {
    root: resolvedRoot,
    dbPath: join(resolvedRoot, 'apartment.sqlite'),
    checkpoint: () => db.exec('PRAGMA wal_checkpoint(FULL)'),
    close: () => db.close(),
    status,
    reapExpired,
    registerAgent({ id, name, capabilities = [] }) {
      const agentId = id || 'agent-' + randomUUID().slice(0, 8)
      const home = safeJoin(resolvedRoot, 'agents', agentId)
      mkdirSync(home, { recursive: true })
      const agentsMd = join(home, 'AGENTS.md')
      if (!existsSync(agentsMd)) writeFileSync(agentsMd, `# ${name}\n\nAgent home for ${agentId}.\n`, 'utf8')
      mkdirSync(join(home, 'skills'), { recursive: true })
      mkdirSync(join(home, 'tools'), { recursive: true })
      db.prepare(`INSERT INTO agents (id,name,home,status,capabilities,created_at,updated_at) VALUES (?,?,?,'active',?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`).run(agentId, name, home, JSON.stringify(capabilities), now(), now())
      return db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
    },
    listAgents() { return db.prepare('SELECT * FROM agents ORDER BY name').all() },
    createTeam({ id, name, purpose = null, workspace = null }) {
      const teamId = id || 'team-' + randomUUID().slice(0, 8)
      db.prepare('INSERT OR IGNORE INTO teams (id,name,purpose,workspace,created_at) VALUES (?,?,?,?,?)').run(teamId, name, purpose, workspace, now())
      return db.prepare('SELECT * FROM teams WHERE id=?').get(teamId)
    },
    addMember({ teamId, agentId, role }) {
      db.prepare('INSERT OR IGNORE INTO memberships (team_id,agent_id,role,created_at) VALUES (?,?,?,?)').run(teamId, agentId, role, now())
      return { teamId, agentId, role }
    },
    removeMember({ teamId, agentId, role }) {
      db.prepare('DELETE FROM memberships WHERE team_id=? AND agent_id=? AND role=?').run(teamId, agentId, role)
      return { removed: true }
    },
    listTeams() { return db.prepare('SELECT * FROM teams ORDER BY name').all() },
    listMemberships(teamId) { return teamId === undefined ? db.prepare('SELECT * FROM memberships').all() : db.prepare('SELECT * FROM memberships WHERE team_id=?').all(teamId) },
    claimLease({ agentId, workspace, taskId = null, ttlMs = 3600000 }) {
      reapExpired()
      const id = 'lease-' + randomUUID().slice(0, 8)
      const workDir = safeJoin(resolvedRoot, 'work', taskId || id)
      mkdirSync(workDir, { recursive: true })
      const expiresAt = new Date(Date.now() + ttlMs).toISOString()
      db.prepare('INSERT INTO leases (id,agent_id,workspace,work_dir,task_id,state,expires_at,created_at) VALUES (?,?,?,?,?,\'active\',?,?)').run(id, agentId, workspace, workDir, taskId, expiresAt, now())
      return db.prepare('SELECT * FROM leases WHERE id=?').get(id)
    },
    releaseLease(id) { db.prepare("UPDATE leases SET state='released' WHERE id=?").run(id); return { released: true } },
    listLeases(agentId) { reapExpired(); return agentId === undefined ? db.prepare('SELECT * FROM leases').all() : db.prepare('SELECT * FROM leases WHERE agent_id=?').all(agentId) },
    assignTaskRole({ taskId, agentId, teamId = null, role }) {
      db.prepare('INSERT OR REPLACE INTO task_roles (task_id,agent_id,team_id,role,created_at) VALUES (?,?,?,?,?)').run(taskId, agentId, teamId, role, now())
      return { taskId, agentId, teamId, role }
    },
    listTaskRoles(taskId) { return taskId === undefined ? db.prepare('SELECT * FROM task_roles').all() : db.prepare('SELECT * FROM task_roles WHERE task_id=?').all(taskId) },
    recordExperience({ agentId, taskId = null, summary, skills = [], outcome = null }) {
      const id = 'exp-' + randomUUID().slice(0, 8)
      db.prepare('INSERT INTO experiences (id,agent_id,task_id,summary,skills,outcome,created_at) VALUES (?,?,?,?,?,?,?)').run(id, agentId, taskId, summary, JSON.stringify(skills), outcome, now())
      writeFileSync(safeJoin(resolvedRoot, 'agents', agentId, 'EXPERIENCE.md'), `# Experience\n\n- ${now()} ${summary}\n`, { flag: 'a' })
      return { id }
    },
    listExperiences(agentId) { return agentId === undefined ? db.prepare('SELECT * FROM experiences').all() : db.prepare('SELECT * FROM experiences WHERE agent_id=?').all(agentId) },
    importLegacy(workspace) {
      const membersDir = join(resolve(workspace), 'team', 'members')
      const imported = []
      let names = []
      try { names = readdirSync(membersDir) } catch { return { imported } }
      for (const name of names) {
        const agentsMd = join(membersDir, name, 'AGENTS.md')
        if (!existsSync(agentsMd)) continue
        const agent = this.registerAgent({ id: 'legacy-' + name, name })
        const team = this.createTeam({ id: 'legacy-' + name + '-team', name: name + ' legacy team' })
        this.addMember({ teamId: team.id, agentId: agent.id, role: 'member' })
        imported.push(agent.id)
      }
      return { imported }
    },
    backup(label = 'manual') {
      const stamp = now().replace(/[:.]/g, '-')
      const dir = join(resolvedRoot, 'backups', `${stamp}-${label}`)
      mkdirSync(dir, { recursive: true })
      cpSync(join(resolvedRoot, 'agents'), join(dir, 'agents'), { recursive: true })
      cpSync(join(resolvedRoot, 'work'), join(dir, 'work'), { recursive: true })
      const manifest = { id: stamp, at: now(), root: resolvedRoot, files: [] }
      const walk = (base, prefix = '') => {
        for (const entry of readdirSync(base)) {
          const file = join(base, entry)
          const rel = join(prefix, entry)
          if (statSync(file).isDirectory()) { walk(file, rel); continue }
          manifest.files.push({ path: rel, sha256: sha256(readFileSync(file)) })
        }
      }
      walk(dir)
      writeJson(join(dir, 'manifest.json'), manifest)
      writeJson(join(resolvedRoot, 'manifests', `${stamp}.json`), manifest)
      return { backup: dir, files: manifest.files.length }
    },
    restoreFrom(source) {
      const from = resolve(source)
      if (!existsSync(join(from, 'manifest.json'))) throw new Error('backup manifest not found: ' + from)
      const safety = this.backup('pre-restore')
      for (const dir of ['agents', 'work']) {
        if (existsSync(join(from, dir))) cpSync(join(from, dir), join(resolvedRoot, dir), { recursive: true })
      }
      return { restoredFrom: from, safetyBackup: safety.backup, restartRequired: true }
    },
    verify() {
      const issues = []
      for (const agent of this.listAgents()) {
        if (!existsSync(agent.home)) issues.push({ agent: agent.id, issue: 'missing-home' })
        if (!existsSync(join(agent.home, 'AGENTS.md'))) issues.push({ agent: agent.id, issue: 'missing-AGENTS.md' })
      }
      return { ok: issues.length === 0, issues }
    },
  }
}
export function setActiveRoot(root) {
  const target = resolve(root)
  mkdirSync(target, { recursive: true })
  writeJson(pointerPath(), { root: target, at: now() })
  return { root: target }
}
export function getActiveRoot(configured) { return activeRoot(configured) }
