/** Tool registration for dsh-session-network (P0/P1 skeleton; modules are injected lazily). */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  MEETING_DIGEST_DEFAULT_LIMIT,
  MEETING_DIGEST_MAX_LIMIT,
  buildMeetingDigest,
  emptyMeetingDigest,
  parseDigestNow,
  updateMeetingActionInStore,
  validateMeetingDeadline,
} from './meeting-digest.js'
import { buildPitfalls as buildPitfallsDirect } from './pitfalls.js'

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
    const normalize = parsed => {
      if (parsed === null || typeof parsed !== 'object') return null
      if (!Array.isArray(parsed.posts)) parsed.posts = []
      if (!Array.isArray(parsed.decisions)) parsed.decisions = []
      if (!Array.isArray(parsed.actions)) parsed.actions = []
      return parsed
    }
    const file = meetingStorePath(meetingId)
    if (file === null) return null
    if (existsSync(file)) {
      try { return normalize(JSON.parse(readFileSync(file, 'utf8'))) } catch { return null }
    }
    // Renaming an entity must re-derive its sidecar filename. Accept a stale-hash
    // sidecar only when its embedded meetingId matches exactly, so old data stays
    // readable after a rename instead of silently degrading to empty decisions.
    const raw = String(meetingId)
    const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '_').slice(0, 48) || 'meeting'
    try {
      for (const name of readdirSync(MEETING_STORE_DIR)) {
        if (!name.startsWith(`${safe}-`) || !name.endsWith('.json')) continue
        try {
          const parsed = normalize(JSON.parse(readFileSync(join(MEETING_STORE_DIR, name), 'utf8')))
          if (parsed !== null && parsed.meetingId === raw) return parsed
        } catch { /* one corrupt sidecar must not hide the others */ }
      }
    } catch { /* directory unreadable */ }
    return null
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

  // P1-1 (CR3 final): the sidecar is read-modify-write. An in-process queue
  // alone cannot protect callers in another Node process sharing this dataDir,
  // so every writer also takes an adjacent `<file>.lock` created with O_EXCL.
  // A crashed holder is detected (dead pid on this host, or age past the stale
  // threshold) and its lock is quarantined before the waiter retries.
  const MEETING_LOCK_TIMEOUT_MS = Math.max(1000, Number(process.env.DSH_MEETING_LOCK_TIMEOUT_MS) || 20000)
  const MEETING_LOCK_STALE_MS = Math.max(2000, Number(process.env.DSH_MEETING_LOCK_STALE_MS) || 60000)
  const MEETING_LOCK_RETRY_MS = 10
  const meetingStoreLocks = new Map()

  const meetingLockInfo = lockPath => {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
      const stats = statSync(lockPath)
      return { parsed: parsed !== null && typeof parsed === 'object' ? parsed : {}, mtimeMs: stats.mtimeMs }
    } catch {
      return null
    }
  }

  const meetingLockAgeMs = observed => {
    const created = Number(observed?.parsed?.createdAt)
    const baseline = Number.isFinite(created) && created > 0
      ? Math.min(observed.mtimeMs, created)
      : observed.mtimeMs
    return Date.now() - baseline
  }

  const pidAlive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return null
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'ESRCH' ? false : null
    }
  }

  const meetingLockIsStale = lockPath => {
    const observed = meetingLockInfo(lockPath)
    if (observed === null) {
      // The lock may have been created a microsecond ago and not yet written;
      // an unreadable lock only becomes stale after the age threshold.
      try { return Date.now() - statSync(lockPath).mtimeMs > MEETING_LOCK_STALE_MS } catch { return false }
    }
    if (meetingLockAgeMs(observed) > MEETING_LOCK_STALE_MS) return true
    const ownerHost = observed.parsed?.host
    if (ownerHost !== hostname()) return false
    return pidAlive(Number(observed.parsed?.pid)) === false
  }

  const removeStaleMeetingLock = lockPath => {
    if (!meetingLockIsStale(lockPath)) return false
    // Rename is atomic: exactly one of several waiters wins the quarantine and
    // a freshly-created lock can never be unlinked by a stale breaker.
    const quarantine = `${lockPath}.stale-${process.pid}-${Date.now()}-${randomUUID()}`
    try {
      renameSync(lockPath, quarantine)
    } catch {
      return false
    }
    try { unlinkSync(quarantine) } catch { /* best effort */ }
    return true
  }

  const acquireMeetingStoreFileLock = async file => {
    const lockPath = `${file}.lock`
    const token = randomUUID()
    const body = JSON.stringify({ pid: process.pid, host: hostname(), token, createdAt: Date.now() })
    const startedAt = Date.now()
    let delay = MEETING_LOCK_RETRY_MS
    while (true) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600)
        try { writeFileSync(fd, body, 'utf8') } finally { closeSync(fd) }
        return { lockPath, token }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        if (removeStaleMeetingLock(lockPath)) { delay = MEETING_LOCK_RETRY_MS; continue }
        if (Date.now() - startedAt >= MEETING_LOCK_TIMEOUT_MS) {
          const timeout = new Error(`timed out after ${MEETING_LOCK_TIMEOUT_MS}ms waiting for ${lockPath}`)
          timeout.code = 'MEETING_STORE_LOCK_TIMEOUT'
          throw timeout
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, delay + Math.floor(Math.random() * delay)))
        delay = Math.min(delay * 2, 200)
      }
    }
  }

  const releaseMeetingStoreFileLock = lock => {
    if (lock === null) return
    try {
      const parsed = JSON.parse(readFileSync(lock.lockPath, 'utf8'))
      if (parsed?.token !== lock.token) return // a stale-breaker already owns it
    } catch {
      return // gone or unreadable: never unlink another writer's lock
    }
    try { unlinkSync(lock.lockPath) } catch { /* best effort */ }
  }

  async function withMeetingStoreFileLock(meetingId, fn) {
    const file = meetingStorePath(meetingId)
    let lock = null
    if (file !== null) {
      mkdirSync(MEETING_STORE_DIR, { recursive: true })
      lock = await acquireMeetingStoreFileLock(file)
    }
    try {
      return await fn()
    } finally {
      releaseMeetingStoreFileLock(lock)
    }
  }

  // P1-1: per-meeting in-process queue + cross-process file lock. Callers in
  // this process must never contend on the file (and lose FIFO ordering), so
  // the file lock is acquired inside the queued task.
  function withMeetingStoreLock(meetingId, fn) {
    const key = String(meetingId)
    const previous = meetingStoreLocks.get(key) ?? Promise.resolve()
    const run = previous.then(
      () => withMeetingStoreFileLock(key, fn),
      () => withMeetingStoreFileLock(key, fn),
    )
    const tail = run.then(() => {}, () => {})
    meetingStoreLocks.set(key, tail)
    tail.then(() => {
      if (meetingStoreLocks.get(key) === tail) meetingStoreLocks.delete(key)
    })
    return run
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

  /**
   * Q3-A meeting identity. `resolveMeetingAuthor` is a display name; it must
   * never be used as an authorization key. The authoritative caller is the
   * host-injected session id, with alias/displayName only used to match legacy
   * (`convener` held an alias before Batch A) meetings.
   */
  function callerIdentity(exec) {
    const agent = exec?.agent ?? {}
    const session = agent?.session ?? {}
    const header = session?.header ?? {}
    return {
      sessionId: firstString(session?.id, agent?.id) ?? null,
      alias: firstString(agent?.alias, agent?.info?.alias, header?.alias) ?? null,
      displayName: firstString(agent?.displayName, agent?.info?.displayName, header?.displayName) ?? null,
    }
  }

  function isMeetingOperator(exec) {
    try {
      const policy = ctx.get?.('sandboxPolicy')
      const resolved = policy?.resolve?.({ session: exec?.agent?.session })
      return resolved?.mode === 'danger-full-access'
    } catch {
      return false
    }
  }

  function meetingConvenerSessionOf(state) {
    const value = state?.store?.convenerSession
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  /**
   * P1-3: alias authorization must follow the host alias route. A bare string
   * match is not enough for a write claim: the alias row must belong to the
   * calling session. displayName is never an authorization key.
   */
  function aliasRouteMatchesSession(alias, sessionId) {
    if (typeof alias !== 'string' || alias === '' || sessionId === null) return false
    if (typeof modules.db?.resolveAlias !== 'function') return false
    const read = withReadDb(() => modules.db.resolveAlias(alias))
    if (!read.ok) return false
    const row = read.value
    return row !== undefined && row !== null && row.session_id === sessionId
  }

  function participantMatches(participants, identity) {
    const known = new Set()
    for (const row of Array.isArray(participants) ? participants : []) {
      const value = typeof row === 'string' ? row : firstString(row?.sessionId, row?.session_id, row?.id)
      if (value !== undefined) known.add(value)
    }
    // displayName is a presentation label, never an authorization key.
    for (const value of [identity.sessionId, identity.alias]) {
      if (typeof value === 'string' && value !== '' && known.has(value)) return true
    }
    return false
  }

  function legacyConvenerMatches(state, identity) {
    const convener = firstString(state?.meeting?.convener, state?.store?.convener)
    if (convener === undefined) return false
    return [identity.sessionId, identity.alias]
      .some(value => typeof value === 'string' && value !== '' && value === convener)
  }

  /**
   * `write:true` is used by post/finalize: a legacy meeting (no convenerSession
   * yet) grants its alias-identified convener read access only; the first write
   * must explicitly claim the meeting via an idempotent meeting_open. New
   * meetings store convenerSession in the sidecar, so no alias fallback is used.
   */
  function meetingAccess(state, exec, { write = false } = {}) {
    const identity = callerIdentity(exec)
    if (isMeetingOperator(exec)) return { allowed: true, role: 'operator', identity }
    const participant = participantMatches(state.participants, identity)
    const convenerSession = meetingConvenerSessionOf(state)
    if (convenerSession !== null) {
      if (identity.sessionId !== null && identity.sessionId === convenerSession) {
        return { allowed: true, role: 'convener', identity }
      }
      if (participant) return { allowed: true, role: 'participant', identity }
      return { allowed: false, code: 'FORBIDDEN', identity, reason: 'caller is not a meeting participant or convener' }
    }
    if (legacyConvenerMatches(state, identity)) {
      if (write) {
        return {
          allowed: false, code: 'MEETING_CONVENER_CLAIM_REQUIRED', identity,
          reason: 'legacy convener must claim the meeting before writing',
        }
      }
      return { allowed: true, role: 'legacy-convener', identity }
    }
    if (participant) return { allowed: true, role: 'participant', identity }
    return { allowed: false, code: 'FORBIDDEN', identity, reason: 'caller is not a meeting participant or convener' }
  }

  function meetingAccessError(access, meetingId) {
    if (access.code === 'MEETING_CONVENER_CLAIM_REQUIRED') {
      return {
        ok: false,
        code: 'MEETING_CONVENER_CLAIM_REQUIRED',
        meetingCode: 'MEETING_FORBIDDEN',
        meetingId,
        error: `MEETING_CONVENER_CLAIM_REQUIRED: claim legacy meeting ${meetingId} first `
          + '(call meeting_open with the same meetingId)',
      }
    }
    return {
      ok: false,
      code: 'FORBIDDEN',
      meetingCode: 'MEETING_FORBIDDEN',
      meetingId,
      error: `FORBIDDEN: ${access.reason ?? 'caller is not a meeting participant or convener'}`,
    }
  }

  /**
   * Bind a legacy meeting's alias convener to the caller's session id.
   * The caller must already hold the meeting sidecar lock (the read-modify-write
   * below would otherwise race a concurrent post from another process).
   */
  function claimLegacyMeetingForConvenerLocked(state, exec) {
    if (state === null || typeof state !== 'object') return false
    if (state.store === null || typeof state.store !== 'object') return false
    if (meetingConvenerSessionOf(state) !== null) return false
    const identity = callerIdentity(exec)
    if (identity.sessionId === null) return false
    const convener = firstString(state?.meeting?.convener, state?.store?.convener)
    if (convener === undefined) return false
    // A session-id convener is authoritative. An alias convener is only
    // claimable when the host alias route maps that alias to this session.
    let authorized = convener === identity.sessionId
    if (!authorized && identity.alias !== null && convener === identity.alias) {
      authorized = aliasRouteMatchesSession(identity.alias, identity.sessionId)
    }
    if (!authorized) return false
    // Re-read before mutating so a claim cannot overwrite a concurrent post.
    const latest = readMeetingStore(state.store.meetingId) ?? state.store
    if (meetingConvenerSessionOf({ store: latest }) !== null) return false
    latest.convenerSession = identity.sessionId
    latest.convenerClaimedAt = new Date().toISOString()
    writeMeetingStore(latest)
    state.store = latest
    return true
  }

  async function claimLegacyMeetingForConvener(state, exec) {
    if (state === null || typeof state !== 'object') return false
    if (state.store === null || typeof state.store !== 'object') return false
    const meetingId = state.store.meetingId
    if (meetingId === undefined || meetingId === null) return false
    let claimed = false
    await withMeetingStoreLock(meetingId, () => {
      claimed = claimLegacyMeetingForConvenerLocked(state, exec)
    })
    return claimed
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
      convenerSession: store?.convenerSession ?? null,
      createdAt: toIsoTime(row?.created_at) ?? store?.createdAt ?? null,
      updatedAt: toIsoTime(row?.updated_at) ?? store?.updatedAt ?? null,
      deadline: toIsoTime(row?.deadline ?? store?.deadline) ?? null,
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
    const result = { ok: false, code, error: `${code}: ${message}` }
    if (code === 'MEETING_FINALIZED') {
      result.hint = 'meeting_post is closed after finalize, but meeting_action_update still works: use {meetingId, actionId, status:"completed"|"closed"|"cancelled", owner?, due?} to close pending actions.'
    }
    return result
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
      + 'capability audit.',
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
        const knownSessionIds = new Set(sessions.map(item => item.sessionId))
        for (const agent of Array.isArray(live) ? live : []) {
          const id = agent?.session?.id
          if (typeof id !== 'string' || id === '' || knownSessionIds.has(id)) continue
          knownSessionIds.add(id)
          sessions.push({
            sessionId: id,
            alias: null,
            displayName: agent?.session?.header?.displayName ?? agent?.displayName ?? null,
            roleName: agent?.session?.header?.roleName ?? null,
            status: agent?.status === 'running' ? 'running' : 'active',
            routable: true,
            source: 'live-agent',
          })
        }
        const pitfallsForNetwork = safeCall(
          () => (modules.pitfalls?.buildPitfalls ?? buildPitfallsDirect)({ limit: 10, probe: false }),
          () => ({ count: 0, items: [] }),
        )
        const meetingDigest = safeCall(() => {
          const read = withReadDb(() => buildMeetingDigest({ db: modules.db, dataDir, now: Date.now(), limit: 50 }))
          return read.ok ? read.value : emptyMeetingDigest(Date.now(), { limit: 50 })
        }, () => emptyMeetingDigest(Date.now(), { limit: 50 }))
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
          meetings: (meetingDigest.meetings ?? []).map(row => ({
            meetingId: row.meetingId,
            status: row.status,
            convener: row.convener ?? null,
            participants: Number(row.participantCount ?? row.participants ?? 0),
            pendingActions: Number(row.pendingActionCount ?? 0),
          })),
          meetingsData: {
            counts: meetingDigest.counts ?? null,
            scanned: meetingDigest.scanned ?? null,
          },
          pitfalls: pitfallsForNetwork.items ?? [],
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
      'Known environment pitfalls extracted from the dsh-dev-pitfalls symptom index (<=10 lines). Canonical quick entry; memory_search and the dsh-dev-pitfalls skill are supplemental. Use full:true for the complete action text. '
      + 'Used by session briefings instead of inlining pitfall lists.',
    parameters: baseParams({
      query: { type: 'string', description: 'Optional keyword filter.' },
      limit: { type: 'number', description: 'Max items (default 10, max 10).' },
      full: { type: 'boolean', description: 'Return up to 4000 chars of each action instead of the 400-char summary.' },
    }),
    output: jsonOut,
    async execute(args = {}) {
      const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? profileDir
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(10, args.limit)) : 10
      const result = modules.pitfalls?.buildPitfalls
        ? safeCall(() => modules.pitfalls.buildPitfalls({ query: args.query, limit, full: args.full === true }), () => readPitfalls(homeDir, args.query, limit))
        : readPitfalls(homeDir, args.query, limit)
      safeCall(() => audit?.({ action: 'pitfalls', count: result.count, caller: resolveAuditCaller(exec) }), () => {})
      return result
    },
  })

  ctx.tools.register({
    name: 'audit_page',
    description:
      'Read the session-network append-only audit log (read-only, paginated). Filters: actor/action/result/'
      + 'target/meetingId/since/targetSource. Each item carries effectiveTarget and targetSource: '
      + '"column" (target written), "meta" (legacy row whose meetingId exists only in meta) or "none" '
      + '(historical row with neither target nor meta.meetingId: NOT attributable, never back-filled). '
      + 'Pass targetSource:"none" to count/label unattributable rows.',
    parameters: baseParams({
      limit: { type: 'number', description: 'Max rows (default 100, max 500).' },
      offset: { type: 'number', description: 'Row offset (default 0).' },
      actor: { type: 'string', description: 'Actor substring match.' },
      action: { type: 'string', description: 'Exact action (e.g. meeting_post).' },
      target: { type: 'string', description: 'Exact effective target (e.g. meeting:M1).' },
      meetingId: { type: 'string', description: 'Meeting id; matches effective target meeting:<id>.' },
      since: { type: 'string', description: 'ISO timestamp lower bound.' },
      result: { type: 'string', description: 'Exact result (ok/error/...).' },
      targetSource: { type: 'string', enum: ['column', 'meta', 'none'], description: 'Which effective-target source to return.' },
    }),
    output: jsonOut,
    async execute(args = {}) {
      if (dataDir === null) return { ok: false, code: 'NO_DB', message: 'registry database unavailable (no dataDir)' }
      if (typeof modules.db?.queryAuditPage !== 'function') {
        return { ok: false, code: 'AUDIT_UNSUPPORTED', message: 'queryAuditPage is unavailable in this db module' }
      }
      const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
      const limit = Number.isFinite(Number(args.limit)) ? Math.min(500, Math.max(1, Math.trunc(Number(args.limit)))) : 100
      const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.trunc(Number(args.offset))) : 0
      const read = withReadDb(() => modules.db.queryAuditPage({
        limit,
        offset,
        actor: text(args.actor),
        action: text(args.action),
        target: text(args.target),
        meetingId: text(args.meetingId),
        since: text(args.since),
        result: text(args.result),
        targetSource: text(args.targetSource),
      }))
      if (!read.ok) {
        return { ok: false, code: read.error?.code ?? 'AUDIT_QUERY_FAILED', message: String(read.error?.message ?? read.error) }
      }
      return { ok: true, ...read.value }
    },
  })

  ctx.tools.register({
    name: 'alias_register',
    description:
      'Register (or propose) this session\'s own alias in the host-native sessionDirectory (host DB). '
      + 'Only the caller session may register/rename itself; wildcards are rejected; no PEERS.json/ACL/workspace writes. '
      + 'Rename limit is 2 per session (the 3rd rename is rejected); old aliases stay resolvable as legacy. '
      + 'Human confirmation required: preview with dryRun and confirm before changing routing; see '
      + 'release notes.',
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
      // A previous read may have bound the read-only handle; rebind the
      // writable one before the alias route is mutated.
      modules.db.useDb?.(dbHandle)
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
    deadline: { type: 'string', description: 'meeting_open only: optional ISO date/time deadline, e.g. 2026-11-18T12:00:00+08:00 (invalid values are rejected).' },
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
      const deadlineInput = validateMeetingDeadline(args.deadline)
      if (!deadlineInput.ok) return meetingInvalid(deadlineInput.message, deadlineInput.code)
      const meetingId = firstString(args.meetingId) ?? generateMeetingId()
      const dedupeKey = firstString(args.dedupeKey) ?? null
      if (dedupeKey !== null) {
        const duplicateStore = findMeetingStoreByDedupe(dedupeKey)
        if (duplicateStore !== null) {
          const duplicateState = loadMeetingState(duplicateStore.meetingId)
          if (duplicateState.ok) {
            // P1-2: duplicate meeting_open is a read too; the same participant /
            // convener boundary as post/finalize applies (legacy read-only kept).
            const access = meetingAccess(duplicateState, exec, { write: false })
            if (!access.allowed) return meetingAccessError(access, duplicateStore.meetingId)
            let claimed = false
            try { claimed = await claimLegacyMeetingForConvener(duplicateState, exec) } catch (error) { return meetingError(error) }
            const participants = duplicateState.participants.map(participantView)
            const messages = mergeMeetingMessages(duplicateState.store, duplicateState.messages)
            return {
              ok: true,
              duplicate: true,
              existingMeetingId: duplicateStore.meetingId,
              claimed,
              meeting: meetingView(duplicateState.meeting, duplicateState.store, participants, messages),
              participants,
              participantIds: participants.map(participant => participant.sessionId),
              messages,
            }
          }
          const sidecarState = { store: duplicateStore, meeting: undefined, participants: [], messages: [] }
          const access = meetingAccess(sidecarState, exec, { write: false })
          if (!access.allowed) return meetingAccessError(access, duplicateStore.meetingId)
          const messages = mergeMeetingMessages(duplicateStore, [])
          return {
            ok: true,
            duplicate: true,
            existingMeetingId: duplicateStore.meetingId,
            claimed: false,
            meeting: meetingView(undefined, duplicateStore, [], messages),
            participants: [],
            participantIds: [],
            messages,
          }
        }
      }
      const existingState = loadMeetingState(meetingId)
      if (existingState.ok) {
        // Authorize before writing a reconstructed sidecar or claiming.
        const access = meetingAccess(existingState, exec, { write: false })
        if (!access.allowed) return meetingAccessError(access, meetingId)
        let claimed = false
        try {
          // The reconstruction and the legacy claim are one read-modify-write:
          // hold the cross-process lock for both.
          claimed = await withMeetingStoreLock(meetingId, () => {
            if (readMeetingStore(meetingId) === null) writeMeetingStore(existingState.store)
            return claimLegacyMeetingForConvenerLocked(existingState, exec)
          })
        } catch (error) { return meetingError(error) }
        const existingParticipants = existingState.participants.map(participantView)
        const existingMessages = mergeMeetingMessages(existingState.store, existingState.messages)
        return {
          ok: true,
          duplicate: true,
          existingMeetingId: meetingId,
          claimed,
          meeting: meetingView(existingState.meeting, existingState.store, existingParticipants, existingMessages),
          participants: existingParticipants,
          participantIds: existingParticipants.map(participant => participant.sessionId),
          messages: existingMessages,
        }
      }
      if (existingState.notFound !== true) return meetingError(existingState.error)
      const title = firstString(args.title) ?? null
      const convener = resolveMeetingAuthor(exec)
      const convenerSession = callerIdentity(exec).sessionId
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
        modules.db.createMeeting({ meetingId, title, convener, dirPath, deadline: deadlineInput.deadline?.ms ?? null, at: atMs })
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
        convenerSession,
        dedupeKey,
        dirPath,
        deadline: deadlineInput.deadline?.iso ?? null,
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
      'Append one round of meeting speech (R1/R2/R3/notes) to a meeting. Only a registered participant or the '
      + 'convener may post (others get FORBIDDEN); a legacy alias-convener must claim via meeting_open first. '
      + 'dedupeKey is idempotent: a repeated post returns {ok:true, duplicate:true, existingMsgId} without adding another message.',
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
      const access = meetingAccess(state, exec, { write: true })
      if (!access.allowed) return meetingAccessError(access, meetingId)
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
      let locked
      try {
        locked = await withMeetingStoreLock(meetingId, () => {
          // Re-read inside the lock: another participant (or another process)
          // may have appended since this call loaded `state`, and that post
          // must not be lost.
          const latest = readMeetingStore(meetingId) ?? state.store
          if (normalizeMeetingStatus(latest.status) === 'finalized' || Boolean(latest.finalizedAt)) {
            return { store: latest, duplicate: null, finalized: true, recovered: false }
          }
          const duplicate = dedupeKey === null
            ? null
            : (latest.posts ?? []).find(post => post?.dedupeKey === dedupeKey) ?? null
          if (duplicate !== null) return { store: latest, duplicate, finalized: false, recovered: false }

          // P2-1 (CR3 final): insert the DB row only after the finalized and
          // dedupe checks above, while holding the sidecar lock. A rejected
          // post therefore never leaves a DB-only "ghost" message behind.
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
            if (insert === null || (insert.inserted !== true && insert.deduped !== true)) {
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
          if (!write.ok) throw write.error
          if (write.value.deduped === true) {
            if (write.value.meetingId !== meetingId) {
              return {
                store: latest, duplicate: null, finalized: false, recovered: false,
                foreignMeetingId: write.value.meetingId,
              }
            }
            entry.msgId = write.value.msgId
            const present = (latest.posts ?? []).some(post => post?.msgId === entry.msgId
              || (dedupeKey !== null && post?.dedupeKey === dedupeKey))
            if (!present) {
              // The DB row survived a crashed sidecar write: heal it now that
              // the body is available again.
              latest.posts = [...(latest.posts ?? []), entry]
              latest.updatedAt = atIso
              writeMeetingStore(latest)
            }
            return { store: latest, duplicate: null, finalized: false, recovered: !present }
          }
          latest.posts = [...(latest.posts ?? []), entry]
          latest.status = normalizeMeetingStatus(write.value.meeting?.status ?? latest.status) ?? latest.status
          latest.updatedAt = atIso
          try {
            writeMeetingStore(latest)
          } catch (error) {
            // Keep DB and sidecar consistent: the sidecar append failed, so
            // remove the DB row inserted above. Only an inserted (not deduped)
            // row belongs to this call.
            const rollback = withWriteDb(() => modules.db.deleteMeetingMessage({ meetingId, msgId: entry.msgId }))
            if (!rollback.ok) log('meeting_post: failed to roll back DB row after sidecar write error', rollback.error)
            error.rollback = rollback.ok ? rollback.value : false
            throw error
          }
          return {
            store: latest, duplicate: null, finalized: false, recovered: false,
            meeting: write.value.meeting,
            participants: write.value.participants,
            messages: write.value.messages,
          }
        })
      } catch (error) {
        return meetingError(error)
      }
      if (locked.finalized === true) {
        return meetingInvalid(`meeting is finalized: ${meetingId}`, 'MEETING_FINALIZED')
      }
      if (locked.duplicate !== null) {
        return duplicatePostResponse({ ...state, store: locked.store }, locked.duplicate)
      }
      if (locked.foreignMeetingId !== undefined && locked.foreignMeetingId !== meetingId) {
        return meetingInvalid(`dedupeKey already belongs to meeting ${locked.foreignMeetingId}`, 'MEETING_DUPLICATE')
      }
      if (locked.recovered === true) {
        const messages = mergeMeetingMessages(locked.store, state.messages)
        const recoveredParticipants = state.participants.map(participantView)
        return {
          ok: true,
          duplicate: true,
          recovered: true,
          existingMsgId: entry.msgId,
          meeting: meetingView(state.meeting, locked.store, recoveredParticipants, messages),
          message: messageView(entry),
          participants: recoveredParticipants,
          participantIds: recoveredParticipants.map(participant => participant.sessionId),
        }
      }
      const participants = (locked.participants ?? []).map(participantView)
      const messages = mergeMeetingMessages(locked.store, locked.messages)
      const meeting = meetingView(locked.meeting, locked.store, participants, messages)
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
    async execute(args = {}, exec = {}) {
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
      // P1-2: collect returns every body/decision, so it must share the same
      // participant/convener boundary as post/finalize (legacy read-only kept).
      const access = meetingAccess(state, exec, { write: false })
      if (!access.allowed) return meetingAccessError(access, meetingId)
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
    name: 'meeting_digest',
    description:
      'Read-only meeting recall digest. Lists active (open/R1/R2) meetings whose deadline is expired or due within '
      + '24h, plus any non-cancelled meeting with pending actions (actions produced by meeting_finalize stay '
      + 'recallable until closed). Supports limit/now; never writes. Returns counts + meetings.',
    parameters: baseParams({
      limit: { type: 'number', description: `Max meetings to return (1-${MEETING_DIGEST_MAX_LIMIT}, default ${MEETING_DIGEST_DEFAULT_LIMIT}).` },
      now: { type: 'string', description: 'Optional ISO date/time or epoch milliseconds used to evaluate deadlines (default: now).' },
    }),
    output: jsonOut,
    async execute(args = {}) {
      const nowMs = parseDigestNow(args.now)
      if (nowMs === null) {
        return meetingInvalid('now must be an ISO date/time or epoch milliseconds', 'MEETING_INVALID_NOW')
      }
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit)
        ? Math.min(MEETING_DIGEST_MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
        : MEETING_DIGEST_DEFAULT_LIMIT
      // Read-only: no audit write, no DB creation. A missing registry means an
      // empty digest, not an error (the "no meetings" negative case).
      const read = withReadDb(() => buildMeetingDigest({ db: modules.db, dataDir, now: nowMs, limit }))
      if (!read.ok) {
        if (read.error?.code === 'NO_DB' || read.error?.code === 'DB_NOT_FOUND' || read.error?.code === 'DB_NOT_BOUND') {
          return emptyMeetingDigest(nowMs, { limit })
        }
        return meetingError(read.error)
      }
      return read.value
    },
  })

  ctx.tools.register({
    name: 'meeting_finalize',
    description:
      '⚠ Scope: one meeting (all participants); reversible: no for FINAL, but meeting_action_update remains available; precondition: participant/convener. Finalize a meeting (status finalized) and record decisions/actions parsed from body (JSON or Markdown) '
      + 'or supplied by earlier posts. Only a registered participant or the convener may finalize (others get FORBIDDEN); '
      + 'legacy alias-convener meetings require an explicit meeting_open claim before writing. '
      + 'Idempotent: finalizing twice returns alreadyFinalized:true.',
    parameters: meetingParameters,
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId)
      if (meetingId === undefined) return meetingInvalid('meetingId is required')
      const state = loadMeetingState(meetingId)
      if (!state.ok) return state.notFound ? meetingNotFound(meetingId) : meetingError(state.error)
      const alreadyFinalized = state.store.status === 'finalized' || Boolean(state.store.finalizedAt)
      // Finalizing a closed meeting is a read of its decisions/actions: legacy
      // alias conveners stay readable, but a live write still needs a claim.
      const access = meetingAccess(state, exec, { write: !alreadyFinalized })
      if (!access.allowed) return meetingAccessError(access, meetingId)
      const participants = state.participants.map(participantView)
      const existingDecisions = Array.isArray(state.store.decisions) ? state.store.decisions : []
      const existingActions = Array.isArray(state.store.actions) ? state.store.actions : []
      // R3: the idempotent response is built from the sidecar that holds the
      // winning finalize. The DB row may still show an older status when a
      // concurrent finalize has written the sidecar but not yet the registry.
      const finalizedResponse = store => {
        const decisionsForResponse = Array.isArray(store.decisions) ? store.decisions : []
        const actionsForResponse = Array.isArray(store.actions) ? store.actions : []
        const messages = mergeMeetingMessages(store, state.messages)
        const finalizedRow = state.meeting === undefined || state.meeting === null
          ? state.meeting
          : { ...state.meeting, status: 'final' }
        const meeting = meetingView(finalizedRow, store, participants, messages)
        const summary = store.summary ?? {
          meetingId,
          title: meeting.title,
          status: 'finalized',
          convener: meeting.convener,
          participantCount: participants.length,
          messageCount: messages.length,
          rounds: meeting.rounds,
          decisions: decisionsForResponse,
          actions: actionsForResponse,
          decisionCount: decisionsForResponse.length,
          actionCount: actionsForResponse.length,
          finalizedAt: store.finalizedAt ?? null,
        }
        return { ok: true, alreadyFinalized: true, meeting, summary, decisions: decisionsForResponse, actions: actionsForResponse, participants, participantIds: participants.map(participant => participant.sessionId) }
      }
      if (alreadyFinalized) return finalizedResponse(state.store)
      const parsedBody = parseMeetingFinalBody(args.body)
      const decisions = parsedBody.decisions.length > 0 ? parsedBody.decisions : existingDecisions
      const actions = parsedBody.actions.length > 0 ? parsedBody.actions : existingActions
      const atIso = new Date().toISOString()
      let written
      try {
        written = await withMeetingStoreLock(meetingId, () => {
          // Re-read inside the lock so a concurrent participant post is kept,
          // then write the finalized view back atomically.
          const latest = readMeetingStore(meetingId) ?? state.store
          // R3 CAS: the finalized check above happened before the lock. A
          // concurrent finalize (same process or another sharing dataDir) may
          // have won the lock first; never overwrite its decisions/actions.
          if (normalizeMeetingStatus(latest.status) === 'finalized' || Boolean(latest.finalizedAt)) {
            return { alreadyFinalized: true, store: latest }
          }
          const next = {
            ...latest,
            status: 'finalized',
            finalizedAt: atIso,
            updatedAt: atIso,
            decisions,
            actions,
            summaryText: parsedBody.summaryText,
          }
          const lockedMessages = mergeMeetingMessages(next, state.messages)
          const lockedMeeting = meetingView(state.meeting, next, participants, lockedMessages)
          next.summary = {
            meetingId,
            title: lockedMeeting.title,
            status: 'finalized',
            convener: lockedMeeting.convener,
            participantCount: participants.length,
            participants: participants.map(participant => participant.sessionId),
            messageCount: lockedMessages.length,
            rounds: lockedMeeting.rounds,
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
          writeMeetingStore(next)
          return { alreadyFinalized: false, store: next }
        })
      } catch (error) {
        return meetingError(error)
      }
      if (written.alreadyFinalized === true) return finalizedResponse(written.store)
      const stored = written.store
      const messages = mergeMeetingMessages(stored, state.messages)
      const summary = stored.summary
      const statusWrite = withWriteDb(() => {
        const changed = modules.db.setMeetingStatus(meetingId, 'final')
        return { changed, meeting: modules.db.getMeeting(meetingId) }
      })
      if (!statusWrite.ok) return meetingError(statusWrite.error)
      if (statusWrite.value.changed !== true) return meetingNotFound(meetingId)
      const finalMeeting = meetingView(statusWrite.value.meeting, stored, participants, messages)
      safeCall(() => audit?.({ action: 'meeting_finalize', meetingId, ok: true, decisions: decisions.length, actions: actions.length, caller: resolveAuditCaller(exec) }), () => {})
      return { ok: true, alreadyFinalized: false, meeting: finalMeeting, summary, decisions, actions, participants, participantIds: participants.map(participant => participant.sessionId) }
    },
  })

  ctx.tools.register({
    name: 'meeting_action_update',
    description: 'P1-6: assign or close one action on a finalized meeting. Only a participant or the convener may write. '
      + 'Status is pending|completed|closed|cancelled; owner and due are optional. The sidecar is updated and the action '
      + 'disappears from meeting_digest once it is no longer pending.',
    parameters: baseParams({
      meetingId: { type: 'string', description: 'Meeting id.' },
      actionId: { type: 'string', description: 'Action id from meeting_digest (e.g. A1).' },
      status: { type: 'string', description: 'pending|completed|closed|cancelled.' },
      owner: { type: 'string', description: 'Optional owner alias/session.' },
      due: { type: 'string', description: 'Optional ISO date/time deadline.' },
    }, ['meetingId', 'actionId']),
    output: jsonOut,
    async execute(args = {}, exec = {}) {
      if (!meetingStoreAvailable()) return meetingError({ code: 'NO_DB', message: 'meeting store unavailable (no dataDir)' })
      const meetingId = firstString(args.meetingId)
      if (meetingId === undefined) return meetingInvalid('meetingId is required')
      const state = loadMeetingState(meetingId)
      if (!state.ok) return state.notFound ? meetingNotFound(meetingId) : meetingError(state.error)
      const access = meetingAccess(state, exec, { write: true })
      if (!access.allowed) return meetingAccessError(access, meetingId)
      const updated = updateMeetingActionInStore(state.store, {
        actionId: args.actionId, status: args.status, owner: args.owner, due: args.due,
      })
      if (!updated.ok) return meetingInvalid(updated.message, updated.code)
      state.store.updatedAt = new Date().toISOString()
      try { writeMeetingStore(state.store) } catch (error) { return meetingError(error) }
      const pending = (Array.isArray(state.store.actions) ? state.store.actions : [])
        .filter(action => typeof action === 'object' && action !== null && String(action.status ?? 'pending').toLowerCase() === 'pending')
        .length
      safeCall(() => audit?.({ action: 'meeting_action_update', meetingId, actionId: updated.action.id, ok: true, status: updated.action.status, caller: resolveAuditCaller(exec) }), () => {})
      return { ok: true, meetingId, action: updated.action, pendingActions: pending, storeUpdatedAt: state.store.updatedAt }
    },
  })

  ctx.tools.register({
    name: 'workspace_agents_init',
    description:
      'Initialize the workspace-root AGENTS.md once. X4 order: auto-create a minimal file first, then the model may ask '
      + 'the user (non-blocking, <=30s) and call again with purpose to upgrade the auto template. Existing files are never overwritten. '
      + 'Human confirmation required before the first write (team-bootstrap §2 / release notes).',
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
