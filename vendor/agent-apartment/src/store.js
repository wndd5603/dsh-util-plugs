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
/**
 * Delete entries under `targetRoot` that do not exist under `sourceRoot` (same
 * relative path), so a restore reproduces the backup exactly instead of merging
 * post-backup files into it. Returns the number of removed/replaced entries.
 */
const removeExtraEntries = (sourceRoot, targetRoot) => {
  let removed = 0
  const walk = (source, target) => {
    if (!existsSync(source) || !existsSync(target)) return
    const sourceNames = new Set(readdirSync(source))
    for (const name of readdirSync(target)) {
      const sourcePath = join(source, name)
      const targetPath = join(target, name)
      if (!sourceNames.has(name)) {
        rmSync(targetPath, { recursive: true, force: true })
        removed += 1
        continue
      }
      const sourceIsDir = statSync(sourcePath).isDirectory()
      const targetIsDir = statSync(targetPath).isDirectory()
      if (sourceIsDir && targetIsDir) { walk(sourcePath, targetPath); continue }
      if (sourceIsDir !== targetIsDir) {
        rmSync(targetPath, { recursive: targetIsDir, force: true })
        cpSync(sourcePath, targetPath, { recursive: sourceIsDir })
        removed += 1
      }
    }
  }
  walk(sourceRoot, targetRoot)
  return removed
}

