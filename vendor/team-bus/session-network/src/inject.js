/**
 * First-turn pointer injector for dsh-session-network.
 *
 * Contract: INTERFACES_v1 §4 (injector) and DESIGN_v1 §3 (injection contract).
 * The injector is registered on `agent/pre-step`. Direct registration works:
 *
 *   const injector = createInjector({ getConfig, getState, audit, logger, now })
 *   ctx.on('agent/pre-step', injector.handler)
 *
 * The handler also accepts an already-resolved decision (`handler(decision, next)`)
 * so a host that calls `next()` itself can delegate only the injection step. In
 * that degraded form there is no agent/session to inspect: the handler then only
 * sees the current step's messages and will NOT inject (fail-open, audited as
 * `skipped/visibility-unavailable`) rather than risk injecting on every turn.
 *
 * Visibility is durable and turn/step-independent: scan committed `user/message`
 * session events for `source.kind === 'session-network-brief'`. This survives
 * resume, compaction (complete log), HMR/reload and shutdown. Forked sessions
 * inherit the marker prefix and therefore count as already injected.
 *
 * Fail-open: every failure after `next()` resolves is caught, logged and audited,
 * and the untouched downstream decision is returned. `next()` failures are not
 * ours and are rethrown.
 *
 * @module @local/dsh-session-network/inject
 */
import { createHash, randomUUID } from 'node:crypto'

export const INJECTOR_NAME = 'session-network'
export const BRIEF_SOURCE_KIND = 'session-network-brief'
export const BRIEF_TEMPLATE_VERSION = 1
export const MAX_POINTER_LINES = 2
/** Conservative character bound for the DESIGN ≤120-token pointer budget. */
export const MAX_POINTER_CHARS = 240
export const MAX_POINTER_TOKENS = 120

const POINTER_LINE_1 = '本机交流网可用。'
const POINTER_LINE_2 = '查询：`network_info()`；初始化：`skill team-bootstrap`；忽略不影响当前工作。'

/** True when `value` is a plain non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Recursively freeze a value so the injected message cannot be mutated later. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** SHA-256 hex of one pointer text (audit stores hashes, never the content). */
export function hashPointer(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * Normalize pointer text to at most {@link MAX_POINTER_LINES} non-empty lines and
 * {@link MAX_POINTER_CHARS} characters. Exported for contract tests.
 * @param {string} text - candidate pointer.
 * @returns {string} normalized pointer.
 */
export function normalizePointerText(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, MAX_POINTER_LINES)
  let normalized = lines.join('\n')
  if (normalized.length > MAX_POINTER_CHARS) normalized = normalized.slice(0, MAX_POINTER_CHARS).trimEnd()
  return normalized
}

/**
 * Build the ≤2-line pointer from an optional network summary.
 * @param {{ activeSessions?: number, aliasCandidates?: number }} [summary]
 * @param {number} [version] - template version (informational).
 * @returns {string} two-line pointer text.
 */
export function buildPointerText(summary = {}, version = BRIEF_TEMPLATE_VERSION) {
  const active = Number.isFinite(summary?.activeSessions)
    ? Math.max(0, Math.trunc(summary.activeSessions))
    : undefined
  const aliases = Number.isFinite(summary?.aliasCandidates)
    ? Math.max(0, Math.trunc(summary.aliasCandidates))
    : undefined
  const line1 = active === undefined
    ? POINTER_LINE_1
    : `本机交流网可用：${active} 个活跃会话${aliases === undefined ? '' : `，${aliases} 个别名候选`}。`
  return normalizePointerText(`${line1}\n${POINTER_LINE_2}`)
}

/**
 * Build the identified, frozen user message carrying the pointer.
 * @param {{ text?: string, version?: number }} [options]
 * @returns {{ id: string, role: 'user', content: { type: 'text', text: string }[], source: { kind: string, version: number } }}
 */
