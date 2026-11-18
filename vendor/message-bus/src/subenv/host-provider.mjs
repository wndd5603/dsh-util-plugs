/**
 * In-process provider bridge backed by the host's `ctx.llm` service.
 * No API key, base URL, or provider config is read from the subenv itself.
 */
export function createHostProvider({
  getLlm,
  providerId = '',
  modelId = '',
  maxTokens = 2048,
} = {}) {
  if (typeof getLlm !== 'function') throw new Error('getLlm is required')

  function llm() {
    try {
      const service = getLlm()
      return service !== null && typeof service === 'object' && typeof service.stream === 'function' ? service : null
    } catch {
      return null
    }
  }

  async function resolveRoute() {
    const service = llm()
    if (service === null) return { ok: false, code: 'LLM_UNAVAILABLE', message: 'host ctx.llm is not available' }
    const configuredProvider = typeof providerId === 'string' ? providerId.trim() : ''
    const configuredModel = typeof modelId === 'string' ? modelId.trim() : ''
    const providers = typeof service.listProviders === 'function' ? service.listProviders() : []
    const provider = configuredProvider !== '' ? configuredProvider : (Array.isArray(providers) ? providers[0]?.id : null)
    if (typeof provider !== 'string' || provider === '') {
      return { ok: false, code: 'LLM_NO_PROVIDER', message: 'host has no LLM provider' }
    }
    let model = configuredModel
    if (model === '') {
      const models = typeof service.listModels === 'function' ? await service.listModels(provider) : []
      model = Array.isArray(models) ? models[0]?.id : ''
    }
    if (typeof model !== 'string' || model === '') {
      return { ok: false, code: 'LLM_NO_MODEL', message: 'host provider has no model' }
    }
    return { ok: true, provider, model }
  }

  return {
    get enabled() { return llm() !== null },
    describe() {
      const service = llm()
      if (service === null) return { configured: false, source: 'dsh-llm', hasApiKey: null, llmEnabled: false }
      return {
        configured: true,
        source: 'dsh-llm',
        id: typeof providerId === 'string' && providerId !== '' ? providerId : null,
        model: typeof modelId === 'string' && modelId !== '' ? modelId : null,
        hasApiKey: null,
        llmEnabled: true,
      }
    },
    async chat({ messages } = {}) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'messages must be a non-empty array' }
      }
      const route = await resolveRoute()
      if (route.ok !== true) return route
      let text = ''
      let blockText = ''
      try {
        for await (const chunk of llm().stream({
          provider: route.provider,
          model: route.model,
          messages,
          maxTokens,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            blockText += chunk.block.text
          }
          if (chunk?.type === 'finish' && chunk.reason === 'error') {
            return { ok: false, code: 'LLM_FINISH_ERROR', message: 'host LLM stream finished with error' }
          }
        }
      } catch (error) {
        return { ok: false, code: 'LLM_STREAM_ERROR', message: String(error?.message ?? error) }
      }
      return { ok: true, text: text !== '' ? text : blockText, model: route.model, usage: null }
    },
  }
}