export function createApartment({ root, dbPath } = {}) {
  const resolvedRoot = ensureLayout(resolve(root || defaultRoot()))
  const dbFile = join(resolvedRoot, 'apartment.sqlite')
  const pendingDb = join(resolvedRoot, 'apartment.sqlite.restore-pending')
  let restoredPendingDb = false
  if (existsSync(pendingDb)) {
    try {
      renameSync(pendingDb, dbFile)
    } catch (error) {
      // A committed restore must never be dropped silently: report it so the
      // operator can resolve the lock/permission problem and retry.
      const failure = new Error('apartment: pending restore DB could not replace ' + dbFile + ': ' + (error?.message ?? error)
        + ' (pending file kept at ' + pendingDb + ')')
      failure.code = 'APARTMENT_RESTORE_PENDING_FAILED'
      failure.pendingDb = pendingDb
      failure.targetDb = dbFile
      throw failure
    }
    // WAL/SHM left behind belong to the replaced database; replaying them over
    // the restored file would corrupt it.
    for (const suffix of ['-wal', '-shm']) {
      try { rmSync(dbFile + suffix, { force: true }) } catch (error) {
        const failure = new Error('apartment: restored DB was applied but stale ' + suffix + ' for ' + dbFile
          + ' could not be removed: ' + (error?.message ?? error))
        failure.code = 'APARTMENT_RESTORE_PENDING_FAILED'
        failure.pendingDb = null
        failure.targetDb = dbFile
        throw failure
      }
    }
    restoredPendingDb = true
  }
  const db = new DatabaseSync(dbPath || dbFile)
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
    restoredPendingDb,
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
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, home=excluded.home, capabilities=excluded.capabilities, updated_at=excluded.updated_at`).run(agentId, name, home, JSON.stringify(capabilities), now(), now())
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
      const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+/, '').slice(0, 64) || 'manual'
      const dir = join(resolvedRoot, 'backups', `${stamp}-${safeLabel}`)
      mkdirSync(dir, { recursive: true })
      cpSync(join(resolvedRoot, 'agents'), join(dir, 'agents'), { recursive: true })
      cpSync(join(resolvedRoot, 'work'), join(dir, 'work'), { recursive: true })
      this.checkpoint?.()
      if (existsSync(join(resolvedRoot, 'apartment.sqlite'))) cpSync(join(resolvedRoot, 'apartment.sqlite'), join(dir, 'apartment.sqlite'))
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
    restoreFrom(source, options = {}) {
      const from = resolve(source)
      const allowCrossRoot = options !== null && typeof options === 'object' && options.allowCrossRoot === true
      const manifestPath = join(from, 'manifest.json')
      if (!existsSync(manifestPath)) throw new Error('backup manifest not found: ' + from)
      const manifest = readJson(manifestPath, null)
      if (manifest === null || !Array.isArray(manifest.files)) throw new Error('backup manifest invalid: ' + from)
      // Refuse a backup made for a different apartment root unless the operator
      // explicitly opts in; an unverifiable (root-less) manifest is treated the
      // same way instead of silently trusting it.
      const manifestRoot = typeof manifest.root === 'string' && manifest.root.trim() !== '' ? resolve(manifest.root) : null
      if (manifestRoot !== resolvedRoot && !allowCrossRoot) {
        const error = new Error(manifestRoot === null
          ? 'backup manifest has no root; refusing to restore it into ' + resolvedRoot + ' (pass allowCrossRoot=true to override)'
          : 'backup root mismatch: backup was created for ' + manifestRoot + ' but target root is ' + resolvedRoot
            + ' (pass allowCrossRoot=true to override)')
        error.code = manifestRoot === null ? 'APARTMENT_RESTORE_ROOT_UNVERIFIABLE' : 'APARTMENT_RESTORE_ROOT_MISMATCH'
        error.manifestRoot = manifestRoot
        error.targetRoot = resolvedRoot
        error.restoredFrom = from
        throw error
      }
      for (const entry of manifest.files) {
        if (entry === null || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') throw new Error('backup manifest entry invalid')
        const file = resolve(from, entry.path)
        if (file !== from && !file.startsWith(from + sep)) throw new Error('backup path escapes root: ' + entry.path)
        if (!existsSync(file) || sha256(readFileSync(file)) !== entry.sha256) throw new Error('backup hash mismatch: ' + entry.path)
      }
      const safety = this.backup('pre-restore')
      let removedFiles = 0
      for (const dir of ['agents', 'work', 'manifests']) {
        const sourceDir = join(from, dir)
        if (!existsSync(sourceDir)) continue
        cpSync(sourceDir, join(resolvedRoot, dir), { recursive: true })
        // Exact restore: drop entries created after the backup so the filesystem
        // matches the restored roster instead of merging two states.
        removedFiles += removeExtraEntries(sourceDir, join(resolvedRoot, dir))
      }
      let pendingDbPath = null
      if (existsSync(join(from, 'apartment.sqlite'))) {
        pendingDbPath = join(resolvedRoot, 'apartment.sqlite.restore-pending')
        try {
          cpSync(join(from, 'apartment.sqlite'), pendingDbPath)
          // Point every agent home at this root: required for an allowed
          // cross-root restore and idempotent for a same-root one.
          const pendingDb = new DatabaseSync(pendingDbPath)
          try {
            const update = pendingDb.prepare('UPDATE agents SET home=? WHERE id=?')
            for (const row of pendingDb.prepare('SELECT id FROM agents').all()) {
              update.run(join(resolvedRoot, 'agents', row.id), row.id)
            }
          } finally { pendingDb.close() }
        } catch (error) {
          try { rmSync(pendingDbPath, { force: true }) } catch { /* best effort */ }
          const failure = new Error('apartment: cannot stage restored DB at ' + pendingDbPath + ': ' + (error?.message ?? error))
          failure.code = 'APARTMENT_RESTORE_DB_FAILED'
          failure.pendingDb = null
          failure.restoredFrom = from
          failure.safetyBackup = safety.backup
          throw failure
        }
      }
      return {
        restoredFrom: from,
        targetRoot: resolvedRoot,
        manifestRoot,
        crossRoot: manifestRoot !== resolvedRoot,
        safetyBackup: safety.backup,
        pendingDb: pendingDbPath,
        removedFiles,
        restartRequired: pendingDbPath !== null,
      }
    },
    listBackups() {
      const dir = join(resolvedRoot, 'backups')
      if (!existsSync(dir)) return []
      return readdirSync(dir).filter(name => {
        try { return statSync(join(dir, name)).isDirectory() } catch { return false }
      }).map(name => {
        const path = join(dir, name)
        let manifest = null
        try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) } catch { /* ignore */ }
        return { name, path, at: manifest?.at ?? null, files: Array.isArray(manifest?.files) ? manifest.files.length : 0 }
      }).sort((a, b) => String(b.name).localeCompare(String(a.name)))
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
