/**
 * Tool handlers for dsh-local-worker. Every handler is a pure async function
 * over `(args)`; registration lives in index.js. This separation keeps the
 * unit tests independent of Cordis and guarantees the handlers cannot touch
 * the filesystem or spawn processes.
 */
import { LocalLlmError, createLocalClient } from './client.js'
import { validateJsonSchema } from './jsonschema.js'
import {
  LIMITS,
  buildPlanMessages,
  buildTransformMessages,
  buildValidateMessages,
  compactText,
  normalizePlan,
  normalizeTransform,
  normalizeVerdict,
  parseResultInput,
  promptChars,
  resultToText,
} from './prompts.js'

export const WORKER_TOOL_NAMES = Object.freeze([
  'local_llm_health',
  'local_task_plan',
  'local_task_transform',
  'local_task_validate',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function asArgs(args) {
  return isPlainObject(args) ? args : {}
}

function invalidArgs(message) {
  return { ok: false, code: 'INVALID_ARGS', message }
}

function tooLarge(field, actual, limit) {
  return {
    ok: false,
    code: 'INPUT_TOO_LARGE',
    message: `${field} is ${actual} chars; limit is ${limit}. Split the input or summarize it first.`,
  }
}

function callMeta(config, result, started, extra = {}) {
  return {
    model: result?.model ?? config.model,
    elapsedMs: Date.now() - started,
    serverLatencyMs: typeof result?.latencyMs === 'number' ? result.latencyMs : null,
    completionTokens: typeof result?.usage?.completion_tokens === 'number' ? result.usage.completion_tokens : null,
    ...extra,
  }
}

function failure(config, error, started, extra = {}) {
  const base = { ok: false, model: config.model, elapsedMs: Date.now() - started, ...extra }
  if (error instanceof LocalLlmError) {
    return {
      ...base,
      code: error.code,
      message: error.message,
      ...(typeof error.details?.excerpt === 'string' ? { detail: error.details.excerpt } : {}),
      ...(typeof error.details?.status === 'number' ? { httpStatus: error.details.status } : {}),
    }
  }
  return { ...base, code: 'INTERNAL_ERROR', message: String(error?.message ?? error) }
}

function checkPromptBudget(messages) {
  const chars = promptChars(messages)
  if (chars > LIMITS.maxPromptChars) {
    throw new LocalLlmError(
      'INPUT_TOO_LARGE',
      `prompt is ${chars} chars; limit is ${LIMITS.maxPromptChars}. Shorten the input or split the task.`,
    )
  }
  return chars
}

/**
 * Build the four handlers against one config. `fetch` stays the global Node
 * implementation; no shell, filesystem, or Cordis service is used.
 * @param {Record<string, unknown>} [rawConfig]
 */
export function createToolHandlers(rawConfig = {}) {
  const client = createLocalClient(rawConfig)
  const config = client.config

  async function localLlmHealth() {
    return client.health()
  }

  async function localTaskPlan(rawArgs) {
    const started = Date.now()
    const args = asArgs(rawArgs)
    try {
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (task === '') return invalidArgs('task must be a non-empty string')
      if (task.length > LIMITS.planTaskChars) return tooLarge('task', task.length, LIMITS.planTaskChars)

      if (args.allowedSteps !== undefined && !Array.isArray(args.allowedSteps)) {
        return invalidArgs('allowedSteps must be an array of strings')
      }
      const allowedSteps = []
      if (Array.isArray(args.allowedSteps)) {
        if (args.allowedSteps.length > 12) return invalidArgs('allowedSteps supports at most 12 entries')
        for (const item of args.allowedSteps) {
          if (typeof item !== 'string') return invalidArgs('allowedSteps must contain only strings')
          const value = item.replace(/\s+/g, ' ').trim()
          if (value === '') continue
          if (value.length > 160) return invalidArgs('each allowedStep must be at most 160 chars')
          if (!allowedSteps.includes(value)) allowedSteps.push(value)
        }
      }

      const maxSteps = clampInt(args.maxSteps, 5, 1, LIMITS.maxSteps)
      const rawContext = typeof args.context === 'string' ? args.context : ''
      const context = compactText(rawContext, LIMITS.planContextChars)
      const messages = buildPlanMessages({ task, context: context.text, allowedSteps, maxSteps })
      const promptLength = checkPromptBudget(messages)
      const response = await client.chatJson(messages)
      const plan = normalizePlan(response.value, { maxSteps, allowedSteps })
      return {
        ok: true,
        plan,
        meta: callMeta(config, response, started, {
          promptChars: promptLength,
          context: {
            originalChars: context.originalChars,
            usedChars: context.usedChars,
            truncated: context.truncated,
          },
        }),
      }
    } catch (error) {
      return failure(config, error, started)
    }
  }

  async function localTaskTransform(rawArgs) {
    const started = Date.now()
    const args = asArgs(rawArgs)
    try {
      const text = typeof args.text === 'string' ? args.text : ''
      const spec = typeof args.spec === 'string' ? args.spec.trim() : ''
      if (text.trim() === '') return invalidArgs('text must be a non-empty string')
      if (spec === '') return invalidArgs('spec must be a non-empty string')
      if (text.length > LIMITS.transformTextChars) {
        return tooLarge('text', text.length, LIMITS.transformTextChars)
      }
      if (spec.length > LIMITS.transformSpecChars) {
        return tooLarge('spec', spec.length, LIMITS.transformSpecChars)
      }
      if (args.schema !== undefined && !isPlainObject(args.schema)) {
        return invalidArgs('schema must be a JSON object when provided')
      }
      const schemaText = args.schema === undefined ? '' : JSON.stringify(args.schema)
      if (schemaText.length > LIMITS.transformSchemaChars) {
        return tooLarge('schema', schemaText.length, LIMITS.transformSchemaChars)
      }
      const messages = buildTransformMessages({ text, spec, schema: schemaText })
      const promptLength = checkPromptBudget(messages)
      const response = await client.chatJson(messages)
      const { result, notes } = normalizeTransform(response.value)
      return {
        ok: true,
        result,
        notes,
        meta: callMeta(config, response, started, {
          promptChars: promptLength,
          inputChars: text.length,
          resultChars: JSON.stringify(result).length,
        }),
      }
    } catch (error) {
      return failure(config, error, started)
    }
  }

  async function localTaskValidate(rawArgs) {
    const started = Date.now()
    const args = asArgs(rawArgs)
    try {
      if (args.result === undefined) return invalidArgs('result is required (object or JSON/text string)')
      if (args.schema !== undefined && !isPlainObject(args.schema)) {
        return invalidArgs('schema must be a JSON object when provided')
      }
      if (args.rules !== undefined && !Array.isArray(args.rules)) {
        return invalidArgs('rules must be an array of strings')
      }
      const rules = []
      if (Array.isArray(args.rules)) {
        if (args.rules.length > 20) return invalidArgs('rules supports at most 20 entries')
        for (const rule of args.rules) {
          if (typeof rule !== 'string' || rule.trim() === '') {
            return invalidArgs('rules must contain only non-empty strings')
          }
          rules.push(rule.trim())
        }
      }
      const hasSchema = args.schema !== undefined
      if (!hasSchema && rules.length === 0) {
        return invalidArgs('provide schema, rules, or both')
      }
      const rulesText = JSON.stringify(rules)
      if (rulesText.length > LIMITS.validateRulesChars) {
        return tooLarge('rules', rulesText.length, LIMITS.validateRulesChars)
      }

      const parsed = parseResultInput(args.result)
      const resultText = resultToText(parsed)
      if (resultText === '') return invalidArgs('result is empty')
      if (resultText.length > LIMITS.validateResultChars) {
        return tooLarge('result', resultText.length, LIMITS.validateResultChars)
      }

      const schemaViolations = hasSchema ? validateJsonSchema(parsed, args.schema) : []
      if (schemaViolations.length > 0) {
        return {
          ok: true,
          verdict: 'fail',
          pass: false,
          reasons: schemaViolations.map(item => `${item.path}: ${item.message}`),
          violations: schemaViolations,
          meta: {
            model: config.model,
            elapsedMs: Date.now() - started,
            source: 'schema',
            schemaChecked: true,
            modelCalls: 0,
          },
        }
      }

      if (rules.length === 0) {
        return {
          ok: true,
          verdict: 'pass',
          pass: true,
          reasons: ['JSON schema satisfied locally'],
          violations: [],
          meta: {
            model: config.model,
            elapsedMs: Date.now() - started,
            source: 'schema',
            schemaChecked: true,
            modelCalls: 0,
          },
        }
      }

      const messages = buildValidateMessages({ rules, resultText })
      const promptLength = checkPromptBudget(messages)
      const response = await client.chatJson(messages)
      const verdict = normalizeVerdict(response.value)
      return {
        ok: true,
        verdict: verdict.pass ? 'pass' : 'fail',
        pass: verdict.pass,
        reasons: verdict.reasons.length > 0
          ? verdict.reasons
          : [verdict.pass ? 'model validation passed' : 'model validation failed'],
        violations: verdict.violations,
        meta: callMeta(config, response, started, {
          promptChars: promptLength,
          source: 'model',
          schemaChecked: hasSchema,
          modelCalls: 1,
        }),
      }
    } catch (error) {
      return failure(config, error, started)
    }
  }

  return Object.freeze({
    config,
    client,
    local_llm_health: localLlmHealth,
    local_task_plan: localTaskPlan,
    local_task_transform: localTaskTransform,
    local_task_validate: localTaskValidate,
  })
}
