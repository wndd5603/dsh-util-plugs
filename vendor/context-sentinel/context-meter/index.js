/**
 * Context Meter — agent-facing context-occupancy inspection.
 *
 * Registers one read-only tool (`context_usage`) that measures the calling
 * session's token pressure through the Host `tokenMeter` replay fold, one
 * runtime skill (`context-usage`) that teaches when to call it and how to act
 * on the result, an occupancy watchdog that injects one automated advisory
 * into a session when its occupancy crosses the advisory threshold (derived
 * from the installed compaction backend's thresholdRatio when present, a
 * fixed 85% otherwise), and a minimal per-turn `[ctx <percent>%]` line at the
 * first model step of every turn (decision 11/R11, default on, configurable).
 *
 * Zero npm dependencies by design: the only import is the package-local
 * `lib/standard-schema.js` (Standard Schema v1 config validation), so a local
 * path install never needs the npm registry.
 */

import { boolean, number, defaultsOf, objectSchema, fieldDocs } from '../lib/standard-schema.js'

const TOOL_NAME = 'context_usage'
const SKILL_NAME = 'context-usage'

/** Occupancy buckets; thresholds live here so tool, skill, and watchdog stay in sync. */
function occupancyStatus(percent) {
  if (percent === null) return 'unknown'
  if (percent < 70) return 'ok'
  if (percent < 85) return 'elevated'
  return 'critical'
}

/**
 * Resolve advisory thresholds at event time. With a compaction backend
 * resolvable from the caller's scope, fire two points below its configured
 * `thresholdRatio` so the advisory precedes (or backstops) automatic
 * compaction instead of masking it, and re-arm ten points lower. Without one
 * (or with an unreadable config), fall back to a fixed conservative 85% / 75%.
 *
 * The compaction service ships inside an isolated preset group
 * (`isolate: { compaction: true }`), which hides the service instance from
 * every scope that does not declare itself a consumer — the global layer AND
 * the agent scope in current DSH. Both lookups are attempted anyway so the
 * dynamic thresholds light up automatically if a future DSH exposes the
 * isolated provider to agent scopes; until then the fixed fallback applies.
 */
function resolveAdvisoryThresholds(agentCtx, pluginCtx, config) {
  // 显式配置优先（用于对齐自动压缩阈值；compaction 服务在 isolate 组里读不到时也能用）
  const overrideNotify = Number.isFinite(config?.notifyPercent) ? config.notifyPercent : undefined
  const overrideRearm = Number.isFinite(config?.rearmPercent) ? config.rearmPercent : undefined
  if (overrideNotify !== undefined) {
    return {
      notifyPercent: overrideNotify,
      rearmPercent: overrideRearm ?? Math.max(10, overrideNotify - 10),
      source: 'config',
    }
  }
  const compaction = agentCtx?.get('compaction') ?? pluginCtx?.get('compaction')
  const ratio = compaction?.config?.thresholdRatio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    return { notifyPercent: 85, rearmPercent: 75, source: 'default' }
  }
  const notifyPercent = Math.min(90, Math.max(70, Math.round(ratio * 100) - 2))
  return { notifyPercent, rearmPercent: notifyPercent - 10, source: 'compaction' }
}

/**
 * Build one frozen user-role message without importing the LLM package.
 * The shape mirrors `createUserMessage` from `@deepseek-ai/dsh-llm`:
 * `{ id, role: 'user', content, source }`; user messages may carry any
 * producer kind and consumers fall through unknown ones — the bracketed
 * `[context-meter]` prefix keeps the automated origin visible in the text.
 */
function createUserMessage(text, sourceKind = 'user') {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: sourceKind }),
  })
}

const TURN_CONTEXT_KIND = 'context-meter/turn-context'
const TURN_CONTEXT_PREFIX = '[ctx '
const TURN_CONTEXT_MAX_CHARS = 64
/** Conservative window for the very first turn, before any model request reports it. */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

