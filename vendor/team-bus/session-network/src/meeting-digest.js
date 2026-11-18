/**
 * P0-2 · meeting deadline validation + read-only recall digest.
 *
 * The registry DB keeps the authoritative `meetings.deadline` column; decisions
 * and actions live in the per-meeting JSON sidecar (tools.js). This module has
 * no writes: `buildMeetingDigest` only reads `listMeetings()` and sidecars.
 *
 * Digest rules (see research notes §P0-2):
 * - deadline criterion: active meetings only (`open|r1|r2`) whose deadline is
 *   already past, or due within the 24h window;
 * - pending-actions criterion: any non-cancelled meeting (finalized meetings
 *   included, because actions are produced by meeting_finalize and must stay
 *   recallable until closed);
 * - finalized/cancelled meetings without pending actions never match.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MEETING_DIGEST_WINDOW_HOURS = 24
export const MEETING_DIGEST_DEFAULT_LIMIT = 50
export const MEETING_DIGEST_MAX_LIMIT = 200
export const MEETING_DIGEST_MAX_ACTIONS_PER_MEETING = 20

const ACTIVE_STATUSES = new Set(['open', 'r1', 'r2'])
const CLOSED_STATUSES = new Set(['final', 'finalized', 'cancelled'])
const ISO_DEADLINE_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Validate an optional `meeting_open.deadline` argument.
 * Accepts ISO dates (`YYYY-MM-DD`) and ISO date-times with optional seconds,
 * fraction and `Z`/offset. An empty value means "no deadline".
 * @param {unknown} value
 * @returns {{ok: true, deadline: null} | {ok: true, deadline: {ms: number, iso: string}} | {ok: false, code: string, message: string}}
 */
export function validateMeetingDeadline(value) {
  if (value === undefined || value === null) return { ok: true, deadline: null }
  if (typeof value !== 'string') {
    return {
      ok: false,
      code: 'MEETING_INVALID_DEADLINE',
      message: `deadline must be an ISO date/time string, got ${typeof value}`,
    }
  }
  const text = value.trim()
  if (text === '') return { ok: true, deadline: null }
  if (!ISO_DEADLINE_RE.test(text)) {
    return {
      ok: false,
      code: 'MEETING_INVALID_DEADLINE',
      message: `deadline is not an ISO date/time: ${JSON.stringify(value)}`,
    }
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      code: 'MEETING_INVALID_DEADLINE',
      message: `deadline is not a valid calendar date/time: ${JSON.stringify(value)}`,
    }
  }
  return { ok: true, deadline: { ms, iso: new Date(ms).toISOString() } }
}

/**
 * Normalize a digest `now` argument (ISO string, epoch ms, Date) to epoch ms.
 * @returns {number | null} null when the value is invalid.
 */
export function parseDigestNow(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return fallback
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Same sidecar naming algorithm as tools.js (sha256 suffix prevents collisions). */
export function meetingSidecarFile(meetingId) {
  const raw = String(meetingId)
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12)
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '_').slice(0, 48) || 'meeting'
  return `${safe}-${digest}.json`
}

function normalizeStore(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!Array.isArray(parsed.posts)) parsed.posts = []
  if (!Array.isArray(parsed.decisions)) parsed.decisions = []
  if (!Array.isArray(parsed.actions)) parsed.actions = []
  return parsed
}

/**
 * Read one meeting sidecar without writing. Mirrors tools.js: the canonical
 * filename wins, then a renamed-id fallback scans `<safe>-*.json` for a store
 * whose embedded `meetingId` matches exactly.
 * @returns {object | null}
 */
