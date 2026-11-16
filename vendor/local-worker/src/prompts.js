/**
 * Prompt construction and strict output normalization for the four worker
 * tools. Prompts are deliberately small: one task, an explicit output shape,
 * and hard character budgets so a 7B model is not asked to swallow a whole
 * repository or to produce an unbounded answer.
 */
import { LocalLlmError } from './client.js'

export const LIMITS = Object.freeze({
  planTaskChars: 4_000,
  planContextChars: 6_000,
  planContextInputChars: 20_000,
  transformTextChars: 12_000,
  transformSpecChars: 2_000,
  transformSchemaChars: 4_000,
  validateResultChars: 12_000,
  validateRulesChars: 4_000,
  outputChars: 20_000,
  maxSteps: 8,
  maxPromptChars: 20_000,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value, maxChars) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function stringList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    const text = cleanString(item, maxChars)
    if (text !== '' && !result.includes(text)) result.push(text)
    if (result.length >= maxItems) break
  }
  return result
}

/**
 * Keep an explicitly marked prefix instead of silently truncating. The marker
 * is fixed-length so the returned text never exceeds `maxChars`.
 */
export function compactText(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  const originalChars = text.length
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, usedChars: originalChars }
  }
  const marker = '\n[TRUNCATED]'
  const keep = Math.max(0, maxChars - marker.length)
  return {
    text: text.slice(0, keep) + marker,
    truncated: true,
    originalChars,
    usedChars: keep + marker.length,
  }
}

export function promptChars(messages) {
  return messages.reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : 0), 0)
}

function invalidModelOutput(message, details = {}) {
  return new LocalLlmError('INVALID_MODEL_OUTPUT', message, details)
}

/**
 * Validate and normalize the model's plan. The model is a proposal source, so
 * structural drift is rejected rather than repaired silently; only harmless
 * things (step ids, excess steps, case of allowedStep) are normalized.
 */
export function normalizePlan(value, { maxSteps = 5, allowedSteps = [] } = {}) {
  if (!isPlainObject(value)) throw invalidModelOutput('plan must be a JSON object')
  const goal = cleanString(value.goal, 300)
  if (goal === '') throw invalidModelOutput('plan.goal must be a non-empty string')
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw invalidModelOutput('plan.steps must be a non-empty array')
  }

  const steps = []
  for (const raw of value.steps.slice(0, maxSteps)) {
    if (!isPlainObject(raw)) throw invalidModelOutput('each plan step must be an object')
    const title = cleanString(raw.title, 160) || cleanString(raw.action, 160)
    const action = cleanString(raw.action, 400) || title
    if (title === '') throw invalidModelOutput('each plan step needs a title')
    const output = cleanString(raw.output ?? raw.expectedOutput, 200)
    let allowedStep = null
    if (allowedSteps.length > 0) {
      const candidate = cleanString(raw.allowedStep, 160)
      const match = allowedSteps.find(item => item === candidate)
        ?? allowedSteps.find(item => item.toLowerCase() === candidate.toLowerCase())
        ?? allowedSteps.find(item => item.toLowerCase() === title.toLowerCase())
      if (match === undefined) {
        throw invalidModelOutput(
          `plan step "${title}" is not one of allowedSteps; allowedStep must be an exact listed value`,
          { allowedSteps },
        )
      }
      allowedStep = match
    } else if (typeof raw.allowedStep === 'string') {
      allowedStep = cleanString(raw.allowedStep, 160) || null
    }
    steps.push({ id: steps.length + 1, title, action, output, allowedStep })
  }

  const needsClarification = value.needsClarification === true
  const questions = needsClarification ? stringList(value.questions, 5, 200) : []
  return {
    goal,
    steps,
    assumptions: stringList(value.assumptions, 8, 200),
    needsClarification,
    questions,
  }
}

/** Validate the model's transform envelope and enforce a bounded result. */
export function normalizeTransform(value) {
  if (!isPlainObject(value)) throw invalidModelOutput('transform output must be a JSON object')
  let result = Object.hasOwn(value, 'result') ? value.result : value
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result)
    } catch {
      throw invalidModelOutput('transform result is a string but not valid JSON')
    }
  }
  if (!isPlainObject(result) && !Array.isArray(result)) {
    throw invalidModelOutput('transform result must be a JSON object or array')
  }
  const serialized = JSON.stringify(result)
  if (serialized.length > LIMITS.outputChars) {
    throw new LocalLlmError('OUTPUT_TOO_LARGE', `transform result is ${serialized.length} chars; limit is ${LIMITS.outputChars}`)
  }
  return { result, notes: stringList(value.notes, 8, 200) }
}

