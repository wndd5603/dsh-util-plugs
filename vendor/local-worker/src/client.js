/**
 * Zero-dependency OpenAI-compatible client for a local llama.cpp/Ollama server.
 *
 * The plugin never shells out and never touches the filesystem: every operation
 * here is a bounded HTTP request to the configured endpoint. Keeping the client
 * independent of Cordis makes the tool handlers directly unit-testable against
 * a mock HTTP server.
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11435/v1'
const DEFAULT_MODEL = 'qwen2.5-coder:0.5b'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TOKENS = 512
const MAX_ERROR_EXCERPT = 600
const MAX_HEALTH_MODELS = 20

/** Structured failure that tool handlers turn into `{ok:false, code, message}`. */
export class LocalLlmError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details] small JSON-safe details
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LocalLlmError'
    this.code = code
    this.details = details
  }
}

function excerpt(value, max = MAX_ERROR_EXCERPT) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Normalize an OpenAI-compatible base URL. Accepts a root, `/v1`, or a full
 * `/v1/chat/completions` URL and always returns the `/v1` root without a
 * trailing slash. Query strings and fragments are dropped.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeEndpoint(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') throw new LocalLlmError('INVALID_ENDPOINT', 'endpoint must not be empty')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new LocalLlmError('INVALID_ENDPOINT', `endpoint is not a valid URL: ${excerpt(value, 200)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalLlmError('INVALID_ENDPOINT', 'endpoint must use http:// or https://')
  }
  if (url.username !== '' || url.password !== '') {
    throw new LocalLlmError('INVALID_ENDPOINT', 'endpoint must not embed credentials')
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length)
  if (!path.endsWith('/v1')) path = `${path}/v1`
  if (!path.startsWith('/')) path = `/${path}`
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

