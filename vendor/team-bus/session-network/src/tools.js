/** Tool registration for dsh-session-network (P0/P1 skeleton; modules are injected lazily). */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// Meeting helpers (P1): finalize-payload parsing and generated ids.
// ---------------------------------------------------------------------------

/** Strip one Markdown list marker (`-`, `*`, `+`, `1.`, `1)`) from a line. */
function parseMeetingListLine(line) {
  const text = String(line ?? '').trim()
  if (text === '') return null
  const match = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(text)
  return match === null ? null : match[1].trim()
}

/** Normalize decisions to `{id,text,owner?}` entries (never throws). */
function normalizeDecisionEntries(list) {
  const entries = Array.isArray(list) ? list : []
  const out = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text !== '') out.push({ id: `D${index + 1}`, text })
      continue
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) continue
    const text = firstString(entry.text, entry.title, entry.description, entry.decision, entry.summary)
    if (text === undefined) continue
    const owner = firstString(entry.owner, entry.assignee)
    out.push({ id: firstString(entry.id) ?? `D${index + 1}`, text, ...(owner === undefined ? {} : { owner }) })
  }
  return out
}

/** Normalize actions to `{id,text,owner,status}` entries (never throws). */
function normalizeActionEntries(list) {
  const entries = Array.isArray(list) ? list : []
  const out = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === null || entry === undefined) continue
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text !== '') out.push({ id: `A${index + 1}`, text, owner: null, status: 'pending' })
      continue
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) continue
    const text = firstString(entry.text, entry.title, entry.description, entry.action)
    if (text === undefined) continue
    out.push({
      id: firstString(entry.id) ?? `A${index + 1}`,
      text,
      owner: firstString(entry.owner, entry.assignee) ?? null,
      status: firstString(entry.status) ?? 'pending',
    })
  }
  return out
}

/**
 * Parse the optional finalize `body`: JSON (`{decisions,actions,summary}` or an
 * array of decisions) or Markdown sections (`## 决策` / `## 行动`). Plain text is
 * recorded as one decision so a free-form minute is never lost.
 */
function meetingSectionOf(label) {
  const normalized = String(label ?? '').replace(/^\*+|\*+$/g, '').trim().toLowerCase()
  if (/^(decisions?|决策|决定|结论)$/.test(normalized)) return 'decisions'
  if (/^(actions?|行动|待办|todo|下一步)$/.test(normalized)) return 'actions'
  return null
}

function parseMeetingFinalBody(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (text === '') return { decisions: [], actions: [], summaryText: null, parsed: false }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return { decisions: normalizeDecisionEntries(parsed), actions: [], summaryText: null, parsed: true }
      }
      if (parsed !== null && typeof parsed === 'object') {
        const decisions = normalizeDecisionEntries(parsed.decisions ?? parsed.decision)
        const actions = normalizeActionEntries(parsed.actions ?? parsed.action)
        const summaryText = firstString(parsed.summary, parsed.text, parsed.note) ?? null
        if (decisions.length > 0 || actions.length > 0 || summaryText !== null) {
          return { decisions, actions, summaryText, parsed: true }
        }
      }
    } catch {
      // not JSON: fall through to Markdown/plain-text parsing
    }
  }
  const decisions = []
  const actions = []
  const intro = []
  let section = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed)
    if (heading !== null) {
      section = meetingSectionOf(heading[1])
      continue
    }
    const listItem = parseMeetingListLine(trimmed)
    const candidate = listItem ?? trimmed
    const bareSection = meetingSectionOf(candidate.replace(/^\*+|\*+$/g, ''))
    if (bareSection !== null) { section = bareSection; continue }
    const label = /^(.{1,24}?)\s*[:：]\s*(.*)$/.exec(candidate)
    if (label !== null) {
      const sectionName = meetingSectionOf(label[1])
      if (sectionName !== null) {
        const inline = label[2].trim()
        if (inline === '') { section = sectionName; continue }
        if (sectionName === 'decisions') decisions.push(inline)
        else actions.push(inline)
        section = sectionName
        continue
      }
    }
    if (section === 'decisions') decisions.push(candidate)
    else if (section === 'actions') actions.push(candidate)
    else intro.push(candidate)
  }
  if (decisions.length === 0 && actions.length === 0) {
    const fallback = intro.length > 0 ? intro.join('\n') : text
    return { decisions: normalizeDecisionEntries([fallback]), actions: [], summaryText: null, parsed: false }
  }
  return {
    decisions: normalizeDecisionEntries(decisions),
    actions: normalizeActionEntries(actions),
    summaryText: intro.length > 0 ? intro.join('\n') : null,
    parsed: false,
  }
}

/** Generated meeting id: `M-YYYYMMDD-HHMMSS-<6hex>` (caller may pass its own). */
function generateMeetingId(now = new Date()) {
  const iso = now.toISOString()
  const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '')
  return `M-${stamp}-${randomUUID().slice(0, 6)}`
}

