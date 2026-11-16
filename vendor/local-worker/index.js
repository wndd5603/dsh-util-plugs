/**
 * dsh-local-worker — four small, bounded tools backed by a local
 * OpenAI-compatible LLM (Ollama / llama.cpp), plus a strict-JSON workflow.
 *
 * Design boundaries:
 * - no npm dependencies, no filesystem writes, no child processes;
 * - every tool returns a proposal/verdict object, never an action;
 * - all requests are bounded by timeoutMs/maxTokens and compact prompts.
 */
import { normalizeConfig } from './src/client.js'
import { createToolHandlers } from './src/tools.js'
import { number, objectSchema, string } from './lib/standard-schema.js'

/** @type {readonly string[]} */
export const inject = ['tools']

export const Config = objectSchema({
  endpoint: string('http://127.0.0.1:11435/v1', {
    description: 'OpenAI-compatible base URL, e.g. http://127.0.0.1:11435/v1. A root or /chat/completions URL is normalized to /v1.',
  }),
  model: string('qwen2.5-coder:0.5b', {
    description: 'Exact model id expected at GET <endpoint>/models and sent in chat requests.',
  }),
  timeoutMs: number(120_000, {
    description: 'Per-request HTTP timeout in milliseconds (1000..600000).',
    int: true,
    min: 1_000,
    max: 600_000,
  }),
  maxTokens: number(512, {
    description: 'Maximum completion tokens per local request (16..4096).',
    int: true,
    min: 16,
    max: 4_096,
  }),
}, {
  description: 'Local OpenAI-compatible worker: endpoint, model, timeout, and output budget.',
  schemaVersion: 1,
})

const outputDefinition = (properties = {}) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      code: { type: 'string' },
      message: { type: 'string' },
      ...properties,
    },
    required: ['ok'],
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const healthOutput = outputDefinition({
  reachable: { type: 'boolean' },
  endpoint: { type: 'string' },
  model: { type: 'string' },
  modelAvailable: { type: 'boolean' },
  models: { type: 'array', items: { type: 'string' } },
  latencyMs: { type: 'number' },
})

const planOutput = outputDefinition({
  plan: { type: 'object', additionalProperties: true },
  meta: { type: 'object', additionalProperties: true },
})

const transformOutput = outputDefinition({
  result: {},
  notes: { type: 'array', items: { type: 'string' } },
  meta: { type: 'object', additionalProperties: true },
})

const validateOutput = outputDefinition({
  verdict: { type: 'string', enum: ['pass', 'fail'] },
  pass: { type: 'boolean' },
  reasons: { type: 'array', items: { type: 'string' } },
  violations: { type: 'array', items: { type: 'object', additionalProperties: true } },
  meta: { type: 'object', additionalProperties: true },
})

/**
 * @param {import('@deepseek-ai/dsh-tools').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const handlers = createToolHandlers(cfg)
  const toolTimeoutMs = cfg.timeoutMs + 5_000

  ctx.tools.register({
    name: 'local_llm_health',
    description: 'Read-only health probe for the local OpenAI-compatible LLM: checks GET /v1/models '
      + 'and whether the configured model id is available. Does not load the model or change state. '
      + 'Use before local_task_* calls when the service may be down.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: healthOutput,
    execute: () => handlers.local_llm_health(),
    presentCall: () => ({ card: 'generic', title: 'Check local LLM health', kind: 'read' }),
    timeoutMs: Math.min(toolTimeoutMs, 20_000),
  })

  ctx.tools.register({
    name: 'local_task_plan',
    description: 'Ask the local model for a strict-JSON plan proposal for one scoped task. '
      + 'Returns {plan:{goal,steps[],assumptions[],needsClarification,questions[]}} and never writes '
      + 'files or executes commands. Pass only relevant context (first 6000 chars used, truncation is '
      + 'reported); use allowedSteps to constrain the proposal to approved steps. The result is a '
      + 'proposal that the calling agent must review.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'One scoped task, at most 4000 chars.' },
        context: {
          type: 'string',
          description: 'Optional relevant context (max 20000 chars accepted; only the first 6000 are sent).',
        },
        allowedSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional approved step names (max 12, each <=160 chars). The plan may only choose these.',
        },
        maxSteps: { type: 'integer', description: 'Maximum proposal steps, 1..8; default 5.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: planOutput,
    execute: args => handlers.local_task_plan(args),
    presentCall: () => ({ card: 'generic', title: 'Plan with local LLM', kind: 'read' }),
    timeoutMs: toolTimeoutMs,
  })

  ctx.tools.register({
    name: 'local_task_transform',
    description: 'Ask the local model to transform text into one bounded structured JSON result. '
      + 'Returns {result,notes[]}; it never writes files or runs commands. Text <=12000 chars, spec '
      + '<=2000 chars, optional schema <=4000 chars; the result is capped at 20000 chars. Use for '
      + 'extraction/normalization, not for open-ended generation.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Input text, at most 12000 chars.' },
        spec: { type: 'string', description: 'What to produce, at most 2000 chars.' },
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON-Schema-like shape hint for the result.',
        },
      },
      required: ['text', 'spec'],
      additionalProperties: false,
    },
    output: transformOutput,
    execute: args => handlers.local_task_transform(args),
    presentCall: () => ({ card: 'generic', title: 'Transform with local LLM', kind: 'read' }),
    timeoutMs: toolTimeoutMs,
  })

  ctx.tools.register({
    name: 'local_task_validate',
    description: 'Validate a result against a deterministic JSON-schema subset and/or semantic rules. '
      + 'Schema violations fail locally without a model call; semantic rules are judged by the local '
      + 'model and reported as {verdict,pass,reasons[],violations[]}. Read-only: never rewrites the '
      + 'result or executes commands. Result <=12000 chars; rules <=20 entries and 4000 chars.',
    parameters: {
      type: 'object',
      properties: {
        result: {
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'string' },
          ],
          description: 'The result to validate: a JSON object/array or a text/JSON string.',
        },
        schema: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON-Schema-like structural schema (type/properties/required/enum/items...).',
        },
        rules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional semantic rules, each a short sentence (max 20).',
        },
      },
      required: ['result'],
      additionalProperties: false,
    },
    output: validateOutput,
    execute: args => handlers.local_task_validate(args),
    presentCall: () => ({ card: 'generic', title: 'Validate with local LLM', kind: 'read' }),
    timeoutMs: toolTimeoutMs,
  })

  ctx.logger?.info?.(
    `[dsh-local-worker] ready endpoint=${cfg.endpoint} model=${cfg.model} `
    + `timeoutMs=${cfg.timeoutMs} maxTokens=${cfg.maxTokens} tools=4`,
  )
}