export function readMeetingSidecar(dataDir, meetingId) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '' || dataDir === ':memory:') return null
  const dir = join(dataDir, 'meetings')
  const file = join(dir, meetingSidecarFile(meetingId))
  if (existsSync(file)) {
    try { return normalizeStore(JSON.parse(readFileSync(file, 'utf8'))) } catch { return null }
  }
  const raw = String(meetingId)
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '_').slice(0, 48) || 'meeting'
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${safe}-`) || !name.endsWith('.json')) continue
      try {
        const parsed = normalizeStore(JSON.parse(readFileSync(join(dir, name), 'utf8')))
        if (parsed !== null && parsed.meetingId === raw) return parsed
      } catch { /* one corrupt sidecar must not hide the others */ }
    }
  } catch { /* directory unreadable */ }
  return null
}

/** Normalize sidecar actions to `{id,text,owner,status}` and keep pending rows. */
export function pendingActionsOf(store) {
  const entries = Array.isArray(store?.actions) ? store.actions : []
  const pending = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    let action
    if (typeof entry === 'string') {
      const text = entry.trim()
      if (text === '') continue
      action = { id: `A${index + 1}`, text, owner: null, status: 'pending' }
    } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const text = firstString(entry.text, entry.title, entry.description, entry.action)
      if (text === undefined) continue
      action = {
        id: firstString(entry.id) ?? `A${index + 1}`,
        text,
        owner: firstString(entry.owner, entry.assignee) ?? null,
        status: firstString(entry.status) ?? 'pending',
      }
    } else {
      continue
    }
    if (action.status.toLowerCase() === 'pending') pending.push(action)
  }
  return pending
}

/**
 * P1-6: update one sidecar action in place (status/owner/due). Returns a
 * normalized action or a coded error without mutating when the id is unknown.
 * The caller owns persistence; digest simply stops counting non-pending rows.
 */
export function updateMeetingActionInStore(store, { actionId, status, owner, due } = {}) {
  if (store === null || typeof store !== 'object' || !Array.isArray(store.actions)) {
    return { ok: false, code: 'MEETING_ACTION_NOT_FOUND', message: 'meeting has no actions' }
  }
  const id = firstString(actionId)
  if (id === undefined) return { ok: false, code: 'INVALID_ARGUMENT', message: 'actionId is required' }
  const normalizedStatus = status === undefined ? undefined : String(status).trim().toLowerCase()
  if (normalizedStatus !== undefined && !['pending', 'completed', 'closed', 'cancelled'].includes(normalizedStatus)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'status must be pending|completed|closed|cancelled' }
  }
  if (due !== undefined && due !== null) {
    if (typeof due !== 'string' || Number.isNaN(Date.parse(due))) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'due must be an ISO date/time' }
    }
  }
  for (let index = 0; index < store.actions.length; index += 1) {
    const entry = store.actions[index]
    const currentId = typeof entry === 'string' ? `A${index + 1}` : firstString(entry?.id) ?? `A${index + 1}`
    if (currentId !== id) continue
    const base = typeof entry === 'string'
      ? { id, text: entry.trim(), owner: null, status: 'pending' }
      : { ...entry, id: currentId }
    if (normalizedStatus !== undefined) base.status = normalizedStatus
    if (owner !== undefined) base.owner = typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null
    if (due !== undefined) base.due = due === null ? null : new Date(due).toISOString()
    store.actions[index] = base
    return { ok: true, action: base }
  }
  return { ok: false, code: 'MEETING_ACTION_NOT_FOUND', message: 'action not found: ' + id }
}

function normalizeStatus(status) {
  if (status === null || status === undefined) return null
  return status === 'final' ? 'finalized' : String(status)
}

function normalizeLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return MEETING_DIGEST_DEFAULT_LIMIT
  return Math.min(MEETING_DIGEST_MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
}

function emptyDigest(nowMs, { limit = MEETING_DIGEST_DEFAULT_LIMIT, windowHours = MEETING_DIGEST_WINDOW_HOURS } = {}) {
  return {
    ok: true,
    now: new Date(nowMs).toISOString(),
    windowHours,
    counts: {
      activeMeetings: 0,
      matched: 0,
      returned: 0,
      deadlineExpired: 0,
      deadlineSoon: 0,
      pendingActions: 0,
    },
    meetings: [],
    limit: normalizeLimit(limit),
    truncated: false,
  }
}

export { emptyDigest as emptyMeetingDigest }

/**
 * Build the read-only meeting recall digest.
 *
 * `db` must expose `listMeetings()` / `listMeetingParticipants(meetingId)` and
 * an already-bound shared connection (callers use `db.useDb(handle)`). When
 * `mineOnly` is true, only meetings where the caller is the convener or a
 * participant are considered (used by the pre-step reminder; the tool itself
 * is a global read-only view).
 *
 * @param {{db?: object, dataDir?: string|null, now?: number|string|Date, limit?: number, sessionId?: string|null, alias?: string|null, mineOnly?: boolean, windowHours?: number}} [options]
 */
export function buildMeetingDigest({
  db,
  dataDir = null,
  now = Date.now(),
  limit = MEETING_DIGEST_DEFAULT_LIMIT,
  sessionId = null,
  alias = null,
  mineOnly = false,
  windowHours = MEETING_DIGEST_WINDOW_HOURS,
} = {}) {
  const nowMs = parseDigestNow(now)
  if (nowMs === null) {
    return { ok: false, code: 'MEETING_INVALID_NOW', error: 'MEETING_INVALID_NOW: now must be an ISO date/time or epoch milliseconds' }
  }
  if (db === undefined || db === null || typeof db.listMeetings !== 'function') {
    return { ok: false, code: 'NO_DB', error: 'NO_DB: meeting registry is unavailable' }
  }
  const safeLimit = normalizeLimit(limit)
  const safeWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) >= 0
    ? Number(windowHours)
    : MEETING_DIGEST_WINDOW_HOURS
  const windowMs = safeWindowHours * 60 * 60 * 1000
  let rows
  try {
    rows = db.listMeetings()
  } catch (error) {
    return { ok: false, code: error?.code ?? 'MEETING_DIGEST_FAILED', error: String(error?.message ?? error) }
  }
  const source = Array.isArray(rows) ? rows : []
  const counts = {
    activeMeetings: 0,
    matched: 0,
    returned: 0,
    deadlineExpired: 0,
    deadlineSoon: 0,
    pendingActions: 0,
  }
  const matched = []
  for (const row of source) {
    if (row === null || typeof row !== 'object') continue
    const meetingId = firstString(row.meeting_id)
    if (meetingId === undefined) continue
    const status = normalizeStatus(row.status)
    const active = status !== null && ACTIVE_STATUSES.has(status)
    if (active) counts.activeMeetings += 1
    const rawDeadline = Number(row.deadline)
    const deadlineMs = Number.isFinite(rawDeadline) && rawDeadline > 0 ? rawDeadline : null
    let deadlineState = null
    if (active && deadlineMs !== null) {
      if (deadlineMs < nowMs) deadlineState = 'expired'
      else if (deadlineMs <= nowMs + windowMs) deadlineState = 'due_soon'
    }
    const store = readMeetingSidecar(dataDir, meetingId)
    const pending = pendingActionsOf(store)
    const actionsHit = status !== 'cancelled' && pending.length > 0
    const deadlineHit = deadlineState === 'expired' || deadlineState === 'due_soon'
    if (!deadlineHit && !actionsHit) continue
    if (mineOnly) {
      let mine = false
      try {
        const participants = typeof db.listMeetingParticipants === 'function'
          ? db.listMeetingParticipants(meetingId)
          : []
        mine = (Array.isArray(participants) ? participants : [])
          .some(participant => participant?.session_id === sessionId)
      } catch { mine = false }
      if (!mine && typeof sessionId === 'string' && sessionId !== '' && store?.convenerSession === sessionId) mine = true
      if (!mine && typeof alias === 'string' && alias !== '') {
        mine = store?.convener === alias || row.convener === alias
      }
      if (!mine) continue
    }
    counts.matched += 1
    if (deadlineState === 'expired') counts.deadlineExpired += 1
    if (deadlineState === 'due_soon') counts.deadlineSoon += 1
    counts.pendingActions += pending.length
    matched.push({
      meetingId,
      title: row.title ?? null,
      status,
      convener: row.convener ?? null,
      deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
      deadlineState,
      deadlineInHours: deadlineMs === null ? null : Math.round(((deadlineMs - nowMs) / 3_600_000) * 100) / 100,
      pendingActionCount: pending.length,
      pendingActions: pending.slice(0, MEETING_DIGEST_MAX_ACTIONS_PER_MEETING),
      participantCount: Number.isFinite(Number(row.participants)) ? Number(row.participants) : 0,
      reasons: [
        ...(deadlineState === 'expired' ? ['deadline_expired'] : []),
        ...(deadlineState === 'due_soon' ? ['deadline_soon'] : []),
        ...(actionsHit ? ['pending_actions'] : []),
      ],
      sortAt: row.updated_at ?? row.created_at ?? 0,
    })
  }
  matched.sort((left, right) => {
    const rank = item => (item.deadlineState === 'expired' ? 0 : item.deadlineState === 'due_soon' ? 1 : 2)
    const byRank = rank(left) - rank(right)
    if (byRank !== 0) return byRank
    const leftDeadline = left.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(left.deadline)
    const rightDeadline = right.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(right.deadline)
    if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline
    return Number(right.sortAt) - Number(left.sortAt)
  })
  const meetings = matched.slice(0, safeLimit).map(({ sortAt, ...item }) => item)
  counts.returned = meetings.length
  return {
    ok: true,
    now: new Date(nowMs).toISOString(),
    windowHours: safeWindowHours,
    counts,
    meetings,
    limit: safeLimit,
    truncated: counts.matched > meetings.length,
  }
}