/**
 * Validate and clamp the four documented configuration fields.
 * @param {Record<string, unknown>} [raw]
 * @returns {{endpoint: string, model: string, timeoutMs: number, maxTokens: number}}
 */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const endpoint = normalizeEndpoint(
    typeof source.endpoint === 'string' && source.endpoint.trim() !== ''
      ? source.endpoint
      : DEFAULT_ENDPOINT,
  )
  const model = typeof source.model === 'string' && source.model.trim() !== ''
    ? source.model.trim()
    : DEFAULT_MODEL
  return Object.freeze({
    endpoint,
    model,
    timeoutMs: clampInt(source.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 600_000),
    maxTokens: clampInt(source.maxTokens, DEFAULT_MAX_TOKENS, 16, 4_096),
  })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findJsonSlice(text, start) {
  const stack = []
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      const open = stack.pop()
      const expected = char === '}' ? '{' : '['
      if (open !== expected) return null
      if (stack.length === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

/**
 * Extract one JSON object from model text. Tolerates markdown fences and short
 * prose before/after the object, but rejects arrays, scalars, and truncated
 * JSON instead of guessing.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function extractJsonObject(text) {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '').trim() : ''
  if (source === '') {
    throw new LocalLlmError('INVALID_MODEL_JSON', 'model returned empty content')
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : source
  const start = body.search(/[\[{]/)
  if (start < 0) {
    throw new LocalLlmError('INVALID_MODEL_JSON', 'model response contains no JSON object', {
      excerpt: excerpt(source),
    })
  }
  const candidate = findJsonSlice(body, start)
  if (candidate === null) {
    throw new LocalLlmError('INVALID_MODEL_JSON', 'model returned unbalanced/truncated JSON', {
      excerpt: excerpt(source),
    })
  }
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    throw new LocalLlmError('INVALID_MODEL_JSON', `model returned invalid JSON: ${error.message}`, {
      excerpt: excerpt(candidate),
    })
  }
  if (!isPlainObject(parsed)) {
    throw new LocalLlmError('INVALID_MODEL_OUTPUT', 'model JSON must be an object', {
      excerpt: excerpt(candidate),
    })
  }
  return parsed
}

function sanitizeUsage(usage) {
  if (!isPlainObject(usage)) return null
  const result = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) result[key] = usage[key]
  }
  return Object.keys(result).length > 0 ? result : null
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (isPlainObject(part) && typeof part.text === 'string') return part.text
      return ''
    }).join('')
  }
  return ''
}

function modelMatches(available, wanted) {
  if (typeof available !== 'string' || typeof wanted !== 'string') return false
  const left = available.trim().toLowerCase()
  const right = wanted.trim().toLowerCase()
  if (left === right) return true
  // An untagged requested model matches any tag of that family; a tagged
  // request must match exactly so health cannot claim the wrong quantization.
  if (!right.includes(':')) return left.split(':')[0] === right
  return false
}

/**
 * Bounded JSON request. The abort timer covers connect, headers, and body.
 * @param {string} url
 * @param {{method?: string, body?: unknown, timeoutMs: number}} options
 */
async function requestJson(url, { method = 'GET', body, timeoutMs } = {}) {
  const timeout = clampInt(timeoutMs, DEFAULT_TIMEOUT_MS, 200, 600_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const started = Date.now()
  try {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new LocalLlmError('HTTP_ERROR', `local LLM returned HTTP ${response.status}`, {
        status: response.status,
        endpoint: url,
        excerpt: excerpt(text),
      })
    }
    if (text.trim() === '') {
      throw new LocalLlmError('INVALID_JSON_RESPONSE', 'local LLM returned an empty HTTP body', {
        status: response.status,
        endpoint: url,
      })
    }
    let json
    try {
      json = JSON.parse(text)
    } catch (error) {
      throw new LocalLlmError('INVALID_JSON_RESPONSE', `local LLM returned non-JSON HTTP body: ${error.message}`, {
        status: response.status,
        endpoint: url,
        excerpt: excerpt(text),
      })
    }
    return { json, text, status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    if (error instanceof LocalLlmError) throw error
    if (controller.signal.aborted) {
      throw new LocalLlmError('TIMEOUT', `local LLM request timed out after ${timeout} ms`, {
        timeoutMs: timeout,
        endpoint: url,
      })
    }
    throw new LocalLlmError('UNREACHABLE', `cannot reach local LLM at ${url}: ${excerpt(error?.message ?? error, 300)}`, {
      endpoint: url,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a client bound to one normalized configuration.
 * @param {Record<string, unknown>} [rawConfig]
 */
export function createLocalClient(rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  async function listModels() {
    const { json, latencyMs } = await requestJson(`${config.endpoint}/models`, {
      timeoutMs: Math.min(config.timeoutMs, 10_000),
    })
    const entries = Array.isArray(json?.data) ? json.data : []
    const models = entries
      .map(entry => (isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null))
      .filter(Boolean)
    return { models, latencyMs }
  }

  async function chat(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LocalLlmError('INVALID_ARGS', 'messages must be a non-empty array')
    }
    const maxTokens = clampInt(options.maxTokens, config.maxTokens, 16, 4_096)
    const body = {
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
      response_format: { type: 'json_object' },
    }
    const { json, latencyMs } = await requestJson(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      body,
      timeoutMs: config.timeoutMs,
    })
    const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined
    const text = messageText(choice?.message?.content).trim()
    if (text === '') {
      throw new LocalLlmError('INVALID_MODEL_OUTPUT', 'local LLM returned no assistant content', {
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      })
    }
    return {
      text,
      usage: sanitizeUsage(json?.usage),
      model: typeof json?.model === 'string' && json.model !== '' ? json.model : config.model,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      latencyMs,
    }
  }

  async function chatJson(messages, options = {}) {
    const result = await chat(messages, options)
    return { ...result, value: extractJsonObject(result.text) }
  }

  async function health() {
    const started = Date.now()
    try {
      const { models, latencyMs } = await listModels()
      const modelAvailable = models.some(id => modelMatches(id, config.model))
      return {
        ok: modelAvailable,
        reachable: true,
        endpoint: config.endpoint,
        model: config.model,
        modelAvailable,
        modelCount: models.length,
        models: models.slice(0, MAX_HEALTH_MODELS),
        latencyMs: latencyMs ?? Date.now() - started,
        ...(modelAvailable
          ? {}
          : {
              code: 'MODEL_NOT_FOUND',
              message: `service is reachable but model "${config.model}" is not listed by ${config.endpoint}/models`,
              hint: 'pull/download the model or set config.model to one of the listed ids',
            }),
      }
    } catch (error) {
      if (!(error instanceof LocalLlmError)) {
        return {
          ok: false,
          reachable: false,
          endpoint: config.endpoint,
          model: config.model,
          modelAvailable: false,
          models: [],
          latencyMs: Date.now() - started,
          code: 'INTERNAL_ERROR',
          message: String(error?.message ?? error),
        }
      }
      return {
        ok: false,
        reachable: error.code !== 'UNREACHABLE',
        endpoint: config.endpoint,
        model: config.model,
        modelAvailable: false,
        models: [],
        latencyMs: Date.now() - started,
        code: error.code,
        message: error.message,
        ...(typeof error.details?.hint === 'string' ? { hint: error.details.hint } : {}),
      }
    }
  }

  return Object.freeze({ config, chat, chatJson, listModels, health })
}
