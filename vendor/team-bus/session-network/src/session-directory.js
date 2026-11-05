/**
 * Host-native session directory (task-106).
 *
 * The directory is a thin, least-privilege view over the existing session-network
 * SQLite registry (`<profile>/data/session-network/network.db`). It does not read
 * or write PEERS.json, workspace files, ACLs, or any profile configuration.
 *
 * A session may only upsert/remove its own alias. Reads are joined-only: an
 * alias whose session is no longer live is stale and is excluded from
 * listJoined(), but remains resolvable for diagnostics until removed.
 */

const ALIAS_RE = /^[a-z][a-z0-9-]{0,15}$/u
const WILDCARDS = new Set(['*', 'all', 'everyone', 'any', 'broadcast', 'team'])

function normalizeAlias(value) {
  if (typeof value !== 'string') return null
  const alias = value.trim().toLowerCase()
  if (alias === '' || WILDCARDS.has(alias) || !ALIAS_RE.test(alias)) return null
  return alias
}

function safeCall(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * @param {{
 *   database: object,
 *   dataDir: string|null,
 *   agents?: () => object|undefined,
 *   logger?: object,
 *   initialDb?: object|null,
 * }} options
 */
export function createSessionDirectory({ database, dataDir = null, agents, logger, initialDb = null } = {}) {
  let handle = initialDb
  const agentService = () => {
    try {
      return typeof agents === 'function' ? agents() : agents
    } catch {
      return undefined
    }
  }
  const ensureDb = () => {
    if (handle !== null && handle !== undefined) return handle
    if (dataDir === null || typeof database?.openDb !== 'function') return undefined
    handle = safeCall(() => database.openDb({ dataDir }), undefined)
    if (handle !== undefined) database.useDb?.(handle)
    return handle
  }
  const withDb = (fn, fallback) => {
    const db = ensureDb()
    if (db === undefined) return fallback
    database.useDb?.(db)
    return safeCall(fn, fallback)
  }
  const liveAgent = sessionId => {
    const service = agentService()
    if (service === undefined || service === null) return undefined
    return safeCall(() => service.get?.(sessionId), undefined)
  }
  const displayNameOf = (row, agent) => {
    const fromAgent = agent?.session?.header?.displayName ?? agent?.displayName
    if (typeof fromAgent === 'string' && fromAgent.trim() !== '') return fromAgent.trim()
    if (typeof row?.display_name === 'string' && row.display_name.trim() !== '') return row.display_name.trim()
    return typeof row?.alias === 'string' ? row.alias : null
  }

  const service = {
    /** Resolve one joined alias to its session id; null when unknown. */
    resolve(aliasOrArgs) {
      const rawAlias = aliasOrArgs !== null && typeof aliasOrArgs === 'object' ? aliasOrArgs.alias : aliasOrArgs
      const normalized = normalizeAlias(rawAlias)
      if (normalized === null) return null
      const row = withDb(() => database.resolveAlias(normalized), undefined)
      if (row === undefined || row === null || typeof row.session_id !== 'string') return null
      const agent = liveAgent(row.session_id)
      return {
        alias: normalized,
        sessionId: row.session_id,
        displayName: displayNameOf(row, agent),
        status: typeof row.status === 'string' ? row.status : 'active',
        stale: agent === undefined,
      }
    },

    /** List only live, joined aliases; stale rows are counted but not returned. */
    listJoined({ includeStale = false } = {}) {
      const rows = withDb(() => database.listAliases(), [])
      const joined = []
      let staleCount = 0
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row === null || typeof row !== 'object' || typeof row.alias !== 'string' || typeof row.session_id !== 'string') continue
        if (row.status !== undefined && row.status !== 'active') continue
        const agent = liveAgent(row.session_id)
        if (agent === undefined) {
          staleCount += 1
          if (includeStale !== true) continue
        }
        joined.push({
          alias: row.alias,
          sessionId: row.session_id,
          displayName: displayNameOf(row, agent),
          roleName: typeof row.role_name === 'string' ? row.role_name : null,
          stale: agent === undefined,
        })
      }
      return joined.sort((a, b) => a.alias.localeCompare(b.alias))
    },

    /** Snapshot for message_bus_status / diagnostics. */
    status() {
      const joined = service.listJoined()
      return {
        source: 'host-registry',
        transport: 'sqlite-directory',
        joinedCount: joined.length,
        staleCount: withDb(() => {
          const rows = database.listAliases()
          let stale = 0
          for (const row of Array.isArray(rows) ? rows : []) {
            if (row?.status !== undefined && row.status !== 'active') continue
            if (typeof row?.session_id === 'string' && liveAgent(row.session_id) === undefined) stale += 1
          }
          return stale
        }, 0),
        joined,
      }
    },

    /**
     * Register/replace the caller's own alias. Only the caller may register
     * itself; there is no wildcard, no cross-session rename and no PEERS write.
     */
    upsert(aliasOrArgs, options = {}) {
      const request = aliasOrArgs !== null && typeof aliasOrArgs === 'object'
        ? { ...aliasOrArgs, ...options }
        : { ...options, alias: aliasOrArgs }
      const normalized = normalizeAlias(request.alias)
      if (normalized === null) {
        return { ok: false, code: 'ALIAS_INVALID', message: 'alias must be lowercase kebab (1-16 chars), no wildcard' }
      }
      const sid = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
      if (sid === '') return { ok: false, code: 'SESSION_INVALID', message: 'sessionId is required' }
      if (typeof request.callerSessionId !== 'string' || request.callerSessionId !== sid) {
        return { ok: false, code: 'ALIAS_FOREIGN_SESSION', message: 'a session may only register its own alias' }
      }
      const displayName = request.displayName ?? null
      const roleName = request.roleName ?? null
      const agent = liveAgent(sid)
      if (agent === undefined) return { ok: false, code: 'SESSION_GONE', message: 'caller session is not live' }
      return withDb(() => {
        try {
          if (typeof database.registerAliasGuarded === 'function') {
            if (typeof database.getSession === 'function' && database.getSession(sid) === undefined) {
              database.upsertSession?.({ sessionId: sid, displayName: displayName ?? alias, status: 'active' })
            }
            const result = database.registerAliasGuarded({
              alias: normalized,
              sessionId: sid,
              displayName,
              roleName,
              maxRenames: 2,
            })
            return { ...result, source: 'host-registry' }
          }
          const row = database.upsertAlias?.({ alias: normalized, sessionId: sid, roleName })
          return { ok: true, alias: normalized, sessionId: sid, row, source: 'host-registry' }
        } catch (error) {
          return {
            ok: false,
            code: typeof error?.code === 'string' ? error.code : 'ALIAS_WRITE_FAILED',
            message: String(error?.message ?? error),
          }
        }
      }, { ok: false, code: 'NO_DB', message: 'host directory database is unavailable' })
    },

    /** Remove the caller's own alias; foreign aliases are never touched. */
    remove(aliasOrArgs, options = {}) {
      const request = aliasOrArgs !== null && typeof aliasOrArgs === 'object'
        ? { ...aliasOrArgs, ...options }
        : { ...options, alias: aliasOrArgs }
      const normalized = normalizeAlias(request.alias)
      if (normalized === null) return { ok: false, code: 'ALIAS_INVALID' }
      const sid = typeof request.callerSessionId === 'string' ? request.callerSessionId.trim() : ''
      if (sid === '') return { ok: false, code: 'SESSION_INVALID' }
      return withDb(() => {
        try {
          const row = database.resolveAlias?.(normalized)
          if (row === undefined || row === null) return { ok: false, code: 'ALIAS_NOT_FOUND' }
          if (row.session_id !== sid) return { ok: false, code: 'ALIAS_FOREIGN_SESSION' }
          if (typeof database.removeAlias === 'function') {
            return { ok: database.removeAlias({ alias: normalized, sessionId: sid }), alias: normalized }
          }
          return { ok: false, code: 'NO_REMOVE_API' }
        } catch (error) {
          return { ok: false, code: 'ALIAS_REMOVE_FAILED', message: String(error?.message ?? error) }
        }
      }, { ok: false, code: 'NO_DB' })
    },
  }
  return Object.freeze(service)
}

export { normalizeAlias }
