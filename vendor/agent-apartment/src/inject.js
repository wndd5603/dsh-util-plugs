// One-per-session pre-step injection for the P0 Collaboration Brief.
//
// Idempotency is process-local (documented in the P0 design review): a Set of
// session ids, not a durable marker. Injection is fail-open: downstream pre-step
// decisions are returned untouched on any unexpected error. An unbound session
// is never injected; a bound session whose brief cannot be read gets one explicit
// `[collab] brief unavailable: <code>` line instead of silence.
import { randomUUID } from 'node:crypto'
import { COLLAB_BRIEF_SOURCE_KIND } from './collab.js'

export const MAX_INJECTION_LINES = 2
export const BRIEF_UNAVAILABLE_CODE = 'BRIEF_UNAVAILABLE'

/** Trim to at most two non-empty lines (the injection budget). */
export function normalizeInjectionText(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, MAX_INJECTION_LINES)
  return lines.join('\n')
}

/** Build the identified, frozen user message that carries the brief. */
export function createBriefMessage({ text, reason = 'collaboration-brief' } = {}) {
  const normalized = normalizeInjectionText(text)
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: normalized })]),
    source: Object.freeze({ kind: COLLAB_BRIEF_SOURCE_KIND, version: 1, reason }),
  })
}

/** True when a message is one of this plugin's brief markers. */
export function isCollabBriefMessage(message) {
  return message !== null
    && typeof message === 'object'
    && message.source !== null
    && typeof message.source === 'object'
    && message.source.kind === COLLAB_BRIEF_SOURCE_KIND
}

const isPreStepPayload = value => value !== null
  && typeof value === 'object'
  && value.agent !== null
  && typeof value.agent === 'object'
  && Array.isArray(value.messages)
  && (typeof value.turn === 'number' || typeof value.step === 'number')

const isPreStepDecision = value => value !== null
  && typeof value === 'object'
  && (value.kind === 'enter' || value.kind === 'reject')

const isDecisionWrapper = value => value !== null
  && typeof value === 'object'
  && Object.hasOwn(value, 'decision')
  && !isPreStepDecision(value)

const sessionIdOfAgent = agent => {
  const session = agent?.session
  const candidates = [session?.id, session?.sessionId, agent?.sessionId, agent?.session_id]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

const errorCode = error => {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code.trim() !== '') {
    return error.code.trim()
  }
  return BRIEF_UNAVAILABLE_CODE
}

const prependMessage = (decision, message) => {
  const messages = Array.isArray(decision?.messages) ? decision.messages : []
  return { ...decision, messages: [message, ...messages] }
}

/**
 * Create the `agent/pre-step` listener.
 *
 * @param {{
 *   getBrief: (sessionId: string) => object,
 *   enabled?: boolean,
 *   logger?: { warn?: (message: string, error?: unknown) => void },
 *   injectedSessions?: Set<string>,
 * }} options
 */
export function createCollabInjector({ getBrief, enabled = true, logger, injectedSessions } = {}) {
  if (typeof getBrief !== 'function') throw new TypeError('createCollabInjector: getBrief is required')
  const injected = injectedSessions instanceof Set ? injectedSessions : new Set()
  const warn = (message, error) => {
    try { logger?.warn?.(message, error) } catch { /* logging is best-effort */ }
  }

  const handler = async (first, next) => {
    let decision
    let agent
    if (isPreStepPayload(first)) {
      agent = first.agent
      try {
        decision = typeof next === 'function' ? await next() : undefined
      } catch (error) {
        // Downstream failures are not ours: rethrow and never mask them.
        throw error
      }
    } else if (isPreStepDecision(first)) {
      decision = first
    } else if (isDecisionWrapper(first)) {
      decision = first.decision
      agent = first.agent
      if (decision === undefined && typeof next === 'function') decision = await next()
    } else if (first === undefined || first === null) {
      decision = typeof next === 'function' ? await next() : first
    } else {
      return first
    }
    if (!enabled) return decision
    if (decision === undefined || decision === null) return decision
    if (decision.kind === 'reject') return decision
    try {
      if (!agent) return decision
      const sessionId = sessionIdOfAgent(agent)
      if (sessionId === null) return decision
      if (injected.has(sessionId)) return decision
      // Persisted session history can already carry a brief after a resume or
      // host restart, where the process-local Set is empty. Check both the
      // current pre-step payload and the downstream decision before injecting.
      const claimedMessages = [
        ...(isPreStepPayload(first) && Array.isArray(first.messages) ? first.messages : []),
        ...(Array.isArray(decision.messages) ? decision.messages : []),
      ]
      if (claimedMessages.some(isCollabBriefMessage)) {
        injected.add(sessionId)
        return decision
      }
      let brief
      try {
        brief = await getBrief(sessionId)
      } catch (error) {
        const message = createBriefMessage({
          text: '[collab] brief unavailable: ' + errorCode(error),
          reason: 'unavailable',
        })
        injected.add(sessionId)
        return prependMessage(decision, message)
      }
      if (brief === null || typeof brief !== 'object' || brief.ok !== true) {
        // UNBOUND_SESSION (or an equivalent miss) must not inject and must not
        // consume the one-shot marker: a session may be bound later.
        return decision
      }
      const text = normalizeInjectionText(brief.text)
      if (text === '') return decision
      const message = createBriefMessage({ text, reason: 'bound' })
      injected.add(sessionId)
      return prependMessage(decision, message)
    } catch (error) {
      warn('apartment: collaboration brief injection failed (fail-open)', error)
      return decision
    }
  }

  return { name: 'apartment-collab-brief', handler, injectedSessions: injected }
}