/** Message text helper (content entries are text parts in the host's shape). */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const parts = Array.isArray(message.content) ? message.content : []
  const first = parts.find(part => part !== null && typeof part === 'object' && typeof part.text === 'string')
  return first === undefined ? '' : first.text
}

function isThresholdAdvisory(message) {
  return messageText(message).startsWith('[context-meter]')
}

function isTurnContextMessage(message) {
  if (message !== null && typeof message === 'object' && message.source?.kind === TURN_CONTEXT_KIND) return true
  return messageText(message).startsWith(TURN_CONTEXT_PREFIX)
}

/** Compact token counts for the ≤20-token per-turn line (1.5M / 649k / 980). */
function compactTokenCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (n >= 1_000_000) {
    const millions = Math.round((n / 1_000_000) * 10) / 10
    return String(millions).replace(/\.0$/u, '') + 'M'
  }
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(Math.round(n))
}

/**
 * Format the per-turn minimal line (decision 11/R11): `[ctx 65%]` by default,
 * or `[ctx 65% 649k/1M]` when the optional usage detail is enabled. Always
 * capped to TURN_CONTEXT_MAX_CHARS so one line stays well under 20 tokens.
 */
export function formatTurnContextLine(occupancy, showUsage = false) {
  const percent = Math.min(100, Math.max(0, Math.round(Number(occupancy?.percent ?? 0))))
  const base = '[ctx ' + percent + '%]'
  if (showUsage !== true) return base
  const used = compactTokenCount(occupancy?.usedTokens)
  const window = compactTokenCount(occupancy?.contextWindow)
  if (used === null || window === null) return base
  const detailed = '[ctx ' + percent + '% ' + used + '/' + window + ']'
  return detailed.length <= TURN_CONTEXT_MAX_CHARS ? detailed : base
}

function createTurnContextMessage(text) {
  return createUserMessage(text, TURN_CONTEXT_KIND)
}

/** Deep-clone into lossless JSON (drop undefined properties, non-finite numbers). */
function toLosslessJson(value) {
  if (Array.isArray(value)) return value.map(item => toLosslessJson(item))
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = toLosslessJson(entry)
  }
  return out
}

/** Catalog window fallback so the first turn (before any model request) can still inject. */
function resolveContextWindowFallback(ctx, modelSelection) {
  const provider = modelSelection?.provider
  const model = modelSelection?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  try {
    const llm = ctx.get?.('llm')
    const models = llm?.listModels?.(provider)
    if (!Array.isArray(models)) return null
    const entry = models.find(candidate => candidate !== null && typeof candidate === 'object' && candidate.id === model)
    const window = entry?.contextWindow
    return Number.isFinite(window) && window > 0 ? window : null
  } catch {
    return null
  }
}

/** Compactly describe the routed model facts, omitting unknown fields. */
function sessionInfo(session, routed) {
  return {
    id: session.id,
    ...(routed?.provider === undefined ? {} : { provider: routed.provider }),
    ...(routed?.model === undefined ? {} : { model: routed.model }),
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    session: { type: 'object', description: 'Session id and the routed provider/model.' },
    context: { type: 'object', description: 'Measured occupancy: usedTokens, contextWindow, percent, status, baseline, surface totals, top nodes, advisory thresholds.' },
    note: { type: 'string', description: 'Optional caveat, e.g. unknown context window or compaction advice.' },
  },
  required: ['session', 'context'],
  additionalProperties: false,
}

const TOOL_DESCRIPTION =
  'Measure the current session context occupancy: tokens used against the model context window, the '
  + 'provider usage anchor, surface totals, and the largest surface nodes. Call it when the user asks '
  + 'about context or token usage, before very large reads or generations, periodically in long sessions, '
  + 'or to decide whether to suggest /compact. Read-only, no arguments. An automatic occupancy advisory '
  + 'is injected once per threshold crossing.'

