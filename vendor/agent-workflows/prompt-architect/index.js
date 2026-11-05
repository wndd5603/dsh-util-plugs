/**
 * Prompt Architect host plugin: exposes the workflow tools that disclose the
 * next step from the current phase and record empty-context subagent
 * verification. Mounted as a profile-level global row (global row), so blank and
 * any-preset sessions can use prompt_forge_*; the prompt-architect preset only
 * contributes persona/instructions. The bundled prompt-forge skill is
 * registered from this global plugin (single source).
 */
import { readFileSync } from 'node:fs'
import {
  advance,
  nextStep,
  resetSubagentRun,
  status,
  verifyDispatch,
  verifyRecord,
  verificationProtocol,
} from './src/core.js'
import { ARTIFACTS, DIMENSIONS } from './src/workflow.js'
import { boolean, number, string, defaultsOf, objectSchema } from '../lib/standard-schema.js'

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1, zero dependency). All keys are
 * optional; the host validates and fills defaults before `apply`.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the prompt_forge_* tools and the prompt-forge runtime skill.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  defaultWorkDir: string('', { description: 'Default project directory when a tool call omits projectDir (empty = session cwd).' }),
}, { description: 'Prompt Architect (prompt-forge) tool configuration.', schemaVersion: 1 })

export const inject = ['tools']

/** Minimal frontmatter reader: only `name` and `description` are needed. */
function readSkillMeta(text, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: fallbackName, description: '' }
  const nameMatch = /^name:\s*(.+)$/m.exec(match[1])
  const lines = match[1].split(/\r?\n/)
  const descriptionLines = []
  let capturing = false
  for (const line of lines) {
    const descriptionMatch = /^description:\s*(.*)$/.exec(line)
    if (descriptionMatch !== null) {
      const inline = descriptionMatch[1].trim()
      if (inline !== '' && inline !== '>-' && inline !== '|') descriptionLines.push(inline)
      capturing = true
      continue
    }
    if (capturing) {
      if (/^\S/.test(line) && line.trim() !== '') capturing = false
      else if (/^\s+\S/.test(line)) descriptionLines.push(line.trim())
    }
  }
  return {
    name: nameMatch === null ? fallbackName : nameMatch[1].trim(),
    description: descriptionLines.join(' ').trim(),
  }
}

/**
 * Register the bundled prompt-forge skill through the host skills service. The
 * skill lives inside this package (no absolute customSkillDirs, no junction), so
 * moving the install directory cannot silently lose it.
 */
function registerBundledSkill(ctx) {
  let service
  try { service = ctx.get?.('skills') } catch { service = undefined }
  if (service === undefined || typeof service.register !== 'function') {
    ctx.logger?.warn?.('[prompt-architect] skills service unavailable; register prompt-architect/skills manually')
    return false
  }
  try {
    const content = readFileSync(new URL('./skills/prompt-forge/SKILL.md', import.meta.url), 'utf8')
    const meta = readSkillMeta(content, 'prompt-forge')
    service.register({
      name: meta.name === '' ? 'prompt-forge' : meta.name,
      source: 'runtime',
      description: meta.description === '' ? 'Prompt Architect staged workflow skill' : meta.description,
      content,
    })
    return true
  } catch (error) {
    ctx.logger?.warn?.('[prompt-architect] runtime skill registration failed: ' + String(error))
    return false
  }
}

const toolOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Tool results must be lossless JSON: DSH rejects `undefined` object properties. */
const jsonSafe = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

const json = description => ({
  type: 'object',
  properties: {
    projectDir: {
      type: 'string',
      description: 'Absolute path to the working project. Defaults to the current session cwd when omitted.',
    },
    ...description,
  },
  additionalProperties: false,
})

