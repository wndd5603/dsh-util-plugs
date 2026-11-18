/**
 * Read-only provider adapter for the sidecar.
 *
 * The main DSH environment explicitly hands over a descriptor; this module
 * never reads the main profile, session DB, or credentials file. Only the
 * named environment variable holds the secret.
 */
const DEFAULT_TIMEOUT_MS = 60_000

function safeString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function parseProviderConfig(raw) {
  if (safeString(raw) === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const baseUrl = safeString(parsed.baseUrl)
    const model = safeString(parsed.model)
    if (baseUrl === null || model === null) return null
    return {
      id: safeString(parsed.id) ?? 'subenv-provider',
      baseUrl: baseUrl.replace(/\/+$/u, ''),
      model,
      apiKeyEnv: safeString(parsed.apiKeyEnv) ?? 'SUBENV_API_KEY',
      allowLLM: parsed.allowLLM === true,
    }
  } catch {
    return null
  }
}

export function createProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = parseProviderConfig(env.SUBENV_PROVIDER_JSON)
  const apiKey = config === null ? null : safeString(env[config.apiKeyEnv])
  const enabled = config !== null && config.allowLLM === true && apiKey !== null && typeof fetchImpl === 'function'

  return {
    enabled,
    describe() {
      if (config === null) return { configured: false, llmEnabled: false }
      return {
        configured: true,
        id: config.id,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKeyEnv: config.apiKeyEnv,
        hasApiKey: apiKey !== null,
        llmEnabled: enabled,
      }
    },
    async chat({ messages, temperature = 0.2, maxTokens = 2048, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (config === null) return { ok: false, code: 'PROVIDER_NOT_CONFIGURED', message: 'SUBENV_PROVIDER_JSON is missing or invalid' }
      if (!config.allowLLM) return { ok: false, code: 'LLM_DISABLED', message: 'set SUBENV_ALLOW_LLM=1 / provider.allowLLM=true' }
      if (apiKey === null) return { ok: false, code: 'PROVIDER_NOT_CONFIGURED', message: 'API key environment variable is empty' }
      if (!Array.isArray(messages) || messages.length === 0) return { ok: false, code: 'INVALID_ARGUMENT', message: 'messages must be a non-empty array' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
      try {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: config.model, messages, temperature, max_tokens: maxTokens }),
          signal: controller.signal,
        })
        if (!response.ok) {
          return { ok: false, code: 'PROVIDER_HTTP_ERROR', message: `provider returned HTTP ${response.status}` }
        }
        const body = await response.json()
        const text = body?.choices?.[0]?.message?.content
        if (typeof text !== 'string') return { ok: false, code: 'PROVIDER_BAD_RESPONSE', message: 'provider response has no text' }
        return { ok: true, text, model: body?.model ?? config.model, usage: body?.usage ?? null }
      } catch (error) {
        return { ok: false, code: 'PROVIDER_ERROR', message: String(error?.message ?? error) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