export function createBriefMessage({ text, version = BRIEF_TEMPLATE_VERSION, reason } = {}) {
  const pointer = normalizePointerText(text === undefined ? buildPointerText({}, version) : text)
  const templateVersion = Number.isInteger(version) && version > 0 ? version : BRIEF_TEMPLATE_VERSION
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: pointer }],
    source: { kind: BRIEF_SOURCE_KIND, version: templateVersion, ...(typeof reason === 'string' && reason !== '' ? { reason } : {}) },
  })
}

/** True when a message is this plugin's durable brief marker. */
export function isBriefMessage(message) {
  return isPlainObject(message) && isPlainObject(message.source) && message.source.kind === BRIEF_SOURCE_KIND
}

/** True when the first handler argument looks like an `agent/pre-step` payload. */
function isPreStepPayload(value) {
  return isPlainObject(value)
    && isPlainObject(value.agent)
    && Array.isArray(value.messages)
    && (typeof value.turn === 'number' || typeof value.step === 'number')
}

/** True when the first handler argument looks like a resolved PreStepDecision. */
function isPreStepDecision(value) {
  return isPlainObject(value) && (value.kind === 'enter' || value.kind === 'reject')
}

/** True when the first argument is the explicit `{ decision, agent }` wrapper form. */
function isDecisionWrapper(value) {
  return isPlainObject(value) && 'decision' in value && !isPreStepDecision(value)
}

/** Read the enabled flag from a state object, a config object, or a boolean. */
function readEnabled(value) {
  if (typeof value === 'boolean') return value
  if (isPlainObject(value)) {
    if (isPlainObject(value.autoInject) && typeof value.autoInject.enabled === 'boolean') {
      return value.autoInject.enabled
    }
    if (typeof value.enabled === 'boolean') return value.enabled
  }
  return false
}

/** Read a state's failure reason, if any (fail-safe reads carry `lastError`). */
function readFailureReason(value) {
  return isPlainObject(value) && typeof value.lastError === 'string' && value.lastError.length > 0
    ? value.lastError
    : undefined
}

/** Best-effort session lookup: payload/agent already carries it; allow an override dep. */
function resolveSession(deps, agent) {
  if (isPlainObject(agent) && isPlainObject(agent.session)) return agent.session
  if (typeof deps.getSession === 'function') return deps.getSession(agent)
  return undefined
}

/**
 * Collect committed session events defensively across host API versions.
 * @returns {readonly unknown[] | undefined} events, or undefined when unavailable.
 */
function collectSessionEvents(session) {
  if (!isPlainObject(session)) return undefined
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch { /* fall through to the next access path */ }
  try {
    if (Array.isArray(session.events)) return session.events
  } catch { /* fall through */ }
  try {
    if (typeof session.eventAt === 'function' && Number.isSafeInteger(session.seq) && session.seq >= 0) {
      const events = []
      for (let index = 0; index < session.seq; index += 1) {
        const event = session.eventAt(index)
        if (event === undefined) return undefined
        events.push(event)
      }
      return events
    }
  } catch { /* unavailable */ }
  return undefined
}