const SKILL_CONTENT = `# Context Usage（上下文占用检查）

通过 \`context_usage\` 工具（无参数、只读）测量当前会话的上下文占用。

## 何时调用
- 用户询问"上下文用了多少 / token 占用 / 窗口还剩多少"时，立即调用。
- 预计产生大量上下文之前（读取大文件、长输出工具、生成大段内容），先测量再决定策略。
- 长会话中周期性调用（约每 10–15 轮工具调用一次），不要等到溢出。
- 会话恢复（resume / fork）后，先测量一次了解起点。

## 如何解读
- \`context.percent\`：占用百分比。\`ok\`(<70%) 正常；\`elevated\`(70–85%) 开始节约；\`critical\`(≥85%) 立即收敛。
- \`context.usedTokens\`：当前请求压力（输入 + 最近响应）。
- \`context.projectedTokens\`（若存在）：provider 上报锚点 + 表面增量推算出的下一次请求占用，更接近实际。
- \`context.baseline.kind\`：\`usage\` = provider 真实上报（最准）；\`estimated\` = 启发式估算；\`none\` = 尚无请求。
- \`context.topNodes\`：占用最大的表面节点（\`seq\` 可定位日志事件）——大节点通常来自长工具结果或大文件读取。
- \`context.advisory\`：自动提醒阈值（\`notifyPercent\` 触发位 / \`rearmPercent\` 重臂位）。安装了 compaction 服务时随其 \`thresholdRatio\` 自适应（低 2 个百分点，夹在 70–90%），否则固定 85%/75%。
- 每轮第一个模型步骤可能自动附带一条极短 \`[ctx 65%]\`（可选 \`[ctx 65% 649k/1M]\`）；这是自动化提示，不是用户消息。默认开启，配置 \`turnInjection:false\` 可关闭；同轮已有 \`[context-meter]\` 阈值提醒时不会重复注入。

## 如何行动
- \`elevated\`：避免重复读取大文件、避免输出超长结果，优先摘要而非全文。
- \`critical\`：建议用户执行 \`/compact\`（手动压缩）；压缩完成前避免大读取与大输出。
- 收到 \`[context-meter]\` 开头的自动提醒时，视为权威测量信号（自动化注入，非用户文本）：立即收敛输出并按 critical 处理。
- 归档提醒（team-hooks2，自动）：收到 \`[team-hooks2] 上下文归档提醒\` 时，按提示创建/更新本会话归档文件；上下文骤降提示 \`读取最新归档\` 时先读取归档再继续，不要另建重复归档。
- 向用户报告占用时，引用 \`percent\` 与 \`usedTokens\`/\`contextWindow\` 即可，不要粘贴完整 JSON。
`

export const inject = ['tools', 'tokenMeter', 'skills']

const PLUGIN_VERSION = '2026.11.4-1'