/** Validate the model's pass/fail verdict. */
export function normalizeVerdict(value) {
  if (!isPlainObject(value)) throw invalidModelOutput('validation verdict must be a JSON object')
  let pass = value.pass
  if (typeof pass !== 'boolean' && typeof value.verdict === 'string') {
    const verdict = value.verdict.trim().toLowerCase()
    if (verdict === 'pass' || verdict === 'passed' || verdict === 'ok') pass = true
    else if (verdict === 'fail' || verdict === 'failed') pass = false
  }
  if (typeof pass !== 'boolean') throw invalidModelOutput('validation verdict needs a boolean "pass" field')
  const reasons = stringList(value.reasons, 12, 300)
  if (!pass && reasons.length === 0) reasons.push('model reported failure without a reason')
  const violations = []
  if (Array.isArray(value.violations)) {
    for (const item of value.violations) {
      if (violations.length >= 20) break
      if (!isPlainObject(item)) continue
      const path = cleanString(item.path, 200) || '$'
      const message = cleanString(item.message, 300)
      if (message !== '') violations.push({ path, message })
    }
  }
  return { pass, reasons, violations }
}

/** Parse a JSON string result for schema validation; otherwise keep text. */
export function parseResultInput(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return value
      }
    }
  }
  return value
}

/** Serialize a result for the validator prompt, preserving plain text. */
export function resultToText(value) {
  if (typeof value === 'string') return value
  const serialized = JSON.stringify(value)
  return typeof serialized === 'string' ? serialized : ''
}

const PLAN_OUTPUT_EXAMPLE = '{"goal":"...","steps":[{"id":1,"title":"...","action":"...","output":"...","allowedStep":null}],"assumptions":["..."],"needsClarification":false,"questions":["..."]}'

export function buildPlanMessages({ task, context = '', allowedSteps = [], maxSteps = 5 }) {
  const rules = [
    `Use 1 to ${maxSteps} steps; prefer 3 or fewer. Each step must be one small, checkable action.`,
    'Never claim the work is already done; this is a proposal only.',
    'Do not invent files, commands, or results you cannot know.',
    'Keep title <= 80 chars, action <= 200 chars, output <= 120 chars.',
  ]
  if (allowedSteps.length > 0) {
    rules.push(`allowedStep MUST be exactly one of these strings: ${JSON.stringify(allowedSteps)}`)
    rules.push('Choose only steps from that list; do not add new step names.')
  } else {
    rules.push('allowedStep MUST be null.')
  }
  const system = [
    'You are a local planning worker inside a coding harness.',
    'You cannot execute tools, write files, or run commands. Return a plan proposal only.',
    'Return exactly one JSON object and nothing else. No markdown fences, no commentary.',
    'Output shape:',
    PLAN_OUTPUT_EXAMPLE,
    'Rules:',
    ...rules.map(rule => `- ${rule}`),
  ].join('\n')

  const user = [
    'TASK:',
    task,
    ...(context === '' ? [] : ['', 'CONTEXT (possibly truncated; use only what is relevant):', context]),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildTransformMessages({ text, spec, schema }) {
  const system = [
    'You are a local transformation worker inside a coding harness.',
    'You cannot execute tools, write files, or run commands.',
    'Return exactly one JSON object and nothing else. No markdown fences, no commentary.',
    'Output shape:',
    '{"result":{...},"notes":["..."]}',
    'Rules:',
    '- "result" MUST be a JSON object or array that follows SPEC and SCHEMA.',
    '- Keep the result small (at most 3000 characters) and deterministic.',
    '- Use null for unknown facts instead of inventing values; explain gaps in notes.',
    '- Do not rewrite the input into prose; produce structured data only.',
  ].join('\n')
  const user = [
    'SPEC:',
    spec,
    '',
    'SCHEMA (optional shape hint):',
    schema === '' ? '(none)' : schema,
    '',
    'TEXT:',
    text,
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildValidateMessages({ rules, resultText }) {
  const system = [
    'You are a strict validation worker inside a coding harness.',
    'You cannot modify the result, execute tools, write files, or run commands.',
    'Return exactly one JSON object and nothing else. No markdown fences, no commentary.',
    'Output shape:',
    '{"pass":true,"reasons":["..."],"violations":[{"path":"$","message":"..."}]}',
    'Rules:',
    '- Set pass=false if any rule is violated or cannot be verified from the result.',
    '- Be conservative: do not assume missing data.',
    '- Use short reasons and path values like "$.field".',
    '- Do not rewrite the result and do not add prose outside JSON.',
  ].join('\n')
  const user = [
    'RULES (JSON array):',
    JSON.stringify(rules),
    '',
    'RESULT:',
    resultText,
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