/** Extract a safe session id string for audit records (never logs message text). */
function sessionIdOf(session) {
  try {
    const id = session?.id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** Normalize a maybe-Date/maybe-ms/maybe-string `now` dependency to ISO-8601. */
function isoNow(now) {
  try {
    const value = typeof now === 'function' ? now() : undefined
    const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value)
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/** Serialize an error for audit records without leaking stack frames. */
function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Create the injector.
 * @param {{
 *   getConfig?: () => object,
 *   getState?: (() => object | boolean | Promise<object | boolean>) | object | boolean,
 *   audit?: (record: object) => void,
 *   logger?: { warn?: (message: string, error?: unknown) => void },
 *   now?: () => Date | number | string,
 *   getAgent?: () => object | undefined,
 *   getSession?: (agent: object | undefined) => object | undefined,
 *   getProjection?: (agent: object | undefined, session: object | undefined) => object | boolean | Promise<object | boolean>,
 *   getNetworkSummary?: () => object | Promise<object>,
 *   getSessionId?: (agent: object | undefined, session: object | undefined) => string | undefined,
 *   getSessionKind?: (sessionId: string, agent: object | undefined) => string | Promise<string | undefined> | undefined,
 *   getSessionBrief?: (sessionId: string) => object | Promise<object | undefined> | undefined,
 *   hasProfileContext?: boolean | (() => boolean | Promise<boolean>),
 *   networkAvailable?: boolean | ((session: unknown, agent: unknown) => boolean | Promise<boolean>),
 *   getProfileContext?: () => unknown,
 *   profileContext?: unknown,
 *   getInjectionReason?: (agent: object | undefined, session: object | undefined) => string | undefined,
 *   getSessionStartSource?: (agent: object | undefined) => string | undefined,
 *   briefStore?: {
 *     isBriefed: (sessionId: string) => boolean | Promise<boolean>,
 *     markBriefed: (record: { sessionId: string, reason: string, at: string }) => void | Promise<void>,
 *   },
 *   heartbeat?: (record: { sessionId: string, at: string }) => void | Promise<void>,
 * }} [deps]
 * @returns {{ name: string, handler: (first: unknown, next?: () => Promise<object>, context?: object) => Promise<unknown> }}
 */
export function createInjector(deps = {}) {
  const safeDeps = isPlainObject(deps) ? deps : {}
  /** Sessions already confirmed injected in this process (fast path after first scan). */
  const confirmedInjected = new WeakSet()

  /**
   * marker-heal observability (R3-5c5d8088-11): repeated DB write failures must
   * not be silently hidden by the durable marker. Counts are process-local; a
   * restart resets them (accepted). `dayCount` is a 24h-ish UTC-day window.
   */
  const healStats = { bySession: new Map(), day: undefined, dayCount: 0 }

  /** Increment the per-session heal attempt counter and return both counters. */
  function bumpHealCount(sessionId) {
    const count = (healStats.bySession.get(sessionId) ?? 0) + 1
    healStats.bySession.set(sessionId, count)
    const day = isoNow(safeDeps.now).slice(0, 10)
    if (healStats.day !== day) {
      healStats.day = day
      healStats.dayCount = 0
    }
    healStats.dayCount += 1
    return { healCount: count, dayCount: healStats.dayCount }
  }

  /** WARN when one session heals repeatedly or the DB fails across many sessions. */
  function warnIfHealRepeated(sessionId, healCount) {
    if (healCount <= 1 && healStats.dayCount <= 5) return
    warn('marker-heal repeated: DB writes may be failing', {
      sessionId,
      healCount,
      dayCount: healStats.dayCount,
    })
  }

  /** Audit records are best-effort: never let an audit sink break the handler. */
  function emitAudit(record) {
    try {
      if (typeof safeDeps.audit === 'function') {
        safeDeps.audit({ at: isoNow(safeDeps.now), source: 'session-network-inject', ...record })
      } else if (Array.isArray(safeDeps.audit)) {
        safeDeps.audit.push({ at: isoNow(safeDeps.now), source: 'session-network-inject', ...record })
      }
    } catch { /* audit sinks are best-effort */ }
  }

  /** Warn without letting the logger throw into the pre-step path. */
  function warn(message, error) {
    try {
      safeDeps.logger?.warn?.(message, error)
    } catch { /* logger sinks are best-effort */ }
  }

  /** Resolve the optional DB-backed idempotency store (both methods are required). */
  function resolveBriefStore() {
    const store = safeDeps.briefStore
    if (!isPlainObject(store)) return undefined
    if (typeof store.isBriefed !== 'function' || typeof store.markBriefed !== 'function') return undefined
    return store
  }

  /**
   * Whether a profileContext exists. Host integration should pass a probe
   * (`hasProfileContext`/`getProfileContext`/`profileContext`); without a probe
   * this injector is standalone and assumes the context exists.
   */
  async function resolveNetworkAvailable(session) {
    try {
      const value = safeDeps.networkAvailable
      if (typeof value === 'function') return await value(session, safeDeps.getAgent?.())
      if (typeof value === 'boolean') return value
      return undefined
    } catch {
      return undefined
    }
  }

  async function hasProfileContext() {
    try {
      if (typeof safeDeps.hasProfileContext === 'function') return Boolean(await safeDeps.hasProfileContext())
      if (typeof safeDeps.hasProfileContext === 'boolean') return safeDeps.hasProfileContext
      if (typeof safeDeps.getProfileContext === 'function') {
        const value = await safeDeps.getProfileContext()
        return value !== undefined && value !== null
      }
      if (Object.hasOwn(safeDeps, 'profileContext')) return safeDeps.profileContext !== undefined && safeDeps.profileContext !== null
    } catch { /* a throwing probe must not disable injection silently */ }
    return true
  }

  /** Resolve the durable session id used as the DB idempotency key. */
  function resolveSessionId(agent, session) {
    const direct = sessionIdOf(session)
    if (direct !== undefined && direct.length > 0) return direct
    try {
      if (typeof safeDeps.getSessionId === 'function') {
        const value = safeDeps.getSessionId(agent, session)
        if (typeof value === 'string' && value.length > 0) return value
      }
    } catch { /* fall through */ }
    return undefined
  }

  /** Resolve the durable session kind (`normal|fork|subagent`) for the subagent guard. */
  async function resolveSessionKind(agent, session, sessionId) {
    try {
      if (typeof safeDeps.getSessionKind === 'function') {
        const value = await safeDeps.getSessionKind(sessionId, agent)
        if (typeof value === 'string') return value
      }
      if (typeof safeDeps.getSessionBrief === 'function') {
        const brief = await safeDeps.getSessionBrief(sessionId)
        if (isPlainObject(brief) && typeof brief.kind === 'string') return brief.kind
      }
      const sessionKind = session?.kind
      if (typeof sessionKind === 'string') return sessionKind
      const header = typeof session?.header === 'function' ? session.header() : session?.header
      if (isPlainObject(header)) {
        if (typeof header.kind === 'string') return header.kind
        // Host SessionHeader.origin is the durable subagent classification; ordinary
        // forks may retain parentSession but never carry origin='subagent'.
        if (header.origin === 'subagent') return 'subagent'
      }
      const agentKind = agent?.kind
      if (typeof agentKind === 'string') return agentKind
      if (agent?.session?.origin === 'subagent') return 'subagent'
    } catch { /* kind is advisory; fail-open for a parent session */ }
    return undefined
  }

  /** Injection reason recorded by `markBriefed`: startup | fork | resume | install-backfill. */
  const INJECTION_REASONS = new Set(['startup', 'fork', 'resume', 'install-backfill'])

  /** True for committed conversation events (used to detect a pre-existing session). */
  function isConversationEvent(event) {
    if (!isPlainObject(event)) return false
    return event.type === 'user/message'
      || event.type === 'assistant/message'
      || event.type === 'developer/message'
      || event.type === 'tool/result'
  }

  /** True when a session already carries committed conversation history. */
  function sessionHasHistory(session) {
    if (!isPlainObject(session)) return false
    try {
      const events = collectSessionEvents(session)
      if (events !== undefined) return events.some(isConversationEvent)
      if (Number.isSafeInteger(session.seq)) return session.seq > 0
    } catch { /* history detection is advisory */ }
    return false
  }

  /**
   * Resolve the reason recorded with the durable brief. `install-backfill` covers
   * a session that already existed when the plugin first became visible (for
   * example the next pre-step of a long-running session right after install):
   * no fork/resume source is known, but the session already has history.
   */
  function detectInjectionReason(agent, session, payload) {
    try {
      if (typeof safeDeps.getInjectionReason === 'function') {
        const explicit = safeDeps.getInjectionReason(agent, session, payload)
        if (typeof explicit === 'string' && INJECTION_REASONS.has(explicit)) return explicit
      }
      if (typeof safeDeps.getSessionStartSource === 'function') {
        const source = safeDeps.getSessionStartSource(agent)
        if (source === 'startup' || source === 'fork') return source
        if (source === 'resume' || source === 'clear' || source === 'compact') return 'resume'
      }
      const header = typeof session?.header === 'function' ? session.header() : session?.header
      if (isPlainObject(header) && header.isSeeded === true) return 'fork'
      const turn = Number.isSafeInteger(payload?.turn) ? payload.turn : undefined
      if ((turn !== undefined && turn > 1) || sessionHasHistory(session)) return 'install-backfill'
    } catch { /* fall through to the default */ }
    return 'startup'
  }

  /**
   * Best-effort heartbeat on every pre-step (game ACCEPT-02 P1-4): the registry
   * needs a recent `heartbeats` row for lastSeenBucket. Never blocks/threatens
   * the pre-step; failure only warns.
   */
  async function pulseHeartbeat(agent) {
    if (typeof safeDeps.heartbeat !== 'function') return
    try {
      const session = resolveSession(safeDeps, agent)
      const sessionId = resolveSessionId(agent, session)
      if (sessionId === undefined) return
      await safeDeps.heartbeat({ sessionId, at: isoNow(safeDeps.now) })
    } catch (error) {
      warn('session-network injector: heartbeat failed (fail-open)', error)
    }
  }

  /** Resolve the runtime switch: state.json first, config as an explicit fallback. */
  async function resolveSwitch() {
    if (safeDeps.getState !== undefined) {
      try {
        const state = typeof safeDeps.getState === 'function' ? await safeDeps.getState() : safeDeps.getState
        const failure = readFailureReason(state)
        return { enabled: readEnabled(state), reason: failure === undefined ? 'state' : 'state-unreadable' }
      } catch (error) {
        return { enabled: false, reason: 'state-error', error }
      }
    }
    try {
      const config = typeof safeDeps.getConfig === 'function' ? safeDeps.getConfig() : undefined
      return { enabled: readEnabled(config), reason: 'config' }
    } catch (error) {
      return { enabled: false, reason: 'config-error', error }
    }
  }

  /** Template version from config (defensive: malformed config falls back to v1). */
  function resolveTemplateVersion() {
    try {
      const config = typeof safeDeps.getConfig === 'function' ? safeDeps.getConfig() : undefined
      const version = config?.autoInject?.pointerTemplateVersion
      return Number.isInteger(version) && version > 0 ? version : BRIEF_TEMPLATE_VERSION
    } catch {
      return BRIEF_TEMPLATE_VERSION
    }
  }

  /** Optional network summary; absence or failure degrades to the generic pointer. */
  async function resolveNetworkSummary() {
    try {
      if (typeof safeDeps.getNetworkSummary === 'function') {
        const summary = await safeDeps.getNetworkSummary()
        return isPlainObject(summary) ? summary : {}
      }
    } catch { /* generic pointer is enough */ }
    return {}
  }

  /**
   * Durable visibility: projection (if provided) or complete session log scan.
   * Returns `{ known, injected }`; `known === false` means "cannot verify" and the
   * caller must fail-open without injecting.
   */
  async function detectVisibility(agent, claimedMessages) {
    const session = resolveSession(safeDeps, agent)
    try {
      if (typeof safeDeps.getProjection === 'function') {
        const projection = await safeDeps.getProjection(agent, session)
        if (typeof projection === 'boolean') return { known: true, injected: projection }
        if (isPlainObject(projection) && typeof projection.injected === 'boolean') {
          return { known: true, injected: projection.injected }
        }
      }
    } catch { /* projection is an optimization; degrade to the log scan */ }

    if (isPlainObject(session)) {
      if (confirmedInjected.has(session)) return { known: true, injected: true }
      const events = collectSessionEvents(session)
      if (events !== undefined) {
        const injected = events.some(event => isPlainObject(event)
          && event.type === 'user/message'
          && isBriefMessage(event.data))
        if (injected) confirmedInjected.add(session)
        return { known: true, injected }
      }
      return { known: false }
    }

    // Degraded form (no agent/session): only the current step's messages are visible.
    const current = Array.isArray(claimedMessages) ? claimedMessages : []
    if (current.some(isBriefMessage)) return { known: true, injected: true }
    return { known: false }
  }

  /**
   * The `agent/pre-step` listener. Accepts the event payload (preferred), an
   * already-resolved decision, or `{ decision, agent }`. Never throws because of
   * injection; failures after `next()` return the downstream decision untouched.
   */
  async function handler(first, next, context) {
    let decision
    let agent
    let claimedMessages = []

    if (isPreStepPayload(first)) {
      agent = first.agent
      claimedMessages = Array.isArray(first.messages) ? first.messages : []
      // Contract order: run the downstream waterfall first, then consider injecting.
      decision = typeof next === 'function' ? await next() : undefined
    } else if (isPreStepDecision(first)) {
      decision = first
      agent = isPlainObject(context) && isPlainObject(context.agent)
        ? context.agent
        : typeof safeDeps.getAgent === 'function' ? safeDeps.getAgent() : undefined
      claimedMessages = Array.isArray(first.messages) ? first.messages : []
    } else if (isDecisionWrapper(first)) {
      decision = first.decision
      agent = isPlainObject(first.agent) ? first.agent : (isPlainObject(context) ? context.agent : undefined)
      claimedMessages = Array.isArray(first.claimedMessages) ? first.claimedMessages : []
      if (decision === undefined && typeof next === 'function') decision = await next()
    } else if (first === undefined || first === null) {
      decision = typeof next === 'function' ? await next() : first
    } else {
      // Unknown argument shape: our uncertainty must not fail the pre-step.
      emitAudit({ action: 'skipped', reason: 'unknown-handler-argument' })
      return first
    }

    // Best-effort heartbeat on every pre-step, independent of injection decisions.
    await pulseHeartbeat(agent)

    // ---- injection path: every failure below returns `decision` untouched ----
    try {
      if (decision === undefined || decision === null) return decision
      if (isPlainObject(decision) && decision.kind === 'reject') return decision

      const briefStore = resolveBriefStore()
      const briefStoreMode = briefStore === undefined ? 'log-fallback' : 'db'
      let effectiveBriefStoreMode = briefStoreMode
      let idempotency = briefStore === undefined ? 'scan-fallback' : 'brief-store'

      if (!(await hasProfileContext())) {
        emitAudit({ action: 'skipped', reason: 'no-profile-context', idempotency, briefStore: effectiveBriefStoreMode })
        return decision
      }

      const switchState = await resolveSwitch()
      if (!switchState.enabled) {
        emitAudit({
          action: 'disabled',
          reason: switchState.reason,
          idempotency,
          briefStore: effectiveBriefStoreMode,
          ...(switchState.error === undefined ? {} : { error: errorText(switchState.error) }),
        })
        return decision
      }

      const session = resolveSession(safeDeps, agent)
      const sessionId = resolveSessionId(agent, session)
      if (sessionId === undefined) {
        emitAudit({ action: 'skipped', reason: 'no-session-id', idempotency, briefStore: effectiveBriefStoreMode })
        return decision
      }

      // Record the resolved kind early (best effort) so DB sessions.kind converges even
      // when this workspace has no local network and injection is skipped below.
      const sessionKind = await resolveSessionKind(agent, session, sessionId)
      try { await safeDeps.recordSessionKind?.(sessionId, sessionKind ?? 'normal') } catch { /* advisory */ }

      // (C3/G10b/R27b) No local network (no team/pipe2/PEERS.json in this workspace) => never inject.
      const networkAvailable = await resolveNetworkAvailable(session)
      if (networkAvailable === false) {
        emitAudit({ action: 'skipped', reason: 'no-network', idempotency, briefStore: effectiveBriefStoreMode, sessionId, sessionKind })
        return decision
      }

      // Non-subagent guard (R3/P1): only parent sessions receive the brief. Fork is a
      // NEW sessionId with kind='fork' and is injected once; never judge subagent by
      // parentSessionId alone because forks also carry a parent.
      if (sessionKind === 'subagent') {
        emitAudit({ action: 'skipped', reason: 'subagent', idempotency, briefStore: effectiveBriefStoreMode, sessionId })
        return decision
      }

      // Visibility is an OR: DB `briefed_at` OR durable log marker. The DB key being
      // available never skips the log check, and vice versa.
      let storeBriefed
      if (briefStore !== undefined) {
        try {
          storeBriefed = Boolean(await briefStore.isBriefed(sessionId))
        } catch (error) {
          storeBriefed = undefined
          idempotency = 'scan-fallback'
          effectiveBriefStoreMode = 'log-fallback'
          warn('session-network injector: briefStore.isBriefed failed; falling back to durable log scan', error)
          emitAudit({ action: 'skipped', reason: 'brief-store-error', idempotency, briefStore: effectiveBriefStoreMode, error: errorText(error) })
        }
      }
      if (storeBriefed === true) return decision

      const logVisibility = await detectVisibility(agent, claimedMessages)
      if (!logVisibility.known) {
        emitAudit({ action: 'skipped', reason: 'visibility-unavailable', idempotency, briefStore: effectiveBriefStoreMode })
        return decision
      }
      if (logVisibility.injected) {
        // DB lost `briefed_at` (backup restore / DB replacement / earlier markFailed)
        // while the durable marker still proves prior injection. Never inject here;
        // heal the DB idempotency key (`brief_reason='marker-heal'`) so F24 does not
        // observe "injected without a mark". Heal failure stays fail-open but is counted.
        if (storeBriefed === false && briefStore !== undefined) {
          const counters = bumpHealCount(sessionId)
          let healError
          try {
            const healed = await briefStore.markBriefed({ sessionId, reason: 'marker-heal', at: isoNow(safeDeps.now) })
            if (healed === false || (isPlainObject(healed) && healed.ok === false)) {
              healError = new Error('markBriefed returned failure')
            }
          } catch (error) {
            healError = error
          }
          emitAudit({
            action: 'skipped',
            reason: 'already-injected',
            idempotency: 'store-recovered',
            briefStore: healError === undefined ? 'db' : 'log-fallback',
            markerHeal: healError === undefined ? 'done' : 'failed',
            healCount: counters.healCount,
            ...(healError === undefined ? {} : { markFailed: errorText(healError) }),
            sessionId,
          })
          if (healError !== undefined) {
            warn('session-network injector: marker-heal markBriefed failed (fail-open, no injection)', healError)
          }
          warnIfHealRepeated(sessionId, counters.healCount)
        }
        return decision
      }

      const injectionReason = detectInjectionReason(agent, session, first)
      const templateVersion = resolveTemplateVersion()
      const pointerText = buildPointerText(await resolveNetworkSummary(), templateVersion)
      const brief = createBriefMessage({ text: pointerText, version: templateVersion, reason: injectionReason })
      const downstreamMessages = Array.isArray(decision.messages) ? decision.messages : []
      const injectedDecision = { ...decision, messages: [brief, ...downstreamMessages] }

      if (isPlainObject(session)) confirmedInjected.add(session)

      let markError
      if (briefStore !== undefined) {
        try {
          const marked = await briefStore.markBriefed({ sessionId, reason: injectionReason, at: isoNow(safeDeps.now) })
          if (marked === false || (isPlainObject(marked) && marked.ok === false)) {
            markError = new Error('markBriefed returned failure')
          }
        } catch (error) {
          markError = error
        }
        if (markError !== undefined) {
          warn('session-network injector: briefStore.markBriefed failed (injection kept; durable marker is the fallback)', markError)
        }
      }

      const auditBriefStore = effectiveBriefStoreMode === 'db' && markError === undefined ? 'db' : 'log-fallback'
      emitAudit({
        action: 'injected',
        idempotency,
        briefStore: auditBriefStore,
        injectionReason,
        ...(markError === undefined ? {} : { markFailed: errorText(markError) }),
        templateVersion,
        pointerHash: hashPointer(pointerText),
        pointerLines: pointerText.split('\n').length,
        pointerChars: pointerText.length,
        sessionId,
        ...(Number.isSafeInteger(first?.turn) ? { turn: first.turn } : {}),
        ...(Number.isSafeInteger(first?.step) ? { step: first.step } : {}),
      })
      return injectedDecision
    } catch (error) {
      try {
        emitAudit({ action: 'error', reason: 'inject-failed', error: errorText(error) })
      } catch { /* audit is best-effort */ }
      warn('session-network injector: fail-open after injection error', error)
      return decision
    }
  }

  return { name: INJECTOR_NAME, handler }
}
