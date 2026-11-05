#!/usr/bin/env node
/**
 * Prompt Architect CLI — the same core as the preset tools, usable without the
 * host (for tests, and so an empty-context verifier can inspect state directly).
 *
 * Usage:
 *   prompt-forge status            --project <dir> [--json]
 *   prompt-forge next              --project <dir> [--json]
 *   prompt-forge advance           --project <dir> --artifacts '<json>'
 *   prompt-forge verify-dispatch   --project <dir> [--focus <text>] [--json]
 *   prompt-forge verify-record     --project <dir> --run <id> --verdicts '<json>'
 *   prompt-forge reset-subagent    --project <dir> --run <id> [--reason <text>]
 *   prompt-forge artifacts
 */
import { advance, nextStep, resetSubagentRun, status, verifyDispatch, verifyRecord, artifactChecklist } from '../src/core.js'

const args = process.argv.slice(2)
const command = args[0]
const valueOf = name => {
  const index = args.indexOf('--' + name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}
const jsonOut = args.includes('--json')

function print(value) {
  if (jsonOut) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
    return
  }
  console.log(JSON.stringify(value, null, 2))
}

function projectDir() {
  const dir = valueOf('project')
  if (dir === undefined) {
    console.error('error: --project <absolute dir> is required')
    process.exit(2)
  }
  return dir
}

function parseJsonFlag(name) {
  const raw = valueOf(name)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error('error: --' + name + ' must be valid JSON: ' + String(error))
    process.exit(2)
  }
}

try {
  switch (command) {
    case 'status':
      print(status(projectDir()))
      break
    case 'next':
      print(nextStep(projectDir()))
      break
    case 'advance': {
      const artifacts = parseJsonFlag('artifacts') ?? {}
      print(advance(projectDir(), {
        artifacts,
        verifyFallbackReason: valueOf('verify-fallback-reason'),
        note: valueOf('note'),
      }))
      break
    }
    case 'verify-dispatch':
      print(verifyDispatch(projectDir(), { focus: valueOf('focus') }))
      break
    case 'verify-record':
      print(verifyRecord(projectDir(), {
        runId: valueOf('run'),
        verdicts: parseJsonFlag('verdicts') ?? [],
        notes: valueOf('notes'),
      }))
      break
    case 'reset-subagent':
      print(resetSubagentRun(projectDir(), { runId: valueOf('run'), reason: valueOf('reason') }))
      break
    case 'artifacts':
      print(artifactChecklist())
      break
    default:
      console.error('usage: prompt-forge <status|next|advance|verify-dispatch|verify-record|reset-subagent|artifacts> [options]')
      process.exit(2)
  }
} catch (error) {
  console.error('error: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
