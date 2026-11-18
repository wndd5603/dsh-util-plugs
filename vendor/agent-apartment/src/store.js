// dsh-agent-apartment core: filesystem apartment + SQLite roster/teams/roles.
// Zero npm dependencies.
import { DatabaseSync } from 'node:sqlite'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const now = () => new Date().toISOString()
const sha256 = text => createHash('sha256').update(text).digest('hex')
const codedError = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}
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
CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id),
  UNIQUE (session_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_primary
  ON agent_sessions(agent_id) WHERE is_primary = 1;
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace TEXT NOT NULL, work_dir TEXT NOT NULL,
  task_id TEXT, state TEXT NOT NULL DEFAULT 'active', expires_at TEXT, created_at TEXT NOT NULL,
  fencing_token INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT, workspace TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  team_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (team_id, agent_id, role)
);
CREATE TABLE IF NOT EXISTS task_roles (
  task_id TEXT NOT NULL, agent_id TEXT NOT NULL, team_id TEXT, board_id TEXT,
  verified INTEGER NOT NULL DEFAULT 1, role TEXT NOT NULL,
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
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_BACKUP_KEEP = 5
const MAX_BACKUP_KEEP = 100
const DEFAULT_BACKUP_MAX_AGE_MS = 8 * DAY_MS
const PRUNE_LOCK_NAME = '.prune.lock'
// A prune pass normally takes well under a second; a lock older than this is
// assumed to be abandoned by a crashed process and may be reclaimed once.
const PRUNE_LOCK_STALE_MS = 60 * 60 * 1000
const isPreRestoreBackup = (name, manifest) => /(^|-)pre-restore(?:-|$)/.test(name)
  || manifest?.label === 'pre-restore' || manifest?.kind === 'pre-restore'
// Directories only: a symlink or the prune lock file is never treated as a
// backup, so retention can never follow a link out of the backups directory.
const listBackupDirs = backupsDir => {
  let entries
  try { entries = readdirSync(backupsDir, { withFileTypes: true }) } catch { return [] }
  return entries.filter(entry => entry.isDirectory()).map(entry => {
    const path = join(backupsDir, entry.name)
    const manifest = readJson(join(path, 'manifest.json'), null)
    return { name: entry.name, path, manifest, preRestore: isPreRestoreBackup(entry.name, manifest) }
  }).sort((a, b) => String(b.name).localeCompare(String(a.name)))
}
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

export function createApartment({ root, dbPath, backupKeep, backupMaxAgeMs } = {}) {
  const resolvedRoot = ensureLayout(resolve(root || defaultRoot()))
  const backupKeepLimit = (() => {
    const value = Number(backupKeep)
    return Number.isFinite(value) ? Math.max(1, Math.min(MAX_BACKUP_KEEP, Math.trunc(value))) : DEFAULT_BACKUP_KEEP
  })()
  const configuredBackupMaxAgeMs = (() => {
    const value = Number(backupMaxAgeMs)
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BACKUP_MAX_AGE_MS
  })()
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
  // Additive migration for databases created before P1: CREATE TABLE IF NOT
  // EXISTS never alters an existing table, so board_id must be added in place.
  // Old task_roles rows keep board_id = NULL and stay readable. `verified`
  // (D2) was added later: default 1 keeps pre-existing rows non-warning, while
  // an allowUnverified write stores 0.
  {
    const columns = db.prepare('PRAGMA table_info(task_roles)').all()
    if (!columns.some(column => column.name === 'board_id')) {
      db.exec('ALTER TABLE task_roles ADD COLUMN board_id TEXT')
    }
    if (!columns.some(column => column.name === 'verified')) {
      db.exec('ALTER TABLE task_roles ADD COLUMN verified INTEGER NOT NULL DEFAULT 1')
    }
  }
  {
    const leaseColumns = db.prepare('PRAGMA table_info(leases)').all()
    if (!leaseColumns.some(column => column.name === 'fencing_token')) {
      db.exec('ALTER TABLE leases ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 1')
    }
  }
  const reapExpired = () => {
    const result = db.prepare("UPDATE leases SET state='expired' WHERE state='active' AND expires_at IS NOT NULL AND expires_at < ?").run(now())
    return { expired: result.changes }
  }
  // Retention is best effort: a failed prune must never fail the backup that
  // just succeeded, and a concurrent prune (another apartment instance or
  // process) must never race into deleting a different set of candidates. A
  // short-lived lock file serializes prune passes; when it is held, this call
  // skips pruning and leaves the bound to be restored by the next backup.
  const pruneBackups = (keep, options = {}) => {
    const backupsDir = join(resolvedRoot, 'backups')
    const result = { pruned: [], kept: [], errors: [], skipped: null }
    const protectedPaths = new Set()
    for (const item of [options?.protect].flat()) {
      if (typeof item === 'string' && item !== '') protectedPaths.add(resolve(item))
    }
    const lockPath = join(backupsDir, PRUNE_LOCK_NAME)
    let lockHeld = false
    try {
      const acquireLock = () => {
        const create = () => {
          const fd = openSync(lockPath, 'wx')
          try { writeFileSync(fd, `${process.pid} ${now()}`) } finally { closeSync(fd) }
        }
        try { create(); return true } catch (error) {
          if (error?.code !== 'EEXIST') throw error
          try {
            if (Date.now() - statSync(lockPath).mtimeMs <= PRUNE_LOCK_STALE_MS) return false
            unlinkSync(lockPath)
            create()
            return true
          } catch { return false }
        }
      }
      lockHeld = acquireLock()
      if (!lockHeld) {
        result.skipped = 'locked'
        return result
      }
      const entries = listBackupDirs(backupsDir)
      const normal = entries.filter(entry => !entry.preRestore)
      for (const entry of normal.slice(0, keep)) result.kept.push(entry.name)
      for (const entry of normal.slice(keep)) {
        if (protectedPaths.has(resolve(entry.path))) { result.kept.push(entry.name); continue }
        try {
          rmSync(entry.path, { recursive: true, force: true })
          result.pruned.push(entry.name)
        } catch (error) {
          result.errors.push({ name: entry.name, error: String(error?.message ?? error) })
        }
      }
    } catch (error) {
      result.errors.push({ name: null, error: String(error?.message ?? error) })
    } finally {
      if (lockHeld) { try { unlinkSync(lockPath) } catch { /* best effort */ } }
    }
    return result
  }
  const status = () => {
    reapExpired()
    return {
      root: resolvedRoot,
      agents: db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      agentSessions: db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get().n,
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
    // ---- P0 identity mapping: agent <-> session (never network aliases) ----
    getAgentSession(sessionId) {
      return db.prepare(`SELECT s.*, a.name AS agent_name, a.home AS agent_home, a.status AS agent_status
        FROM agent_sessions s LEFT JOIN agents a ON a.id = s.agent_id
        WHERE s.session_id = ?`).get(sessionId)
    },
    listAgentSessions(agentId) {
      const base = `SELECT s.*, a.name AS agent_name, a.home AS agent_home, a.status AS agent_status
        FROM agent_sessions s LEFT JOIN agents a ON a.id = s.agent_id`
      return agentId === undefined
        ? db.prepare(base + ' ORDER BY s.agent_id, s.is_primary DESC, s.session_id').all()
        : db.prepare(base + ' WHERE s.agent_id = ? ORDER BY s.is_primary DESC, s.session_id').all(agentId)
    },
    /**
     * Upsert one agent/session binding. A session may belong to only one agent
     * (UNIQUE session_id): binding it to a different agent transfers it. Setting
     * isPrimary clears the agent's other primary in the same transaction; the
     * partial unique index is the final guard against two primaries.
     */
    bindAgentSession({ agentId, sessionId, isPrimary }) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw codedError('SESSION_NOT_FOUND', 'apartment: sessionId is required')
      }
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId)
      if (agent === undefined) throw codedError('AGENT_NOT_FOUND', 'apartment: agent not found: ' + agentId)
      const stamp = now()
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ? AND session_id = ?').get(agentId, sessionId)
        const occupying = db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId)
        const primary = isPrimary === undefined || isPrimary === null
          ? Number(current?.is_primary ?? 0)
          : (isPrimary === true ? 1 : 0)
        if (occupying !== undefined && occupying.agent_id !== agentId) {
          db.prepare('DELETE FROM agent_sessions WHERE session_id = ?').run(sessionId)
        }
        if (primary === 1) {
          db.prepare('UPDATE agent_sessions SET is_primary = 0, updated_at = ? WHERE agent_id = ? AND is_primary = 1 AND session_id <> ?')
            .run(stamp, agentId, sessionId)
        }
        if (current !== undefined) {
          db.prepare('UPDATE agent_sessions SET is_primary = ?, updated_at = ? WHERE agent_id = ? AND session_id = ?')
            .run(primary, stamp, agentId, sessionId)
        } else {
          db.prepare('INSERT INTO agent_sessions (agent_id, session_id, is_primary, created_at, updated_at) VALUES (?,?,?,?,?)')
            .run(agentId, sessionId, primary, stamp, stamp)
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* transaction already gone */ }
        throw error
      }
      return db.prepare(`SELECT s.*, a.name AS agent_name, a.home AS agent_home, a.status AS agent_status
        FROM agent_sessions s LEFT JOIN agents a ON a.id = s.agent_id
        WHERE s.agent_id = ? AND s.session_id = ?`).get(agentId, sessionId)
    },
    unbindAgentSession({ agentId, sessionId }) {
      const result = db.prepare('DELETE FROM agent_sessions WHERE agent_id = ? AND session_id = ?').run(agentId, sessionId)
      return { agentId, sessionId, removed: Number(result.changes) > 0 }
    },
    createTeam({ id, name, purpose = null, workspace = null }) {
      const teamId = id || 'team-' + randomUUID().slice(0, 8)
      db.prepare('INSERT OR IGNORE INTO teams (id,name,purpose,workspace,created_at) VALUES (?,?,?,?,?)').run(teamId, name, purpose, workspace, now())
      return db.prepare('SELECT * FROM teams WHERE id=?').get(teamId)
    },
    addMember({ teamId, agentId, role }) {
      // Membership must never create a roster row for a ghost team/agent; the
      // caller-facing add is idempotent, so a duplicate returns changes = 0.
      const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
      if (team === undefined) throw codedError('TEAM_NOT_FOUND', 'apartment: team not found: ' + (teamId ?? '<empty>'))
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId)
      if (agent === undefined) throw codedError('AGENT_NOT_FOUND', 'apartment: agent not found: ' + (agentId ?? '<empty>'))
      const result = db.prepare('INSERT OR IGNORE INTO memberships (team_id,agent_id,role,created_at) VALUES (?,?,?,?)').run(teamId, agentId, role, now())
      return { teamId, agentId, role, changes: Number(result.changes), added: Number(result.changes) > 0 }
    },
    removeMember({ teamId, agentId, role }) {
      const result = db.prepare('DELETE FROM memberships WHERE team_id=? AND agent_id=? AND role=?').run(teamId, agentId, role)
      const changes = Number(result.changes)
      return { teamId, agentId, role, changes, removed: changes > 0 }
    },
    listTeams() { return db.prepare('SELECT * FROM teams ORDER BY name').all() },
    listMemberships(teamId) { return teamId === undefined ? db.prepare('SELECT * FROM memberships').all() : db.prepare('SELECT * FROM memberships WHERE team_id=?').all(teamId) },
    claimLease({ agentId, workspace, taskId = null, ttlMs = 3600000 }) {
      if (typeof agentId !== 'string' || agentId.trim() === '') throw codedError('INVALID_ARGUMENT', 'claimLease: agentId is required')
      if (typeof workspace !== 'string' || workspace.trim() === '') throw codedError('INVALID_ARGUMENT', 'claimLease: workspace is required')
      const task = typeof taskId === 'string' && taskId.trim() !== '' ? taskId.trim() : null
      reapExpired()
      db.exec('BEGIN IMMEDIATE')
      try {
        if (task !== null) {
          const existing = db.prepare("SELECT * FROM leases WHERE task_id=? AND state='active' ORDER BY created_at DESC LIMIT 1").get(task)
          if (existing !== undefined) {
            throw codedError('LEASE_CONFLICT', 'claimLease: active lease already exists for task ' + task, { existingLease: existing })
          }
        }
        const fencingToken = task === null ? 1 : Number(db.prepare('SELECT COALESCE(MAX(fencing_token), 0) + 1 AS n FROM leases WHERE task_id=?').get(task)?.n ?? 1)
        const id = 'lease-' + randomUUID().slice(0, 8)
        const workDir = safeJoin(resolvedRoot, 'work', task || id)
        mkdirSync(workDir, { recursive: true })
        const expiresAt = new Date(Date.now() + ttlMs).toISOString()
        db.prepare('INSERT INTO leases (id,agent_id,workspace,work_dir,task_id,state,expires_at,created_at,fencing_token) VALUES (?,?,?,?,?,\'active\',?,?,?)')
          .run(id, agentId.trim(), workspace, workDir, task, expiresAt, now(), fencingToken)
        db.exec('COMMIT')
        return db.prepare('SELECT * FROM leases WHERE id=?').get(id)
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* best effort */ }
        throw error
      }
    },
    releaseLease(id, options = {}) {
      const row = db.prepare('SELECT * FROM leases WHERE id=?').get(id)
      if (row === undefined) throw codedError('NOT_FOUND', 'releaseLease: lease not found: ' + id)
      if (typeof options.agentId === 'string' && options.agentId !== '' && row.agent_id !== options.agentId) {
        throw codedError('FORBIDDEN', 'releaseLease: only the lease owner may release it')
      }
      const result = db.prepare("UPDATE leases SET state='released' WHERE id=? AND state='active'").run(id)
      return { released: result.changes > 0, id, state: result.changes > 0 ? 'released' : row.state, fencingToken: row.fencing_token }
    },
    listLeases(agentId) { reapExpired(); return agentId === undefined ? db.prepare('SELECT * FROM leases').all() : db.prepare('SELECT * FROM leases WHERE agent_id=?').all(agentId) },
    // Read-only lease view: never calls reapExpired and never UPDATEs. Used by
    // apartment_collaboration_brief, whose read-only contract is load-bearing.
    listLeasesReadOnly(options = {}) {
      const agentId = typeof options === 'string' ? options : options?.agentId
      // Surface active/expired-first so an overdue lease is visible in the capped
      // brief, but only SELECT: no reap, no UPDATE, no state rewrite.
      const order = ` ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
        CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at ASC, created_at DESC`
      return agentId === undefined
        ? db.prepare('SELECT * FROM leases' + order).all()
        : db.prepare('SELECT * FROM leases WHERE agent_id = ?' + order).all(agentId)
    },
    assignTaskRole({ taskId, agentId, teamId = null, boardId = null, role, verified = true }) {
      if (typeof taskId !== 'string' || taskId.trim() === '') throw codedError('INVALID_ARGUMENT', 'apartment: taskId is required')
      if (typeof agentId !== 'string' || agentId.trim() === '') throw codedError('AGENT_NOT_FOUND', 'apartment: agentId is required')
      if (typeof role !== 'string' || role.trim() === '') throw codedError('INVALID_ARGUMENT', 'apartment: role is required')
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId)
      if (agent === undefined) throw codedError('AGENT_NOT_FOUND', 'apartment: agent not found: ' + agentId)
      if (teamId !== null && teamId !== undefined) {
        const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
        if (team === undefined) throw codedError('TEAM_NOT_FOUND', 'apartment: team not found: ' + teamId)
      }
      // D2: only an explicit allowUnverified write stores verified=0; every
      // other write (and every pre-migration row) stays verified=1.
      const verifiedFlag = verified === false ? 0 : 1
      // Idempotent: the same (task, agent, role) keeps its original created_at;
      // only the optional team/board/verified pointers are refreshed.
      db.prepare(`INSERT INTO task_roles (task_id,agent_id,team_id,board_id,verified,role,created_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(task_id,agent_id,role) DO UPDATE SET team_id=excluded.team_id, board_id=excluded.board_id, verified=excluded.verified`)
        .run(taskId, agentId, teamId ?? null, boardId ?? null, verifiedFlag, role, now())
      const row = db.prepare('SELECT * FROM task_roles WHERE task_id=? AND agent_id=? AND role=?').get(taskId, agentId, role)
      return {
        taskId: row.task_id,
        agentId: row.agent_id,
        teamId: row.team_id ?? null,
        boardId: row.board_id ?? null,
        verified: Number(row.verified) !== 0,
        role: row.role,
        createdAt: row.created_at,
      }
    },
    listTaskRoles(filters = {}) {
      // Backwards compatible: a bare string means taskId.
      const query = typeof filters === 'string' ? { taskId: filters } : (filters ?? {})
      const clauses = []
      const params = []
      for (const [key, column] of [['taskId', 'task_id'], ['agentId', 'agent_id'], ['teamId', 'team_id'], ['boardId', 'board_id']]) {
        const value = query[key]
        if (typeof value === 'string' && value.trim() !== '') {
          clauses.push(column + ' = ?')
          params.push(value.trim())
        }
      }
      const sql = 'SELECT * FROM task_roles' + (clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '')
        + ' ORDER BY task_id, agent_id, role'
      return db.prepare(sql).all(...params)
    },
    // Team -> task projection derived only from task_roles (no team_tasks table).
    listTeamTasks({ teamId, boardId } = {}) {
      const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
      if (team === undefined) throw codedError('TEAM_NOT_FOUND', 'apartment: team not found: ' + (teamId ?? '<empty>'))
      const rows = this.listTaskRoles({ teamId, boardId })
      const tasks = new Map()
      for (const row of rows) {
        let item = tasks.get(row.task_id)
        if (item === undefined) {
          item = { taskId: row.task_id, boardId: row.board_id ?? null, roles: [], agents: [] }
          tasks.set(row.task_id, item)
        }
        if (item.boardId === null && row.board_id !== null && row.board_id !== undefined) item.boardId = row.board_id
        if (!item.roles.includes(row.role)) item.roles.push(row.role)
        if (!item.agents.includes(row.agent_id)) item.agents.push(row.agent_id)
      }
      return { teamId, boardId: boardId ?? null, tasks: [...tasks.values()], total: tasks.size }
    },
    recordExperience({ agentId, taskId, summary, skills = [], outcome }) {
      // P1 evidence contract: new writes must carry a task and an outcome. Old
      // rows with NULL fields are kept and reported as invalid by the brief.
      if (typeof taskId !== 'string' || taskId.trim() === '') {
        throw codedError('EXPERIENCE_FIELDS_REQUIRED', 'apartment: experience taskId is required')
      }
      if (typeof outcome !== 'string' || outcome.trim() === '') {
        throw codedError('EXPERIENCE_FIELDS_REQUIRED', 'apartment: experience outcome is required')
      }
      if (typeof summary !== 'string' || summary.trim() === '') {
        throw codedError('EXPERIENCE_FIELDS_REQUIRED', 'apartment: experience summary is required')
      }
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId)
      if (agent === undefined) throw codedError('AGENT_NOT_FOUND', 'apartment: agent not found: ' + (agentId ?? '<empty>'))
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
    backup(label = 'manual', options = {}) {
      const stamp = now().replace(/[:.]/g, '-')
      const safeLabel = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+/, '').slice(0, 64) || 'manual'
      const backupsDir = join(resolvedRoot, 'backups')
      let dir = null
      for (let attempt = 0; attempt < 5 && dir === null; attempt += 1) {
        const suffix = attempt === 0 ? '' : '-' + randomUUID().slice(0, 8)
        const candidate = join(backupsDir, `${stamp}-${safeLabel}${suffix}`)
        try {
          // Non-recursive mkdir is the atomic claim: two concurrent backups can
          // never write into the same snapshot directory.
          mkdirSync(candidate)
          dir = candidate
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
      }
      if (dir === null) throw new Error('apartment: could not allocate a unique backup directory under ' + backupsDir)
      try {
        cpSync(join(resolvedRoot, 'agents'), join(dir, 'agents'), { recursive: true })
        cpSync(join(resolvedRoot, 'work'), join(dir, 'work'), { recursive: true })
        this.checkpoint?.()
        if (existsSync(join(resolvedRoot, 'apartment.sqlite'))) cpSync(join(resolvedRoot, 'apartment.sqlite'), join(dir, 'apartment.sqlite'))
        const manifest = {
          id: stamp,
          at: now(),
          label: safeLabel,
          kind: safeLabel === 'pre-restore' ? 'pre-restore' : 'snapshot',
          root: resolvedRoot,
          files: [],
        }
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
        const retention = pruneBackups(backupKeepLimit, { protect: [dir, options?.protect] })
        return {
          backup: dir,
          files: manifest.files.length,
          pruned: retention.pruned,
          ...(retention.errors.length > 0 ? { pruneErrors: retention.errors } : {}),
          ...(retention.skipped ? { pruneSkipped: retention.skipped } : {}),
        }
      } catch (error) {
        // Never leave a half-written snapshot behind: it would consume a
        // retention slot and could later look like a corrupt backup.
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
        throw error
      }
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
      const safety = this.backup('pre-restore', { protect: from })
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
      return listBackupDirs(join(resolvedRoot, 'backups')).map(entry => ({
        name: entry.name,
        path: entry.path,
        at: entry.manifest?.at ?? null,
        files: Array.isArray(entry.manifest?.files) ? entry.manifest.files.length : 0,
        label: entry.manifest?.label ?? null,
        preRestore: entry.preRestore,
      }))
    },
    // Read-only backup audit: manifest shape, per-file sha256, path containment
    // and the age of the newest normal snapshot. It never opens or writes the
    // business DB, so it is safe to call while migration/restore is pending.
    verifyBackups(options = {}) {
      const requestedDays = Number(options?.maxAgeDays)
      const requestedMs = Number(options?.maxAgeMs)
      const maxAgeMs = Number.isFinite(requestedDays) && requestedDays >= 0
        ? requestedDays * DAY_MS
        : (Number.isFinite(requestedMs) && requestedMs >= 0 ? requestedMs : configuredBackupMaxAgeMs)
      const issues = []
      const entries = listBackupDirs(join(resolvedRoot, 'backups'))
      let filesChecked = 0
      for (const entry of entries) {
        const base = resolve(entry.path)
        const manifestPath = join(base, 'manifest.json')
        if (!existsSync(manifestPath)) {
          issues.push({ backup: entry.name, issue: 'missing-manifest' })
          continue
        }
        let manifest
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {
          issues.push({ backup: entry.name, issue: 'invalid-manifest' })
          continue
        }
        if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
          issues.push({ backup: entry.name, issue: 'invalid-manifest' })
          continue
        }
        const listed = new Set()
        for (const file of manifest.files) {
          if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.sha256 !== 'string') {
            issues.push({ backup: entry.name, issue: 'invalid-manifest-entry' })
            continue
          }
          const target = resolve(base, file.path)
          if (target !== base && !target.startsWith(base + sep)) {
            issues.push({ backup: entry.name, issue: 'path-escape', path: file.path })
            continue
          }
          listed.add(target)
          let data
          try { data = readFileSync(target) } catch {
            issues.push({ backup: entry.name, issue: 'missing-file', path: file.path })
            continue
          }
          filesChecked += 1
          if (sha256(data) !== file.sha256) issues.push({ backup: entry.name, issue: 'hash-mismatch', path: file.path })
        }
        // Anything on disk that the manifest does not list is unexpected in an
        // immutable snapshot (and catches a manifest entry silently removed).
        const walk = (dir, prefix = '') => {
          for (const dirent of readdirSync(dir, { withFileTypes: true })) {
            if (prefix === '' && dirent.name === 'manifest.json') continue
            const full = join(dir, dirent.name)
            const rel = join(prefix, dirent.name)
            if (dirent.isDirectory()) { walk(full, rel); continue }
            if (!listed.has(resolve(full))) issues.push({ backup: entry.name, issue: 'unlisted-file', path: rel })
          }
        }
        try { walk(base) } catch (error) {
          issues.push({ backup: entry.name, issue: 'unreadable-directory', detail: String(error?.message ?? error) })
        }
      }
      const normal = entries.filter(entry => !entry.preRestore)
      let latestBackup = null
      if (normal.length === 0) {
        issues.push({ issue: 'no-backups' })
      } else {
        const latest = normal[0]
        const at = latest.manifest?.at
        const timestamp = typeof at === 'string' ? Date.parse(at) : NaN
        if (!Number.isFinite(timestamp)) {
          issues.push({ backup: latest.name, issue: 'invalid-backup-time' })
        } else {
          const ageMs = Math.max(0, Date.now() - timestamp)
          latestBackup = { name: latest.name, at, ageMs }
          if (ageMs > maxAgeMs) issues.push({ backup: latest.name, issue: 'latest-backup-stale', ageMs, maxAgeMs })
        }
      }
      return {
        ok: issues.length === 0,
        root: resolvedRoot,
        backups: entries.length,
        normalBackups: normal.length,
        filesChecked,
        latestBackup,
        maxAgeMs,
        checkedAt: now(),
        issues,
      }
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
