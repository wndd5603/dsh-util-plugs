/**
 * dsh-session-network · read-only disclosure (`network_info`) + redaction + audit
 *
 * Contract: docs/INTERFACES_v1.md §5/§5.0 (B3/R3 narrowed schema + C3 no-network
 * workspace semantics + N3 reachability), schema docs/DESIGN_v1.md §8, P1-A.
 *
 * Two modes:
 * - Workspace-strict mode (`workspaceDir` supplied by src/tools.js): only the
 *   current workspace is described. `team/pipe2/PEERS.json` is the membership
 *   source; when it is absent the payload is `{network:null, hint}` (C3/G10b)
 *   and no other workspace / host-wide live session is enumerated.
 * - Direct/legacy mode (no `workspaceDir`, tests/back-compat): aggregate from
 *   the optional db/peers/liveAgents/agentTeam inputs.
 *
 * Field enums (R3 frozen):
 * - presetCategory: captain|worker|readonly|reviewer|other
 * - roleKind:      manager|implementer|verifier|other
 * - team.kind:     captain|member|reviewer|infra|unknown (lead -> captain)
 * - contact.via:   session-id|alias|none; plus reason enum peers|inbox|route|unknown
 *
 * `pitfalls` is unified with the `pitfalls()` entry: same `buildPitfalls`
 * function and fields (P1-B). `sanitizeForOutput` is a second pass (F9/F18).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { buildPitfalls } from './pitfalls.js'
import { insertAudit, listAliases, listMeetings, listSessions, useDb } from './db.js'

export { buildPitfalls } from './pitfalls.js'

export const NETWORK_INFO_SCHEMA_VERSION = 1
export const NO_NETWORK_HINT = '本工作区未接入会话网络'
export const PEERS_RELATIVE = join('team', 'pipe2', 'PEERS.json')

const SECRET_PATTERNS = [
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g },
  { name: 'secret-assignment', re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*["']?[^\s"',;}]{4,}/gi },
]
const PATH_PATTERNS = [
  { name: 'windows-path', re: /\b[A-Za-z]:[\\/][^\s"',;}]*/g },
  { name: 'unc-path', re: /\\\\[^\\\s"',;}]+\\(?:[^\s"',;}]*)/g },
  { name: 'unix-path', re: /\/(?:Users|home|work|projects|tmp|root|opt|var)\/[^\s"',;}]*/g },
]
const ALL_PATTERNS = [...SECRET_PATTERNS, ...PATH_PATTERNS]

const WORKER_PRESETS = new Set(['standard', 'ptc', 'minimal', 'cordis', 'context-pro', 'context_pro'])
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLE_MANAGER_RE = /^(lead|队长|captain|manager|owner|director)$/i
const ROLE_VERIFIER_RE = /^(cr|cr-[a-z0-9-]+|review[a-z-]*|verify[a-z-]*|verifier|checker|auditor)$/i
const ROLE_INFRA_RE = /^(infra[a-z-]*|ops|sre|platform)$/i

function hashShort(value, length = 12) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length)
}

function safeCall(fn, fallback) {
  try { return fn() } catch { return fallback }
}

function normalizePath(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isInside(parent, child) {
  try {
    const relation = relative(parent, child)
    return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
  } catch {
    return false
  }
}

/** R3 frozen enum: manager|implementer|verifier|other. */
export function roleKindOf(roleName) {
  const name = typeof roleName === 'string' ? roleName.trim() : ''
  if (name === '' || name === '(unset)') return 'other'
  if (ROLE_MANAGER_RE.test(name)) return 'manager'
  if (ROLE_VERIFIER_RE.test(name)) return 'verifier'
  return 'implementer'
}

/** R3 frozen enum: captain|worker|readonly|reviewer|other (never a full preset name). */
export function presetCategoryOf(agentPreset, roleName) {
  const role = typeof roleName === 'string' ? roleName.trim().toLowerCase() : ''
  const roleKind = roleKindOf(roleName)
  if (roleKind === 'manager' || role === 'captain') return 'captain'
  if (/^verify/i.test(role)) return 'reviewer'
  if (/^cr(-|$)/i.test(role)) return 'readonly'
  const preset = typeof agentPreset === 'string' ? agentPreset.trim().toLowerCase() : ''
  if (preset === 'captain') return 'captain'
  if (WORKER_PRESETS.has(preset)) return 'worker'
  return 'other'
}

/** R3 frozen enum: captain|member|reviewer|infra|unknown (lead -> captain). */
export function teamKindOf(roleName, membershipRole) {
  if (membershipRole === 'lead') return 'captain'
  const name = typeof roleName === 'string' ? roleName.trim() : ''
  if (name !== '' && name !== '(unset)') {
    if (ROLE_VERIFIER_RE.test(name)) return 'reviewer'
    if (ROLE_INFRA_RE.test(name)) return 'infra'
    if (ROLE_MANAGER_RE.test(name)) return 'captain'
    return 'member'
  }
  return membershipRole === undefined || membershipRole === null ? 'unknown' : 'member'
}

// ---------------------------------------------------------------------------
// Input readers (read-only, fail-open)
// ---------------------------------------------------------------------------

export function readPeersFile(workspaceDir) {
  const file = join(workspaceDir, PEERS_RELATIVE)
  if (!existsSync(file)) return { file, exists: false, peers: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { file, exists: true, peers: Array.isArray(parsed?.peers) ? parsed.peers : [] }
  } catch {
    return { file, exists: true, peers: [], error: 'PEERS.json parse failed' }
  }
}

export function readRootName(workspaceDir) {
  try {
    const value = readFileSync(join(workspaceDir, 'team', 'pipe2', 'ROOT_NAME'), 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/** Read pipe2 bridge routes (three-layer reachability: alias + inbox + route). */
export function readBridgeRoutes(profileDir, { bridgeConfigFile } = {}) {
  if (typeof bridgeConfigFile === 'string' && bridgeConfigFile.trim() !== '') return parseBridgeRoutesFile(bridgeConfigFile.trim())
  const candidates = []
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    const legacyPipe2Name = 'dsh-pipe2' + '-bridge'
  candidates.push(join(profileDir, 'node_modules', '@local', legacyPipe2Name, 'cordis.patch.yml'))
    candidates.push(join(profileDir, 'node_modules', legacyPipe2Name, 'cordis.patch.yml'))
  }
  for (const candidate of candidates) if (existsSync(candidate)) return parseBridgeRoutesFile(candidate)
  return { pipes: new Set(), sessions: new Set(), source: null }
}

function parseBridgeRoutesFile(file) {
  const pipes = new Set()
  const sessions = new Set()
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { pipes, sessions, source: file, parsed: false } }
  const routeRe = /-\s*pipe:\s*['"]?([a-z0-9-]+)['"]?[\s\S]{0,240}?session:\s*['"]?(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
  let match
  while ((match = routeRe.exec(text)) !== null) {
    pipes.add(String(match[1]).toLowerCase())
    sessions.add(String(match[2]).toLowerCase())
  }
  return { pipes, sessions, source: file, parsed: true }
}

export function resolveProfileDir({ profileDir, env = process.env } = {}) {
  for (const candidate of [profileDir, env.DSH_PROFILE_DIR]) {
    const value = normalizePath(candidate)
    if (value !== null) return value
  }
  const home = env.DSH_HOME ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), '.dsh')
  return join(home, 'profiles', normalizePath(env.DSH_PROFILE) ?? 'web')
}

function latestActivityAt(pipe2Dir, alias) {
  let newest = null
  for (const dir of [join(pipe2Dir, 'inbox', alias), join(pipe2Dir, 'ack', alias)]) {
    try {
      for (const name of readdirSync(dir)) {
        try {
          const mtime = statSync(join(dir, name)).mtimeMs
          if (newest === null || mtime > newest) newest = mtime
        } catch { /* skip */ }
      }
    } catch { /* missing dir */ }
  }
  try {
    const seenFile = join(pipe2Dir, '.bridge-seen-' + alias + '.json')
    if (existsSync(seenFile)) {
      const mtime = statSync(seenFile).mtimeMs
      if (newest === null || mtime > newest) newest = mtime
    }
  } catch { /* ignore */ }
  return newest
}

function bucketFor(at, now) {
  if (!Number.isFinite(at)) return 'unknown'
  const age = Math.max(0, now - at)
  if (age < 5 * 60_000) return '<5m'
  if (age < 60 * 60_000) return '1h'
  if (age < 24 * 60 * 60_000) return '24h'
  return 'older'
}

function normalizePeers(peers) {
  const raw = Array.isArray(peers) ? peers : (Array.isArray(peers?.peers) ? peers.peers : [])
  return raw
    .filter(peer => peer !== null && typeof peer === 'object')
    .map(peer => ({
      alias: typeof peer.alias === 'string' ? peer.alias.trim().toLowerCase() : null,
      sessionId: typeof peer.session === 'string' && SESSION_ID_RE.test(peer.session.trim()) ? peer.session.trim() : null,
      roleName: typeof peer.role === 'string' ? peer.role : null,
      team: typeof peer.team === 'string' ? peer.team : null,
      root: typeof peer.root === 'string' ? peer.root : null,
      status: typeof peer.status === 'string' ? peer.status.toLowerCase() : 'unknown',
      kind: typeof peer.kind === 'string' ? peer.kind : null,
    }))
}

function normalizeLiveAgents(liveAgents) {
  const out = []
  for (const raw of Array.isArray(liveAgents) ? liveAgents : []) {
    if (raw === null || typeof raw !== 'object') continue
    const sessionId = typeof raw.session?.id === 'string' ? raw.session.id
      : (typeof raw.id === 'string' ? raw.id : (typeof raw.sessionId === 'string' ? raw.sessionId : null))
    if (sessionId === null) continue
    const liveStatus = typeof raw.status === 'string' ? raw.status : (typeof raw.phase === 'string' ? raw.phase : null)
    const role = typeof raw.role === 'string' ? raw.role : null
    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim()
      : (typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName.trim() : null)
    out.push({ sessionId, liveStatus, role, name })
  }
  return out
}

function archiveIds(workspaceRegistry) {
  return safeCall(() => {
    if (Array.isArray(workspaceRegistry?.archivedSessionIds)) return workspaceRegistry.archivedSessionIds
    if (Array.isArray(workspaceRegistry?.global?.archivedSessionIds)) return workspaceRegistry.global.archivedSessionIds
    const list = typeof workspaceRegistry?.list === 'function' ? workspaceRegistry.list() : workspaceRegistry
    return (Array.isArray(list) ? list : []).flatMap(workspace => Array.isArray(workspace?.archivedSessionIds) ? workspace.archivedSessionIds : [])
  }, []).filter(value => typeof value === 'string')
}

// ---------------------------------------------------------------------------
// buildNetworkInfo
// ---------------------------------------------------------------------------

/**
 * @param {{db?: object, peers?: Array|object, liveAgents?: Array, workspaceRegistry?: object,
 *   agentTeam?: object, config?: object, section?: string, now?: Date|number,
 *   workspaceDir?: string|null, networkAvailable?: boolean|null, profileDir?: string,
 *   audit?: Function}} [options]
 */
export function buildNetworkInfo({
  db,
  peers,
  liveAgents,
  workspaceRegistry,
  agentTeam,
  config = {},
  section = 'all',
  now = new Date(),
  workspaceDir = null,
  networkAvailable = null,
  profileDir,
  audit,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now()
  const env = config?.env ?? process.env
  const workspace = normalizePath(workspaceDir)
  const workspaceStrict = workspace !== null
  const pitfalls = buildPitfalls({ file: config?.pitfallsFile, probe: true, env })

  // C3/G10b: a workspace without team/pipe2/PEERS.json has no local network.
  // V4 zero-config fallback: when enabled, a fresh workspace falls back to the
  // host-wide session registry (live sessions + network DB) instead of returning
  // network:null on first use. PEERS.json remains the strict membership source
  // when it exists, and set globalFallback:false to restore workspace-only privacy.
  const peersFile = workspaceStrict ? readPeersFile(workspace) : null
  const fallbackToGlobal = workspaceStrict && config?.globalFallback === true && peersFile.exists === false
  const strict = workspaceStrict && !fallbackToGlobal
  const peersExist = strict ? (networkAvailable === false ? false : peersFile.exists) : null
  if (strict && peersExist === false) {
    return narrowSection({
      schemaVersion: NETWORK_INFO_SCHEMA_VERSION,
      generatedAt: new Date(effectiveNow).toISOString(),
      network: null,
      hint: NO_NETWORK_HINT,
      sessions: [],
      meetings: [],
      pitfalls,
    }, section)
  }

  if (db !== undefined && db !== null) useDb(db)
  const effectivePeers = strict
    ? ((Array.isArray(peers) && peers.length > 0) ? normalizePeers(peers) : normalizePeers(peersFile.peers))
    : normalizePeers(peers)
  const routes = readBridgeRoutes(resolveProfileDir({ profileDir, env }), { bridgeConfigFile: config?.bridgeConfigFile })
  const live = normalizeLiveAgents(liveAgents)
  const liveBySession = new Map(live.map(entry => [entry.sessionId, entry]))
  const archived = new Set(archiveIds(workspaceRegistry))
  const teamMembers = Array.isArray(agentTeam?.members) ? agentTeam.members : (Array.isArray(agentTeam) ? agentTeam : [])
  const teamBySession = new Map()
  for (const member of teamMembers) {
    if (member === null || typeof member !== 'object') continue
    const id = typeof member.id === 'string' ? member.id : (typeof member.sessionId === 'string' ? member.sessionId : null)
    if (id === null) continue
    teamBySession.set(id, { name: typeof member.name === 'string' ? member.name : null, role: member.role === 'lead' ? 'lead' : 'member' })
  }
  const dbSessions = db !== undefined && db !== null ? safeCall(() => listSessions(), []) : []
  const dbAliases = db !== undefined && db !== null ? safeCall(() => listAliases(), []) : []
  const dbAliasesBySession = new Map()
  for (const row of dbAliases) {
    if (typeof row?.session_id !== 'string' || typeof row?.alias !== 'string') continue
    const list = dbAliasesBySession.get(row.session_id) ?? []
    list.push(row.alias)
    dbAliasesBySession.set(row.session_id, list)
  }
  const dbBySession = new Map()
  for (const raw of dbSessions) {
    if (raw !== null && typeof raw === 'object' && typeof raw.session_id === 'string') dbBySession.set(raw.session_id, raw)
  }

  const profileRaw = normalizePath(config?.profile) ?? normalizePath(env.DSH_PROFILE) ?? 'unknown'
  const rootNames = [...new Set(effectivePeers.map(peer => peer.root).filter(value => typeof value === 'string' && value !== ''))]
  if (strict) {
    const rootFile = readRootName(workspace)
    if (rootFile !== null) rootNames.push(rootFile)
  }
  const rootHashes = [...new Set(rootNames)].map(root => hashShort(root, 8)).sort()
  const pipe2Dir = strict ? join(workspace, 'team', 'pipe2') : null

  const ids = new Set()
  if (strict) {
    for (const peer of effectivePeers) if (peer.sessionId !== null) ids.add(peer.sessionId)
  } else {
    for (const row of dbSessions) if (typeof row?.session_id === 'string') ids.add(row.session_id)
    for (const peer of effectivePeers) if (peer.sessionId !== null) ids.add(peer.sessionId)
    for (const entry of live) ids.add(entry.sessionId)
    for (const id of teamBySession.keys()) ids.add(id)
    const workspaces = safeCall(() => (typeof workspaceRegistry?.list === 'function' ? workspaceRegistry.list() : workspaceRegistry), [])
    for (const item of Array.isArray(workspaces) ? workspaces : []) {
      if (Array.isArray(item?.sessionIds)) for (const id of item.sessionIds) if (typeof id === 'string') ids.add(id)
    }
  }

  const sessions = []
  for (const sessionId of ids) {
    const dbRow = dbBySession.get(sessionId)
    const sessionPeers = effectivePeers.filter(peer => peer.sessionId === sessionId)
    const member = teamBySession.get(sessionId)
    const liveEntry = liveBySession.get(sessionId)
    const peer = sessionPeers.find(entry => entry.alias !== null && entry.status === 'active') ?? sessionPeers[0]
    const aliases = new Set()
    for (const entry of sessionPeers) if (entry.alias !== null) aliases.add(entry.alias)
    for (const alias of dbAliasesBySession.get(sessionId) ?? []) aliases.add(alias)
    const roleName = dbRow?.role_name ?? peer?.roleName ?? member?.role ?? '(unset)'
    const roleKind = roleKindOf(roleName)
    const displayName = dbRow?.display_name ?? peer?.alias ?? member?.name ?? null
    let availability
    if (archived.has(sessionId)) availability = 'archived'
    else if (liveEntry !== undefined) availability = liveEntry.liveStatus === 'running' ? 'running' : 'idle'
    else if (strict && peer !== undefined) availability = peer.status === 'active' ? 'idle' : 'inactive'
    else availability = 'inactive'
    let lastSeenBucket = 'unknown'
    if (dbRow !== undefined && Number.isFinite(dbRow.last_seen)) lastSeenBucket = bucketFor(dbRow.last_seen, effectiveNow)
    if (lastSeenBucket === 'unknown' && strict && peer?.alias != null) {
      const activity = latestActivityAt(pipe2Dir, peer.alias)
      if (activity !== null) lastSeenBucket = bucketFor(activity, effectiveNow)
    }

    let contact
    if (strict) {
      const peersLayer = peer !== undefined && peer.alias !== null && peer.status === 'active'
      const inboxLayer = peer?.alias != null && existsSync(join(pipe2Dir, 'inbox', peer.alias))
      const routeLayer = peer?.alias != null && (routes.pipes.has(peer.alias) || routes.sessions.has(sessionId))
      const failed = !peersLayer ? 'peers' : (!inboxLayer ? 'inbox' : (!routeLayer ? 'route' : null))
      contact = failed === null
        ? { routable: true, via: 'alias', reason: null, reachable: true }
        : (sessionId !== null && sessionId !== ''
          ? { routable: false, via: 'session-id', reason: failed, reachable: true }
          : { routable: false, via: 'none', reason: 'unknown', reachable: false })
    } else {
      const aliasActive = peer !== undefined && peer.alias !== null && peer.status === 'active'
      const hasLive = liveBySession.has(sessionId)
      contact = aliasActive
        ? { routable: true, via: 'alias', reason: null, reachable: true }
        : hasLive
          ? { routable: true, via: 'session-id', reason: null, reachable: true }
          : { routable: false, via: 'session-id', reason: 'peers', reachable: true }
    }

    const teamRole = member?.role ?? (peer?.team ? (roleKind === 'manager' ? 'lead' : 'member') : null)
    const team = teamRole === null
      ? null
      : { kind: teamKindOf(roleName, teamRole === 'lead' ? 'lead' : 'member') }

    sessions.push({
      sessionId,
      shortId: dbRow?.short_id ?? sessionId.replace(/^session-/, '').slice(0, 8),
      displayName,
      aliases: [...aliases].filter(alias => typeof alias === 'string').sort(),
      roleName: typeof roleName === 'string' && roleName !== '' ? roleName : '(unset)',
      roleKind,
      presetCategory: presetCategoryOf(dbRow?.agent_preset, roleName),
      availability,
      team,
      contact,
      lastSeenBucket,
    })
  }
  sessions.sort((left, right) => {
    const rank = value => ({ running: 0, idle: 1, inactive: 2, archived: 3 })[value] ?? 9
    return rank(left.availability) - rank(right.availability) || left.sessionId.localeCompare(right.sessionId)
  })

  const active = sessions.filter(session => session.availability === 'running').length
  const network = {
    id: 'snv1-' + hashShort([profileRaw, ...rootHashes].join('|')),
    profileHash: hashShort(profileRaw, 12),
    rootHashes,
    total: sessions.length,
    active,
    stale: sessions.length - active,
  }

  let meetings = []
  if (db !== undefined && db !== null) {
    meetings = safeCall(() => listMeetings(), [])
      .filter(row => {
        if (strict !== true) return true
        if (row.dir_path === null || row.dir_path === undefined) return true
        return isInside(workspace, row.dir_path)
      })
      .map(row => ({ meetingId: row.meeting_id, status: row.status, convener: row.convener ?? null, participants: Number(row.participants ?? 0) }))
  }

  const payload = {
    schemaVersion: NETWORK_INFO_SCHEMA_VERSION,
    generatedAt: new Date(effectiveNow).toISOString(),
    network,
    sessions,
    meetings,
    pitfalls,
  }
  const sanitized = sanitizeForOutput(payload)
  if (sanitized.redactedCount > 0) {
    safeCall(() => audit?.({
      action: 'network_info.redact',
      target: 'network_info',
      result: 'redacted',
      meta: { count: sanitized.redactedCount, patterns: sanitized.patterns },
    }), undefined)
  }
  return narrowSection(sanitized.value, section)
}

function narrowSection(payload, section) {
  const base = {
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    ...(payload.network === null ? { network: null, hint: payload.hint } : { network: payload.network }),
  }
  if (section === 'sessions') return { ...base, sessions: payload.sessions }
  if (section === 'meetings') return { ...base, meetings: payload.meetings }
  if (section === 'pitfalls') return { ...base, pitfalls: payload.pitfalls }
  if (section === 'network') return base
  return payload
}

/** Walk a value and replace path/secret-looking substrings in string values with `[redacted]`. */
export function sanitizeForOutput(obj, { audit } = {}) {
  const patterns = new Set()
  let redactedCount = 0
  const walk = value => {
    if (typeof value === 'string') {
      let text = value
      for (const pattern of ALL_PATTERNS) {
        text = text.replace(pattern.re, () => {
          patterns.add(pattern.name)
          redactedCount += 1
          return '[redacted]'
        })
      }
      return text
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, nested] of Object.entries(value)) out[key] = walk(nested)
      return out
    }
    return value
  }
  const cleaned = walk(obj)
  const result = { value: cleaned, redactedCount, patterns: [...patterns].sort() }
  if (redactedCount > 0) {
    safeCall(() => audit?.({
      action: 'sanitize',
      target: 'network_info',
      result: 'redacted',
      meta: { count: redactedCount, patterns: result.patterns },
    }), undefined)
  }
  return result
}

/** Persist (or normalize) the metadata-only audit row for a network_info call. */
export function auditNetworkInfoCall({ db, caller = null, target = 'network_info', resultHash, fieldCount, section = 'all', result = 'ok', now = new Date(), displayName = null, roleName = null } = {}) {
  if (db !== undefined && db !== null) useDb(db)
  const at = now instanceof Date ? now.getTime() : Number(now)
  const meta = {
    resultHash: typeof resultHash === 'string' ? resultHash : null,
    fieldCount: Number.isFinite(fieldCount) ? Math.trunc(fieldCount) : null,
    section,
  }
  // INTERFACES §5.0: actor={sessionId, displayName, roleName?}; alias is not an audit anchor.
  const actor = { sessionId: caller, displayName, roleName }
  const record = { at: Number.isFinite(at) ? at : Date.now(), actor, action: 'network_info', target, result, meta }
  if (db === undefined || db === null) return { ...record, persisted: false }
  try {
    const inserted = insertAudit({ at: record.at, actor: record.actor, action: record.action, target: record.target, result: record.result, meta })
    return { ...record, id: inserted.id, persisted: true }
  } catch (error) {
    return { ...record, persisted: false, error: String(error?.code ?? error?.message ?? error) }
  }
}

/** Hash a response payload for audit correlation. */
export function hashResponse(payload) {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}