/**
 * Declarative config schema (Standard Schema v1, zero dependency). The host
 * validates and normalizes this before `apply`; values are optional so the
 * dynamic threshold resolution (compaction ratio, clamped 70-90%) stays the
 * default when no explicit override is configured.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the context_usage tool, the runtime skill and the occupancy watchdog.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  notifyPercent: number(undefined, {
    description: 'Explicit advisory threshold in percent (10-99). Omit to derive it from compaction.thresholdRatio (fallback 85).',
    min: 10, max: 99,
  }),
  rearmPercent: number(undefined, {
    description: 'Re-arm threshold in percent; defaults to notifyPercent - 10.', min: 5, max: 98,
  }),
  turnInjection: boolean(true, {
    description: 'Inject one tiny [ctx <percent>%] line at the first model step of every agent turn (default on).',
  }),
  turnInjectionUsage: boolean(false, {
    description: 'Include used/window tokens in the per-turn line: [ctx 65% 649k/1M] (≤20 tokens).',
  }),
}, { description: 'Context occupancy meter configuration.', schemaVersion: 1 })

export function apply(ctx, config) {
  config = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[context-meter] disabled by config (enabled=false); no tool/skill/watchdog registered')
    return
  }
  try {
    const startupThresholds = resolveAdvisoryThresholds(undefined, ctx, config)
    ctx.logger?.info?.('[context-meter] v' + PLUGIN_VERSION + ' ready threshold='
      + startupThresholds.notifyPercent + '/' + startupThresholds.rearmPercent
      + ' source=' + startupThresholds.source)
  } catch { /* startup log must never break the plugin */ }
  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('context_usage requires an Agent-backed session')
      const session = agent.session
      const measurement = ctx.tokenMeter.measure(session)
      const routed = session.requestContext()
      const pressure = ctx.get('sessionProjections')?.stateOf(session, 'contextPressure')

      const contextWindow = routed?.contextWindow ?? pressure?.contextWindow ?? null
      const usedTokens = measurement.totalTokens
      const percent = contextWindow === null
        ? null
        : Math.min(100, Math.round((usedTokens / contextWindow) * 100))
      const remainingTokens = contextWindow === null ? null : Math.max(0, contextWindow - usedTokens)
      const status = occupancyStatus(percent)

      const baseline = { kind: measurement.baseline.kind, tokens: measurement.baseline.tokens }
      if (measurement.baseline.kind === 'usage') {
        const usage = measurement.baseline.usage
        baseline.usage = {
          uncachedInputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
          ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
        }
      }

      const topNodes = [...measurement.nodes]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .map(node => ({ seq: node.seq, tokens: node.tokens }))

      const context = {
        usedTokens,
        contextWindow,
        percent,
        remainingTokens,
        status,
        baseline,
        surfaceTokens: measurement.surfaceTokens,
        surfaceDeltaTokens: measurement.surfaceDeltaTokens,
        surfaceNodes: measurement.nodes.length,
        topNodes,
        logRevision: measurement.logRevision,
      }
      if (pressure?.pressureTokens !== undefined && pressure.sampledSurfaceTokens !== undefined) {
        context.pressureTokens = pressure.pressureTokens
        context.projectedTokens = Math.max(
          0,
          pressure.pressureTokens + pressure.surfaceTokens - pressure.sampledSurfaceTokens,
        )
      }

      context.advisory = resolveAdvisoryThresholds(agent.ctx, ctx, config)

      const value = { session: sessionInfo(session, routed), context }
      if (contextWindow === null) {
        return { ...value, note: 'Context window is unknown until the first model request; call again afterwards.' }
      }
      if (status === 'critical') {
        return {
          ...value,
          note: 'Occupancy is critical: suggest /compact (manual compaction) and keep reads and outputs minimal until then.',
        }
      }
      return value
    },
    presentCall: () => ({ card: 'generic', title: 'Measure context occupancy', kind: 'read' }),
  })

  ctx.skills.register({
    name: SKILL_NAME,
    source: 'runtime',
    description:
      '检查当前会话上下文 Token 占用 / Check session context-token occupancy. Use when the user asks about '
      + 'context or token usage, window headroom, or compaction timing.',
    whenToUse:
      'Context/token occupancy questions; before large reads or generations; periodic long-session checks; deciding on /compact.',
    content: SKILL_CONTENT,
  })

  // ---- occupancy watchdog: one automated advisory per threshold crossing ----
  const advisoryState = new Map()
  const perAgentDisposers = new Map()
  const metrics = { advisories: 0, injectionErrors: 0, lastAdvisoryAt: null }

  const measureOccupancy = (agent, fallbackWindow = null) => {
    try {
      const measurement = ctx.tokenMeter.measure(agent.session)
      const routed = agent.session.requestContext()
      const pressure = ctx.get('sessionProjections')?.stateOf(agent.session, 'contextPressure')
      const window = routed?.contextWindow
        ?? pressure?.contextWindow
        ?? (Number.isFinite(fallbackWindow) && fallbackWindow > 0 ? fallbackWindow : null)
      if (window === undefined || window === null || window <= 0) return null
      return {
        percent: Math.min(100, Math.round((measurement.totalTokens / window) * 100)),
        usedTokens: measurement.totalTokens,
        contextWindow: window,
      }
    } catch {
      return null
    }
  }

  const installWatchdog = (agent) => {
    const key = agent.session.id
    if (perAgentDisposers.has(key)) return
    advisoryState.set(key, { notified: false })
    let dispose
    try {
      dispose = agent.ctx.on('agent/turn-stopping', () => {
        const state = advisoryState.get(key)
        if (state === undefined) return
        const occupancy = measureOccupancy(agent)
        if (occupancy === null) return
        const thresholds = resolveAdvisoryThresholds(agent.ctx, ctx, config)
        if (!state.notified && occupancy.percent >= thresholds.notifyPercent) {
          state.notified = true
          try {
            agent.inject(createUserMessage(
              '[context-meter] Context occupancy advisory (automated, not from the user): this session is at '
              + occupancy.percent + '% (' + occupancy.usedTokens + '/' + occupancy.contextWindow + ' tokens), '
              + 'advisory threshold ' + thresholds.notifyPercent + '%. '
              + 'Keep replies, reads, and tool outputs minimal from here on; summarize instead of quoting; '
              + 'propose /compact to the user if heavy work remains.',
            ))
            metrics.advisories += 1
            metrics.lastAdvisoryAt = new Date().toISOString()
          } catch (error) {
            metrics.injectionErrors += 1
            ctx.logger.warn('context-meter: failed to inject occupancy advisory: ' + String(error))
          }
        } else if (state.notified && occupancy.percent < thresholds.rearmPercent) {
          state.notified = false
        }
      })
    } catch (error) {
      advisoryState.delete(key)
      ctx.logger.warn('context-meter: failed to attach watchdog for ' + key + ': ' + String(error))
      return
    }
    perAgentDisposers.set(key, dispose)
  }

  ctx.on('agent/created', ({ agent }) => { installWatchdog(agent) })

  // ---- per-turn minimal context line (decision 11/R11) ----
  // One line at the first model step of each turn. It is prepended to the
  // pre-step messages (transient model input, not an injected user turn), never
  // blocks a step, and stays silent when the same turn already carries the
  // context-guard threshold advisory (no double reminders).
  const turnState = new Map()
  const turnMetrics = {
    injected: 0, skippedThreshold: 0, skippedDuplicate: 0, errors: 0, lastInjectedAt: null,
  }

  const turnContextHandler = async (first, next) => {
    const isPayload = first !== null && typeof first === 'object'
      && first.agent !== null && typeof first.agent === 'object'
      && Array.isArray(first.messages) && Number.isInteger(first.turn)
    if (!isPayload) return typeof next === 'function' ? next() : first
    let decision
    try { decision = typeof next === 'function' ? await next() : undefined } catch (error) { throw error }
    try {
      if (config.turnInjection === false) return decision
      if (decision !== null && typeof decision === 'object' && decision.kind === 'reject') return decision
      if (first.step !== 1) return decision
      const agent = first.agent
      const sessionId = agent?.session?.id
      if (sessionId === undefined) return decision
      const state = turnState.get(sessionId)
      if (state !== undefined && state.turn === first.turn) return decision
      const claimed = Array.isArray(first.messages) ? first.messages : []
      if (claimed.some(isThresholdAdvisory)) {
        turnState.set(sessionId, { turn: first.turn })
        turnMetrics.skippedThreshold += 1
        return decision
      }
      if (claimed.some(isTurnContextMessage)) {
        turnState.set(sessionId, { turn: first.turn })
        turnMetrics.skippedDuplicate += 1
        return decision
      }
      const occupancy = measureOccupancy(agent, resolveContextWindowFallback(ctx, first.modelSelection) ?? FALLBACK_CONTEXT_WINDOW)
      if (occupancy === null) return decision
      const text = formatTurnContextLine(occupancy, config.turnInjectionUsage === true)
      const message = createTurnContextMessage(text)
      const downstream = Array.isArray(decision?.messages) ? decision.messages : []
      turnState.set(sessionId, { turn: first.turn })
      turnMetrics.injected += 1
      turnMetrics.lastInjectedAt = new Date().toISOString()
      return {
        ...(decision !== null && typeof decision === 'object' ? decision : {}),
        messages: [message, ...downstream],
      }
    } catch (error) {
      turnMetrics.errors += 1
      try { ctx.logger.warn('context-meter: per-turn context injection failed (fail-open): ' + String(error)) } catch { /* best effort */ }
      return decision
    }
  }

  let disposeTurnContext
  try {
    disposeTurnContext = ctx.on?.('agent/pre-step', turnContextHandler)
  } catch (error) {
    ctx.logger.warn('context-meter: failed to attach per-turn context injection: ' + String(error))
  }

  ctx.on('agent/disposed', ({ agent }) => {
    const key = agent.session.id
    turnState.delete(key)
    const dispose = perAgentDisposers.get(key)
    if (dispose === undefined) return
    perAgentDisposers.delete(key)
    advisoryState.delete(key)
    try { dispose() } catch { /* already gone with the agent context */ }
  })

  // Re-arm for agents that already existed before (re)activation, e.g. HMR reload.
  const agents = ctx.get('agents')
  if (agents !== undefined) {
    for (const agent of agents.list()) installWatchdog(agent)
  }

  // ---- read-only status tool ------------------------------------------------
  ctx.tools.register({
    name: 'context_guard_status',
    description:
      'Read-only status of the context guard entry: version, enabled flag, effective advisory thresholds and '
      + 'their source, watchdog counters (attached agents / sessions currently in the notified state / '
      + 'advisories injected / injection errors / last advisory time), and the registered skill name. Use it '
      + 'to verify the guard is active and which thresholds are in effect. Capability index: skill("team-bootstrap") §2 '
      + '/ CAPABILITY_AUDIT.md.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      let thresholds = { notifyPercent: null, rearmPercent: null, source: 'unavailable' }
      try {
        thresholds = resolveAdvisoryThresholds(exec?.agent?.ctx, ctx, config)
      } catch { /* keep unavailable */ }
      return toLosslessJson({
        ok: true,
        plugin: 'dsh-context-guard/context-meter',
        version: PLUGIN_VERSION,
        enabled: true,
        tool: { name: TOOL_NAME, readOnly: true },
        skill: { name: SKILL_NAME, source: 'runtime' },
        thresholds,
        watchdog: {
          attachedAgents: perAgentDisposers.size,
          notifiedSessions: [...advisoryState.values()].filter(state => state.notified === true).length,
          advisories: metrics.advisories,
          injectionErrors: metrics.injectionErrors,
          lastAdvisoryAt: metrics.lastAdvisoryAt,
        },
        turnInjection: {
          enabled: config.turnInjection !== false,
          showUsage: config.turnInjectionUsage === true,
          maxChars: TURN_CONTEXT_MAX_CHARS,
          injected: turnMetrics.injected,
          skippedThreshold: turnMetrics.skippedThreshold,
          skippedDuplicate: turnMetrics.skippedDuplicate,
          errors: turnMetrics.errors,
          lastInjectedAt: turnMetrics.lastInjectedAt,
        },
        config: { defaults: defaultsOf(Config), fields: fieldDocs(Config) },
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Context guard status', kind: 'read' }),
  })

  // Plugin unload (HMR) must also lift the per-agent listeners it installed.
  ctx.effect(() => () => {
    try { disposeTurnContext?.() } catch { /* ignore */ }
    turnState.clear()
    for (const dispose of perAgentDisposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    perAgentDisposers.clear()
    advisoryState.clear()
  })
}
