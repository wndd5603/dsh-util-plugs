/**
 * P1-3 · throttled stale-session / legacy-alias state sweep.
 *
 * There is no new timer: this rides the existing `agent/pre-step` waterfall as
 * a second listener next to the injector. Every pre-step is cheap (one settings
 * read) and only one sweep runs per `staleSweep.intervalMinutes` (default 10)
 * across all sessions sharing the SQLite registry.
 *
 * State transitions are soft only:
 * - `listStaleSessions` -> `markSessionStale` (status only; no DELETE, no
 *   last_seen rewrite);
 * - `legacy` aliases whose owning session is inactive > aliasRetireAfterHours
 *   (default 72h) -> `retired` (row/session_id preserved; resolveAlias keeps
 *   resolving it, matching the current product behaviour).
 *
 * Live sessions supplied by the host agent service are excluded from both
 * transitions, so a session that is active but momentarily quiet is never
 * mislabelled. Any failure in the sweep is logged and swallowed: the
 * downstream pre-step decision is returned untouched.
 */

export const STALE_SWEEP_NAME = 'session-network-stale-sweep'

const DEFAULT_INTERVAL_MINUTES = 10
const DEFAULT_STALE_AFTER_MINUTES = 60
const DEFAULT_ALIAS_RETIRE_AFTER_HOURS = 72

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function toMs(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Best-effort session id of the pre-step payload (protects the current step). */
function sessionIdOfPreStep(value) {
  if (value === null || typeof value !== 'object') return null
  for (const candidate of [
    value.agent?.session?.id,
    value.agent?.sessionId,
    value.agent?.id,
    value.session?.id,
    value.sessionId,
  ]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/**
 * Normalize `config.staleSweep`; missing/malformed values fall back to the
 * documented defaults. Only enabled/intervalMinutes are required knobs, but the
 * two thresholds are exposed so deployments can tune without code changes.
 */
export function normalizeStaleSweepConfig(config) {
  const raw = config?.staleSweep
  const section = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const intervalMinutes = boundedNumber(section.intervalMinutes, DEFAULT_INTERVAL_MINUTES, 1, 1440)
  const staleAfterMinutes = boundedNumber(section.staleAfterMinutes, DEFAULT_STALE_AFTER_MINUTES, 1, 7 * 24 * 60)
  const aliasRetireAfterHours = boundedNumber(section.aliasRetireAfterHours, DEFAULT_ALIAS_RETIRE_AFTER_HOURS, 1, 365 * 24)
  return {
    enabled: section.enabled !== false && section.enabled !== 'false',
    intervalMinutes,
    intervalMs: intervalMinutes * 60_000,
    staleAfterMinutes,
    staleAfterMs: staleAfterMinutes * 60_000,
    aliasRetireAfterHours,
    aliasRetireAfterMs: aliasRetireAfterHours * 60 * 60_000,
  }
}

/** Extract live session ids from the host agents.list() shape (never throws). */
export function liveSessionIdsOf(agents) {
  const ids = new Set()
  for (const raw of Array.isArray(agents) ? agents : []) {
    if (typeof raw === 'string') {
      if (raw !== '') ids.add(raw)
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    const sessionId = typeof raw.session?.id === 'string'
      ? raw.session.id
      : (typeof raw.id === 'string' ? raw.id : (typeof raw.sessionId === 'string' ? raw.sessionId : null))
    if (sessionId !== null && sessionId !== '') ids.add(sessionId)
  }
  return ids
}

/**
 * @param {{
 *   db: object, dataDir?: string|null, handle?: object|null,
 *   getConfig?: () => object|undefined, getLiveSessionIds?: () => Iterable<string>|undefined,
 *   now?: () => Date|number|string, logger?: object, audit?: Function,
 * }} deps
 */
export function createStaleSweeper(deps = {}) {
  const database = deps.db
  const dataDir = typeof deps.dataDir === 'string' && deps.dataDir !== '' ? deps.dataDir : null
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => undefined
  const getLiveSessionIds = typeof deps.getLiveSessionIds === 'function' ? deps.getLiveSessionIds : () => undefined
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const logger = deps.logger
  const audit = typeof deps.audit === 'function' ? deps.audit : undefined
  let connection = deps.handle ?? null
  let ownsConnection = false
  let disposed = false

  const warn = (message, error) => {
    try {
      if (typeof logger?.warn === 'function') logger.warn('[session-network] ' + message, error)
      else if (typeof logger?.info === 'function') logger.info('[session-network] ' + message, error)
    } catch { /* logging must never break the sweep */ }
  }

  const ensureDb = () => {
    if (disposed) return null
    if (connection !== null && connection !== undefined) {
      database?.useDb?.(connection)
      return connection
    }
    if (dataDir === null || typeof database?.openDb !== 'function') return null
    connection = database.openDb({ dataDir })
    ownsConnection = true
    database.useDb?.(connection)
    return connection
  }

  const readConfig = () => {
    try { return normalizeStaleSweepConfig(getConfig()) } catch { return normalizeStaleSweepConfig(undefined) }
  }

  const safeLiveSessionIds = () => {
    try {
      const value = getLiveSessionIds()
      return value instanceof Set ? new Set(value) : liveSessionIdsOf(value)
    } catch (error) {
      warn('stale sweep: live-agent probe failed (fail-open)', error)
      return new Set()
    }
  }

  /**
   * Run one state-migration pass. Never throws for sweep/DB failures; callers
   * get `{ok:false}` instead so the pre-step can continue.
   * @param {{protectSessionIds?: string[]}} [options]
   */
  async function sweep({ protectSessionIds = [] } = {}) {
    const config = readConfig()
    if (!config.enabled) return { ok: true, ran: false, reason: 'disabled', config }
    try {
      if (ensureDb() === null) return { ok: false, ran: false, reason: 'no-db' }
      if (typeof database.claimStaleSweep !== 'function'
        || typeof database.listStaleSessions !== 'function'
        || typeof database.markSessionStale !== 'function') {
        return { ok: false, ran: false, reason: 'db-api-unavailable' }
      }
      const nowMs = toMs(now())
      const claim = database.claimStaleSweep({ now: nowMs, intervalMs: config.intervalMs })
      if (claim?.claimed !== true) {
        return { ok: true, ran: false, reason: 'throttled', lastSweepAt: claim?.lastSweepAt ?? null, nextAt: claim?.nextAt ?? null }
      }

      const live = safeLiveSessionIds()
      for (const id of Array.isArray(protectSessionIds) ? protectSessionIds : []) {
        if (typeof id === 'string' && id !== '') live.add(id)
      }
      let candidates = []
      try {
        candidates = database.listStaleSessions(nowMs, config.staleAfterMs)
      } catch (error) {
        warn('stale sweep: listStaleSessions failed (fail-open)', error)
      }
      const rows = (Array.isArray(candidates) ? candidates : [])
        .filter(row => row !== null && typeof row === 'object' && typeof row.session_id === 'string')
        .filter(row => !live.has(row.session_id))
      let staleMarked = 0
      for (const row of rows) {
        try {
          if (database.markSessionStale(row.session_id, nowMs) === true) staleMarked += 1
        } catch (error) {
          warn('stale sweep: markSessionStale failed for one session (fail-open)', error)
        }
      }

      let aliases = { count: 0, retired: [], scanned: 0 }
      if (typeof database.retireStaleLegacyAliases === 'function') {
        try {
          aliases = database.retireStaleLegacyAliases({
            now: nowMs,
            olderThanMs: config.aliasRetireAfterMs,
            protectSessionIds: [...live],
          })
        } catch (error) {
          warn('stale sweep: retireStaleLegacyAliases failed (fail-open)', error)
        }
      }

      const result = {
        ok: true,
        ran: true,
        at: nowMs,
        staleCandidates: rows.length,
        staleMarked,
        aliasesRetired: Number(aliases?.count) || 0,
        protectedSessions: live.size,
        intervalMinutes: config.intervalMinutes,
      }
      try {
        audit?.({
          action: 'stale_sweep',
          result: 'ok',
          staleCandidates: result.staleCandidates,
          staleMarked: result.staleMarked,
          aliasesRetired: result.aliasesRetired,
          protectedSessions: result.protectedSessions,
        })
      } catch { /* audit is best-effort */ }
      return result
    } catch (error) {
      warn('stale sweep failed (fail-open)', error)
      return { ok: false, ran: false, reason: 'error' }
    }
  }

  /**
   * `agent/pre-step` listener: run the downstream waterfall first, then sweep
   * without changing the decision. Sweep errors are already swallowed.
   */
  async function handler(first, next) {
    const decision = typeof next === 'function' ? await next() : first
    try {
      const currentSessionId = sessionIdOfPreStep(first)
      await sweep(currentSessionId === null ? undefined : { protectSessionIds: [currentSessionId] })
    } catch (error) {
      warn('stale sweep handler failed (fail-open)', error)
    }
    return decision
  }

  function dispose() {
    disposed = true
    if (ownsConnection && connection !== null && typeof database?.closeDb === 'function') {
      try { database.closeDb(connection) } catch { /* best-effort */ }
    }
    connection = null
    ownsConnection = false
  }

  return { name: STALE_SWEEP_NAME, handler, sweep, dispose }
}
