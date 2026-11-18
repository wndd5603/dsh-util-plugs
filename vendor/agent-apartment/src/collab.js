// P0 collaboration projections for dsh-agent-apartment.
//
// Everything in this module is read-only except the caller's own use of the
// apartment store write helpers (bind/unbind live in src/store.js). The brief
// deliberately never calls listLeases()/status(), because both reap expired
// leases (UPDATE) and would break the read-only contract.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export const MAX_ALIAS_LENGTH = 16
export const COLLAB_BRIEF_SOURCE_KIND = 'apartment-collab-brief'
export const BRIEF_LIMITS = Object.freeze({
  teams: 10,
  roles: 10,
  tasks: 10,
  leases: 10,
  experiences: 5,
  // E2: every list in the model-facing brief is capped, including aliases.
  aliases: 20,
})
export const COLLAB_ERROR_CODES = Object.freeze({
  OPERATOR_REQUIRED: 'APARTMENT_OPERATOR_REQUIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_STORE_UNAVAILABLE: 'TASK_STORE_UNAVAILABLE',
  TASK_BOARD_MISMATCH: 'TASK_BOARD_MISMATCH',
  EXPERIENCE_FIELDS_REQUIRED: 'EXPERIENCE_FIELDS_REQUIRED',
  ALIAS_TOO_LONG: 'ALIAS_TOO_LONG',
  UNBOUND_SESSION: 'UNBOUND_SESSION',
})
export const COLLAB_WARNING_CODES = Object.freeze({
  ORPHAN_TASK_ROLE: 'ORPHAN_TASK_ROLE',
  TASK_UNVERIFIED: 'TASK_UNVERIFIED',
  INVALID_EXPERIENCE: 'INVALID_EXPERIENCE',
})

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const nowIso = () => new Date().toISOString()
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== ''
const unique = values => [...new Set(values.filter(isNonEmptyString))]
const truncate = (items, limit) => ({
  items: items.slice(0, limit),
  truncated: items.length > limit,
})

