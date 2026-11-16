/**
 * DSH-provider client: same chat/chatJson/health surface as the local HTTP
 * client, but routes through ctx.llm and the current agentDefaultModel.
 */
import { LocalLlmError, extractJsonObject, normalizeConfig } from './client.js'

const now = () => Date.now()

export function createDshProviderClient({ llm, agentDefaultModel, rawConfig = {} }) {
  const config = normalizeConfig(rawConfig)
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    throw new LocalLlmError('PROVIDER_UNAVAILABLE', 'ctx.llm.prepareCall is unavailable')
  }
  if (agentDefaultModel === undefined || typeof agentDefaultModel.currentSelection !== 'function') {
    throw new LocalLlmError('PROVIDER_UNAVAILABLE', 'agentDefaultModel.currentSelection is unavailable')
  }

  const selection = () => {
    const value = agentDefaultModel.currentSelection()
    if (value === null || typeof value !== 'object' || typeof value.provider !== 'string' || typeof value.model !== 'string') {
      throw new LocalLlmError('PROVIDER_UNAVAILABLE', 'no provider/model selection is configured')
    }
    return value
  }

  async function chat(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LocalLlmError('INVALID_ARGS', 'messages must be a non-empty array')
    }
    const selected = selection()
    const maxTokens = Number.isFinite(Number(options.maxTokens))
      ? Math.min(4096, Math.max(16, Math.trunc(Number(options.maxTokens))))
      : config.maxTokens
    const started = now()
    let text = ''
    let usage = null
    let finishReason = null
    const observed = []
    try {
      const prepared = await llm.prepareCall({
        provider: selected.provider,
        model: selected.model,
        maxTokens,
        temperature: 0,
      })
      const streamOptions = {
        ...prepared.config,
        messages: messages.map(message => ({
          role: message.role,
          content: typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content,
        })),
        maxTokens,
        temperature: 0,
        signal: options.signal,
      }
      for await (const chunk of prepared.stream(streamOptions)) {
        if (chunk?.type !== undefined) observed.push(String(chunk.type))
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') text += chunk.block.text
        else if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage
        else if (chunk?.type === 'finish' && typeof chunk.reason === 'string') finishReason = chunk.reason
      }
    } catch (error) {
      if (error instanceof LocalLlmError) throw error
      throw new LocalLlmError('PROVIDER_CALL_FAILED', String(error?.message ?? error), { code: error?.code ?? null })
    }
    if (text.trim() === '') {
      throw new LocalLlmError('INVALID_MODEL_OUTPUT', 'provider returned no assistant content', {
        finishReason,
        excerpt: observed.join(',') || 'no chunks',
      })
    }
    return {
      text: text.trim(),
      usage: usage === null ? null : {
        prompt_tokens: usage.inputTokens ?? usage.promptTokens ?? null,
        completion_tokens: usage.outputTokens ?? usage.completionTokens ?? null,
        total_tokens: usage.totalTokens ?? null,
      },
      model: selected.model,
      provider: selected.provider,
      finishReason,
      latencyMs: now() - started,
    }
  }

  async function chatJson(messages, options = {}) {
    const result = await chat(messages, options)
    return { ...result, value: extractJsonObject(result.text) }
  }

  async function health() {
    try {
      const selected = selection()
      return {
        ok: true,
        reachable: true,
        source: 'dsh-provider',
        endpoint: 'ctx.llm',
        model: selected.model,
        provider: selected.provider,
        modelAvailable: true,
        models: [selected.model],
        latencyMs: 0,
      }
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        source: 'dsh-provider',
        endpoint: 'ctx.llm',
        model: config.model,
        modelAvailable: false,
        models: [],
        latencyMs: 0,
        code: error?.code ?? 'PROVIDER_UNAVAILABLE',
        message: String(error?.message ?? error),
      }
    }
  }

  return { config, chat, chatJson, health, source: 'dsh-provider' }
}