/** Generated msgId keeps meeting/round/author visible for msgId-based dedupe. */
function generateMeetingMsgId(meetingId, round, author) {
  const slug = String(author ?? 'anon').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'anon'
  return `${meetingId}-${round}-${slug}-${randomUUID().slice(0, 8)}`
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
  const { config, profileDir, dataDir, modules = {}, audit, logger, directory = null } = deps
  const log = (...args) => safeCall(() => logger?.info?.(...args), () => {})
  const dbState = { handle: null }
  const dbWriteState = { handle: null }
  const ensureDb = () => {
    if (!modules.db?.openDb || dataDir === null) return undefined
    if (dbState.handle === null) {
      // Read-only: network_info must not create the DB as a side effect (M1: no write side effects).
      // Do not cache a failed open: a later meeting_open may create the DB.
      dbState.handle = safeCall(() => modules.db.openDb({ dataDir, readonly: true, create: false }), () => null)
    }
    return dbState.handle ?? undefined
  }
  const ensureDbWritable = () => {
    if (!modules.db?.openDb || dataDir === null) return undefined
    if (dbWriteState.handle === null) {
      dbWriteState.handle = safeCall(() => modules.db.openDb({ dataDir }), () => null)
    }
    return dbWriteState.handle ?? undefined
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
  /** Run one registry read with the read-only handle installed as the shared DB. */
  const withReadDb = fn => {
    const handle = ensureDb()
    if (handle === undefined) {
      const error = new Error('registry database unavailable')
      error.code = 'NO_DB'
      return { ok: false, error }
    }
    try {
      modules.db.useDb?.(handle)
      return { ok: true, value: fn(handle) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  // -------------------------------------------------------------------------
  // Meeting workflow (P1)
  //
  // Contract: `messages` stores only `body_sha256` / `body_len` (INTERFACES §2).
  // Round + body + decisions/actions therefore live in a per-meeting JSON
  // sidecar under `<dataDir>/meetings/`; SQLite stays authoritative for the
  // meeting/participant/message registry and for `dedupe_key` uniqueness.
  // -------------------------------------------------------------------------
  const MEETING_ROUNDS = new Set(['R1', 'R2', 'R3', 'notes'])
  const MEETING_ACK_STATES = new Set(['pending', 'ack', 'absent', 'unacked'])
  const MEETING_STORE_DIR = dataDir === null || dataDir === ':memory:' ? null : join(dataDir, 'meetings')
  const meetingStoreAvailable = () => MEETING_STORE_DIR !== null

  function meetingStorePath(meetingId) {
    if (MEETING_STORE_DIR === null) return null
    const raw = String(meetingId)
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12)
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '_').slice(0, 48) || 'meeting'
    return join(MEETING_STORE_DIR, `${safe}-${digest}.json`)
  }

  function readMeetingStore(meetingId) {
    const file = meetingStorePath(meetingId)
    if (file === null || !existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return null
      if (!Array.isArray(parsed.posts)) parsed.posts = []
      if (!Array.isArray(parsed.decisions)) parsed.decisions = []
      if (!Array.isArray(parsed.actions)) parsed.actions = []
      return parsed
    } catch {
      return null
    }
  }

  function findMeetingStoreByDedupe(dedupeKey) {
    if (MEETING_STORE_DIR === null || typeof dedupeKey !== 'string' || dedupeKey.trim() === '') return null
    if (!existsSync(MEETING_STORE_DIR)) return null
    let entries
    try { entries = readdirSync(MEETING_STORE_DIR) } catch { return null }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(MEETING_STORE_DIR, name), 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && parsed.dedupeKey === dedupeKey) return parsed
      } catch {
        // one corrupt sidecar must not hide the others
      }
    }
    return null
  }

  function writeMeetingStore(store) {
    const file = meetingStorePath(store.meetingId)
    if (file === null) {
      const error = new Error('meeting store unavailable (no dataDir)')
      error.code = 'NO_DB'
      throw error
    }
    mkdirSync(MEETING_STORE_DIR, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return file
  }

  function normalizeMeetingStatus(status) {
    if (status === null || status === undefined) return null
    return status === 'final' ? 'finalized' : String(status)
  }

  function toIsoTime(value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
    }
    return null
  }

  /** `R1|R2|R3|notes` normalization; returns null for an invalid explicit value. */
  function normalizeRound(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback
    const raw = String(value).trim()
    const canonical = raw.toLowerCase() === 'notes' ? 'notes' : raw.toUpperCase()
    return MEETING_ROUNDS.has(canonical) ? canonical : null
  }

  function roundFromMsgId(msgId) {
    const match = /-(R[123])-/i.exec(String(msgId ?? ''))
    return match === null ? null : match[1].toUpperCase()
  }

  function resolveMeetingAuthor(exec) {
    const agent = exec?.agent ?? {}
    const session = agent?.session ?? {}
    const header = session?.header ?? {}
    return firstString(
      agent?.alias, agent?.info?.alias, header?.alias,
      agent?.displayName, agent?.info?.displayName, header?.displayName,
      session?.id, agent?.id,
    ) ?? '(unknown)'
  }

  function resolveMeetingWorkspace(exec) {
    const agent = exec?.agent ?? {}
    const session = agent?.session ?? {}
    return firstString(session?.header?.cwd, session?.cwd, agent?.workspace?.cwd) ?? null
  }

  function normalizeParticipantEntries(participants) {
    const list = Array.isArray(participants)
      ? participants
      : (typeof participants === 'string' && participants.trim() !== '' ? participants.split(',') : [])
    const seen = new Set()
    const out = []
    for (const entry of list) {
      const sessionId = typeof entry === 'string'
        ? entry.trim()
        : firstString(entry?.sessionId, entry?.session_id, entry?.id)
      if (sessionId === undefined || seen.has(sessionId)) continue
      seen.add(sessionId)
      const rawAck = typeof entry === 'object' && entry !== null ? firstString(entry.ackState, entry.ack_state) : undefined
      out.push({
        sessionId,
        role: typeof entry === 'object' && entry !== null ? firstString(entry.role) ?? null : null,
        ackState: rawAck !== undefined && MEETING_ACK_STATES.has(rawAck) ? rawAck : 'pending',
      })
    }
    return out
  }

  function participantView(row) {
    return {
      sessionId: row.session_id,
      role: row.role ?? null,
      ackState: row.ack_state ?? null,
    }
  }

  function messageView(entry) {
    return {
      msgId: entry.msgId ?? null,
      round: entry.round ?? null,
      from: entry.from ?? null,
      to: entry.to ?? null,
      subject: entry.subject ?? null,
      body: entry.body ?? null,
      bodySha256: entry.bodySha256 ?? null,
      bodyLen: entry.bodyLen ?? null,
      dedupeKey: entry.dedupeKey ?? null,
      at: toIsoTime(entry.at),
    }
  }

  function countRounds(messages) {
    const counts = {}
    for (const message of Array.isArray(messages) ? messages : []) {
      const key = typeof message?.round === 'string' && message.round !== '' ? message.round : 'unclassified'
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }

  function meetingView(row, store, participants, messages) {
    const participantList = Array.isArray(participants) ? participants : []
    const messageList = Array.isArray(messages) ? messages : []
    return {
      meetingId: row?.meeting_id ?? store?.meetingId ?? null,
      title: row?.title ?? store?.title ?? null,
      status: normalizeMeetingStatus(row?.status ?? store?.status),
      convener: row?.convener ?? store?.convener ?? null,
      createdAt: toIsoTime(row?.created_at) ?? store?.createdAt ?? null,
      updatedAt: toIsoTime(row?.updated_at) ?? store?.updatedAt ?? null,
      deadline: toIsoTime(row?.deadline) ?? null,
      dirPath: row?.dir_path ?? store?.dirPath ?? null,
      participantCount: participantList.length,
      messageCount: messageList.length,
      rounds: countRounds(messageList),
      finalizedAt: store?.finalizedAt ?? null,
    }
  }

  function reconstructMeetingStore(dbRow, dbMessages) {
    const rows = Array.isArray(dbMessages) ? dbMessages : []
    return {
      schemaVersion: 1,
      meetingId: dbRow.meeting_id,
      title: dbRow.title ?? null,
      convener: dbRow.convener ?? null,
      dedupeKey: null,
      dirPath: dbRow.dir_path ?? null,
      createdAt: toIsoTime(dbRow.created_at),
      updatedAt: toIsoTime(dbRow.updated_at),
      status: normalizeMeetingStatus(dbRow.status) ?? 'open',
      posts: rows.map(messageRow => ({
        msgId: messageRow.msg_id,
        round: roundFromMsgId(messageRow.msg_id),
        from: messageRow.from_alias ?? null,
        to: messageRow.to_alias ?? null,
        subject: null,
        body: null,
        bodySha256: messageRow.body_sha256 ?? null,
        bodyLen: messageRow.body_len ?? null,
        dedupeKey: messageRow.dedupe_key ?? null,
        at: toIsoTime(messageRow.at),
      })),
      decisions: [],
      actions: [],
      finalizedAt: null,
      summary: null,
      reconstructed: true,
    }
  }

  /** Merge DB message rows (hash/len) with sidecar posts (round/body). */
  function mergeMeetingMessages(store, dbMessages) {
    const merged = new Map()
    for (const row of Array.isArray(dbMessages) ? dbMessages : []) {
      merged.set(row.msg_id, {
        msgId: row.msg_id,
        round: roundFromMsgId(row.msg_id),
        from: row.from_alias ?? null,
        to: row.to_alias ?? null,
        subject: null,
        body: null,
        bodySha256: row.body_sha256 ?? null,
        bodyLen: row.body_len ?? null,
        dedupeKey: row.dedupe_key ?? null,
        at: toIsoTime(row.at),
      })
    }
    for (const post of Array.isArray(store?.posts) ? store.posts : []) {
      if (post === null || typeof post !== 'object' || typeof post.msgId !== 'string') continue
      merged.set(post.msgId, { ...(merged.get(post.msgId) ?? {}), ...post })
    }
    return [...merged.values()]
      .map(messageView)
      .sort((left, right) => {
        const byTime = String(left.at ?? '').localeCompare(String(right.at ?? ''))
        return byTime !== 0 ? byTime : String(left.msgId ?? '').localeCompare(String(right.msgId ?? ''))
      })
  }

  function loadMeetingState(meetingId) {
    const read = withReadDb(() => ({
      meeting: typeof modules.db.getMeeting === 'function' ? modules.db.getMeeting(meetingId) : undefined,
      participants: typeof modules.db.listMeetingParticipants === 'function' ? modules.db.listMeetingParticipants(meetingId) : [],
      messages: typeof modules.db.listMeetingMessages === 'function' ? modules.db.listMeetingMessages(meetingId) : [],
    }))
    if (!read.ok) {
      if (read.error?.code === 'NO_DB' || read.error?.code === 'DB_NOT_FOUND') {
        // No registry yet and no sidecar: the meeting simply does not exist.
        if (readMeetingStore(meetingId) === null) return { ok: false, notFound: true }
      }
      return { ok: false, error: read.error }
    }
    const stored = readMeetingStore(meetingId)
    const store = stored ?? (read.value.meeting === undefined ? null : reconstructMeetingStore(read.value.meeting, read.value.messages))
    if (store === null) return { ok: false, notFound: true }
    return {
      ok: true,
      store,
      meeting: read.value.meeting,
      participants: read.value.participants,
      messages: read.value.messages,
    }
  }

  function meetingError(error, fallbackCode = 'MEETING_ERROR') {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : fallbackCode
    const message = error?.message !== undefined ? String(error.message) : String(error)
    return { ok: false, code, error: `${code}: ${message}` }
  }

  function meetingInvalid(message, code = 'MEETING_INVALID') {
    return { ok: false, code, error: `${code}: ${message}` }
  }

  function meetingNotFound(meetingId) {
    return { ok: false, code: 'MEETING_NOT_FOUND', error: `MEETING_NOT_FOUND: meeting not found: ${meetingId}`, meetingId }
  }

  function duplicatePostResponse(state, entry) {
    const participants = (state.participants ?? []).map(participantView)
    const messages = mergeMeetingMessages(state.store, state.messages)
    return {
      ok: true,
      duplicate: true,
      existingMsgId: entry.msgId,
      meeting: meetingView(state.meeting, state.store, participants, messages),
      message: messageView(entry),
      participants,
      participantIds: participants.map(participant => participant.sessionId),
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
      // task-106: host-native joined aliases are the primary discovery source;
      // PEERS remains an optional legacy reader only when no joined aliases exist.
      const directoryJoined = directory === null ? [] : safeCall(() => directory.listJoined(), [])
      if (directoryJoined.length > 0) {
        const joined = directoryJoined
        const live = safeCall(() => readLiveAgents(ctx), [])
        const liveById = new Map()
        for (const agent of Array.isArray(live) ? live : []) {
          if (typeof agent?.session?.id === 'string') liveById.set(agent.session.id, agent)
        }
        const sessions = joined.map(entry => {
          const agent = liveById.get(entry.sessionId)
          return {
            sessionId: entry.sessionId,
            alias: entry.alias,
            displayName: entry.displayName,
            roleName: entry.roleName ?? null,
            status: agent?.status === 'running' ? 'running' : 'active',
            routable: agent !== undefined,
            source: 'host-registry',
          }
        })
        const hostResult = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          section,
          network: {
            total: sessions.length,
            active: sessions.filter(item => item.routable).length,
            joinedCount: sessions.length,
            source: 'host-registry',
            transport: 'sqlite-directory',
            dataDirConfigured: dataDir !== null,
          },
          sessions,
          meetings: [],
          pitfalls: [],
        }
        safeCall(() => audit?.({ action: 'network_info', section, source: 'host-registry', joinedCount: sessions.length, caller: resolveAuditCaller(exec) }), () => {})
        return hostResult
      }
      if (networkAvailable !== true && directory !== null) {
        const nullResult = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          section,
          network: null,
          hint: 'no joined aliases in the host session directory; use alias_register to join',
          sessions: [],
          meetings: [],
          pitfalls: [],
        }
        safeCall(() => audit?.({ action: 'network_info', section, source: 'host-registry', joinedCount: 0, caller: resolveAuditCaller(exec) }), () => {})
        return nullResult
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
            directory,
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

  ctx.tools.register({
    name: 'alias_register',
    description:
      'Register (or propose) this session\'s own alias in the host-native sessionDirectory (host DB). '
      + 'Only the caller session may register/rename itself; wildcards are rejected; no PEERS.json/ACL/workspace writes. '
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
      const requestedSessionId = typeof args.sessionId === 'string' && args.sessionId.trim() !== ''
        ? args.sessionId.trim() : null
      if (requestedSessionId !== null && requestedSessionId !== currentSessionId) {
        return { ok: false, code: 'ALIAS_FOREIGN_SESSION', message: 'a session may only register its own alias' }
      }
      // task-106: alias registration is host-native and must not read workspace
      // files (PEERS/ROOT_NAME); derive candidates only from the session.
      const result = safeCall(() => aliasRegisterCore({
        db: modules.db,
        sessionId: currentSessionId,
        workspaceDir: null,
        now: new Date(),
      }, args), error => ({ ok: false, code: error?.code ?? 'ALIAS_ERROR', message: String(error?.message ?? error) }))
      safeCall(() => audit?.({ action: 'alias_register', ok: result.ok === true, alias: result.alias ?? null, code: result.code ?? null, caller: resolveAuditCaller(exec) }), () => {})
      return result
    },
  })

  const meetingParameters = baseParams({
    meetingId: { type: 'string', description: 'Meeting id.' },
    title: { type: 'string', description: 'meeting_open only: meeting title.' },
    participants: { type: 'array', items: { type: 'string' }, description: 'meeting_open only: participant session ids/aliases.' },
    to: { type: 'string', description: 'meeting_open/post: recipient (defaults to all participants).' },
    subject: { type: 'string', description: 'meeting_open/post: message subject.' },
    body: { type: 'string', description: 'meeting_open: R1 body; meeting_post: position/minutes; meeting_finalize: decisions/actions (JSON or Markdown).' },
    dedupeKey: { type: 'string', description: 'Idempotency key; a duplicate returns the existing meeting/message.' },
    round: { type: 'string', description: 'R1 | R2 | R3 | notes. meeting_post defaults to notes; meeting_collect may filter by it.' },
  })

  ctx.tools.register({
    name: 'meeting_open',
    description:
      'Open a cross-session meeting: creates the meeting (status open), records the convener and participants, '
      + 'and registers the optional R1 body as the first meeting message. meetingId/dedupeKey are idempotent.',
    parameters: meetingParameters,
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId) ?? generateMeetingId()
      const dedupeKey = firstString(args.dedupeKey) ?? null
      if (dedupeKey !== null) {
        const duplicateStore = findMeetingStoreByDedupe(dedupeKey)
        if (duplicateStore !== null) {
          const duplicateState = loadMeetingState(duplicateStore.meetingId)
          if (duplicateState.ok) {
            const participants = duplicateState.participants.map(participantView)
            const messages = mergeMeetingMessages(duplicateState.store, duplicateState.messages)
            return {
              ok: true,
              duplicate: true,
              existingMeetingId: duplicateStore.meetingId,
              meeting: meetingView(duplicateState.meeting, duplicateState.store, participants, messages),
              participants,
              participantIds: participants.map(participant => participant.sessionId),
              messages,
            }
          }
          const messages = mergeMeetingMessages(duplicateStore, [])
          return {
            ok: true,
            duplicate: true,
            existingMeetingId: duplicateStore.meetingId,
            meeting: meetingView(undefined, duplicateStore, [], messages),
            participants: [],
            participantIds: [],
            messages,
          }
        }
      }
      const existingState = loadMeetingState(meetingId)
      if (existingState.ok) {
        if (readMeetingStore(meetingId) === null) {
          try { writeMeetingStore(existingState.store) } catch (error) { return meetingError(error) }
        }
        const existingParticipants = existingState.participants.map(participantView)
        const existingMessages = mergeMeetingMessages(existingState.store, existingState.messages)
        return {
          ok: true,
          duplicate: true,
          existingMeetingId: meetingId,
          meeting: meetingView(existingState.meeting, existingState.store, existingParticipants, existingMessages),
          participants: existingParticipants,
          participantIds: existingParticipants.map(participant => participant.sessionId),
          messages: existingMessages,
        }
      }
      if (existingState.notFound !== true) return meetingError(existingState.error)
      const title = firstString(args.title) ?? null
      const convener = resolveMeetingAuthor(exec)
      const workspaceDir = resolveMeetingWorkspace(exec)
      const dirPath = workspaceDir === null ? null : join(workspaceDir, 'docs', 'meetings', meetingId)
      const participants = normalizeParticipantEntries(args.participants)
      const body = typeof args.body === 'string' && args.body.trim() !== '' ? args.body : null
      const to = firstString(args.to) ?? null
      const subject = firstString(args.subject) ?? null
      const atMs = Date.now()
      const atIso = new Date(atMs).toISOString()
      const message = body === null ? null : {
        msgId: generateMeetingMsgId(meetingId, 'R1', convener),
        round: 'R1',
        from: convener,
        to,
        subject,
        body,
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bodyLen: Buffer.byteLength(body, 'utf8'),
        // Namespaced so opening a meeting never collides with a post dedupeKey.
        dedupeKey: dedupeKey === null ? null : `${meetingId}|open|${dedupeKey}`,
        at: atIso,
      }
      const created = withWriteDb(() => {
        modules.db.createMeeting({ meetingId, title, convener, dirPath, at: atMs })
        for (const participant of participants) {
          modules.db.addMeetingParticipant({
            meetingId,
            sessionId: participant.sessionId,
            role: participant.role,
            ackState: participant.ackState,
          })
        }
        let messageResult = null
        if (message !== null) {
          messageResult = modules.db.addMeetingMessage({
            meetingId,
            msgId: message.msgId,
            fromAlias: message.from,
            toAlias: message.to,
            at: atMs,
            bodySha256: message.bodySha256,
            bodyLen: message.bodyLen,
            dedupeKey: message.dedupeKey,
          })
          if (messageResult.inserted === false) message.msgId = messageResult.msgId
        }
        return {
          messageResult,
          meeting: modules.db.getMeeting(meetingId),
          participants: modules.db.listMeetingParticipants(meetingId),
          messages: modules.db.listMeetingMessages(meetingId),
        }
      })
      if (!created.ok) return meetingError(created.error)
      const store = {
        schemaVersion: 1,
        meetingId,
        title,
        convener,
        dedupeKey,
        dirPath,
        createdAt: atIso,
        updatedAt: atIso,
        status: 'open',
        posts: message === null ? [] : [message],
        decisions: [],
        actions: [],
        finalizedAt: null,
        summary: null,
      }
      try {
        writeMeetingStore(store)
      } catch (error) {
        return meetingError(error)
      }
      const participantViews = created.value.participants.map(participantView)
      const messages = mergeMeetingMessages(store, created.value.messages)
      const meeting = meetingView(created.value.meeting, store, participantViews, messages)
      safeCall(() => audit?.({ action: 'meeting_open', meetingId, ok: true, participants: participantViews.length, messages: messages.length, caller: resolveAuditCaller(exec) }), () => {})
      return { ok: true, duplicate: false, created: true, meeting, participants: participantViews, participantIds: participantViews.map(participant => participant.sessionId), messages, actions: [], decisions: [] }
    },
  })

  ctx.tools.register({
    name: 'meeting_post',
    description:
      'Append one round of meeting speech (R1/R2/R3/notes) to a meeting. dedupeKey is idempotent: a repeated post '
      + 'returns {ok:true, duplicate:true, existingMsgId} without adding another message.',
    parameters: meetingParameters,
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId)
      if (meetingId === undefined) return meetingInvalid('meetingId is required')
      if (args.round !== undefined && args.round !== null && args.round !== '' && normalizeRound(args.round) === null) {
        return meetingInvalid(`invalid round: ${String(args.round)} (expected R1|R2|R3|notes)`, 'MEETING_INVALID_ROUND')
      }
      const round = normalizeRound(args.round, 'notes')
      const body = typeof args.body === 'string' ? args.body : ''
      if (body.trim() === '') return meetingInvalid('body is required')
      const dedupeKey = firstString(args.dedupeKey) ?? null
      const state = loadMeetingState(meetingId)
      if (!state.ok) return state.notFound ? meetingNotFound(meetingId) : meetingError(state.error)
      if (normalizeMeetingStatus(state.meeting?.status) === 'finalized'
        || state.store.status === 'finalized'
        || Boolean(state.store.finalizedAt)) {
        return meetingInvalid(`meeting is finalized: ${meetingId}`, 'MEETING_FINALIZED')
      }
      const existing = dedupeKey === null
        ? null
        : (state.store.posts ?? []).find(post => post?.dedupeKey === dedupeKey) ?? null
      if (existing !== null) return duplicatePostResponse(state, existing)
      const author = resolveMeetingAuthor(exec)
      const to = firstString(args.to) ?? null
      const subject = firstString(args.subject) ?? null
      const atMs = Date.now()
      const atIso = new Date(atMs).toISOString()
      const entry = {
        msgId: generateMeetingMsgId(meetingId, round, author),
        round,
        from: author,
        to,
        subject,
        body,
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        bodyLen: Buffer.byteLength(body, 'utf8'),
        dedupeKey,
        at: atIso,
      }
      const write = withWriteDb(() => {
        let insert = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0) entry.msgId = generateMeetingMsgId(meetingId, round, author)
          insert = modules.db.addMeetingMessage({
            meetingId,
            msgId: entry.msgId,
            fromAlias: entry.from,
            toAlias: entry.to,
            at: atMs,
            bodySha256: entry.bodySha256,
            bodyLen: entry.bodyLen,
            dedupeKey: entry.dedupeKey,
          })
          if (insert.inserted === true || insert.deduped === true) break
        }
        if (insert === null) {
          const error = new Error('could not allocate a unique msgId')
          error.code = 'MEETING_MESSAGE_ID_CONFLICT'
          throw error
        }
        if (insert.deduped === true) return { deduped: true, msgId: insert.msgId, meetingId: insert.meetingId }
        const current = modules.db.getMeeting(meetingId)
        const desired = round === 'R1' ? 'r1' : (round === 'R2' || round === 'R3') ? 'r2' : null
        const ranks = { open: 0, r1: 1, r2: 2 }
        if (desired !== null && current !== undefined && !['final', 'cancelled'].includes(current.status)
          && (ranks[desired] ?? 0) > (ranks[current.status] ?? 0)) {
          modules.db.setMeetingStatus(meetingId, desired)
        }
        return {
          deduped: false,
          meeting: modules.db.getMeeting(meetingId),
          participants: modules.db.listMeetingParticipants(meetingId),
          messages: modules.db.listMeetingMessages(meetingId),
        }
      })
      if (!write.ok) return meetingError(write.error)
      if (write.value.deduped === true) {
        const duplicateMeetingId = write.value.meetingId
        if (duplicateMeetingId !== meetingId) {
          return meetingInvalid(`dedupeKey already belongs to meeting ${duplicateMeetingId}`, 'MEETING_DUPLICATE')
        }
        const recovered = (state.store.posts ?? []).find(post => post?.msgId === write.value.msgId || post?.dedupeKey === dedupeKey) ?? null
        if (recovered !== null) return duplicatePostResponse(state, recovered)
        // DB row exists but the sidecar write was lost: heal it from this retry.
        entry.msgId = write.value.msgId
        state.store.posts = [...(state.store.posts ?? []), entry]
        state.store.updatedAt = atIso
        try {
          writeMeetingStore(state.store)
        } catch (error) {
          return meetingError(error)
        }
        const messages = mergeMeetingMessages(state.store, state.messages)
        const participants = state.participants.map(participantView)
        return {
          ok: true,
          duplicate: true,
          recovered: true,
          existingMsgId: entry.msgId,
          meeting: meetingView(state.meeting, state.store, participants, messages),
          message: messageView(entry),
          participants,
          participantIds: participants.map(participant => participant.sessionId),
        }
      }
      state.store.posts = [...(state.store.posts ?? []), entry]
      state.store.status = normalizeMeetingStatus(write.value.meeting?.status ?? state.store.status) ?? state.store.status
      state.store.updatedAt = atIso
      try {
        writeMeetingStore(state.store)
      } catch (error) {
        return meetingError(error)
      }
      const participants = (write.value.participants ?? []).map(participantView)
      const messages = mergeMeetingMessages(state.store, write.value.messages)
      const meeting = meetingView(write.value.meeting, state.store, participants, messages)
      safeCall(() => audit?.({ action: 'meeting_post', meetingId, round, ok: true, messages: messages.length, caller: resolveAuditCaller(exec) }), () => {})
      return { ok: true, duplicate: false, meeting, message: messageView(entry), participants, participantIds: participants.map(participant => participant.sessionId) }
    },
  })

  ctx.tools.register({
    name: 'meeting_collect',
    description:
      'Collect one meeting: returns the meeting summary, participants, messages (round/body included) and '
      + 'decisions/actions. `round` optionally filters messages to R1|R2|R3|notes.',
    parameters: meetingParameters,
    output: jsonOut,
    async execute(args = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId)
      if (meetingId === undefined) return meetingInvalid('meetingId is required')
      const explicitRound = args.round !== undefined && args.round !== null && args.round !== ''
      if (explicitRound && normalizeRound(args.round) === null) {
        return meetingInvalid(`invalid round: ${String(args.round)} (expected R1|R2|R3|notes)`, 'MEETING_INVALID_ROUND')
      }
      const round = explicitRound ? normalizeRound(args.round) : null
      const state = loadMeetingState(meetingId)
      if (!state.ok) return state.notFound ? meetingNotFound(meetingId) : meetingError(state.error)
      const participants = state.participants.map(participantView)
      const allMessages = mergeMeetingMessages(state.store, state.messages)
      const messages = round === null ? allMessages : allMessages.filter(message => message.round === round)
      const meeting = meetingView(state.meeting, state.store, participants, allMessages)
      const decisions = Array.isArray(state.store.decisions) ? state.store.decisions : []
      const actions = Array.isArray(state.store.actions) ? state.store.actions : []
      safeCall(() => audit?.({ action: 'meeting_collect', meetingId, round: round ?? 'all', ok: true, messages: messages.length, caller: resolveAuditCaller(exec) }), () => {})
      return {
        ok: true,
        meeting,
        participants,
        participantIds: participants.map(participant => participant.sessionId),
        messages,
        actions,
        decisions,
        rounds: meeting.rounds,
        count: messages.length,
        filter: { round },
      }
    },
  })

  ctx.tools.register({
    name: 'meeting_finalize',
    description:
      'Finalize a meeting (status finalized) and record decisions/actions parsed from body (JSON or Markdown) '
      + 'or supplied by earlier posts. Idempotent: finalizing twice returns alreadyFinalized:true.',
    parameters: meetingParameters,
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId)
      if (meetingId === undefined) return meetingInvalid('meetingId is required')
      const state = loadMeetingState(meetingId)
      if (!state.ok) return state.notFound ? meetingNotFound(meetingId) : meetingError(state.error)
      const participants = state.participants.map(participantView)
      const existingDecisions = Array.isArray(state.store.decisions) ? state.store.decisions : []
      const existingActions = Array.isArray(state.store.actions) ? state.store.actions : []
      const alreadyFinalized = state.store.status === 'finalized' || Boolean(state.store.finalizedAt)
      if (alreadyFinalized) {
        const messages = mergeMeetingMessages(state.store, state.messages)
        const meeting = meetingView(state.meeting, state.store, participants, messages)
        const summary = state.store.summary ?? {
          meetingId,
          title: meeting.title,
          status: 'finalized',
          convener: meeting.convener,
          participantCount: participants.length,
          messageCount: messages.length,
          rounds: meeting.rounds,
          decisions: existingDecisions,
          actions: existingActions,
          decisionCount: existingDecisions.length,
          actionCount: existingActions.length,
          finalizedAt: state.store.finalizedAt ?? null,
        }
        return { ok: true, alreadyFinalized: true, meeting, summary, decisions: existingDecisions, actions: existingActions, participants, participantIds: participants.map(participant => participant.sessionId) }
      }
      const parsedBody = parseMeetingFinalBody(args.body)
      const decisions = parsedBody.decisions.length > 0 ? parsedBody.decisions : existingDecisions
      const actions = parsedBody.actions.length > 0 ? parsedBody.actions : existingActions
      const atIso = new Date().toISOString()
      const store = {
        ...state.store,
        status: 'finalized',
        finalizedAt: atIso,
        updatedAt: atIso,
        decisions,
        actions,
        summaryText: parsedBody.summaryText,
      }
      const messages = mergeMeetingMessages(store, state.messages)
      const meeting = meetingView(state.meeting, store, participants, messages)
      const summary = {
        meetingId,
        title: meeting.title,
        status: 'finalized',
        convener: meeting.convener,
        participantCount: participants.length,
        participants: participants.map(participant => participant.sessionId),
        messageCount: messages.length,
        rounds: meeting.rounds,
        decisions,
        actions,
        decisionCount: decisions.length,
        actionCount: actions.length,
        finalizedAt: atIso,
        ...(parsedBody.summaryText === null ? {} : { summaryText: parsedBody.summaryText }),
        ...(typeof args.body === 'string' && args.body.trim() !== '' ? {
          bodySha256: createHash('sha256').update(args.body, 'utf8').digest('hex'),
          bodyLen: Buffer.byteLength(args.body, 'utf8'),
        } : {}),
      }
      store.summary = summary
      try {
        writeMeetingStore(store)
      } catch (error) {
        return meetingError(error)
      }
      const statusWrite = withWriteDb(() => {
        const changed = modules.db.setMeetingStatus(meetingId, 'final')
        return { changed, meeting: modules.db.getMeeting(meetingId) }
      })
      if (!statusWrite.ok) return meetingError(statusWrite.error)
      if (statusWrite.value.changed !== true) return meetingNotFound(meetingId)
      const finalMeeting = meetingView(statusWrite.value.meeting, store, participants, messages)
      safeCall(() => audit?.({ action: 'meeting_finalize', meetingId, ok: true, decisions: decisions.length, actions: actions.length, caller: resolveAuditCaller(exec) }), () => {})
      return { ok: true, alreadyFinalized: false, meeting: finalMeeting, summary, decisions, actions, participants, participantIds: participants.map(participant => participant.sessionId) }
    },
  })

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
  const broadcastHint = '广播可用 message_send({to:"<alias>"})，或对已加入的每个 alias 逐个发送（from=' + (displayName ?? '(unset)')
    + '，fromAlias=' + alias + '，自检加 test:true 并在正文头标 [SELFTEST]）；'
    + '本工具只写宿主别名目录，不写工作区路由文件/工作区文件；message-bus 通过宿主 Agent Inbox 投递。'
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