const profileDirs = profileDir => {
  const home = dshHome()
  const explicit = isNonEmptyString(process.env.DSH_PROFILE_DIR)
    ? process.env.DSH_PROFILE_DIR.trim()
    : (isNonEmptyString(profileDir) ? profileDir.trim() : null)
  // An explicit profile inside this DSH_HOME is authoritative. An explicit
  // profile outside a (likely temporary) DSH_HOME is checked after the home
  // profiles, so a test/isolated DSH_HOME never reads another live profile DB.
  if (explicit !== null) {
    const base = resolve(home)
    const value = resolve(explicit)
    if (value === base || value.startsWith(base + sep)) return [explicit]
  }
  const dirs = [join(home, 'profiles', 'web')]
  try {
    for (const name of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', name))
  } catch { /* no profiles directory */ }
  if (explicit !== null) dirs.push(explicit)
  return [...new Set(dirs)]
}

/** Resolve the session-network DB read-only location (never creates it). */
export function resolveNetworkDbPath(profileDir) {
  if (isNonEmptyString(process.env.DSH_NETWORK_DB)) {
    return { path: process.env.DSH_NETWORK_DB.trim(), source: 'env' }
  }
  const dirs = profileDirs(profileDir)
  for (const dir of dirs) {
    const path = join(dir, 'data', 'session-network', 'network.db')
    if (existsSync(path)) return { path, source: 'profile' }
  }
  return {
    path: join(dirs[0] ?? join(dshHome(), 'profiles', 'web'), 'data', 'session-network', 'network.db'),
    source: 'default',
  }
}

/** Resolve the bulletin-board DB read-only location (never creates it). */
export function resolveBulletinDbPath() {
  if (isNonEmptyString(process.env.DSH_BULLETIN_DB)) {
    return { path: process.env.DSH_BULLETIN_DB.trim(), source: 'env' }
  }
  return { path: join(dshHome(), 'bulletin-board', 'board.sqlite'), source: 'default' }
}

/** Resolve the durable memory DB read-only location (never creates it). */
export function resolveMemoryDbPath() {
  if (isNonEmptyString(process.env.DSH_MEMORY_DB)) {
    return { path: process.env.DSH_MEMORY_DB.trim(), source: 'env' }
  }
  return { path: join(dshHome(), 'memory', 'memory.sqlite'), source: 'default' }
}

/** Resolve the content-addressed artifact pointer (read-only). */
export function resolveArtifactCurrentPath() {
  return { path: join(dshHome(), 'artifacts', 'current.json'), source: 'default' }
}

/** Read-only memory digest: keys/counts only, never the memory body. */
export function readMemoryRecall({ limit = 5 } = {}) {
  const resolved = resolveMemoryDbPath()
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) return { available: false, code: 'MEMORY_UNAVAILABLE', file: basename(resolved.path), total: 0, keys: [], scopes: [] }
  try {
    const total = Number(opened.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NULL').get()?.n ?? 0)
    const rows = opened.db.prepare('SELECT id,scope,key,updated_at FROM memories WHERE superseded_by IS NULL ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(20, limit)))
    const scopes = opened.db.prepare('SELECT scope,COUNT(*) AS n FROM memories WHERE superseded_by IS NULL GROUP BY scope').all()
    return {
      available: true, total,
      keys: rows.map(row => ({ id: row.id, key: row.key, scope: row.scope, updatedAt: row.updated_at })),
      scopes: scopes.map(row => ({ scope: row.scope, count: Number(row.n) })),
      contentOmitted: true,
      truncated: total > rows.length,
    }
  } catch (error) {
    return { available: false, code: 'MEMORY_READ_FAILED', reason: String(error?.message ?? error), total: 0, keys: [], scopes: [] }
  } finally {
    opened.db.close()
  }
}

/** Read-only artifact current pointer; never scans artifacts or writes. */
export function readArtifactRecall() {
  const resolved = resolveArtifactCurrentPath()
  try {
    const parsed = JSON.parse(requireReadFile(resolved.path))
    const artifact = parsed?.artifact ?? parsed
    if (artifact === null || typeof artifact !== 'object') return { available: false, code: 'ARTIFACT_INVALID' }
    return {
      available: true,
      artifactId: typeof artifact.artifactId === 'string' ? artifact.artifactId : null,
      sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null,
      size: Number.isFinite(Number(artifact.size)) ? Number(artifact.size) : null,
      file: isNonEmptyString(artifact.file) ? basename(artifact.file) : null,
      buildId: artifact.buildId ?? null,
      createdAt: artifact.createdAt ?? null,
      updatedAt: parsed?.updatedAt ?? null,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, code: 'ARTIFACT_MISSING' }
    return { available: false, code: 'ARTIFACT_READ_FAILED', reason: String(error?.message ?? error) }
  }
}

function requireReadFile(path) {
  // Lazy import keeps the module's top-level surface unchanged.
  return readFileSync(path)
}

const openReadOnly = path => {
  if (!existsSync(path)) return { db: null, reason: 'missing' }
  try {
    return { db: new DatabaseSync(path, { readOnly: true }), reason: null }
  } catch (error) {
    return { db: null, reason: String(error?.message ?? error) }
  }
}

const unavailable = (code, path, reason, extra = {}) => ({
  code,
  // Only the file name is surfaced: the brief is model-facing and must not leak
  // absolute profile/home paths.
  file: basename(path),
  reason,
  ...extra,
})

/**
 * Read aliases for the given sessions from session-network (read-only).
 * routeResolvable means: alias is active, not superseded, and points at that
 * exact session. Session-row drift is reported separately by the drift check.
 */
export function readNetworkAliases({ sessionIds = [], profileDir } = {}) {
  const resolved = resolveNetworkDbPath(profileDir)
  const result = {
    available: false,
    path: resolved.path,
    aliases: [],
    warnings: [],
    sessionsKnown: false,
  }
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) {
    result.warnings.push(unavailable('NETWORK_UNAVAILABLE', resolved.path, opened.reason))
    return result
  }
  const ids = unique(sessionIds)
  try {
    result.available = true
    if (ids.length === 0) return result
    const placeholders = ids.map(() => '?').join(',')
    const rows = opened.db.prepare(`SELECT * FROM aliases WHERE session_id IN (${placeholders})
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, alias`).all(...ids)
    let knownSessions = null
    try {
      const sessionRows = opened.db.prepare(`SELECT session_id FROM sessions WHERE session_id IN (${placeholders})`).all(...ids)
      knownSessions = new Set(sessionRows.map(row => row.session_id))
      result.sessionsKnown = true
    } catch { /* sessions table absent: route resolution degrades to alias status only */ }
    const supersededBy = unique(rows.map(row => row.superseded_by))
    const supersededSessions = new Map()
    if (supersededBy.length > 0) {
      try {
        const targets = opened.db.prepare(`SELECT alias, session_id FROM aliases WHERE alias IN (${supersededBy.map(() => '?').join(',')})`)
          .all(...supersededBy)
        for (const row of targets) supersededSessions.set(row.alias, row.session_id ?? null)
      } catch { /* advisory only */ }
    }
    for (const row of rows) {
      const alias = typeof row.alias === 'string' ? row.alias : String(row.alias ?? '')
      if (alias === '') continue
      if (alias.length > MAX_ALIAS_LENGTH) {
        result.warnings.push({
          code: COLLAB_ERROR_CODES.ALIAS_TOO_LONG,
          alias,
          length: alias.length,
          max: MAX_ALIAS_LENGTH,
        })
        continue
      }
      const sessionId = row.session_id ?? null
      const sessionExists = knownSessions === null ? null : knownSessions.has(sessionId)
      const routeResolvable = row.status === 'active'
        && (row.superseded_by === null || row.superseded_by === undefined)
        && sessionId !== null
        && ids.includes(sessionId)
      result.aliases.push({
        alias,
        sessionId,
        status: row.status ?? null,
        supersededBy: row.superseded_by ?? null,
        supersededBySessionId: row.superseded_by === null || row.superseded_by === undefined
          ? null
          : (supersededSessions.get(row.superseded_by) ?? null),
        supersededByFound: row.superseded_by === null || row.superseded_by === undefined
          ? null
          : supersededSessions.has(row.superseded_by),
        sessionExists,
        routeResolvable,
        createdAt: row.created_at ?? null,
      })
    }
    return result
  } catch (error) {
    result.available = false
    result.aliases = []
    result.warnings.push(unavailable('NETWORK_UNAVAILABLE', resolved.path, String(error?.message ?? error)))
    return result
  } finally {
    try { opened.db.close() } catch { /* best effort */ }
  }
}

/**
 * Read session rows (display_name/status) from session-network, read-only.
 * Used only to enrich live-session candidates. A missing/partial sessions table
 * is not an error: the caller still has the live agent header and aliases.
 */
export function readNetworkSessions({ sessionIds = [], profileDir } = {}) {
  const resolved = resolveNetworkDbPath(profileDir)
  const result = { available: false, sessions: [] }
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) return result
  try {
    result.available = true
    const ids = unique(sessionIds)
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      let rows
      try {
        rows = opened.db.prepare(`SELECT * FROM sessions
          WHERE session_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
      } catch {
        // Older or partial network DBs may lack the sessions table/columns.
        return result
      }
      for (const row of rows) {
        result.sessions.push({
          sessionId: row.session_id,
          displayName: isNonEmptyString(row.display_name) ? row.display_name.trim() : null,
          status: isNonEmptyString(row.status) ? row.status.trim() : null,
          lastSeen: row.last_seen ?? null,
        })
      }
    }
    return result
  } catch {
    return result
  } finally {
    try { opened.db.close() } catch { /* best effort */ }
  }
}

const bulletinTask = row => ({
  id: row.id,
  boardId: row.board_id ?? null,
  title: row.title ?? null,
  status: row.status ?? null,
  assigneeSession: row.assignee_session ?? null,
  assigneeAlias: row.assignee_alias ?? null,
  workspace: row.workspace ?? null,
  priority: row.priority ?? 0,
  updatedAt: row.updated_at ?? null,
  createdAt: row.created_at ?? null,
})

/**
 * Read tasks assigned to the agent's sessions or aliases from bulletin-board
 * (read-only). Callers pass the agent's bound session ids and alias rows.
 */
export function readBulletinTasks({ sessionIds = [], aliases = [], taskId, boardId } = {}) {
  const resolved = resolveBulletinDbPath()
  const result = {
    available: false,
    path: resolved.path,
    tasks: [],
    total: 0,
    truncated: false,
    warnings: [],
  }
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) {
    result.warnings.push(unavailable('BULLETIN_UNAVAILABLE', resolved.path, opened.reason))
    return result
  }
  try {
    result.available = true
    const ids = unique(sessionIds)
    const resolvableAliases = unique(aliases.filter(item => item?.routeResolvable === true).map(item => item.alias))
    const unresolvedAliases = unique(aliases.filter(item => item?.routeResolvable !== true).map(item => item.alias))
    const filters = []
    const filterParams = []
    if (isNonEmptyString(taskId)) { filters.push('id = ?'); filterParams.push(taskId.trim()) }
    if (isNonEmptyString(boardId)) { filters.push('board_id = ?'); filterParams.push(boardId.trim()) }
    const filterSql = filters.length > 0 ? ' AND ' + filters.join(' AND ') : ''

    // Stable ownership: a task is ours when its session is bound, or when its
    // alias is currently routable to one of those sessions. A task assigned to
    // an unresolvable alias is not counted, but is surfaced as a warning below.
    if (ids.length > 0 || resolvableAliases.length > 0) {
      const where = []
      const params = []
      if (ids.length > 0) {
        where.push(`assignee_session IN (${ids.map(() => '?').join(',')})`)
        params.push(...ids)
      }
      if (resolvableAliases.length > 0) {
        where.push(`assignee_alias IN (${resolvableAliases.map(() => '?').join(',')})`)
        params.push(...resolvableAliases)
      }
      params.push(...filterParams)
      const limit = BRIEF_LIMITS.tasks + 1
      const scopeSql = `FROM tasks WHERE (${where.join(' OR ')})${filterSql}`
      result.total = Number(opened.db.prepare('SELECT COUNT(*) AS n ' + scopeSql).get(...params).n)
      const sql = `SELECT id, board_id, title, status, assignee_session, assignee_alias,
          workspace, priority, updated_at, created_at
        ${scopeSql}
        ORDER BY CASE status
          WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'pending' THEN 2
          WHEN 'suspended' THEN 3 ELSE 4 END, updated_at DESC
        LIMIT ${limit}`
      const rows = opened.db.prepare(sql).all(...params)
      result.truncated = result.total > BRIEF_LIMITS.tasks
      result.tasks = rows.slice(0, BRIEF_LIMITS.tasks).map(row => ({
        ...bulletinTask(row),
        assigneeResolvable: true,
      }))
    }
    if (unresolvedAliases.length > 0) {
      const where = [`assignee_alias IN (${unresolvedAliases.map(() => '?').join(',')})`]
      const params = [...unresolvedAliases]
      if (ids.length > 0) {
        where.push(`(assignee_session IS NULL OR assignee_session NOT IN (${ids.map(() => '?').join(',')}))`)
        params.push(...ids)
      }
      params.push(...filterParams)
      const rows = opened.db.prepare(`SELECT id, assignee_alias FROM tasks WHERE ${where.join(' AND ')}${filterSql}`).all(...params)
      for (const row of rows) {
        result.warnings.push({ code: 'TASK_ASSIGNEE_UNRESOLVED', taskId: row.id, assigneeAlias: row.assignee_alias })
      }
    }
    return result
  } catch (error) {
    result.available = false
    result.tasks = []
    result.total = 0
    result.warnings.push(unavailable('BULLETIN_UNAVAILABLE', resolved.path, String(error?.message ?? error)))
    return result
  } finally {
    try { opened.db.close() } catch { /* best effort */ }
  }
}

const BULLETIN_TASK_COLUMNS = `id, board_id, title, status, assignee_session, assignee_alias,
  workspace, priority, updated_at, created_at`

/**
 * Read-only existence check for one bulletin task. `available` is true only when
 * the tasks table could actually be queried; a missing/corrupt DB is a store
 * availability problem, not a missing task.
 */
export function lookupBulletinTask(taskId) {
  const resolved = resolveBulletinDbPath()
  const result = { available: false, path: resolved.path, task: null, reason: null }
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) {
    result.reason = opened.reason
    return result
  }
  try {
    const row = opened.db.prepare(`SELECT ${BULLETIN_TASK_COLUMNS} FROM tasks WHERE id = ?`).get(taskId)
    result.available = true
    result.task = row === undefined ? null : bulletinTask(row)
    return result
  } catch (error) {
    result.reason = String(error?.message ?? error)
    return result
  } finally {
    try { opened.db.close() } catch { /* best effort */ }
  }
}

/**
 * Read-only task records for the given ids, used by the brief to enrich
 * taskRoles with title/board and to detect orphan roles. It never writes.
 */
export function readBulletinTaskRecords({ taskIds = [] } = {}) {
  const resolved = resolveBulletinDbPath()
  const result = { available: false, path: resolved.path, tasks: new Map(), warnings: [] }
  const opened = openReadOnly(resolved.path)
  if (opened.db === null) {
    result.warnings.push(unavailable('BULLETIN_UNAVAILABLE', resolved.path, opened.reason))
    return result
  }
  try {
    // Prove the tasks table is readable even when there is nothing to fetch.
    opened.db.prepare('SELECT id FROM tasks LIMIT 0').all()
    result.available = true
    const ids = unique(taskIds)
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      const rows = opened.db.prepare(`SELECT ${BULLETIN_TASK_COLUMNS} FROM tasks
        WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
      for (const row of rows) result.tasks.set(row.id, bulletinTask(row))
    }
    return result
  } catch (error) {
    result.available = false
    result.tasks.clear()
    result.warnings.push(unavailable('BULLETIN_UNAVAILABLE', resolved.path, String(error?.message ?? error)))
    return result
  } finally {
    try { opened.db.close() } catch { /* best effort */ }
  }
}

const parseSkills = value => {
  if (value === null || value === undefined) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const leaseRow = row => {
  const expiresAt = row.expires_at ?? null
  const expiresMs = expiresAt === null ? NaN : Date.parse(expiresAt)
  return {
    id: row.id,
    agentId: row.agent_id,
    workspace: row.workspace,
    workDir: row.work_dir,
    taskId: row.task_id ?? null,
    state: row.state,
    expiresAt,
    // Advisory only: computed without UPDATE. state stays whatever is stored.
    expired: row.state === 'active' && Number.isFinite(expiresMs) && expiresMs < Date.now(),
    createdAt: row.created_at,
  }
}

const experienceRow = row => {
  const invalid = row.task_id === null || row.task_id === undefined
    || String(row.task_id).trim() === ''
    || row.outcome === null || row.outcome === undefined
    || String(row.outcome).trim() === ''
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id ?? null,
    summary: row.summary,
    skills: parseSkills(row.skills),
    outcome: row.outcome ?? null,
    createdAt: row.created_at,
    invalid,
  }
}

const briefText = (agentId, counts) => '[collab] agent=' + agentId
  + ' teams=' + counts.teams
  + ' roles=' + counts.roles
  + ' aliases=' + counts.aliases
  + ' tasks=' + counts.tasks
  + ' warnings=' + counts.warnings
  + '; apartment_collaboration_brief()'

/**
 * Read-only Collaboration Brief for one session.
 * Returns { ok:false, code:UNBOUND_SESSION } when the session has no binding.
 */
export function buildCollaborationBrief({ apartment, sessionId, taskId, boardId, profileDir, asOf = nowIso() } = {}) {
  const requestedSession = isNonEmptyString(sessionId) ? sessionId.trim() : null
  if (requestedSession === null) {
    return {
      ok: false, code: COLLAB_ERROR_CODES.UNBOUND_SESSION, sessionId: null, agentId: null,
      warnings: [], asOf, text: '',
    }
  }
  const binding = apartment.getAgentSession(requestedSession)
  if (binding === undefined) {
    return {
      ok: false, code: COLLAB_ERROR_CODES.UNBOUND_SESSION, sessionId: requestedSession, agentId: null,
      warnings: [], asOf, text: '',
    }
  }
  const agents = apartment.listAgents()
  const agent = agents.find(row => row.id === binding.agent_id) ?? null
  const bindings = apartment.listAgentSessions(binding.agent_id)
  const sessionIds = unique(bindings.map(row => row.session_id))
  const network = readNetworkAliases({ sessionIds, profileDir })
  const aliases = network.aliases
  const warnings = [...network.warnings]
  if (agent === null) warnings.push({ code: COLLAB_ERROR_CODES.AGENT_NOT_FOUND, agentId: binding.agent_id })
  for (const alias of aliases) {
    if (!alias.routeResolvable) {
      warnings.push({
        code: 'ALIAS_UNRESOLVED',
        alias: alias.alias,
        status: alias.status,
        sessionId: alias.sessionId,
        supersededBy: alias.supersededBy,
      })
    }
  }

  const teamsById = new Map(apartment.listTeams().map(team => [team.id, team]))
  const memberships = apartment.listMemberships().filter(row => row.agent_id === binding.agent_id)
  const taskIdFilter = isNonEmptyString(taskId) ? taskId.trim() : undefined
  const taskRoles = apartment.listTaskRoles().filter(row => row.agent_id === binding.agent_id
    && (taskIdFilter === undefined || row.task_id === taskIdFilter))
  const leases = apartment.listLeasesReadOnly({ agentId: binding.agent_id })
  const experiences = apartment.listExperiences(binding.agent_id)
  const bulletin = readBulletinTasks({ sessionIds, aliases, taskId, boardId })
  warnings.push(...bulletin.warnings)

  const teamItems = memberships.map(row => ({
    teamId: row.team_id,
    name: teamsById.get(row.team_id)?.name ?? null,
    role: row.role,
  }))
  const roleItems = unique(memberships.map(row => row.role))
  const taskRoleItems = taskRoles.map(row => ({
    taskId: row.task_id,
    agentId: row.agent_id,
    teamId: row.team_id ?? null,
    boardId: row.board_id ?? null,
    role: row.role,
    // D2: pre-migration rows (verified undefined) are treated as verified.
    verified: row.verified === undefined || row.verified === null ? true : Number(row.verified) !== 0,
    taskTitle: null,
  }))
  // D2: an allowUnverified write is surfaced even when bulletin is unavailable,
  // so the caller never has to rely on ORPHAN_TASK_ROLE to notice it.
  for (const item of taskRoleItems) {
    if (item.verified) continue
    warnings.push({
      code: COLLAB_WARNING_CODES.TASK_UNVERIFIED,
      taskId: item.taskId,
      agentId: item.agentId,
      teamId: item.teamId,
      role: item.role,
    })
  }
  // Enrich task roles from bulletin (read-only) and flag roles whose task is
  // gone as orphans. No warning is emitted when the store itself is unavailable:
  // BULLETIN_UNAVAILABLE above already explains why titles are null.
  if (taskRoleItems.length > 0) {
    const taskRecords = readBulletinTaskRecords({ taskIds: taskRoleItems.map(item => item.taskId) })
    if (taskRecords.available) {
      for (const item of taskRoleItems) {
        const task = taskRecords.tasks.get(item.taskId)
        if (task === undefined) {
          warnings.push({
            code: COLLAB_WARNING_CODES.ORPHAN_TASK_ROLE,
            taskId: item.taskId,
            agentId: item.agentId,
            teamId: item.teamId,
            role: item.role,
          })
          continue
        }
        item.taskTitle = task.title ?? null
        if (item.boardId === null) item.boardId = task.boardId ?? null
      }
    } else if (bulletin.available) {
      warnings.push(...taskRecords.warnings)
    }
  }
  const leaseItems = leases.map(leaseRow)
  // Team tasks are derived from task_roles only (no team_tasks table), scoped to
  // the teams this agent belongs to. Roles/agents are deduped per team+task.
  const memberTeamIds = unique(memberships.map(row => row.team_id))
  const teamTaskItems = []
  if (memberTeamIds.length > 0) {
    const byTeamTask = new Map()
    for (const row of apartment.listTaskRoles()) {
      if (row.team_id === null || row.team_id === undefined || !memberTeamIds.includes(row.team_id)) continue
      const key = row.team_id + '\u0000' + row.task_id
      let item = byTeamTask.get(key)
      if (item === undefined) {
        item = { teamId: row.team_id, taskId: row.task_id, boardId: row.board_id ?? null, roles: [], agents: [] }
        byTeamTask.set(key, item)
      }
      if (item.boardId === null && row.board_id !== null && row.board_id !== undefined) item.boardId = row.board_id
      if (!item.roles.includes(row.role)) item.roles.push(row.role)
      if (!item.agents.includes(row.agent_id)) item.agents.push(row.agent_id)
    }
    teamTaskItems.push(...byTeamTask.values())
  }
  // P1: only valid experience entries participate in the brief; old rows that
  // miss taskId/outcome are kept in the DB and surfaced as INVALID_EXPERIENCE.
  const allExperienceItems = experiences.map(experienceRow)
  const experienceItems = allExperienceItems.filter(experience => !experience.invalid)
  for (const experience of allExperienceItems) {
    if (!experience.invalid) continue
    warnings.push({
      code: COLLAB_WARNING_CODES.INVALID_EXPERIENCE,
      experienceId: experience.id,
      agentId: experience.agentId,
    })
  }

  const teams = truncate(teamItems, BRIEF_LIMITS.teams)
  const roles = truncate(roleItems, BRIEF_LIMITS.roles)
  const aliasBox = truncate(aliases, BRIEF_LIMITS.aliases)
  const taskRoleBox = truncate(taskRoleItems, BRIEF_LIMITS.tasks)
  const teamTaskBox = truncate(teamTaskItems, BRIEF_LIMITS.tasks)
  const leaseBox = truncate(leaseItems, BRIEF_LIMITS.leases)
  const experienceBox = truncate(experienceItems, BRIEF_LIMITS.experiences)
  const memory = readMemoryRecall({ limit: 5 })
  const artifact = readArtifactRecall()
  const counts = {
    teams: teamItems.length,
    roles: roleItems.length,
    aliases: aliases.length,
    tasks: bulletin.total,
    leases: leaseItems.length,
    experiences: experienceItems.length,
    warnings: warnings.length,
    taskRoles: taskRoleItems.length,
    teamTasks: teamTaskItems.length,
    memory: memory.total ?? 0,
  }
  const text = briefText(binding.agent_id, counts)
  return {
    ok: true,
    sessionId: requestedSession,
    agentId: binding.agent_id,
    binding: {
      agentId: binding.agent_id,
      sessionId: binding.session_id,
      isPrimary: Number(binding.is_primary) === 1,
      createdAt: binding.created_at,
      updatedAt: binding.updated_at,
    },
    agent: agent === null ? null : {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      // Only the basename is exposed: never leak the absolute home path.
      home: isNonEmptyString(binding.agent_home) ? basename(binding.agent_home) : null,
      homeBasename: isNonEmptyString(binding.agent_home) ? basename(binding.agent_home) : null,
    },
    aliases: aliasBox.items,
    teams: teams.items,
    roles: roles.items,
    taskRoles: taskRoleBox.items,
    teamTasks: teamTaskBox.items,
    leases: leaseBox.items,
    assignedTasks: bulletin.tasks,
    experiences: experienceBox.items,
    memory,
    artifact,
    warnings,
    counts,
    truncated: {
      teams: teams.truncated,
      roles: roles.truncated,
      aliases: aliasBox.truncated,
      tasks: bulletin.truncated,
      taskRoles: taskRoleBox.truncated,
      teamTasks: teamTaskBox.truncated,
      leases: leaseBox.truncated,
      experiences: experienceBox.truncated,
      warnings: false,
    },
    asOf,
    text,
  }
}

/** Read-only binding list with session-network aliases and route resolvability. */
export function buildBindingList({ apartment, agentId, profileDir, asOf = nowIso() } = {}) {
  const bindings = apartment.listAgentSessions(agentId)
  const network = readNetworkAliases({
    sessionIds: bindings.map(row => row.session_id),
    profileDir,
  })
  const aliasesBySession = new Map()
  for (const alias of network.aliases) {
    const list = aliasesBySession.get(alias.sessionId) ?? []
    list.push(alias)
    aliasesBySession.set(alias.sessionId, list)
  }
  const warnings = [...network.warnings]
  const items = bindings.map(row => {
    const aliases = aliasesBySession.get(row.session_id) ?? []
    if (row.agent_name === null || row.agent_name === undefined) {
      warnings.push({ code: COLLAB_ERROR_CODES.AGENT_NOT_FOUND, agentId: row.agent_id, sessionId: row.session_id })
    }
    return {
      agentId: row.agent_id,
      agentName: row.agent_name ?? null,
      agentStatus: row.agent_status ?? null,
      homeBasename: isNonEmptyString(row.agent_home) ? basename(row.agent_home) : null,
      sessionId: row.session_id,
      isPrimary: Number(row.is_primary) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      aliases,
      routeResolvable: aliases.some(alias => alias.routeResolvable),
    }
  })
  return {
    ok: true,
    bindings: items,
    networkAvailable: network.available,
    warnings,
    asOf,
  }
}

/**
 * Read-only drift report: apartment agents / live sessions / network aliases.
 * Never modifies any table; issues are advisory.
 */
export function buildDriftReport({ apartment, resolveSession, profileDir, asOf = nowIso() } = {}) {
  const bindings = apartment.listAgentSessions()
  const agents = new Map(apartment.listAgents().map(row => [row.id, row]))
  const network = readNetworkAliases({
    sessionIds: bindings.map(row => row.session_id),
    profileDir,
  })
  const issues = [...network.warnings]
  const primaryCounts = new Map()
  for (const row of bindings) {
    const count = (primaryCounts.get(row.agent_id) ?? 0) + (Number(row.is_primary) === 1 ? 1 : 0)
    primaryCounts.set(row.agent_id, count)
  }
  for (const [agentId, count] of primaryCounts) {
    if (count > 1) issues.push({ code: 'MULTIPLE_PRIMARY', agentId, count })
  }
  for (const row of bindings) {
    if (!agents.has(row.agent_id)) {
      issues.push({ code: COLLAB_ERROR_CODES.AGENT_NOT_FOUND, agentId: row.agent_id, sessionId: row.session_id })
    }
    let resolved = false
    try {
      resolved = typeof resolveSession === 'function' ? Boolean(resolveSession(row.session_id)) : false
    } catch {
      resolved = false
    }
    if (!resolved) {
      issues.push({ code: COLLAB_ERROR_CODES.SESSION_NOT_FOUND, agentId: row.agent_id, sessionId: row.session_id })
    }
  }
  const boundSessions = new Set(bindings.map(row => row.session_id))
  for (const alias of network.aliases) {
    if (!boundSessions.has(alias.sessionId)) continue
    if (alias.status !== 'active') {
      issues.push({
        code: 'ALIAS_NOT_ACTIVE',
        alias: alias.alias,
        status: alias.status,
        sessionId: alias.sessionId,
        supersededBy: alias.supersededBy,
      })
    }
    if (alias.sessionExists === false) {
      issues.push({ code: 'ALIAS_SESSION_MISSING', alias: alias.alias, sessionId: alias.sessionId })
    }
    if (alias.supersededBy !== null) {
      if (alias.status === 'active') {
        issues.push({ code: 'ALIAS_SUPERSEDED_MISMATCH', alias: alias.alias, supersededBy: alias.supersededBy, sessionId: alias.sessionId })
      } else if (alias.supersededByFound === false) {
        issues.push({ code: 'ALIAS_SUPERSEDED_MISSING', alias: alias.alias, supersededBy: alias.supersededBy, sessionId: alias.sessionId })
      } else if (alias.supersededBySessionId !== null && alias.supersededBySessionId !== alias.sessionId) {
        issues.push({ code: 'ALIAS_SUPERSEDED_MISMATCH', alias: alias.alias, supersededBy: alias.supersededBy, sessionId: alias.sessionId })
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    counts: {
      bindings: bindings.length,
      agents: agents.size,
      sessions: bindings.length,
      aliases: network.aliases.length,
    },
    networkAvailable: network.available,
    asOf,
  }
}

// ---------------------------------------------------------------------------
// P2 onboarding: read-only binding candidates
//
// Candidates are evidence for a human/operator decision, never an automatic
// binding. The matcher never uses cwd as identity evidence. Confidence levels:
//   exact      - a route/declared alias equals agent id/name, or displayName
//                equals the (unique) agent id.
//   normalized - the same comparison after lowercasing and dropping spaces,
//                hyphens and underscores.
//   low        - only the human name (displayName vs agent.name) matches.
//   ambiguous  - a name-based match while several agents share that name; the
//                caller must pick an agentId explicitly.
// ---------------------------------------------------------------------------

export const CANDIDATE_LIMIT = 50
export const CANDIDATE_CONFIDENCE = Object.freeze({
  EXACT: 'exact',
  NORMALIZED: 'normalized',
  LOW: 'low',
  AMBIGUOUS: 'ambiguous',
})
const CANDIDATE_RANK = Object.freeze({
  [CANDIDATE_CONFIDENCE.EXACT]: 0,
  [CANDIDATE_CONFIDENCE.AMBIGUOUS]: 1,
  [CANDIDATE_CONFIDENCE.NORMALIZED]: 2,
  [CANDIDATE_CONFIDENCE.LOW]: 3,
})

const candidateText = value => (isNonEmptyString(value) ? value.trim() : null)
const normalizeCandidateText = value => {
  const text = candidateText(value)
  return text === null ? '' : text.toLowerCase().replace(/[\s\-_]+/g, '')
}
const normalizeLiveStatus = value => {
  const status = candidateText(value)
  if (status === null) return null
  const lower = status.toLowerCase()
  if (lower === 'active' || lower === 'running') return 'live'
  return lower
}

/**
 * Normalize one item from ctx.get('agents').list(). The live DSH agent exposes
 * `session.header`, while lightweight test/team projections may expose the
 * same fields on the wrapper; accept all documented shapes without guessing.
 */
const candidateSessionEntry = raw => {
  if (raw === null || typeof raw !== 'object') return null
  const session = raw.session !== null && typeof raw.session === 'object' ? raw.session : raw
  const header = raw.header !== null && typeof raw.header === 'object'
    ? raw.header
    : (session.header !== null && typeof session.header === 'object' ? session.header : {})
  const sessionId = candidateText(session.id) ?? candidateText(raw.sessionId) ?? candidateText(raw.id)
  if (sessionId === null) return null
  return {
    sessionId,
    displayName: candidateText(raw.displayName) ?? candidateText(header.displayName) ?? candidateText(header.name)
      ?? candidateText(session.displayName) ?? candidateText(session.name) ?? candidateText(raw.name),
    alias: candidateText(raw.alias) ?? candidateText(header.alias) ?? candidateText(session.alias),
    cwd: candidateText(header.cwd) ?? candidateText(session.cwd) ?? candidateText(raw.cwd),
    status: normalizeLiveStatus(raw.status ?? raw.phase ?? raw.liveStatus ?? session.status ?? session.phase),
  }
}

const mergeCandidateSession = (current, incoming) => ({
  sessionId: current.sessionId,
  displayName: current.displayName ?? incoming.displayName,
  alias: current.alias ?? incoming.alias,
  cwd: current.cwd ?? incoming.cwd,
  status: current.status ?? incoming.status,
})

const groupAliasesBySession = aliases => {
  const map = new Map()
  for (const item of aliases) {
    const list = map.get(item.sessionId) ?? []
    list.push(item)
    map.set(item.sessionId, list)
  }
  return map
}

const primarySessionAlias = aliases => {
  const active = aliases.find(item => item.status === 'active'
    && (item.supersededBy === null || item.supersededBy === undefined))
  const fallback = active ?? aliases.find(item => item.status === 'active') ?? aliases[0]
  return fallback?.alias ?? null
}

const candidateAliasEntries = (aliases, headerAlias) => {
  const entries = []
  const seen = new Set()
  for (const item of aliases) {
    if (item.status !== 'active') continue
    if (item.supersededBy !== null && item.supersededBy !== undefined) continue
    const alias = candidateText(item.alias)
    if (alias === null || seen.has(alias)) continue
    seen.add(alias)
    entries.push({
      value: alias,
      source: item.routeResolvable === true ? 'network alias' : 'network alias (route unresolved)',
    })
  }
  if (headerAlias !== null && !seen.has(headerAlias)) {
    entries.push({ value: headerAlias, source: 'header alias' })
  }
  return entries
}

/** Match one unbound agent against one unbound session; null means no match. */
const matchCandidate = ({ agent, aliases, displayName, headerAlias }) => {
  const agentId = candidateText(agent.id)
  if (agentId === null) return null
  const agentName = candidateText(agent.name)
  const aliasEntries = candidateAliasEntries(aliases, headerAlias)
  for (const entry of aliasEntries) {
    if (entry.value === agentId) {
      return {
        confidence: CANDIDATE_CONFIDENCE.EXACT,
        matchedOn: 'id',
        reason: `${entry.source} '${entry.value}' exactly matches agent id '${agentId}'`,
      }
    }
    if (agentName !== null && entry.value === agentName) {
      return {
        confidence: CANDIDATE_CONFIDENCE.EXACT,
        matchedOn: 'name',
        reason: `${entry.source} '${entry.value}' exactly matches agent name '${agentName}'`,
      }
    }
  }
  if (displayName !== null && displayName === agentId) {
    return {
      confidence: CANDIDATE_CONFIDENCE.EXACT,
      matchedOn: 'id',
      reason: `session displayName '${displayName}' exactly matches agent id '${agentId}'`,
    }
  }

  const normalizedId = normalizeCandidateText(agentId)
  const normalizedName = normalizeCandidateText(agentName)
  for (const entry of aliasEntries) {
    const normalizedAlias = normalizeCandidateText(entry.value)
    if (normalizedAlias !== '' && normalizedAlias === normalizedId) {
      return {
        confidence: CANDIDATE_CONFIDENCE.NORMALIZED,
        matchedOn: 'id',
        reason: `${entry.source} '${entry.value}' normalizes to agent id '${agentId}'`,
      }
    }
    if (normalizedAlias !== '' && normalizedName !== '' && normalizedAlias === normalizedName) {
      return {
        confidence: CANDIDATE_CONFIDENCE.NORMALIZED,
        matchedOn: 'name',
        reason: `${entry.source} '${entry.value}' normalizes to agent name '${agentName}'`,
      }
    }
  }
  if (displayName !== null) {
    const normalizedDisplay = normalizeCandidateText(displayName)
    if (normalizedDisplay !== '' && normalizedDisplay === normalizedId) {
      return {
        confidence: CANDIDATE_CONFIDENCE.NORMALIZED,
        matchedOn: 'id',
        reason: `session displayName '${displayName}' normalizes to agent id '${agentId}'`,
      }
    }
  }
  if (displayName !== null && normalizedName !== '' && normalizeCandidateText(displayName) === normalizedName) {
    return {
      confidence: CANDIDATE_CONFIDENCE.LOW,
      matchedOn: 'name',
      reason: `session displayName '${displayName}' matches agent name '${agentName}' only; displayName is not unique`,
    }
  }
  return null
}

const applyNameAmbiguity = (match, agent, nameGroups) => {
  const nameKey = normalizeCandidateText(agent.name)
  const sameName = nameKey === '' ? [] : (nameGroups.get(nameKey) ?? [])
  if (match.matchedOn !== 'name' || sameName.length < 2) return match
  return {
    confidence: CANDIDATE_CONFIDENCE.AMBIGUOUS,
    matchedOn: match.matchedOn,
    reason: match.reason + `; ambiguous: ${sameName.length} agents share name '${agent.name}' (`
      + sameName.map(item => item.id).join(', ') + '); choose agentId explicitly',
  }
}

const candidateSortOrder = (a, b) => {
  const rank = (CANDIDATE_RANK[a.confidence] ?? 9) - (CANDIDATE_RANK[b.confidence] ?? 9)
  return rank !== 0 ? rank : String(a.agentId).localeCompare(String(b.agentId))
}

/**
 * Read-only onboarding candidates for unbound live sessions and unbound agents.
 * It never binds a session, never writes session-network aliases/routes, and
 * never treats cwd as identity evidence. List sizes are capped at 50.
 */
export function buildBindingCandidates({
  apartment,
  listLiveSessions,
  profileDir,
  asOf = nowIso(),
  limit = CANDIDATE_LIMIT,
} = {}) {
  const cap = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(CANDIDATE_LIMIT, Math.trunc(Number(limit))))
    : CANDIDATE_LIMIT
  const warnings = []
  const bindingRows = apartment.listAgentSessions()
  const agents = apartment.listAgents()
  const boundSessionIds = new Set(bindingRows.map(row => row.session_id))
  const boundAgentIds = new Set(bindingRows.map(row => row.agent_id))

  let rawSessions = []
  try {
    const listed = typeof listLiveSessions === 'function' ? listLiveSessions() : []
    rawSessions = Array.isArray(listed) ? listed : []
  } catch (error) {
    warnings.push({ code: 'LIVE_SESSIONS_UNAVAILABLE', reason: String(error?.message ?? error) })
  }

  const liveSessionMap = new Map()
  for (const raw of rawSessions) {
    const entry = candidateSessionEntry(raw)
    if (entry === null) continue
    const current = liveSessionMap.get(entry.sessionId)
    liveSessionMap.set(entry.sessionId, current === undefined ? entry : mergeCandidateSession(current, entry))
  }
  const liveSessions = [...liveSessionMap.values()]
  const unboundSessions = liveSessions
    .filter(entry => !boundSessionIds.has(entry.sessionId))
    .sort((a, b) => String(a.displayName ?? a.sessionId).localeCompare(String(b.displayName ?? b.sessionId))
      || a.sessionId.localeCompare(b.sessionId))

  const unboundAgentRows = agents
    .filter(agent => !boundAgentIds.has(agent.id))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))
      || String(a.id).localeCompare(String(b.id)))

  const sessionPage = unboundSessions.slice(0, cap)
  const agentPage = unboundAgentRows.slice(0, cap)
  const sessionIds = sessionPage.map(entry => entry.sessionId)
  const network = readNetworkAliases({ sessionIds, profileDir })
  const networkSessions = readNetworkSessions({ sessionIds, profileDir })
  warnings.push(...network.warnings)
  const networkSessionById = new Map(networkSessions.sessions.map(row => [row.sessionId, row]))
  const aliasesBySession = groupAliasesBySession(network.aliases)

  const nameGroups = new Map()
  for (const agent of agents) {
    const key = normalizeCandidateText(agent.name)
    if (key === '') continue
    const list = nameGroups.get(key) ?? []
    list.push(agent)
    nameGroups.set(key, list)
  }

  const agentCandidates = new Map(agentPage.map(agent => [agent.id, []]))
  const sessions = []
  let candidateCount = 0
  let ambiguousCount = 0
  let sessionsWithCandidates = 0

  for (const session of sessionPage) {
    const aliases = aliasesBySession.get(session.sessionId) ?? []
    const networkSession = networkSessionById.get(session.sessionId)
    const displayName = session.displayName ?? networkSession?.displayName ?? null
    const headerAlias = session.alias
    const alias = primarySessionAlias(aliases) ?? headerAlias ?? null
    const status = session.status ?? normalizeLiveStatus(networkSession?.status) ?? 'live'
    const candidates = []
    for (const agent of agentPage) {
      const match = matchCandidate({ agent, aliases, displayName, headerAlias })
      if (match === null) continue
      const resolved = applyNameAmbiguity(match, agent, nameGroups)
      const candidate = {
        agentId: agent.id,
        agentName: agent.name,
        confidence: resolved.confidence,
        reason: resolved.reason,
      }
      candidates.push(candidate)
      candidateCount += 1
      if (candidate.confidence === CANDIDATE_CONFIDENCE.AMBIGUOUS) ambiguousCount += 1
      agentCandidates.get(agent.id).push({
        sessionId: session.sessionId,
        displayName,
        confidence: candidate.confidence,
        reason: candidate.reason,
      })
    }
    candidates.sort(candidateSortOrder)
    if (candidates.length > 0) sessionsWithCandidates += 1
    sessions.push({
      sessionId: session.sessionId,
      displayName,
      alias,
      cwd: session.cwd,
      status,
      candidates,
    })
  }

  const unboundAgents = agentPage.map(agent => ({
    agentId: agent.id,
    agentName: agent.name,
    status: agent.status ?? null,
    candidates: (agentCandidates.get(agent.id) ?? []).sort((a, b) => {
      const rank = (CANDIDATE_RANK[a.confidence] ?? 9) - (CANDIDATE_RANK[b.confidence] ?? 9)
      return rank !== 0 ? rank : String(a.sessionId).localeCompare(String(b.sessionId))
    }),
  }))

  return {
    ok: true,
    sessions,
    unboundAgents,
    counts: {
      agents: agents.length,
      bindings: bindingRows.length,
      boundSessions: boundSessionIds.size,
      boundAgents: boundAgentIds.size,
      liveSessions: liveSessions.length,
      unboundSessions: unboundSessions.length,
      sessionsReturned: sessions.length,
      unboundAgents: unboundAgentRows.length,
      unboundAgentsReturned: unboundAgents.length,
      sessionsWithCandidates,
      candidates: candidateCount,
      ambiguous: ambiguousCount,
      networkAvailable: network.available,
      truncated: unboundSessions.length > cap || unboundAgentRows.length > cap,
      limit: cap,
    },
    warnings,
    asOf,
  }
}
