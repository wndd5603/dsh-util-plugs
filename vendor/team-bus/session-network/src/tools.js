/** Tool registration for dsh-session-network (P0/P1 skeleton; modules are injected lazily). */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const AGENTS_AUTO_MARKER = '<!-- session-network:auto:v1 -->'
export const AGENTS_MANAGED_MARKER = '<!-- session-network:managed:v1 -->'
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze(['.git', 'package.json', 'AGENTS.md'])
const DEFAULT_AGV_TIMEOUT_MS = 30000

/** F29 self-use directories: session-network/team plumbing, never user content. */
const SELF_USE_DIR_SEGMENTS = new Set(['team', 'scratch', 'file_backups', 'meetings', 'members'])
/** F29 tool-managed directories: machine state, never triggers the AGENTS question. */
const TOOL_MANAGED_DIR_SEGMENTS = new Set(['files', 'node_modules'])

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isInsideOf(child, parent) {
  try {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

/** True when the resolved path is a filesystem root (drive root on Windows). */
function isFilesystemRoot(path) {
  try {
    const resolved = resolve(path)
    return dirname(resolved) === resolved
  } catch {
    return true
  }
}

/** realpath of the nearest existing ancestor (handles not-yet-created projectDirs). */
function nearestExistingRealPath(path) {
  let current = resolve(path)
  while (true) {
    try {
      return realpathSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

/**
 * Containment check that also resolves symlinks: the candidate (or its nearest
 * existing ancestor) and the base must resolve inside the base's real path.
 */
function isReallyContained(candidate, base) {
  try {
    const baseReal = realpathSync(base)
    const candidateReal = nearestExistingRealPath(candidate)
    if (baseReal === null || candidateReal === null) return false
    return samePath(candidateReal, baseReal) || isInsideOf(candidateReal, baseReal)
  } catch {
    return false
  }
}

/**
 * Security containment bases for an explicitly supplied `projectDir`: only the
 * session cwd / workspace root count (never the host process cwd fallback), and a
 * filesystem root is never a valid base.
 */
function projectDirContainmentBases(sessionCwd, workspaceRoot) {
  return [sessionCwd, workspaceRoot]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .map(value => resolve(value))
    .filter(base => !isFilesystemRoot(base))
}

function rejectProjectDirOutside(projectDir, reason) {
  return {
    ok: false,
    code: 'PROJECT_DIR_OUTSIDE_WORKSPACE',
    reason: reason ?? 'projectDir must stay inside the session workspace/cwd',
    projectDir: typeof projectDir === 'string' ? projectDir : null,
  }
}

/**
 * R3/F23 project-root algorithm:
 *   DSH workspace root (session cwd) > nearest upward marker > cwd itself.
 * The walk never leaves `stopAt` (the DSH workspace root) nor the drive root.
 * @param {string} cwd - session cwd (or explicit projectDir start).
 * @param {{markers?: readonly string[], stopAt?: string}} [options]
 * @returns {string} absolute project root.
 */
export function resolveProjectRoot(cwd, { markers = DEFAULT_PROJECT_ROOT_MARKERS, stopAt } = {}) {
  const start = resolve(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '.')
  const stop = typeof stopAt === 'string' && stopAt.trim() !== '' ? resolve(stopAt) : undefined
  const boundedStop = stop !== undefined && isInsideOf(start, stop) ? stop : undefined
  let dir = start
  while (true) {
    if (markers.some(marker => existsSync(join(dir, marker)))) return dir
    if (boundedStop !== undefined && samePath(dir, boundedStop)) break
    const parent = dirname(dir)
    if (parent === dir) break
    if (boundedStop !== undefined && !samePath(parent, boundedStop) && !isInsideOf(parent, boundedStop)) break
    dir = parent
  }
  return start
}

/** Stable `agv_asks.workspace_hash` for one project root. */
export function workspaceHashFor(projectRoot) {
  const normalized = process.platform === 'win32' ? resolve(projectRoot).toLowerCase() : resolve(projectRoot)
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * F29 trigger set, decided from directory names only (never file content):
 * root files and non-self-use/non-tool-managed directories like `notes/` or
 * `src/` trigger; `team/`, `scratch/`, `file_backups/`, `meetings/`, `members/`,
 * dot-directories, `files/`, `node_modules/` and paths outside the project do not.
 * @param {string} targetPath - file being written.
 * @param {string} projectRoot - resolved project root.
 * @returns {boolean}
 */
export function shouldTriggerAgentsAsk(targetPath, projectRoot) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return false
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return false
  const target = resolve(targetPath)
  const root = resolve(projectRoot)
  if (!isInsideOf(target, root)) return false
  const rel = relative(root, target)
  const segments = rel.split(/[\\/]+/).filter(segment => segment !== '')
  if (segments.length === 0) return false
  const first = segments[0].toLowerCase()
  if (first === 'agents.md' || first === 'claude.md') return false
  if (first.startsWith('.')) return false
  if (SELF_USE_DIR_SEGMENTS.has(first) || TOOL_MANAGED_DIR_SEGMENTS.has(first)) return false
  return true
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function projectNameOf(projectRoot) {
  return basename(projectRoot) || projectRoot
}

/** Skill §4 deterministic default suggestion; never infers business details. */
export function defaultWorkspacePurpose(projectRoot) {
  try {
    const readme = join(projectRoot, 'README.md')
    if (existsSync(readme)) {
      const match = readFileSync(readme, 'utf8').match(/^\s*#\s+(.+)$/m)
      if (match) {
        const title = match[1].replace(/[*_`#]/g, '').trim()
        if (title !== '') return title.slice(0, 40)
      }
    }
  } catch { /* fall through to the directory name */ }
  const name = projectNameOf(projectRoot)
  if (name !== '' && name !== '.' && name !== '/') return name.replace(/[-_]+/g, ' ')
  return '（未识别，请一句话说明）'
}

function identityLine(identity) {
  return `- 网络身份：displayName=${identity.displayName}；alias=${identity.alias}；roleName=${identity.roleName}`
}

function renderAutoAgentsFile({ projectRoot, purpose, identity, createdAt }) {
  return [
    AGENTS_AUTO_MARKER,
    `# ${projectNameOf(projectRoot)} — 工作区说明`,
    '',
    `- 用途：${purpose}（auto 创建；后续可由 workspace_agents_init({purpose}) 覆盖本文件）`,
    identityLine(identity),
    `- 创建：${createdAt}（由 session-network auto 记录，可修改）`,
    '- 项目政策：如有 `team/TEAM.md`，以它为准；本文件不重复其条款。',
    '',
  ].join('\n')
}

function renderManagedAgentsFile({ projectRoot, purpose, identity, createdAt }) {
  return [
    AGENTS_MANAGED_MARKER,
    `# ${projectNameOf(projectRoot)} — 工作区说明`,
    '',
    `- 用途：${purpose}`,
    identityLine(identity),
    `- 创建：${createdAt}（由 session-network 记录，可修改）`,
    '- 项目政策：如有 `team/TEAM.md`，以它为准；本文件不重复其条款。',
    '',
  ].join('\n')
}

/** Same-directory tmp + rename so a crash never leaves a half-written AGENTS.md. */
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    throw error
  }
}

function readWorkspacePeers(cwd) {
  try {
    const file = join(cwd, 'team', 'pipe2', 'PEERS.json')
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.peers)) return parsed.peers
    return []
  } catch {
    return []
  }
}

function findSelfPeer(peers, sessionId, displayName) {
  const keys = [sessionId, displayName].filter(value => typeof value === 'string' && value !== '')
  for (const peer of peers) {
    const values = [peer?.sessionId, peer?.session_id, peer?.id, peer?.displayName, peer?.alias]
    if (values.some(value => typeof value === 'string' && keys.includes(value))) return peer
  }
  return undefined
}

function roleExcluded(roleName, roleKind) {
  if (roleKind === 'verifier') return true
  const name = typeof roleName === 'string' ? roleName.trim() : ''
  return /^verify/i.test(name) || /^cr([-_]|$)/i.test(name)
}

/** Resolve displayName/alias/roleName from the live agent and workspace PEERS. */
function resolveAgentIdentity(agent, header, sessionId, cwd) {
  const peer = findSelfPeer(readWorkspacePeers(cwd), sessionId, firstString(agent?.displayName, agent?.info?.displayName))
  return {
    displayName: firstString(agent?.displayName, agent?.info?.displayName, header?.displayName, peer?.displayName) ?? '(unset)',
    alias: firstString(agent?.alias, agent?.info?.alias, peer?.alias) ?? '(unset)',
    roleName: firstString(agent?.roleName, agent?.info?.roleName, header?.roleName, peer?.roleName, peer?.role) ?? '(unset)',
    roleKind: firstString(peer?.roleKind, peer?.role_kind),
  }
}

function normalizePurpose(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}


/** Pipe2-compatible reserved identity words (alias is a route key, never a generic identity). */
export const ALIAS_RESERVED = new Set([
  'captain', 'lead', 'leader', 'boss', 'admin', 'chief', 'host', 'owner',
  'agent', 'assistant', 'bot', 'team', 'system', 'all', 'everyone', 'main', 'root',
  '队长', '组长', '管理员', '系统',
])
export const ALIAS_MAX_RENAMES = 2

function normalizeAliasCandidate(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  const kebab = text.replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(kebab)) return null
  const clipped = kebab.slice(0, 16).replace(/-+$/g, '')
  return clipped === '' ? null : clipped
}

function readWorkspaceRootName(workspaceDir) {
  if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '') return null
  try {
    const value = readFileSync(join(workspaceDir, 'team', 'pipe2', 'ROOT_NAME'), 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

function shortSessionCode(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

function resolveAuditCaller(exec) {
  try {
    const session = exec?.agent?.session ?? {}
    const header = session?.header ?? {}
    const sessionId = firstString(session?.id, exec?.agent?.id) ?? null
    const displayName = firstString(header?.displayName, header?.name, exec?.agent?.displayName) ?? null
    const roleName = firstString(header?.roleName, exec?.agent?.roleName) ?? null
    return { sessionId, displayName, roleName }
  } catch {
    return { sessionId: null, displayName: null, roleName: null }
  }
}

const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const baseParams = properties => ({
  type: 'object',
  properties,
  additionalProperties: false,
})

function safeCall(fn, fallback) {
  try {
    return fn()
  } catch (error) {
    return fallback(error)
  }
}

/** Pitfalls come from the existing dsh-dev-pitfalls symptom index; no hand-maintained list. */
function readPitfalls(homeDir, query, limit = 10) {
  const file = join(homeDir, '.agents', 'skills', 'dsh-dev-pitfalls', 'SKILL.md')
  if (!existsSync(file)) return { count: 0, source: file, note: 'pitfalls skill not installed' }
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const hits = lines
    .map(line => line.trim())
    .filter(line => line.startsWith('- ') || /^#{2,3} .*适用|^#{2,3} .*症状/.test(line))
    .filter(line => q === '' || line.toLowerCase().includes(q))
    .slice(0, limit)
  return { count: hits.length, source: file, items: hits }
}

export function registerTools(ctx, deps) {
  const { config, profileDir, dataDir, modules = {}, audit, logger } = deps
  const log = (...args) => safeCall(() => logger?.info?.(...args), () => {})
  const dbState = { handle: null }
  const dbWriteState = { handle: null }
  const ensureDb = () => {
    if (!modules.db?.openDb || dataDir === null) return undefined
    if (dbState.handle === null) {
      // Read-only: network_info must not create the DB as a side effect (M1: no write side effects).
      dbState.handle = safeCall(() => modules.db.openDb({ dataDir, readonly: true, create: false }), () => undefined)
    }
    return dbState.handle
  }
  const ensureDbWritable = () => {
    if (!modules.db?.openDb || dataDir === null) return undefined
    if (dbWriteState.handle === null) {
      dbWriteState.handle = safeCall(() => modules.db.openDb({ dataDir }), () => undefined)
    }
    return dbWriteState.handle
  }
  /** Run one registry write with the writable handle installed as the shared DB. */
  const withWriteDb = fn => {
    const handle = ensureDbWritable()
    if (handle === undefined) return { ok: false, error: new Error('registry database unavailable') }
    try {
      modules.db.useDb?.(handle)
      return { ok: true, value: fn(handle) }
    } catch (error) {
      return { ok: false, error }
    }
  }
  try {
    ctx.on?.('dispose', () => {
      if (dbWriteState.handle !== null) safeCall(() => modules.db?.closeDb?.(dbWriteState.handle), () => {})
      if (dbState.handle !== null) safeCall(() => modules.db?.closeDb?.(dbState.handle), () => {})
      dbWriteState.handle = null
      dbState.handle = null
    })
  } catch {
    // dispose hook is optional
  }

  ctx.tools.register({
    name: 'network_info',
    description:
      'Read-only snapshot of the local cross-session network: available sessions, aliases/roles, availability and contact route. '
      + 'Never returns cwd, titles, task text or message bodies. Capability index: skill("team-bootstrap") §2 / '
      + 'CAPABILITY_AUDIT.md.',
    parameters: baseParams({
      section: {
        type: 'string',
        enum: ['network', 'all', 'sessions', 'meetings', 'pitfalls'],
        description: 'Optional section filter; defaults to all.',
      },
    }),
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      const section = args.section ?? 'all'
      const workspaceDir = exec?.agent?.session?.header?.cwd ?? exec?.agent?.workspace?.cwd ?? null
      const workspacePeers = workspaceDir === null ? null : join(workspaceDir, 'team', 'pipe2', 'PEERS.json')
      const networkAvailable = workspacePeers === null ? null : existsSync(workspacePeers)
      let workspacePeersData
      if (networkAvailable === true) {
        try { workspacePeersData = JSON.parse(readFileSync(workspacePeers, 'utf8')) } catch { workspacePeersData = undefined }
      }
      const result = await safeCall(async () => {
        if (modules.networkInfo?.buildNetworkInfo) {
          return await modules.networkInfo.buildNetworkInfo({
            db: ensureDb(),
            peers: workspacePeersData,
            liveAgents: readLiveAgents(ctx),
            config,
            section,
            now: new Date(),
            workspaceDir,
            networkAvailable,
          })
        }
        return {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          section,
          network: { total: 0, active: 0, dataDirConfigured: dataDir !== null },
          sessions: [],
        }
      }, error => ({ schemaVersion: 1, error: 'network_info unavailable: ' + String(error) }))
      safeCall(() => audit?.({ action: 'network_info', section, resultKeys: Object.keys(result ?? {}), caller: resolveAuditCaller(exec) }), () => {})
      return result
    },
  })

  ctx.tools.register({
    name: 'pitfalls',
    description:
      'Known environment pitfalls extracted from the dsh-dev-pitfalls symptom index (<=10 lines). '
      + 'Used by session briefings instead of inlining pitfall lists.',
    parameters: baseParams({
      query: { type: 'string', description: 'Optional keyword filter.' },
      limit: { type: 'number', description: 'Max items (default 10, max 10).' },
    }),
    output: jsonOut,
    async execute(args = {}) {
      const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? profileDir
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(10, args.limit)) : 10
      const result = modules.pitfalls?.buildPitfalls
        ? safeCall(() => modules.pitfalls.buildPitfalls({ query: args.query, limit }), () => readPitfalls(homeDir, args.query, limit))
        : readPitfalls(homeDir, args.query, limit)
      safeCall(() => audit?.({ action: 'pitfalls', count: result.count, caller: resolveAuditCaller(exec) }), () => {})
      return result
    },
  })

  const notImplemented = name => async () =>
    ({ ok: false, tool: name, error: 'not implemented in P0 skeleton (planned for P1)' })

  ctx.tools.register({
    name: 'alias_register',
    description:
      'Register (or propose) the pipe2 route alias for a session in the local SQLite registry. '
      + 'Never writes PEERS.json (PEERS stays the routing authority); callers broadcast with pipe2 themselves. '
      + 'Rename limit is 2 per session (the 3rd rename is rejected); old aliases stay resolvable as legacy. '
      + 'Human confirmation required: preview with dryRun and confirm before changing routing; see '
      + 'OPERATOR_ONLY_BOUNDARIES.md.',
    parameters: baseParams({
      alias: { type: 'string', description: 'Optional proposed alias (lowercase kebab, <=16 chars); omit to auto-derive.' },
      sessionId: { type: 'string', description: 'Optional target session id (defaults to the calling session).' },
      displayName: { type: 'string', description: 'Optional displayName for the audit actor (never rewrites roleName).' },
      roleName: { type: 'string', description: 'Optional roleName to record on the alias row (policy key is never auto-overwritten).' },
      dryRun: { type: 'boolean', description: 'Validate and preview only; writes nothing.' },
      supersedes: { type: 'string', description: 'Optional previous alias to mark legacy for this session.' },
    }),
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      const dbHandle = ensureDbWritable()
      if (dbHandle === undefined) {
        return { ok: false, code: 'NO_DB', message: 'db module or dataDir unavailable (alias_register needs a writable registry)' }
      }
      const currentSessionId = exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? null
      const workspaceDir = exec?.agent?.session?.header?.cwd ?? exec?.agent?.workspace?.cwd ?? null
      const result = safeCall(() => aliasRegisterCore({
        db: modules.db,
        sessionId: currentSessionId,
        workspaceDir,
        now: new Date(),
      }, args), error => ({ ok: false, code: error?.code ?? 'ALIAS_ERROR', message: String(error?.message ?? error) }))
      safeCall(() => audit?.({ action: 'alias_register', ok: result.ok === true, alias: result.alias ?? null, code: result.code ?? null, caller: resolveAuditCaller(exec) }), () => {})
      return result
    },
  })

  for (const name of ['meeting_open', 'meeting_post', 'meeting_collect', 'meeting_finalize']) {
    ctx.tools.register({
      name,
      description: 'Meeting workflow tool (' + name + '): fixed session meeting protocol (P0/P1).',
      parameters: baseParams({
        meetingId: { type: 'string' },
        title: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' } },
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        dedupeKey: { type: 'string' },
      }),
      output: jsonOut,
      execute: notImplemented(name),
    })
  }

  ctx.tools.register({
    name: 'workspace_agents_init',
    description:
      'Initialize the workspace-root AGENTS.md once. X4 order: auto-create a minimal file first, then the model may ask '
      + 'the user (non-blocking, <=30s) and call again with purpose to upgrade the auto template. Existing files are never overwritten. '
      + 'Human confirmation required before the first write (team-bootstrap §2 / OPERATOR_ONLY_BOUNDARIES.md).',
    parameters: baseParams({
      purpose: { type: 'string', description: 'One-line purpose answered by the user; upgrades an auto template.' },
      skip: { type: 'boolean', description: 'Skip asking and remember the skip for this project root.' },
      projectDir: { type: 'string', description: 'Optional directory to resolve the project root from (defaults to session cwd).' },
      targetPath: { type: 'string', description: 'Optional file being written; applies the F29 directory-name trigger rules.' },
      dryRun: { type: 'boolean', description: 'Preview only; writes nothing.' },
    }),
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      const agent = exec?.agent ?? {}
      const session = agent?.session ?? {}
      const header = session?.header ?? {}
      const sessionId = firstString(session?.id, agent?.id)
      const rawSessionCwd = firstString(header.cwd, agent?.workspace?.cwd)
      const rawWorkspaceRoot = firstString(agent?.workspace?.root, header.workspaceRoot)
      const sessionCwd = rawSessionCwd ?? process.cwd()
      // `stopAt` must stay the raw workspace root (never the process.cwd fallback).
      const workspaceRoot = rawWorkspaceRoot
      const explicitProjectDir = typeof args.projectDir === 'string' && args.projectDir.trim() !== ''
      let cwd
      if (explicitProjectDir) {
        const candidate = resolve(args.projectDir.trim())
        const bases = projectDirContainmentBases(rawSessionCwd, rawWorkspaceRoot)
        if (bases.length === 0) return rejectProjectDirOutside(candidate, 'projectDir requires a session workspace/cwd')
        const lexicallyInside = bases.some(base => samePath(candidate, base) || isInsideOf(candidate, base))
        const reallyInside = bases.some(base => isReallyContained(candidate, base))
        if (!lexicallyInside || !reallyInside) return rejectProjectDirOutside(candidate)
        cwd = candidate
      } else {
        cwd = resolve(sessionCwd)
      }
      const projectRoot = resolveProjectRoot(cwd, { stopAt: workspaceRoot })
      if (explicitProjectDir) {
        // The F23 upward marker walk must not escape the allowed bases either.
        const bases = projectDirContainmentBases(rawSessionCwd, rawWorkspaceRoot)
        const rootInside = bases.some(base => (samePath(projectRoot, base) || isInsideOf(projectRoot, base)) && isReallyContained(projectRoot, base))
        if (!rootInside) return rejectProjectDirOutside(cwd, 'resolved project root escapes the session workspace/cwd')
      }
      const agentsPath = join(projectRoot, 'AGENTS.md')
      const claudePath = join(projectRoot, 'CLAUDE.md')
      const identity = resolveAgentIdentity(agent, header, sessionId, cwd)
      const auditRecord = record => safeCall(() => audit?.({ action: 'workspace_agents_init', ...record, caller: resolveAuditCaller(exec) }), () => {})

      // --- non-trigger guards (F19/F29) ---
      if (config?.agvAsk?.enabled === false) return { ok: true, skipped: true, reason: 'disabled', projectRoot }
      if (roleExcluded(identity.roleName, identity.roleKind)) {
        return { ok: true, skipped: true, reason: 'role-excluded', projectRoot }
      }
      let sessionKind = firstString(agent?.kind, agent?.info?.kind, session?.kind, header?.kind)
      if (sessionKind === undefined && header?.origin === 'subagent') sessionKind = 'subagent'
      if (sessionKind === undefined && sessionId !== undefined && typeof modules.db?.getSession === 'function') {
        const row = withWriteDb(() => modules.db.getSession(sessionId))
        if (row.ok && typeof row.value?.kind === 'string') sessionKind = row.value.kind
      }
      if (sessionKind === 'subagent') return { ok: true, skipped: true, reason: 'subagent', projectRoot }
      if (typeof args.targetPath === 'string' && shouldTriggerAgentsAsk(args.targetPath, projectRoot) !== true) {
        return { ok: true, skipped: true, reason: 'not-user-content', projectRoot, targetPath: args.targetPath }
      }

      const purpose = normalizePurpose(args.purpose)
      const suggestion = defaultWorkspacePurpose(projectRoot)
      const configuredTimeout = Number(config?.agvAsk?.timeoutMs)
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.trunc(configuredTimeout) : DEFAULT_AGV_TIMEOUT_MS
      const ask = {
        question: `本工作区（${projectNameOf(projectRoot)}）的用途是？建议：「${suggestion}」`,
        purpose: suggestion,
        options: ['采纳建议并写入 AGENTS.md', '改一句（我输入）', '跳过并记住，不再问'],
        timeoutMs,
      }

      // --- never overwrite an existing file; only upgrade our own auto template ---
      if (existsSync(agentsPath)) {
        const current = safeCall(() => readFileSync(agentsPath, 'utf8'), () => '')
        if (purpose !== undefined && current.includes(AGENTS_AUTO_MARKER)) {
          const text = renderManagedAgentsFile({ projectRoot, purpose, identity, createdAt: new Date().toISOString() })
          const write = safeCall(() => { writeTextAtomic(agentsPath, text); return true }, () => false)
          if (write) {
            const hash = workspaceHashFor(projectRoot)
            const recorded = withWriteDb(() => modules.db.recordAgvAsk?.({
              workspaceHash: hash, answer: purpose, skipped: false, auto: false, at: new Date().toISOString(),
            }))
            auditRecord({ result: 'updated', auto: false })
            return { ok: true, projectRoot, existed: true, updated: true, auto: false, purpose, path: agentsPath, ask, recorded: recorded.ok === true }
          }
          return { ok: false, projectRoot, existed: true, error: 'write-failed', path: agentsPath }
        }
        return {
          ok: true,
          projectRoot,
          existed: true,
          exists: true,
          auto: current.includes(AGENTS_AUTO_MARKER),
          path: agentsPath,
          ...(purpose === undefined ? {} : { updated: false, reason: 'not-auto-template' }),
        }
      }
      if (existsSync(claudePath)) return { ok: true, projectRoot, existed: true, exists: true, reason: 'claude-md', path: claudePath }
      if (args.dryRun === true) {
        return { ok: true, dryRun: true, projectRoot, existed: false, wouldCreate: true, wouldUpdate: purpose !== undefined, path: agentsPath, ask }
      }

      const hash = workspaceHashFor(projectRoot)
      if (args.skip === true) {
        const recorded = withWriteDb(() => modules.db.recordAgvAsk?.({
          workspaceHash: hash, answer: null, skipped: true, auto: false, at: new Date().toISOString(),
        }))
        auditRecord({ result: 'skipped', reason: 'skip' })
        return { ok: true, projectRoot, skipped: true, reason: 'skip', path: agentsPath, recorded: recorded.ok === true }
      }

      // --- exactly one agv_asks row per project root (claim is the single winner) ---
      const existingRow = withWriteDb(() => modules.db.getAgvAsk?.(hash))
      if (existingRow.ok && existingRow.value !== undefined && existingRow.value !== null) {
        const reason = existingRow.value.skipped ? 'skip-memory' : 'already-asked'
        auditRecord({ result: 'skipped', reason })
        return { ok: true, projectRoot, skipped: true, reason, path: agentsPath }
      }
      const claim = withWriteDb(() => modules.db.claimAgvAsk?.(hash))
      if (claim.ok && claim.value === false) {
        auditRecord({ result: 'skipped', reason: 'already-asked' })
        return { ok: true, projectRoot, skipped: true, reason: 'already-asked', path: agentsPath }
      }

      // --- X4 order: auto-create FIRST; a purpose can upgrade it immediately or later ---
      const createdAt = new Date().toISOString()
      try {
        mkdirSync(projectRoot, { recursive: true })
        writeTextAtomic(agentsPath, renderAutoAgentsFile({ projectRoot, purpose: suggestion, identity, createdAt }))
      } catch (error) {
        auditRecord({ result: 'error', error: String(error) })
        return { ok: false, projectRoot, error: 'write-failed', message: String(error), path: agentsPath }
      }
      withWriteDb(() => modules.db.recordAgvAsk?.({
        workspaceHash: hash, answer: null, skipped: false, auto: true, at: createdAt,
      }))
      if (purpose !== undefined) {
        safeCall(() => writeTextAtomic(agentsPath, renderManagedAgentsFile({ projectRoot, purpose, identity, createdAt })), () => {})
        withWriteDb(() => modules.db.recordAgvAsk?.({
          workspaceHash: hash, answer: purpose, skipped: false, auto: false, at: createdAt,
        }))
        auditRecord({ result: 'created-and-updated', auto: false })
        return { ok: true, projectRoot, existed: false, created: true, updated: true, auto: false, purpose, path: agentsPath, ask }
      }
      auditRecord({ result: 'created', auto: true })
      return { ok: true, projectRoot, existed: false, created: true, auto: true, path: agentsPath, ask }
    },
  })

  log('[session-network] tools registered; config=', config?.schemaVersion, 'dataDir=', dataDir, 'modules=', Object.keys(modules))
}

/** Live agents via the agent-teams service when present; never throws. */
export function readLiveAgents(ctx) {
  return safeCall(() => {
    // Prefer a global live-session source; the team projection only lists this team.
    const agents = ctx.get?.('agents')
    if (agents?.list) return agents.list()
    const teams = ctx.get?.('agentTeams')
    if (teams?.listMembers) return teams.listMembers()
    return undefined
  }, () => undefined)
}

/**
 * `alias_register` core (exported for tests): validates and registers an alias.
 * - session must exist; the calling session may be auto-created as a minimal row;
 * - alias: lowercase kebab <=16, reserved words rejected, globally unique;
 * - rename limit 2/session (F22); old alias becomes legacy + superseded_by;
 * - `dryRun` writes nothing (no alias row, no audit);
 * - never writes PEERS.json; returns `broadcastHint` for the caller/skill.
 * @param {{db: object, sessionId?: string|null, workspaceDir?: string|null, now?: Date}} deps
 * @param {{alias?: string, sessionId?: string, displayName?: string, roleName?: string, dryRun?: boolean, supersedes?: string}} [args]
 */
export function aliasRegisterCore(deps = {}, args = {}) {
  const db = deps.db
  if (db === undefined || db === null || typeof db.registerAliasGuarded !== 'function') {
    return { ok: false, code: 'NO_DB', message: 'db module does not expose registerAliasGuarded' }
  }
  const currentSessionId = typeof deps.sessionId === 'string' && deps.sessionId.trim() !== '' ? deps.sessionId.trim() : null
  const requestedSessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : null
  const sessionId = requestedSessionId ?? currentSessionId
  if (sessionId === null) return { ok: false, code: 'NO_SESSION', message: 'sessionId is required (no calling session available)' }

  let session
  try {
    session = db.getSession(sessionId)
  } catch (error) {
    return { ok: false, code: error?.code ?? 'DB_ERROR', message: String(error?.message ?? error) }
  }
  const displayName = typeof args.displayName === 'string' && args.displayName.trim() !== ''
    ? args.displayName.trim()
    : (session?.display_name ?? null)
  const roleName = typeof args.roleName === 'string' && args.roleName.trim() !== ''
    ? args.roleName.trim()
    : (session?.role_name ?? null)
  if (session === undefined) {
    if (currentSessionId === null || sessionId !== currentSessionId) {
      return { ok: false, code: 'SESSION_NOT_FOUND', message: `session not found: ${sessionId}` }
    }
    // The calling session may not be registered yet; create the minimal row (fail-open).
    try {
      db.upsertSession({ sessionId, displayName, roleName, status: 'active', at: deps.now ?? Date.now() })
      session = db.getSession(sessionId)
    } catch (error) {
      return { ok: false, code: error?.code ?? 'DB_ERROR', message: String(error?.message ?? error) }
    }
    if (session === undefined) return { ok: false, code: 'SESSION_NOT_FOUND', message: `session not found: ${sessionId}` }
  }

  const explicitAlias = typeof args.alias === 'string' && args.alias.trim() !== '' ? args.alias.trim().toLowerCase() : null
  let alias = explicitAlias
  if (alias === null) {
    const candidates = [
      displayName,
      roleName,
      typeof deps.workspaceDir === 'string' && deps.workspaceDir !== '' ? basename(deps.workspaceDir) : null,
      shortSessionCode(sessionId),
    ]
    for (const candidate of candidates) {
      const normalized = normalizeAliasCandidate(candidate)
      if (normalized === null || ALIAS_RESERVED.has(normalized)) continue
      let available = null
      for (let suffix = 0; suffix < 10; suffix += 1) {
        const base = suffix === 0 ? normalized : normalized.slice(0, Math.max(1, 16 - String(suffix + 1).length - 1)) + '-' + (suffix + 1)
        const existing = db.resolveAlias(base)
        if (existing === undefined || existing.session_id === sessionId) { available = base; break }
      }
      if (available !== null) { alias = available; break }
    }
    if (alias === null) return { ok: false, code: 'ALIAS_TAKEN', message: 'no free alias candidate could be derived; pass alias explicitly' }
  }
  try {
    db.validateAlias(alias)
  } catch (error) {
    return { ok: false, code: 'ALIAS_INVALID', message: String(error?.message ?? error) }
  }
  if (ALIAS_RESERVED.has(alias)) {
    return { ok: false, code: 'ALIAS_RESERVED', message: `reserved identity word cannot be an alias: ${alias}` }
  }

  const rootName = readWorkspaceRootName(deps.workspaceDir)
  const dryRun = args.dryRun === true
  let result
  try {
    result = db.registerAliasGuarded({
      alias,
      sessionId,
      rootName,
      roleName,
      displayName,
      supersedes: args.supersedes,
      maxRenames: ALIAS_MAX_RENAMES,
      dryRun,
      at: deps.now ?? Date.now(),
    })
  } catch (error) {
    return { ok: false, code: error?.code ?? 'ALIAS_ERROR', message: String(error?.message ?? error) }
  }
  const broadcastHint = '广播由调用方/skill 用 pipe2 发出（from=' + (displayName ?? '(unset)')
    + '，fromAlias=' + alias + '，自检加 test:true 并在正文头标 [SELFTEST]）；'
    + '本工具不写 PEERS.json（PEERS 是路由唯一权威）；pipe2_session_post 可按 session id 直达。'
  return {
    ...result,
    ok: true,
    alias,
    sessionId,
    displayName,
    roleName,
    dryRun,
    broadcastHint,
    ...(dryRun ? { wouldWrite: true } : {}),
  }
}