export function apply(ctx, config) {
  config = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[prompt-architect] disabled by config (enabled=false); no tools/skill registered')
    return
  }
  const skillRegistered = registerBundledSkill(ctx)
  const configured = typeof config.defaultWorkDir === 'string' ? config.defaultWorkDir.trim() : ''

  /** Resolve the working project: explicit argument → config default → session cwd. */
  const resolveDir = (args, exec) => {
    const explicit = typeof args.projectDir === 'string' ? args.projectDir.trim() : ''
    if (explicit !== '') return explicit
    if (configured !== '') return configured
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
    throw new Error('projectDir is required (no session cwd available)')
  }

  ctx.tools.register({
    name: 'prompt_forge_status',
    description:
      'Read the Prompt Architect project state: current phase (S0–S7), recorded artifacts, verification runs, '
      + 'and the next phase. Call this first; it never writes files. Protocol: prompt-forge skill; '
      + 'S6 is an independent fresh-context subagent gate (see team-bootstrap §2 capability index).',
    parameters: json({}),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe({
        plugin: 'dsh-workflow-presets/prompt-architect',
        version: PLUGIN_VERSION,
        enabled: true,
        skill: { name: 'prompt-forge', registered: skillRegistered, source: 'runtime' },
        ...status(resolveDir(args, exec)),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Prompt forge status', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'prompt_forge_next',
    description:
      'Disclose the next-step workflow for the current phase: purpose, concrete steps, artifacts to produce, '
      + 'acceptance criteria, pitfalls, the exact advance call, and (at S6) the empty-context subagent '
      + 'verification protocol. Use it before acting so the flow never depends on memory.',
    parameters: json({}),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe(nextStep(resolveDir(args, exec)))
    },
    presentCall: () => ({ card: 'generic', title: 'Next workflow step', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'prompt_forge_advance',
    description:
      'Record the artifacts produced in the current phase and advance the state machine. Validates that every '
      + 'required artifact exists inside the project and is hashed; S6 additionally requires a recorded '
      + 'empty-context verification with no must-fix ❌ (or an explicit verifyFallbackReason). Refuses with the '
      + 'missing prerequisites instead of silently advancing.',
    parameters: json({
      artifacts: {
        type: 'object',
        description: 'Map of artifact key → project-relative or absolute file path produced in this phase. '
          + 'Allowed keys depend on the phase (see prompt_forge_next).',
        additionalProperties: { type: 'string' },
      },
      verifyFallbackReason: {
        type: 'string',
        description: 'S6 only: explicit reason for skipping empty-context subagent verification. Recorded in the ledger.',
      },
      note: { type: 'string', description: 'Optional free-form note stored in history.' },
    }),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe(advance(resolveDir(args, exec), {
        artifacts: args.artifacts ?? {},
        verifyFallbackReason: args.verifyFallbackReason,
        note: args.note,
      }))
    },
    presentCall: () => ({ card: 'generic', title: 'Advance workflow phase', kind: 'write' }),
  })

  ctx.tools.register({
    name: 'prompt_forge_verify_dispatch',
    description:
      'Build a self-contained, read-only verification packet for an empty-context subagent (all nine dimensions, '
      + 'JSON verdict schema, file:line evidence requirement). Returns packet text plus dispatch instructions: use '
      + 'the subagent tool (fresh context) and never subagent_fork. Available in S5/S6.',
    parameters: json({
      focus: { type: 'string', description: 'Optional focus for the verifier (e.g. one dimension or a risk area).' },
    }),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe(verifyDispatch(resolveDir(args, exec), { focus: args.focus }))
    },
    presentCall: () => ({ card: 'generic', title: 'Build verification packet', kind: 'write' }),
  })

  ctx.tools.register({
    name: 'prompt_forge_verify_record',
    description:
      'Record the verdicts returned by the empty-context subagent. Requires all nine dimensions; accepts '
      + 'pass|warn|fail or ✅/⚠️/❌; stores results.json and updates the verification summary used by the S6 gate.',
    parameters: json({
      runId: { type: 'string', description: 'runId returned by prompt_forge_verify_dispatch.' },
      verdicts: {
        type: 'array',
        description: 'One entry per dimension: { dimension, verdict, evidence, note }.',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', enum: DIMENSIONS.map(dim => dim.id) },
            verdict: { type: 'string' },
            evidence: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['dimension', 'verdict'],
          additionalProperties: false,
        },
      },
      mustFix: { type: 'array', items: { type: 'string' }, description: 'Optional must-fix list echoed from the verifier.' },
      notes: { type: 'string' },
    }),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe(verifyRecord(resolveDir(args, exec), {
        runId: args.runId,
        verdicts: args.verdicts,
        mustFix: args.mustFix,
        notes: args.notes,
      }))
    },
    presentCall: () => ({ card: 'generic', title: 'Record verification verdicts', kind: 'write' }),
  })

  ctx.tools.register({
    name: 'prompt_forge_reset_subagent',
    description:
      'Archive one verification run directory and close it (context hygiene). Fresh subagents are already '
      + 'per-call isolated; this never deletes session records and never touches any other session.',
    parameters: json({
      runId: { type: 'string', description: 'Verification run to archive.' },
      reason: { type: 'string', description: 'Optional reason recorded in the ledger.' },
    }),
    output: toolOutput,
    async execute(args, exec) {
      return jsonSafe(resetSubagentRun(resolveDir(args, exec), { runId: args.runId, reason: args.reason }))
    },
    presentCall: () => ({ card: 'generic', title: 'Archive verification run', kind: 'write' }),
  })

  // Surface the protocol and artifact vocabulary once for operators who inspect
  // the plugin through the host tool catalog.
  ctx.logger?.info?.('[prompt-architect] tools registered; protocol=' + JSON.stringify(verificationProtocol()).length + ' chars')
}

/** Artifact vocabulary for documentation/tests without mounting the host. */
export { ARTIFACTS, DIMENSIONS }
