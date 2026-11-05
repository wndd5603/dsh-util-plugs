/**
 * dsh-restart — restart the DeepSeek Harness Host from inside a conversation,
 * then come back to the work without a human typing "continue".
 *
 * Windows-first: there is no systemd `Restart=always`, so the plugin ships its
 * own detached supervisor. The tool itself never kills anything:
 *
 *   1. WARNING call (no `confirm`): read-only preflight. Lists live sessions;
 *      any session other than the caller with `status === 'running'` blocks the
 *      restart. On success it returns a 12-hex token (TTL 120 s) and persists
 *      the warning's plan to the pending record (memory + disk). It also prints
 *      `hostProcessChain` (Host pid + command line, parent pid/command line via
 *      a best-effort local probe, and what a direct kill would cost) plus the
 *      Host PID's last 4 digits, which the confirmation must echo back.
 *   2. CONFIRM call (`confirm=<token>` + `confirmPidSuffix=<pid last 4>`):
 *      validates both gates (a missing/wrong suffix refuses without consuming
 *      the token). A REAL restart additionally requires `allowRealRestart:true`
 *      (default FALSE, safety double-lock): otherwise the confirmation is
 *      refused before any side effect (no token consumption, no handoff, no
 *      spawn, no exit) — dryRun is unaffected. The plan from the pending record
 *      is then executed, never the new arguments. The handoff record carries
 *      `execPath`, `execArgv` (Node flags such as `--import tsx/esm`, which are
 *      NOT in process.argv — see the P0 incident note) and `argv`; the detached
 *      supervisor is spawned and only then `process.exit(0)` is scheduled so the
 *      tool result reaches the caller first.
 *   3. REPLAY (next boot): if a fresh handoff record exists, the plugin waits
 *      `resumeSettleMs`, resumes the sessions that were running, and wakes the
 *      requesting session with `continuePrompt`. The record is deleted once.
 *      Legacy v1 handoffs (missing `execArgv`) are refused and discarded.
 *   4. AUDIT: every decision appends one JSONL line to
 *      `<handoffDir>/audit.jsonl` (default on): warning/blocked/locked from
 *      step 1 and refused/confirmed/dry-run from step 2, with a `decision`,
 *      `actor` ('tool' or 'ui'), the caller, blocker/wake counts, the Host PID
 *      suffix and `allowRealRestart` — never the token.
 *   5. HOST REMOTE (task-88): the Web conversation-header button uses three
 *      source-mode Remote methods on a `relaunchRemote` Cordis Service:
 *      `relaunch/status` (read-only), `relaunch/prepare` (same warning preflight;
 *      locked/blocked returns no token) and `relaunch/confirm` (same token/
 *      pidSuffix/blocker/lock gates + existing supervisor). Remote calls audit
 *      `actor:'ui'`; the model-facing `restart_dsh` tool keeps `actor:'tool'`.
 *
 * Step-1 warnings also count how many sessions a restart would wake
 * (`wakeCount`) versus idle sessions it would leave asleep (`idleCount`), and
 * blockers carry a best-effort Team member `name`/`role` when
 * `agentTeams.membership(agent)` can resolve the blocking session.
 *
 * The supervisor (supervisor.cjs, written next to the handoff record) polls the
 * old Host pid, waits for it to exit, then relaunches
 * `spawn(execPath, [...execArgv, ...argv], {cwd})`, health-checks the fresh
 * Host for >= 8 s, retries up to 5 times (3 s apart) on an early exit, and
 * writes `restart-failed.json` with the per-attempt exit code/stderr evidence
 * if every attempt fails. `verify-relaunch.mjs` proves this end-to-end on a
 * spare port (13081) without touching the live Host (13080).
 *
 * Fence: `tools/pre-execute` denies shell commands that look like they kill
 * node/the Host and points the model at `restart_dsh` instead. It judges
 * execution channels only (bash/pwsh/shell/cmd), never data payloads.
 *
 * Zero npm dependencies; Node >= 24, ESM.
 */

import { execFileSync as nodeExecFileSync, spawn as nodeSpawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { boolean, number, string, any, enumOf, defaultsOf, objectSchema, fieldDocs } from './lib/standard-schema.js'

export const inject = ['tools', 'agents']

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1 + native Schemastery graph, so
 * the Web settings form projects a real form). All keys optional; defaults live
 * here and `cordis.patch.yml` only lists deviations.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the restart_dsh tool and its fence. false = plugin does nothing.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  pendingTtlMs: number(120000, { description: 'Confirmation-token TTL (single-use token).', int: true, min: 1 }),
  handoffTtlMs: number(1800000, { description: 'Older handoff records are stale and not replayed.', int: true, min: 1 }),
  resumeSettleMs: number(3000, { description: 'Wait after boot before replaying a handoff.', int: true, min: 0 }),
  autoResume: boolean(true, { description: 'Replay a pending handoff on boot.' }),
  fence: boolean(true, { description: 'Deny shell commands that would kill the Host.' }),
  audit: boolean(true, { description: 'Append one JSONL audit line per decision (never contains the token).' }),
  allowRealRestart: boolean(false, { description: 'SAFETY DOUBLE-LOCK. false refuses a real (non-dryRun) restart. Enable only after verify-relaunch passed and the author approved; keep drill values in the machine-local profile override.', volatile: true }),
  diagnostics: enumOf('redacted', ['redacted', 'full'], { description: "Diagnostic output mode: 'redacted' (default) masks the home directory/user segment in host/process command lines; 'full' prints raw paths." }),
  dshHome: string('', { description: 'DSH home override; empty = DSH_HOME env or ~/.dsh.' }),
  handoffDir: string('', { description: 'Handoff/audit directory override; empty = <dshHome>/restart.' }),
  auditFile: string('', { description: 'Audit JSONL override; empty = <handoffDir>/audit.jsonl.' }),
  resumeModel: any(null, { description: 'Optional { provider, model } used for resumed sessions instead of the host default.' }),
}, { description: 'Two-step host restart tool configuration.', schemaVersion: 1 })

const HANDOFF_VERSION = 2
const DEFAULT_PENDING_TTL_MS = 120_000
const DEFAULT_HANDOFF_TTL_MS = 30 * 60 * 1000
const DEFAULT_RESUME_SETTLE_MS = 3_000
const EXIT_DELAY_MS = 1_500
const TOKEN_LENGTH = 12
const TOKEN_PATTERN = /^[0-9a-f]{12}$/
const EXEC_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'cmd', 'terminal'])
const DEFAULT_REASON = '（未提供原因）'
const DEFAULT_CONTINUE_PROMPT = '继续未完成的工作：宿主刚刚按计划重启，请先阅读最近上下文/快照确认状态，再从上一轮中断处接着做。'
const RESTART_METHOD = 'detached supervisor（宿主退出后由 supervisor.cjs 用原命令行重新拉起，并重放 handoff 恢复会话）'
const PROBE_TIMEOUT_MS = 3_000
/** Audit lines are compact: the free-text reason is truncated to this length. */
const AUDIT_REASON_MAX = 200
/** Confirmation tokens are stored on disk only as SHA-256 hashes. */
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * The detached supervisor source. Written to `<handoffDir>/supervisor.cjs` at
 * confirm time so the relaunch helper survives plugin upgrades, profile
 * relinking, and the Host process itself. `supervisor.cjs` in this bundle is
 * the same file kept for reading and `node --check`; test-restart.mjs asserts
 * that the two are byte-identical.
 */
export const SUPERVISOR_SOURCE = `#!/usr/bin/env node
/**
 * dsh-restart detached supervisor (CommonJS helper, HANDOFF_VERSION 2).
 *
 * Usage: node supervisor.cjs <handoffPath>
 *
 * Started by the dsh-restart host plugin right before the Host process exits
 * itself. This helper is the Windows stand-in for a systemd \`Restart=always\`
 * unit:
 *
 *   1. poll process.kill(hostPid, 0) until the old Host process is gone;
 *   2. wait SETTLE_MS so Windows process teardown and file handles settle;
 *   3. relaunch the Host as \`spawn(execPath, [...execArgv, ...argv], ...)\`.
 *      \`execArgv\` is REQUIRED: Node keeps interpreter flags such as
 *      \`--import tsx/esm\` out of \`process.argv\`, and relaunching a TypeScript
 *      entry point without them crashes instantly (P0 incident 2026-10-24);
 *   4. health-check the fresh Host for VERIFY_MS (>= 8s by default); if it dies
 *      early, log its exit code/signal plus a stderr tail and retry up to
 *      MAX_ATTEMPTS (5) times, RETRY_MS (3s) apart;
 *   5. if every attempt fails, write \`restart-failed.json\` (attempt evidence)
 *      next to the handoff record and exit FATAL.
 *
 * The handoff record is intentionally left on disk on success: the fresh Host
 * reads it on boot and replays the interrupted sessions. Only that replay
 * deletes it.
 *
 * Test-only environment overrides (all milliseconds unless noted):
 *   DSH_RESTART_POLL_MS          pid polling interval
 *   DSH_RESTART_SETTLE_MS        wait after the old Host exits
 *   DSH_RESTART_VERIFY_MS        how long a fresh Host must survive to count
 *   DSH_RESTART_RETRY_MS         delay between attempts
 *   DSH_RESTART_WAIT_TIMEOUT_MS  how long to wait for the old Host to exit
 *   DSH_RESTART_MAX_ATTEMPTS     attempt cap (default 5)
 *
 * This file is a zero-dependency CommonJS script on purpose: it must run under
 * a bare \`node supervisor.cjs\` from the handoff directory, without a package
 * context or the plugin's ESM graph.
 */
'use strict'

const { spawn } = require('node:child_process')
const {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} = require('node:fs')
const { dirname, join } = require('node:path')

const NEWLINE = String.fromCharCode(10)
const FAILURE_RECORD = 'restart-failed.json'
const STDERR_TAIL_CHARS = 4000

function readNumberEnv(name, fallback, minimum) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

const POLL_MS = readNumberEnv('DSH_RESTART_POLL_MS', 250, 10)
const SETTLE_MS = readNumberEnv('DSH_RESTART_SETTLE_MS', 2000, 0)
const VERIFY_MS = readNumberEnv('DSH_RESTART_VERIFY_MS', 8000, 0)
const RETRY_MS = readNumberEnv('DSH_RESTART_RETRY_MS', 3000, 0)
const WAIT_TIMEOUT_MS = readNumberEnv('DSH_RESTART_WAIT_TIMEOUT_MS', 120000, 1000)
const MAX_ATTEMPTS = readNumberEnv('DSH_RESTART_MAX_ATTEMPTS', 5, 1)

let supervisorLog = ''

function log(message) {
  if (supervisorLog === '') return
  try {
    appendFileSync(supervisorLog, '[' + new Date().toISOString() + '] ' + message + NEWLINE)
  } catch {
    // Logging is best effort; the restart itself must not depend on it.
  }
}

function stringifyError(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function finish(code, message) {
  if (message !== undefined) log(message)
  process.exit(code)
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means "exists but not ours"; only ESRCH means "gone".
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    // already gone / not removable
  }
}

function readHandoff(handoffPath) {
  try {
    const parsed = JSON.parse(readFileSync(handoffPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Compact tail of a log file: last N chars, one line, control chars folded. */
function readTextTail(file, maxChars) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const tail = text.length > maxChars ? text.slice(-maxChars) : text
  const compact = tail.replace(/\\r\\n/g, ' | ').replace(/[\\r\\n]+/g, ' | ').replace(/\\s+/g, ' ').trim()
  return compact.length > 600 ? compact.slice(-600) : compact
}

/** Write the attempt-evidence record for an all-attempts-failed restart. */
function writeFailureRecord(dir, record) {
  const file = join(dir, FAILURE_RECORD)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
    return file
  } catch (error) {
    log('WARN could not write ' + FAILURE_RECORD + ': ' + stringifyError(error))
    return file
  }
}

/**
 * Relaunch the Host from the handoff record, health-check, and retry.
 * @param {Record<string, unknown>} handoff - the dsh-restart handoff record.
 * @param {string} handoffPath - path of the record (for the failure evidence).
 */
async function restartHost(handoff, handoffPath) {
  const dir = dirname(supervisorLog)
  const execPath = typeof handoff.execPath === 'string' && handoff.execPath !== ''
    ? handoff.execPath
    : process.execPath
  const execArgv = Array.isArray(handoff.execArgv)
    ? handoff.execArgv.filter(item => typeof item === 'string')
    : null
  const argv = Array.isArray(handoff.argv) ? handoff.argv.filter(item => typeof item === 'string') : []
  const cwd = typeof handoff.cwd === 'string' && handoff.cwd !== '' ? handoff.cwd : process.cwd()
  const logPath = typeof handoff.logPath === 'string' && handoff.logPath !== ''
    ? handoff.logPath
    : join(dir, 'host.log')
  const stderrPath = join(dir, 'host.stderr.log')

  // A legacy v1 handoff has no execArgv; relaunching without the Node loader
  // flags (e.g. --import tsx/esm) kills the fresh Host instantly. Refuse.
  if (execArgv === null) {
    finish(2, 'FATAL handoff.execArgv is missing or not an array (legacy handoff); '
      + 'refusing to relaunch without the original Node flags')
  }
  if (argv.length === 0) {
    finish(4, 'FATAL handoff.argv is empty; cannot reconstruct the host command line')
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // openSync below will surface a real failure.
  }
  // A previous failed run left evidence behind; this run supersedes it.
  removeFile(join(dir, FAILURE_RECORD))

  const spawnArgs = [...execArgv, ...argv]
  const attempts = []
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const evidence = {
      attempt,
      startedAt: new Date().toISOString(),
      execPath,
      spawnArgs,
      pid: null,
      exitCode: null,
      signal: null,
      error: null,
      stderrTail: '',
    }
    const early = { value: null }
    let child
    let outputFd
    let errorFd
    try {
      log('attempt ' + attempt + '/' + MAX_ATTEMPTS + ': spawn ' + execPath
        + ' spawnArgs=' + JSON.stringify(spawnArgs) + ' cwd=' + cwd)
      outputFd = openSync(logPath, 'a')
      errorFd = openSync(stderrPath, 'a')
      child = spawn(execPath, spawnArgs, {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', outputFd, errorFd],
        env: process.env,
      })
    } catch (error) {
      log('attempt ' + attempt + ' spawn failed: ' + stringifyError(error))
      evidence.error = stringifyError(error)
      attempts.push(evidence)
      if (outputFd !== undefined) {
        try {
          closeSync(outputFd)
        } catch {
          // already closed
        }
      }
      if (errorFd !== undefined) {
        try {
          closeSync(errorFd)
        } catch {
          // already closed
        }
      }
      await delay(RETRY_MS)
      continue
    }
    for (const fd of [outputFd, errorFd]) {
      if (fd === undefined) continue
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
    if (child === undefined || child === null || !Number.isInteger(child.pid)) {
      log('attempt ' + attempt + ' failed: spawn returned no pid')
      evidence.error = 'spawn returned no pid'
      attempts.push(evidence)
      await delay(RETRY_MS)
      continue
    }
    evidence.pid = child.pid
    child.on('error', error => {
      if (early.value === null) {
        early.value = { exitCode: null, signal: null, error: stringifyError(error) }
      }
    })
    child.on('exit', (code, signal) => {
      if (early.value === null) early.value = { exitCode: code, signal, error: null }
    })
    try {
      child.unref()
    } catch {
      // unref is best effort; the detached flag already separates the process
    }
    await delay(VERIFY_MS)
    if (early.value === null) {
      log('OK host restarted pid=' + child.pid + '; health verified for '
        + String(VERIFY_MS) + 'ms; supervisor exiting (handoff kept for replay)')
      process.exit(0)
    }
    evidence.exitCode = early.value.exitCode
    evidence.signal = early.value.signal
    evidence.error = early.value.error
    evidence.stderrTail = readTextTail(stderrPath, STDERR_TAIL_CHARS)
    attempts.push(evidence)
    log('attempt ' + attempt + ' failed: exit code=' + String(evidence.exitCode)
      + ' signal=' + String(evidence.signal)
      + (evidence.error === null ? '' : ' error=' + String(evidence.error))
      + ' stderr=' + (evidence.stderrTail === '' ? '<empty>' : evidence.stderrTail))
    await delay(RETRY_MS)
  }

  const failureFile = writeFailureRecord(dir, {
    version: 2,
    at: new Date().toISOString(),
    handoffPath,
    hostPid: handoff.hostPid === undefined ? null : handoff.hostPid,
    execPath,
    execArgv,
    argv,
    spawnArgs,
    cwd,
    logPath,
    stderrPath,
    verifyMs: VERIFY_MS,
    retryMs: RETRY_MS,
    maxAttempts: MAX_ATTEMPTS,
    attempts,
    supervisorLog,
  })
  finish(5, 'FATAL could not restart the host after ' + MAX_ATTEMPTS
    + ' attempts; evidence written to ' + failureFile)
}

async function main() {
  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') {
    process.stderr.write('usage: node supervisor.cjs <handoffPath>' + NEWLINE)
    process.exit(2)
  }
  supervisorLog = join(dirname(handoffPath), 'supervisor.log')
  log('supervisor start pid=' + process.pid + ' handoff=' + handoffPath)
  const handoff = readHandoff(handoffPath)
  if (handoff === undefined) {
    finish(2, 'FATAL cannot read handoff record ' + handoffPath)
  }
  if (handoff.dryRun === true) {
    finish(0, 'handoff is a dryRun record; nothing to restart')
  }
  const hostPid = Number(handoff.hostPid)
  if (!Number.isInteger(hostPid) || hostPid <= 0) {
    finish(2, 'FATAL handoff.hostPid is invalid: ' + String(handoff.hostPid))
  }
  log('handoff version=' + String(handoff.version)
    + ' execArgv=' + JSON.stringify(handoff.execArgv)
    + ' argv=' + JSON.stringify(handoff.argv)
    + ' healthCheck=' + String(VERIFY_MS) + 'ms maxAttempts=' + String(MAX_ATTEMPTS))
  log('waiting for host pid ' + hostPid + ' to exit (timeout ' + WAIT_TIMEOUT_MS + 'ms)')
  const startedAt = Date.now()
  while (isAlive(hostPid)) {
    if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
      finish(3, 'FATAL host pid ' + hostPid + ' is still alive after '
        + WAIT_TIMEOUT_MS + 'ms; refusing to start a second host')
    }
    await delay(POLL_MS)
  }
  log('host pid ' + hostPid + ' exited after ' + String(Date.now() - startedAt)
    + 'ms; settling ' + SETTLE_MS + 'ms')
  await delay(SETTLE_MS)
  await restartHost(handoff, handoffPath)
}

main().catch(error => {
  finish(1, 'FATAL supervisor crashed: ' + stringifyError(error))
})
`

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Default DSH home: `%USERPROFILE%\.dsh` (or `$DSH_HOME` when set). */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/** Clamp an optional text argument to a bounded, non-empty string. */
function clampText(value, maxLength, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '…' : trimmed
}

/** Quote one argv item for the diagnostic `hostCommand` line. */
function quoteArg(value) {
  return /[ \t"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
}

/**
 * Redact diagnostic command lines before they enter the tool result / session
 * log: the home directory becomes `~` and a `C:\Users\<name>` segment becomes
 * `C:\Users\<user>`. `diagnostics: 'full'` disables it for local debugging.
 */
function redactDiagnostic(value, diagnostics) {
  if (typeof value !== 'string' || value === '') return value
  if (diagnostics === 'full') return value
  let text = value
  try {
    const home = homedir()
    if (typeof home === 'string' && home !== '') {
      text = text.split(home).join('~')
      const forward = home.replace(/\\/g, '/')
      if (forward !== home) text = text.split(forward).join('~')
    }
  } catch { /* redaction is best-effort */ }
  text = text.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/g, '$1<user>')
  return text
}

/** Reconstruct the Host's command line for the handoff record (diagnostics). */
function hostCommandLine(execPath, argv) {
  return [execPath, ...argv].map(quoteArg).join(' ')
}

/**
 * Probe the parent process command line (Windows only, best effort, step 1
 * only). A timeout, a missing PowerShell, or unparsable output yields a
 * degraded result instead of throwing.
 * @param parentPid - the parent pid to look up (usually `process.ppid`).
 */
function defaultProbeParentChain(parentPid) {
  const degraded = error => ({
    ok: false,
    pid: Number.isInteger(parentPid) ? parentPid : null,
    grandParentPid: null,
    commandLine: null,
    method: null,
    error,
  })
  if (!Number.isInteger(parentPid) || parentPid <= 0) return degraded('no parent pid')
  if (process.platform !== 'win32') return degraded('parent process probe is Windows-only')
  // Windows PowerShell 5.1 defaults stdout to the console code page; force
  // UTF-8 first so Chinese paths in the parent command line survive the pipe.
  const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + 'Get-CimInstance Win32_Process -Filter "ProcessId = ' + String(parentPid) + '"'
    + ' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
  try {
    const raw = nodeExecFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') return degraded('empty probe output')
    const parsed = JSON.parse(text)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    if (entry === null || typeof entry !== 'object') return degraded('unexpected probe output')
    return {
      ok: true,
      pid: parentPid,
      grandParentPid: typeof entry.ParentProcessId === 'number' ? entry.ParentProcessId : null,
      commandLine: typeof entry.CommandLine === 'string' && entry.CommandLine !== ''
        ? entry.CommandLine
        : null,
      method: 'powershell/Get-CimInstance',
      error: null,
    }
  } catch (error) {
    return degraded(error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error))
  }
}

/** Human-readable "what happens if you kill this process" warning text. */
function killConsequenceText(hostPid, parentPid) {
  return '直接 kill/taskkill 宿主 PID ' + String(hostPid)
    + ' 会立刻中止本宿主进程里所有在跑的回合（包括当前会话），工具结果可能丢失；'
    + '只有外部守护（systemd Restart=always 或本插件的 detached supervisor）才会自动把宿主拉回来，'
    + '否则需要人工重启。'
    + (parentPid === null
      ? ''
      : ' 也不要连带 kill 父进程 ' + String(parentPid) + '（启动器/终端）：父进程退出同样会终止宿主。')
    + ' 安全做法是按两步确认调用 restart_dsh（第二步需提供宿主 PID 后 4 位）；'
    + 'shell 里的直接 kill 会被本插件的围栏拒绝。'
}

/**
 * Build the step-1 `hostProcessChain` evidence block: who the Host is, who
 * started it, and what a direct kill would cost. The parent probe is best
 * effort and never throws.
 */
function buildHostProcessChain(deps, settings = {}) {
  const hostPid = process.pid
  // Include process.execArgv: Node keeps interpreter flags (e.g. --import tsx/esm)
  // out of process.argv, and a command line that omits them cannot be re-run.
  // Must stay semantically identical to plan.hostCommand.
  const hostCommand = redactDiagnostic(hostCommandLine(process.execPath, [...process.execArgv, ...process.argv.slice(1)]), settings.diagnostics)
  const parentPid = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null
  let probed = null
  let probeError = null
  try {
    probed = deps.probeParentChain(parentPid)
  } catch (error) {
    probeError = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error)
  }
  const ok = probed !== null && typeof probed === 'object' && probed.ok === true
  const resolvedParentPid = ok && Number.isInteger(probed.pid) ? probed.pid : parentPid
  return {
    hostPid,
    hostCommand,
    parentPid: resolvedParentPid,
    parentCommand: ok && typeof probed.commandLine === 'string' && probed.commandLine !== ''
      ? redactDiagnostic(probed.commandLine, settings.diagnostics)
      : null,
    grandParentPid: ok && Number.isInteger(probed.grandParentPid) ? probed.grandParentPid : null,
    killConsequence: killConsequenceText(hostPid, resolvedParentPid),
    probe: {
      ok,
      method: ok && typeof probed.method === 'string' ? probed.method : null,
      error: probeError !== null
        ? probeError
        : (ok ? null : (probed !== null && typeof probed === 'object' && typeof probed.error === 'string'
          ? probed.error
          : 'probe unavailable')),
      timeoutMs: PROBE_TIMEOUT_MS,
      degraded: !ok,
    },
    note: ok
      ? '父进程链来自本地只读探测（best effort）。'
      : '父进程探测失败/降级：parentCommand=null；不影响重启流程（尽力而为）。',
  }
}

/** Normalize plugin config with defaults and derived paths. */
function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const home = typeof source.dshHome === 'string' && source.dshHome !== ''
    ? source.dshHome
    : dshHome()
  const handoffDir = typeof source.handoffDir === 'string' && source.handoffDir !== ''
    ? source.handoffDir
    : join(home, 'restart')
  const nonNegative = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback)
  const positive = (value, fallback) => Math.max(1, nonNegative(value, fallback))
  const resumeModel = source.resumeModel !== null && typeof source.resumeModel === 'object'
    && typeof source.resumeModel.provider === 'string' && typeof source.resumeModel.model === 'string'
    ? { provider: source.resumeModel.provider, model: source.resumeModel.model }
    : null
  return {
    enabled: source.enabled !== false,
    diagnostics: source.diagnostics === 'full' ? 'full' : 'redacted',
    handoffDir,
    handoffPath: join(handoffDir, 'handoff.json'),
    pendingPath: join(handoffDir, 'pending.json'),
    logPath: join(handoffDir, 'host.log'),
    supervisorPath: join(handoffDir, 'supervisor.cjs'),
    lastReplayPath: join(handoffDir, 'last-replay.json'),
    auditFile: typeof source.auditFile === 'string' && source.auditFile.trim() !== ''
      ? source.auditFile.trim()
      : join(handoffDir, 'audit.jsonl'),
    audit: source.audit !== false,
    pendingTtlMs: positive(source.pendingTtlMs, DEFAULT_PENDING_TTL_MS),
    handoffTtlMs: positive(source.handoffTtlMs, DEFAULT_HANDOFF_TTL_MS),
    resumeSettleMs: nonNegative(source.resumeSettleMs, DEFAULT_RESUME_SETTLE_MS),
    autoResume: source.autoResume !== false,
    fence: source.fence !== false,
    // Safety double-lock: a real (non-dryRun) restart is refused until this is
    // explicitly enabled after verify-relaunch passed on a spare port.
    allowRealRestart: source.allowRealRestart === true,
    resumeModel,
  }
}

/** Resolve injectable process primitives (tests inject mocks here). */
function normalizeDeps(deps) {
  const source = deps !== null && typeof deps === 'object' ? deps : {}
  return {
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
    spawn: typeof source.spawn === 'function' ? source.spawn : nodeSpawn,
    exit: typeof source.exit === 'function' ? source.exit : code => process.exit(code),
    setTimeout: typeof source.setTimeout === 'function' ? source.setTimeout : (fn, ms) => setTimeout(fn, ms),
    clearTimeout: typeof source.clearTimeout === 'function' ? source.clearTimeout : timer => clearTimeout(timer),
    probeParentChain: typeof source.probeParentChain === 'function'
      ? source.probeParentChain
      : defaultProbeParentChain,
    randomToken: typeof source.randomToken === 'function'
      ? source.randomToken
      : () => randomBytes(TOKEN_LENGTH / 2).toString('hex'),
  }
}

/** Atomically write one JSON file (temp file in the same directory + rename). */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid + '-' + String(Date.now())
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // failed write may leave no temp file at all
    }
    throw error
  }
}

/** Read one JSON file, returning null on any failure (missing/corrupt). */
function tryReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Remove one file, ignoring a missing one. */
function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    // already gone or not removable; replay must not fail because of cleanup
  }
}

/** Build one frozen user-role message without importing the LLM package. */
function createUserMessage(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** The calling session id from a tool execution, or null. */
function callerSessionIdOf(exec) {
  try {
    const id = exec !== null && typeof exec === 'object' ? exec.agent?.session?.id : undefined
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

/** The agents service, or null when it is not available. */
function getAgents(ctx) {
  try {
    const agents = ctx.get('agents')
    return agents !== null && typeof agents === 'object' ? agents : null
  } catch {
    return null
  }
}

/**
 * Sample the live sessions. `wake` marks the sessions a planned restart has to
 * bring back: the caller (its turn is in flight) plus anything running.
 */
function collectSessions(ctx, callerSessionId) {
  const agents = getAgents(ctx)
  if (agents === null || typeof agents.list !== 'function') return []
  let live
  try {
    live = agents.list()
  } catch {
    return []
  }
  if (!Array.isArray(live)) return []
  const sessions = []
  for (const agent of live) {
    try {
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') continue
      const status = typeof agent.status === 'string' ? agent.status : 'unknown'
      const cwd = agent.session?.header?.cwd
      sessions.push({
        sessionId,
        status,
        cwd: typeof cwd === 'string' ? cwd : null,
        provider: typeof agent.options?.provider === 'string' ? agent.options.provider : null,
        model: typeof agent.options?.model === 'string' ? agent.options.model : null,
        wake: status === 'running' || sessionId === callerSessionId,
      })
    } catch {
      // A malformed agent entry must never abort the preflight.
    }
  }
  return sessions
}

/**
 * Map a Team framework role to the display role used in blocker hints
 * (`teammate` is a team *member*, which is what the hint shows).
 */
function displayTeamRole(role) {
  if (role === 'teammate' || role === 'member') return 'member'
  if (typeof role === 'string' && role !== '') return role
  return null
}

/**
 * Build a best-effort resolver: blocker session id -> Team member name/role.
 * Looks the Agent up in `agents.list()` by session id, then asks
 * `agentTeams.membership(agent)`. Any failure yields null fields, never a throw.
 */
function makeBlockerTeamResolver(ctx) {
  const agentsBySessionId = new Map()
  try {
    const agents = getAgents(ctx)
    if (agents !== null && typeof agents.list === 'function') {
      const live = agents.list()
      if (Array.isArray(live)) {
        for (const agent of live) {
          const sessionId = agent?.session?.id
          if (typeof sessionId === 'string' && sessionId !== '') agentsBySessionId.set(sessionId, agent)
        }
      }
    }
  } catch {
    // no agent lookup: blockers keep null name/role
  }
  let team = null
  try {
    const service = ctx.get('agentTeams')
    if (service !== null && typeof service === 'object'
      && typeof service.membership === 'function') team = service
  } catch {
    team = null
  }
  return sessionId => {
    const empty = { name: null, role: null, teamRole: null }
    const agent = agentsBySessionId.get(sessionId)
    if (agent === undefined || team === null) return empty
    try {
      const membership = team.membership(agent)
      if (membership === null || typeof membership !== 'object'
        || typeof membership.name !== 'string' || membership.name === '') return empty
      const teamRole = typeof membership.role === 'string' ? membership.role : null
      return { name: membership.name, role: displayTeamRole(teamRole), teamRole }
    } catch {
      return empty
    }
  }
}

/** The enhanced hint for one blocker session (falls back when unknown). */
function blockerHintForTeam(team, fallbackHint, tail) {
  if (team.name === null) return fallbackHint
  const role = team.role === null ? 'unknown' : String(team.role)
  return '这是 Lead 团队的 ' + team.name + '（role=' + role + '），正在执行任务；等它完成或让其停下' + tail
}

/** Build one blocker entry: session evidence plus best-effort Team identity. */
function buildBlockerEntry(session, resolveTeam, fallbackHint, tail) {
  const team = resolveTeam(session.sessionId)
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: session.status,
    name: team.name,
    role: team.role,
    teamRole: team.teamRole,
    hint: blockerHintForTeam(team, fallbackHint, tail),
  }
}

/**
 * Count what a restart would wake: `wake` sessions are resumed; idle sessions
 * are not (they finished their work / have no queued turn).
 */
function summarizeWakeSessions(sessions) {
  const wakeCount = sessions.filter(session => session.wake === true).length
  const idleCount = sessions.filter(session => session.wake !== true && session.status === 'idle').length
  const wakeSummary = '预计重启会唤醒 ' + String(wakeCount) + ' 个会话；另有 ' + String(idleCount)
    + ' 个 idle 会话不会被唤醒（它们已完成/无排队工作）。'
  return { wakeCount, idleCount, wakeSummary }
}

/** Truncate one audit reason to AUDIT_REASON_MAX characters. */
function truncateAuditReason(value) {
  const text = typeof value === 'string' ? value.trim() : (value === null || value === undefined ? '' : String(value))
  return text.length > AUDIT_REASON_MAX ? text.slice(0, AUDIT_REASON_MAX) : text
}

/**
 * Append one restart audit line (JSONL). Field names follow the Lead-defined
 * schema: { at, phase, decision, caller, blockersCount, willResumeCount,
 * hostPidSuffix, allowRealRestart }, plus canRestart/tokenIssued/
 * tokenConsumed/reason extras. The token is NEVER written.
 */
function appendRestartAudit(state, entry) {
  if (state.settings.audit !== true) return
  const count = value => (Number.isInteger(value) && value >= 0 ? value : 0)
  const record = {
    at: new Date(state.deps.now()).toISOString(),
    actor: typeof entry.actor === 'string' ? entry.actor : (typeof state.auditActor === 'string' ? state.auditActor : 'tool'),
    phase: typeof entry.phase === 'string' ? entry.phase : 'unknown',
    decision: typeof entry.decision === 'string' ? entry.decision : 'unknown',
    caller: typeof entry.caller === 'string' ? entry.caller : null,
    blockersCount: count(entry.blockersCount),
    willResumeCount: count(entry.willResumeCount),
    hostPidSuffix: String(process.pid).slice(-4),
    allowRealRestart: state.settings.allowRealRestart === true,
    canRestart: entry.canRestart === true,
    tokenIssued: entry.tokenIssued === true,
    tokenConsumed: entry.tokenConsumed === true,
    reason: truncateAuditReason(entry.reason),
  }
  try {
    mkdirSync(dirname(state.settings.auditFile), { recursive: true })
    appendFileSync(state.settings.auditFile, JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    try {
      state.ctx.logger.warn('[dsh-restart] audit append failed: ' + String(error))
    } catch {
      // audit logging must never break the tool pipeline
    }
  }
}

/** SHA-256 hex of one confirmation token (the only form ever written to disk). */
function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/** Is a value a structurally valid pending (warning) record? */
function isPendingRecord(value) {
  return value !== null && typeof value === 'object'
    && typeof value.tokenHash === 'string'
    && TOKEN_HASH_PATTERN.test(value.tokenHash)
    && value.plan !== null && typeof value.plan === 'object'
}

/**
 * Read the pending record: disk first (durable), memory as fallback. A legacy
 * record that still carries a plaintext `token` is scrubbed from disk (with a
 * WARN) — after the 0.4.0 change no disk file may contain a full token.
 */
function readPending(state) {
  const disk = tryReadJson(state.settings.pendingPath)
  if (isPendingRecord(disk)) return disk
  if (disk !== null && typeof disk === 'object' && typeof disk.token === 'string') {
    removeFile(state.settings.pendingPath)
    try {
      state.ctx.logger.warn('[dsh-restart] discarded a legacy pending record with a plaintext token at '
        + state.settings.pendingPath + ' (tokens are hashed on disk since 0.4.0; get a new warning token)')
    } catch {
      // logging only
    }
    return null
  }
  if (isPendingRecord(state.memoryPending)) return state.memoryPending
  return null
}

/** Consume/clear the pending record (one-time token). */
function discardPending(state) {
  state.memoryPending = null
  removeFile(state.settings.pendingPath)
}

/** Keep only a well-formed 12-hex token. */
function normalizeToken(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TOKEN_PATTERN.test(token) ? token : randomBytes(TOKEN_LENGTH / 2).toString('hex')
}

/** Does the text contain the exact integer pid? */
function containsPid(text, pid) {
  if (!Number.isInteger(pid)) return false
  return new RegExp('(?:^|[^0-9])' + String(pid) + '(?:[^0-9]|$)').test(text)
}

// ---------------------------------------------------------------------------
// Fence: deny shell commands that kill the Host, point at restart_dsh
// ---------------------------------------------------------------------------

/**
 * Judge one shell command against the current Host process. Returns a short
 * human-readable reason when the command looks like it kills node/dsh/the Host,
 * or null when the command is fine. Heuristic by design: it judges the head
 * verb of shell segments, not mere mentions.
 * @param command - the command text from the executing tool's arguments.
 * @param hostPid - the current Host pid.
 */
export function judgeSelfKillCommand(command, hostPid) {
  if (typeof command !== 'string' || command.trim() === '') return null
  const text = command
  const hasHostPid = containsPid(text, hostPid)
  const mentionsNode = /\bnode(?:\.exe)?\b/i.test(text) || /\bnodejs\b/i.test(text)
  const mentionsDsh = /\bdsh(?:\.exe)?\b/i.test(text)
  const mentionsHostPattern = /apps[\\/]cli|deepseek-harness|dsh web/i.test(text)

  if (/\btaskkill(?:\.exe)?\b/i.test(text)) {
    if (hasHostPid) return 'taskkill 直接指向宿主 PID'
    if (mentionsNode || mentionsDsh) return 'taskkill 会结束 node/dsh 进程'
  }
  if (/\bStop-Process\b/i.test(text)) {
    if (hasHostPid) return 'Stop-Process 直接指向宿主 PID'
    if (/(?:-Name|Get-Process)\b[^\n]*\b(?:node|dsh)\b/i.test(text)) {
      return 'Stop-Process 会结束 node/dsh 进程'
    }
  }
  if (/\bpkill(?:\.exe)?\b/i.test(text)) {
    if (hasHostPid) return 'pkill 直接指向宿主 PID'
    if (/\bpkill\b[^\n]*(?:\bnode\b|\bdsh\b|apps[\\/]cli|deepseek-harness)/i.test(text)) {
      return 'pkill 的模式会匹配 node/dsh 宿主进程'
    }
  }
  if (/\bkillall\b/i.test(text) && (mentionsNode || mentionsDsh)) {
    return 'killall 会结束 node/dsh 进程'
  }
  for (const segment of text.split(/[;&|\n]/)) {
    if (!/(?:^|\s)kill\b/i.test(segment)) continue
    const index = segment.toLowerCase().indexOf('kill')
    const tail = segment.slice(index + 4)
    if (containsPid(tail, hostPid)) return 'kill 直接指向宿主 PID'
    if (/\$PPID/i.test(tail) || /\bppid\b/i.test(tail)) return 'kill 指向父进程（宿主）'
    if ((/\bpgrep\b/i.test(tail) || /\bpgrep\b/i.test(text))
      && (mentionsNode || mentionsDsh || mentionsHostPattern)) {
      return 'kill 通过 pgrep 匹配 node/dsh 宿主进程'
    }
    if (/(?:^|\s)(?:-\d+\s+)?(?:0|-1)(?:\s|$)/.test(tail)) {
      return 'kill 0/-1 会波及整个进程组或全部进程'
    }
  }
  if (/(?:process\.kill|os\.kill|killpg)\s*\(/i.test(text)) {
    if (hasHostPid) return '代码里直接 kill 宿主 PID'
    if (/\b(?:process\.(?:ppid|pid)|os\.getppid\s*\()/i.test(text) || /killpg\s*\(/i.test(text)) {
      return '代码里直接 kill 自身/父进程（宿主）'
    }
  }
  return null
}

/** Pick the command-like string out of an exec tool's arguments. */
function firstCommandString(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of ['command', 'cmd', 'script', 'code']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** Install the pre-execute fence. Fails open: a guard bug never blocks tools. */
function installFence(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec === null || typeof exec !== 'object') return next()
      if (!EXEC_TOOL_NAMES.has(String(exec.name))) return next()
      const command = firstCommandString(exec.arguments)
      if (command === null) return next()
      const verdict = judgeSelfKillCommand(command, process.pid)
      if (verdict === null) return next()
      try {
        ctx.logger.warn('[dsh-restart] fence denied ' + String(exec.name) + ' command (' + verdict + ')')
      } catch {
        // logging must not change the decision
      }
      return {
        kind: 'deny',
        reason: '[dsh-restart] 围栏拒绝：这条命令会直接结束宿主进程（' + verdict + '）。'
          + '重启宿主请改用 restart_dsh 工具：第一步只返回警告与令牌，第二步带 confirm=令牌 才执行；'
          + '宿主退出后由 detached supervisor 用原命令行拉起，并重放 handoff 恢复会话（工具结果不会丢失）。',
      }
    } catch (error) {
      try {
        ctx.logger.warn('[dsh-restart] fence error (fail-open): ' + String(error))
      } catch {
        // ignore
      }
      return next()
    }
  })
}

// ---------------------------------------------------------------------------
// Resume helpers (replay fidelity: provider/model + agent preset composition)
// ---------------------------------------------------------------------------

/** Kept-alive handles for sessions resumed by the replay (host owns lifecycle). */
const resumedHandles = new Map()

/** Model selection for a resumed session, or null when the host has none. */
function resolveResumeSelection(ctx, settings) {
  try {
    const service = ctx.get('agentDefaultModel')
    const selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
    if (selection !== null && selection !== undefined && typeof selection === 'object'
      && typeof selection.provider === 'string' && selection.provider !== ''
      && typeof selection.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // fall through to the configured model
  }
  return settings.resumeModel
}

/**
 * Resolve the session's own agent preset and a setup callback that mounts it.
 * A resume without setup composes the ROOT scope instead, which loses the
 * session's preset tools, so refuse rather than create a half-broken session.
 * (Same resolution as the legacy pipe2 bridge's auto-resume path.)
 */
async function resolveResumeComposition(ctx, sessionId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    return undefined
  }
  let presetId
  try {
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.observeSession === 'function') {
      const observation = await query.observeSession(sessionId)
      try {
        const projected = observation?.projections?.values?.agentPreset
        if (typeof projected === 'string' && projected !== '') presetId = projected
      } finally {
        try {
          observation?.[Symbol.dispose]?.()
        } catch {
          // already disposed
        }
      }
    }
  } catch {
    // fall back to the default preset
  }
  try {
    const resolved = await presets.resolve(presetId)
    const id = resolved?.id
    if (typeof id !== 'string' || id === '') return undefined
    return {
      agentPreset: id,
      setup: async agentCtx => {
        await presets.mount(agentCtx, id)
      },
    }
  } catch (error) {
    ctx.logger.warn('[dsh-restart] preset resolve failed for ' + sessionId + ': ' + String(error))
    return undefined
  }
}

/** Is this session id archived (never auto-resumed)? */
function archivedSessionIds(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? ids.map(String) : []
  } catch {
    return []
  }
}

/**
 * Resume one session (or reuse a live agent) for the replay.
 * @returns the bare Agent to call `followup()` on.
 */
async function resumeOne(ctx, settings, sessionId) {
  const agents = getAgents(ctx)
  if (agents === null) throw new Error('agents service unavailable')
  if (typeof agents.get === 'function') {
    const live = agents.get(sessionId)
    if (live !== undefined && live !== null) return { agent: live, via: 'live' }
  }
  if (typeof agents.resume !== 'function') throw new Error('agents.resume unavailable')
  if (archivedSessionIds(ctx).includes(sessionId)) throw new Error('session is archived')
  const selection = resolveResumeSelection(ctx, settings)
  const composition = await resolveResumeComposition(ctx, sessionId)
  if (composition === undefined) {
    throw new Error('agent preset composition unavailable (refusing to resume a half-composed session)')
  }
  const options = {
    resumeSessionId: sessionId,
    setup: composition.setup,
  }
  if (selection !== null) {
    options.agentOptions = { provider: selection.provider, model: selection.model }
  }
  const handle = await agents.resume(options)
  if (handle === null || typeof handle !== 'object' || handle.agent === undefined || handle.agent === null) {
    throw new Error('agents.resume returned no agent handle')
  }
  try {
    resumedHandles.set(sessionId, handle)
  } catch {
    // the host owns the lifecycle anyway
  }
  return { agent: handle.agent, via: 'resume', preset: composition.agentPreset }
}

/** The wake-up message a replayed session receives. */
function replayPrompt(handoff, sessionId) {
  const base = typeof handoff.continuePrompt === 'string' && handoff.continuePrompt !== ''
    ? handoff.continuePrompt
    : DEFAULT_CONTINUE_PROMPT
  const header = sessionId === handoff.callerSessionId
    ? '[dsh-restart] 宿主已按计划重启（handoff 重放）。请在重启后继续未完成的工作。'
    : '[dsh-restart] 宿主已按计划重启（handoff 重放）。你被判定为重启时仍在工作的会话，请从上次中断处继续。'
  return header + '\n\n' + base
}

/**
 * Replay a handoff record written by the confirm step (called on the next
 * boot). Deletes the record once replayed; a record belonging to the running
 * process is never replayed.
 * @param ctx - plugin context.
 * @param config - raw plugin config.
 * @param deps - optional injected process primitives (tests).
 */
export async function replayHandoff(ctx, config, deps) {
  const settings = normalizeConfig(config)
  const resolvedDeps = normalizeDeps(deps)
  const handoffPath = settings.handoffPath
  if (!existsSync(handoffPath)) {
    return { replayed: false, skipped: true, reason: 'no-handoff', handoffPath }
  }
  const handoff = tryReadJson(handoffPath)
  if (handoff === null || typeof handoff !== 'object' || handoff.version !== HANDOFF_VERSION) {
    removeFile(handoffPath)
    const legacy = handoff !== null && typeof handoff === 'object'
      && Number(handoff.version) < HANDOFF_VERSION
    if (legacy) {
      // A v1 record lacks execArgv: relaunching from it would start the Host
      // without its Node loader flags. Never replay/relaunch a legacy record.
      ctx.logger.warn('[dsh-restart] discarding a legacy v' + String(handoff.version)
        + ' handoff (missing execArgv) at ' + handoffPath + '; run the restart again to get a v'
        + String(HANDOFF_VERSION) + ' record')
      return { replayed: false, skipped: true, reason: 'legacy-handoff', handoffPath }
    }
    ctx.logger.warn('[dsh-restart] discarding an invalid handoff record at ' + handoffPath)
    return { replayed: false, skipped: true, reason: 'invalid-handoff', handoffPath }
  }
  if (!Array.isArray(handoff.execArgv)) {
    // Defense in depth: a v2 record must carry the Node interpreter flags.
    removeFile(handoffPath)
    ctx.logger.warn('[dsh-restart] discarding handoff without execArgv at ' + handoffPath)
    return { replayed: false, skipped: true, reason: 'missing-exec-argv', handoffPath }
  }
  if (handoff.hostPid === process.pid) {
    // A record written by this very process means the restart did not happen;
    // replaying it here would be a restart that never occurred.
    return { replayed: false, skipped: true, reason: 'same-process', handoffPath }
  }
  if (handoff.dryRun === true) {
    removeFile(handoffPath)
    ctx.logger.info('[dsh-restart] discarded a dryRun handoff record (no restart happened)')
    return { replayed: false, skipped: true, reason: 'dry-run-record', handoffPath }
  }
  const createdAtMs = typeof handoff.createdAt === 'string' ? Date.parse(handoff.createdAt) : Number.NaN
  if (!Number.isFinite(createdAtMs) || resolvedDeps.now() - createdAtMs > settings.handoffTtlMs) {
    removeFile(handoffPath)
    ctx.logger.warn('[dsh-restart] discarded a stale handoff record (older than ' + settings.handoffTtlMs + 'ms)')
    return { replayed: false, skipped: true, reason: 'stale', handoffPath }
  }
  if (settings.autoResume === false) {
    return { replayed: false, skipped: true, reason: 'autoResume-disabled', handoffPath }
  }
  // The settle delay lives in apply()'s start-up timer: that is the one wait
  // between plugin load and replay. Calling this function directly replays now.

  const sessions = Array.isArray(handoff.sessions)
    ? handoff.sessions.filter(session => session !== null && typeof session === 'object'
      && typeof session.sessionId === 'string' && session.sessionId !== '')
    : []
  const wakeSessions = sessions.filter(session => session.wake === true)
  const seen = new Set()
  const resumed = []
  const failed = []
  for (const session of wakeSessions) {
    const sessionId = session.sessionId
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    try {
      const { agent, via } = await resumeOne(ctx, settings, sessionId)
      agent.followup(createUserMessage(replayPrompt(handoff, sessionId)))
      resumed.push(sessionId)
      ctx.logger.info('[dsh-restart] replayed session ' + sessionId + ' via ' + via)
    } catch (error) {
      failed.push({ sessionId, error: String(error) })
      ctx.logger.warn('[dsh-restart] replay failed for ' + sessionId + ': ' + String(error))
    }
  }
  removeFile(handoffPath)
  const summary = {
    version: HANDOFF_VERSION,
    replayedAt: new Date(resolvedDeps.now()).toISOString(),
    hostPid: process.pid,
    handoffHostPid: handoff.hostPid,
    reason: typeof handoff.reason === 'string' ? handoff.reason : null,
    resumed,
    failed,
  }
  try {
    writeJsonAtomic(settings.lastReplayPath, summary)
  } catch {
    // diagnostics only
  }
  ctx.logger.info('[dsh-restart] handoff replayed: resumed=' + String(resumed.length)
    + ' failed=' + String(failed.length) + ' (record removed)')
  return {
    replayed: true,
    skipped: false,
    handoffPath,
    reason: summary.reason,
    resumed,
    failed,
  }
}

// ---------------------------------------------------------------------------
// restart_dsh tool
// ---------------------------------------------------------------------------

/** Build the absolute paths/config into a JSON-safe plan snapshot. */
function buildPlan(settings, extra) {
  return {
    reason: extra.reason,
    continuePrompt: extra.continuePrompt,
    dryRun: extra.dryRun,
    callerSessionId: extra.callerSessionId,
    hostPid: process.pid,
    hostCommand: extra.hostCommand,
    handoffPath: settings.handoffPath,
    logPath: settings.logPath,
    sessions: extra.sessions,
    willResume: extra.sessions.filter(session => session.wake === true).map(session => session.sessionId),
    restartMethod: RESTART_METHOD,
  }
}

/** Step 1: read-only preflight. Warning + token only; nothing restarts. */
function executeWarning(rawArgs, exec, state, options = {}) {
  const { ctx, settings, deps } = state
  const nowMs = deps.now()
  const callerSessionId = callerSessionIdOf(exec)
    ?? (exec !== null && typeof exec === 'object' && typeof exec.sessionId === 'string' && exec.sessionId !== ''
      ? exec.sessionId
      : null)
  const sessions = collectSessions(ctx, callerSessionId)
  // Best-effort Team identity for each blocker (never throws; nulls on failure).
  const resolveBlockerTeam = makeBlockerTeamResolver(ctx)
  const blockers = sessions
    .filter(session => session.sessionId !== callerSessionId && session.status === 'running')
    .map(session => buildBlockerEntry(
      session,
      resolveBlockerTeam,
      '等待该会话当前回合完成（或让其停下）后再重试第一步。',
      '后再重试第一步。',
    ))
  const reason = clampText(rawArgs.reason, 500, DEFAULT_REASON)
  const continuePrompt = clampText(rawArgs.continuePrompt, 8000, DEFAULT_CONTINUE_PROMPT)
  const dryRun = rawArgs.dryRun === true
  const allowRealRestart = settings.allowRealRestart === true
  const hostCommand = redactDiagnostic(hostCommandLine(process.execPath, [...process.execArgv, ...process.argv.slice(1)]), settings.diagnostics)
  const plan = buildPlan(settings, { reason, continuePrompt, dryRun, callerSessionId, hostCommand, sessions })
  const realRestartNote = allowRealRestart
    ? ''
    : '当前 allowRealRestart=false：真实重启尚未启用，confirm 会被拒绝（dryRun 演练路径不受影响）；'
      + '请先跑 verify-relaunch（备用端口，默认 13081）通过，并由 Lead/作者批准后在 cordis.patch.yml 把 allowRealRestart 设为 true。'
  // How many sessions would a restart wake, and how many idle sessions stay asleep?
  const wakeInfo = summarizeWakeSessions(sessions)
  // Who is this process and what would a direct kill cost? Best effort; the
  // parent probe degrades to null fields instead of throwing.
  const hostProcessChain = buildHostProcessChain(deps, settings)
  const pidSuffix = String(process.pid).slice(-4)

  if (blockers.length > 0) {
    // A blocked warning supersedes any older token: no plan can be confirmed
    // while other sessions are running.
    discardPending(state)
    ctx.logger.warn('[dsh-restart] restart blocked by ' + String(blockers.length) + ' running session(s)')
    appendRestartAudit(state, {
      phase: 'blocked',
      decision: 'blocked',
      caller: callerSessionId,
      blockersCount: blockers.length,
      willResumeCount: wakeInfo.wakeCount,
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason,
    })
    return {
      phase: 'warning',
      tool: 'restart_dsh',
      step: 1,
      canRestart: false,
      blockers,
      token: null,
      expiresInMs: 0,
      pidSuffix,
      allowRealRestart,
      wakeCount: wakeInfo.wakeCount,
      idleCount: wakeInfo.idleCount,
      hostProcessChain,
      plan,
      warning: '拒绝重启：除调用者外还有会话处于 running 状态（见 blockers）。'
        + '这一步没有重启任何东西，也没有签发令牌；等这些会话的回合结束后重新调用第一步。'
        + wakeInfo.wakeSummary,
      next: '等 blockers 中的会话完成工作（状态变 idle）后，再次调用 restart_dsh（不带 confirm）获取令牌。',
    }
  }

  if (process.argv.length <= 1) {
    ctx.logger.warn('[dsh-restart] cannot capture the host command line (empty argv)')
  }
  // task-88 lock-aware prepare: the browser button must show "locked" and get
  // NO token while allowRealRestart=false. The tool path keeps its historical
  // warning + token behavior (confirm still refuses under the lock).
  if (options.lockAware === true && allowRealRestart !== true) {
    appendRestartAudit(state, {
      phase: 'locked',
      decision: 'locked',
      caller: callerSessionId,
      blockersCount: 0,
      willResumeCount: wakeInfo.wakeCount,
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: '真实重启未启用（allowRealRestart=false）；prepare 只返回锁信息，不签发令牌。',
    })
    return {
      phase: 'locked',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      locked: true,
      allowRealRestart: false,
      blockers: [],
      token: null,
      expiresInMs: 0,
      pidSuffix,
      hostPid: process.pid,
      wakeCount: wakeInfo.wakeCount,
      idleCount: wakeInfo.idleCount,
      hostProcessChain,
      plan,
      warning: '重启已锁定（allowRealRestart=false）：不会签发令牌，也不会重启。'
        + '请先在备用端口（默认 13081）运行 verify-relaunch 通过，并由 Lead/作者批准后启用 allowRealRestart。',
      lockReason: '真实重启未启用：allowRealRestart=false（安全双锁）。',
      next: '启用 allowRealRestart 后重新 prepare。',
    }
  }
  const token = normalizeToken(deps.randomToken())
  const expiresAtMs = nowMs + settings.pendingTtlMs
  // Tokens are only persisted as a SHA-256 hash + a 4-char prefix for humans;
  // no disk file (pending/audit/handoff/log) may contain the plain token.
  const pending = {
    version: HANDOFF_VERSION,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 4),
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    plan,
  }
  writeJsonAtomic(settings.pendingPath, pending)
  state.memoryPending = pending
  ctx.logger.info('[dsh-restart] warning issued: reason=' + JSON.stringify(reason)
    + ' sessions=' + String(sessions.length) + ' wake=' + String(wakeInfo.wakeCount)
    + ' idle=' + String(wakeInfo.idleCount) + ' tokenPrefix=' + pending.tokenPrefix
    + ' (token expires in ' + String(settings.pendingTtlMs) + 'ms)')
  appendRestartAudit(state, {
    phase: 'warning',
    decision: 'allowed',
    caller: callerSessionId,
    blockersCount: 0,
    willResumeCount: wakeInfo.wakeCount,
    canRestart: true,
    tokenIssued: true,
    tokenConsumed: false,
    reason,
  })
  return {
    phase: 'warning',
    tool: 'restart_dsh',
    step: 1,
    canRestart: true,
    blockers: [],
    token,
    expiresInMs: settings.pendingTtlMs,
    pidSuffix,
    allowRealRestart,
    wakeCount: wakeInfo.wakeCount,
    idleCount: wakeInfo.idleCount,
    hostProcessChain,
    plan,
    warning: '这是一次破坏性操作：宿主退出会中止本进程里所有在跑的回合。'
      + '本步没有重启任何东西；只有再次调用 restart_dsh 并传入 confirm=' + token
      + '（并同时提供 confirmPidSuffix=' + pidSuffix + '，即宿主 PID 后 4 位）才会执行。'
      + '令牌 ' + String(settings.pendingTtlMs) + 'ms 内有效且只能使用一次，'
      + '执行的是本警告里的计划（原因/继续指令从 pending 记录读取，不读新参数）。'
      + '确认时需提供宿主 PID 后 4 位：' + pidSuffix + '。'
      + wakeInfo.wakeSummary
      + (realRestartNote === '' ? '' : realRestartNote),
    next: '确认计划与 hostProcessChain 无误后，再次调用 restart_dsh 且 confirm=' + token
      + '、confirmPidSuffix=' + pidSuffix + '（宿主 PID 后 4 位）。'
      + '工具返回结果约 ' + String(EXIT_DELAY_MS) + 'ms 后宿主退出，detached supervisor 用原命令行拉起并重放 handoff。',
  }
}

/** Step 2: consume the one-time token and execute the pending plan. */
function executeConfirm(rawArgs, exec, state) {
  const { ctx, settings, deps } = state
  const confirm = typeof rawArgs.confirm === 'string' ? rawArgs.confirm.trim().toLowerCase() : ''
  const pending = readPending(state)
  if (pending === null) {
    appendRestartAudit(state, {
      phase: 'refused',
      decision: 'refused',
      caller: callerSessionIdOf(exec),
      blockersCount: 0,
      willResumeCount: 0,
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: '没有待确认的重启计划：pending 记录不存在（可能已过期、已被消费，或宿主重启过）。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: '没有待确认的重启计划：pending 记录不存在（可能已过期、已被消费，或宿主重启过）。',
      hint: '先调用 restart_dsh（不带 confirm）获取警告和令牌。',
    }
  }
  const plan = pending.plan
  const plannedWillResume = Array.isArray(plan.willResume) ? plan.willResume.length : 0
  /** Audit one step-2 decision against the bound plan (never writes the token). */
  const audit = entry => appendRestartAudit(state, {
    caller: typeof plan.callerSessionId === 'string' ? plan.callerSessionId : callerSessionIdOf(exec),
    blockersCount: 0,
    willResumeCount: plannedWillResume,
    ...entry,
  })
  if (plan.hostPid !== process.pid) {
    discardPending(state)
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: 'pending 记录属于之前的宿主进程，令牌不能跨重启使用。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: 'pending 记录属于之前的宿主进程（hostPid=' + String(plan.hostPid) + '），令牌不能跨重启使用。',
      hint: '重新走第一步获取新的令牌。',
    }
  }
  if (!TOKEN_PATTERN.test(confirm) || hashToken(confirm) !== String(pending.tokenHash)) {
    // A wrong token does not consume the pending record: the model may retry
    // with the token from the warning it actually saw. Compare SHA-256 hashes:
    // only the hash is stored, the plain token lives in the tool result only.
    ctx.logger.warn('[dsh-restart] confirm refused: token mismatch')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: 'confirm 令牌不匹配。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: 'confirm 令牌不匹配。',
      hint: '使用第一步警告里返回的 token（12 位十六进制），不要自己编造。',
    }
  }
  const nowMs = deps.now()
  if (typeof pending.expiresAtMs !== 'number' || nowMs > pending.expiresAtMs) {
    discardPending(state)
    ctx.logger.warn('[dsh-restart] confirm refused: token expired')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: 'confirm 令牌已过期（TTL ' + String(settings.pendingTtlMs) + 'ms）。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: 'confirm 令牌已过期（TTL ' + String(settings.pendingTtlMs) + 'ms）。',
      hint: '重新调用第一步获取新令牌；过期令牌已被消费。',
    }
  }

  // Second gate: the confirmation must also carry the Host PID's last 4 digits
  // that the step-1 warning showed. A missing or wrong value refuses WITHOUT
  // consuming the token, writing a handoff record, or spawning anything, so a
  // mistyped suffix is retryable.
  const expectedPidSuffix = String(process.pid).slice(-4)
  const suppliedPidSuffix = typeof rawArgs.confirmPidSuffix === 'string'
    ? rawArgs.confirmPidSuffix.trim()
    : ''
  if (suppliedPidSuffix === '') {
    ctx.logger.warn('[dsh-restart] confirm refused: confirmPidSuffix is missing')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: '缺少必填参数 confirmPidSuffix（宿主 PID 后 4 位）。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: '缺少必填参数 confirmPidSuffix（宿主 PID 后 4 位）。',
      hint: '第一步警告里有「确认时需提供宿主 PID 后 4 位：XXXX」，把该 4 位数以 confirmPidSuffix 传入；'
        + '令牌未被消费，可重试。',
    }
  }
  if (suppliedPidSuffix !== expectedPidSuffix) {
    ctx.logger.warn('[dsh-restart] confirm refused: confirmPidSuffix mismatch')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      reason: 'confirmPidSuffix 与宿主 PID 后 4 位不匹配。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: 'confirmPidSuffix 与宿主 PID 后 4 位不匹配。',
      hint: '使用第一步返回的 pidSuffix（即 hostProcessChain.hostPid 的后 4 位）；令牌未被消费，可重试。',
    }
  }

  // Re-sample live sessions at the last moment. A session that started running
  // after the warning must not be destroyed by a confirmation of an older
  // plan: refuse and keep the token until it expires.
  const sessions = collectSessions(ctx, plan.callerSessionId)
  const resolveBlockerTeam = makeBlockerTeamResolver(ctx)
  const blockers = sessions
    .filter(session => session.sessionId !== plan.callerSessionId && session.status === 'running')
    .map(session => buildBlockerEntry(
      session,
      resolveBlockerTeam,
      '警告之后该会话开始运行；等它完成后重试确认。',
      '后重试确认。',
    ))
  if (blockers.length > 0) {
    ctx.logger.warn('[dsh-restart] confirm deferred: ' + String(blockers.length) + ' session(s) started running after the warning')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      blockersCount: blockers.length,
      reason: '警告后又有会话进入 running 状态，确认已推迟（未消费令牌，未写 handoff）。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: '警告后又有会话进入 running 状态，确认已推迟（未消费令牌，未写 handoff）。',
      blockers,
      hint: '等这些会话完成后，用同一个 confirm 令牌重试（令牌仍有效），或重新走第一步。',
    }
  }

  // Safety double-lock: refuse a REAL restart before any side effect (no token
  // consumption, no handoff, no spawn, no exit) until allowRealRestart is
  // explicitly enabled after verify-relaunch passed. dryRun is unaffected.
  if (settings.allowRealRestart !== true && plan.dryRun !== true) {
    ctx.logger.warn('[dsh-restart] confirm refused: allowRealRestart=false (real restart disabled)')
    audit({
      phase: 'refused',
      decision: 'refused',
      canRestart: false,
      tokenIssued: false,
      tokenConsumed: false,
      willResumeCount: plannedWillResume,
      reason: '真实重启未启用（allowRealRestart=false），拒绝执行；未消费令牌、未写 handoff、未 spawn、未退出。',
    })
    return {
      phase: 'refused',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      reason: '真实重启未启用：请在备用端口（默认 13081）跑 verify-relaunch 通过并确认后，'
        + '把 cordis.patch.yml 的 allowRealRestart 设为 true 再重试。',
      hint: '令牌未被消费，可重试；dryRun 演练路径仍然可用（第一步传 dryRun:true）。',
    }
  }

  // Token is spent by this confirmation (one-time) before any side effect.
  discardPending(state)

  const willResume = Array.isArray(plan.willResume) ? plan.willResume : []
  const createdAtMs = deps.now()
  const execArgv = Array.isArray(process.execArgv)
    ? process.execArgv.filter(item => typeof item === 'string')
    : []
  const handoff = {
    version: HANDOFF_VERSION,
    hostPid: process.pid,
    createdAt: new Date(createdAtMs).toISOString(),
    execPath: process.execPath,
    // Node keeps interpreter flags (e.g. `--import tsx/esm`) out of
    // process.argv; the supervisor MUST replay them or the fresh Host dies
    // instantly (P0 incident 2026-10-24).
    execArgv,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    hostCommand: redactDiagnostic(hostCommandLine(process.execPath, [...execArgv, ...process.argv.slice(1)]), settings.diagnostics),
    reason: plan.reason,
    continuePrompt: plan.continuePrompt,
    sessions,
    logPath: settings.logPath,
    dryRun: plan.dryRun === true,
    callerSessionId: plan.callerSessionId,
    supervisorPath: settings.supervisorPath,
  }

  if (handoff.dryRun) {
    // dryRun writes the record for inspection only: no supervisor, no exit.
    writeJsonAtomic(settings.handoffPath, handoff)
    ctx.logger.info('[dsh-restart] dryRun handoff written to ' + settings.handoffPath + ' (no restart)')
    audit({
      phase: 'dry-run',
      decision: 'dry-run',
      canRestart: true,
      tokenIssued: false,
      tokenConsumed: true,
      willResumeCount: willResume.length,
      reason: plan.reason,
    })
    return {
      phase: 'dry-run',
      tool: 'restart_dsh',
      ok: true,
      canRestart: true,
      tokenConsumed: true,
      handoffPath: settings.handoffPath,
      hostPid: process.pid,
      sessions,
      resumedPlan: willResume,
      message: 'dryRun：已写入 handoff.json，但没有 spawn supervisor，也没有退出进程；不会发生重启。',
    }
  }

  if (handoff.argv.length === 0) {
    removeFile(settings.handoffPath)
    return {
      phase: 'error',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      error: '无法捕获宿主启动参数（process.argv.slice(1) 为空），不敢重启。',
      hint: '请人工确认宿主启动命令后重试。',
    }
  }

  mkdirSync(settings.handoffDir, { recursive: true })
  writeFileSync(settings.supervisorPath, SUPERVISOR_SOURCE, 'utf8')
  writeJsonAtomic(settings.handoffPath, handoff)

  let child
  try {
    child = deps.spawn(process.execPath, [settings.supervisorPath, settings.handoffPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: settings.handoffDir,
    })
  } catch (error) {
    // Never leave a handoff record for a restart that was not started.
    removeFile(settings.handoffPath)
    ctx.logger.warn('[dsh-restart] supervisor spawn failed: ' + String(error))
    return {
      phase: 'error',
      tool: 'restart_dsh',
      ok: false,
      canRestart: false,
      error: 'supervisor spawn 失败：' + String(error),
      handoffPath: settings.handoffPath,
      hint: '宿主未被退出；请检查权限/Node 路径后重试。',
    }
  }
  try {
    child?.unref?.()
  } catch {
    // unref is best effort; detached already separates the process
  }
  deps.setTimeout(() => {
    try {
      deps.exit(0)
    } catch {
      // the process is going away; nothing useful to do on a failing exit mock
    }
  }, EXIT_DELAY_MS)
  ctx.logger.warn('[dsh-restart] restart confirmed: handoff=' + settings.handoffPath
    + ' supervisor pid=' + String(child?.pid ?? '?') + '; exiting in ' + String(EXIT_DELAY_MS) + 'ms')
  audit({
    phase: 'confirmed',
    decision: 'confirmed',
    canRestart: true,
    tokenIssued: false,
    tokenConsumed: true,
    willResumeCount: willResume.length,
    reason: plan.reason,
  })
  return {
    phase: 'confirmed',
    tool: 'restart_dsh',
    step: 2,
    ok: true,
    canRestart: true,
    tokenConsumed: true,
    handoffPath: settings.handoffPath,
    hostPid: process.pid,
    hostCommand: handoff.hostCommand,
    sessions,
    resumedPlan: willResume,
    supervisor: {
      spawned: true,
      pid: typeof child === 'object' && child !== null && Number.isInteger(child.pid) ? child.pid : null,
      script: settings.supervisorPath,
      logPath: settings.logPath,
    },
    exitInMs: EXIT_DELAY_MS,
    message: '工具结果返回后约 ' + String(EXIT_DELAY_MS) + 'ms 宿主退出；detached supervisor 会用同样的命令行重启宿主，'
      + '新进程启动时会重放 handoff，恢复 ' + String(willResume.length) + ' 个会话并注入 continuePrompt。',
  }
}

// ---------------------------------------------------------------------------
// task-88: Host Remote endpoints for the Web "restart DSH" button.
// The Gateway source-mode discovery reads a Service's `typertRemote` binding and
// the standard Remote method-descriptor prototype property. These are normally
// emitted by @Remote decorators; this zero-dependency plugin declares the SAME
// wire metadata explicitly instead of importing the protocol/build packages.
// All three endpoints delegate to the existing preflight/confirm state machine:
// no second kill/spawn path exists.
// ---------------------------------------------------------------------------

const REMOTE_SERVICE_KEY = 'relaunchRemote'
const REMOTE_NAMESPACE = 'relaunch'
const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const REMOTE_METHODS = Object.freeze([
  Object.freeze({ method: 'status', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'prepare', invocation: Object.freeze({ kind: 'direct' }) }),
  Object.freeze({ method: 'confirm', invocation: Object.freeze({ kind: 'direct' }) }),
])

/** Blockers for an ownerless UI call (no caller session can be excluded). */
function remoteBlockers(state) {
  const sessions = collectSessions(state.ctx, null)
  const resolveBlockerTeam = makeBlockerTeamResolver(state.ctx)
  return sessions
    .filter(session => session.status === 'running')
    .map(session => buildBlockerEntry(
      session,
      resolveBlockerTeam,
      '等待该会话当前回合完成（或让其停下）后再重试。',
      '后再重试。',
    ))
}

/** Read-only `relaunch/status` body. Never issues a token or writes audit. */
function remoteStatus(state) {
  const lastReplay = tryReadJson(state.settings.lastReplayPath)
  return {
    phase: 'status',
    enabled: state.settings.enabled,
    tool: 'restart_dsh',
    allowRealRestart: state.settings.allowRealRestart === true,
    locked: state.settings.allowRealRestart !== true,
    pidSuffix: String(process.pid).slice(-4),
    hostPid: process.pid,
    blockers: remoteBlockers(state),
    lastReplay,
    pendingTtlMs: state.settings.pendingTtlMs,
    remote: { service: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE, endpoints: ['relaunch/status', 'relaunch/prepare', 'relaunch/confirm'] },
  }
}

/** `relaunch/prepare`: reuse the warning preflight; never restarts. */
function remotePrepare(state, args) {
  // An ownerless UI call is audited as caller 'ui'; the caller session id is
  // intentionally not invented, so every running session remains a blocker.
  const remoteExec = { remote: true, sessionId: 'ui' }
  const previousActor = state.auditActor
  state.auditActor = 'ui'
  try {
    const warning = executeWarning(args, remoteExec, state, { lockAware: true })
    return {
      ...warning,
      hostPid: process.pid,
      remote: true,
      actor: 'ui',
      locked: warning.phase === 'locked' || warning.locked === true,
    }
  } finally {
    state.auditActor = previousActor
  }
}

/** `relaunch/confirm`: same token/pidSuffix/blocker/lock checks + audit. */
function remoteConfirm(state, args) {
  const remoteExec = { remote: true, sessionId: 'ui' }
  const previousActor = state.auditActor
  state.auditActor = 'ui'
  try {
    // The lock is one of the four existing gates. Report it before touching the
    // pending record so the browser shows a readable lock error, not a generic
    // "no pending plan" refusal.
    if (state.settings.allowRealRestart !== true) {
      appendRestartAudit(state, {
        phase: 'refused',
        decision: 'refused',
        caller: 'ui',
        blockersCount: 0,
        willResumeCount: 0,
        canRestart: false,
        tokenIssued: false,
        tokenConsumed: false,
        reason: '真实重启未启用（allowRealRestart=false）；confirm 拒绝，未消费令牌、未写 handoff、未 spawn、未退出。',
      })
      return {
        phase: 'refused',
        tool: 'restart_dsh',
        ok: false,
        canRestart: false,
        locked: true,
        allowRealRestart: false,
        hostPid: process.pid,
        remote: true,
        actor: 'ui',
        reason: '真实重启未启用（allowRealRestart=false）：confirm 已拒绝；请先启用安全锁。',
        hint: '先用 prepare 查看锁信息；启用 allowRealRestart 后重新 prepare。',
      }
    }
    const result = executeConfirm({
      confirm: args.token,
      confirmPidSuffix: args.pidSuffix,
    }, remoteExec, state)
    return {
      ...result,
      hostPid: process.pid,
      remote: true,
      actor: 'ui',
      ...(result.phase === 'confirmed' && typeof result.message === 'string'
        ? { message: result.message }
        : {}),
    }
  } finally {
    state.auditActor = previousActor
  }
}

/**
 * Plain-JS equivalent of `class extends TypertRemoteService`, with explicit
 * source-mode markers. The Gateway dispatches these as named JSON arguments.
 */
class RelaunchRemoteService {
  constructor(ctx, state) {
    this.ctx = ctx
    this.state = state
  }

  status() {
    return remoteStatus(this.state)
  }

  prepare(reason, continuePrompt, dryRun) {
    const args = reason !== null && typeof reason === 'object'
      ? reason
      : { reason, continuePrompt, dryRun }
    return remotePrepare(this.state, args)
  }

  confirm(token, pidSuffix) {
    const args = token !== null && typeof token === 'object'
      ? token
      : { token, pidSuffix }
    return remoteConfirm(this.state, args)
  }
}

Object.defineProperty(RelaunchRemoteService.prototype, REMOTE_METHOD_DESCRIPTOR_KEY, {
  configurable: true,
  enumerable: false,
  value: Object.freeze({ version: 1, methods: REMOTE_METHODS }),
})

/** Register the remote-visible Service in the current Cordis context. */
function installRemoteEndpoints(ctx, state) {
  const service = new RelaunchRemoteService(ctx, state)
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ service, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE }),
  })
  try {
    ctx.provide(REMOTE_SERVICE_KEY, service)
  } catch (error) {
    try {
      ctx.logger.warn('[dsh-restart] remote endpoints not registered: ' + String(error))
    } catch {
      // logging only
    }
  }
  return service
}

/** Build the registered restart_dsh tool definition. */
function makeRestartTool(state) {
  return {
    name: 'restart_dsh',
    description:
      'Restart the DeepSeek Harness Host from inside the conversation, then come back to the work automatically. '
      + 'TWO-STEP tool, never a one-shot restart. Step 2 is a human/operator gate: with the shipped '
      + 'allowRealRestart:false, confirm is refused; capability index: skill("team-bootstrap") §2. '
      + 'Step 1 (omit confirm): read-only preflight. It lists live sessions and REFUSES while any session other than '
      + 'the caller is running (blockers[]; each blocker carries sessionId/cwd/status plus best-effort Team name/role '
      + 'and a hint). Otherwise it returns {phase:"warning", canRestart:true, token, expiresInMs, pidSuffix, '
      + 'wakeCount, idleCount, hostProcessChain, plan}: wakeCount sessions would be resumed after the restart, '
      + 'idleCount idle sessions would not. hostProcessChain shows the Host PID, its full command line, its parent '
      + 'PID/command line (best-effort local probe; null fields when unavailable) and what a direct kill would cost. '
      + 'Nothing restarts in step 1. '
      + 'Step 2 (pass confirm=<token> AND confirmPidSuffix=<last 4 digits of the Host PID>): BOTH are required; a '
      + 'missing or wrong value is refused without consuming the token, writing the handoff, or spawning anything. '
      + 'A REAL restart also requires host config allowRealRestart:true (default false, a safety double-lock): while '
      + 'it is false the confirmation is refused before any side effect with a hint to run verify-relaunch on port '
      + 'a spare port (default 13081) and get approval first; dryRun is unaffected. When enabled, the confirmation executes exactly the plan '
      + 'from the step-1 warning (reason/continuePrompt come from the pending record, not from the new arguments), '
      + 'writes a v2 handoff record atomically (execPath + execArgv + argv + cwd, so Node loader flags such as '
      + '--import tsx/esm are preserved), starts a detached supervisor, and exits the Host ~1.5s later so the tool '
      + 'result reaches you first. The supervisor relaunches `node <execArgv> <argv>`, health-checks the fresh Host '
      + 'for >= 8s (retrying up to 5 times, writing restart-failed.json on total failure); on boot the plugin resumes '
      + 'the sessions that were running and wakes the requesting session with continuePrompt. '
      + 'The token is 12 hex characters, single-use, TTL 120s. Use dryRun:true (step 1) to write the handoff record '
      + 'without restarting. Every step appends one JSONL audit line (phase/decision/caller/blocker + wake counts/'
      + 'hostPidSuffix/allowRealRestart; never the token plaintext). Do NOT kill the Host from bash/pwsh: the '
      + 'pre-execute fence denies such commands.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the Host must restart (shown in the warning and persisted in the handoff record). '
            + 'Step-1 only; step 2 ignores it.',
        },
        continuePrompt: {
          type: 'string',
          description: 'The instruction the requesting session should be woken with after the restart '
            + '(persisted in the handoff and replayed on boot). Step-1 only; step 2 ignores it.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Step-1 only. Write the handoff record but never spawn the supervisor or exit the Host.',
        },
        confirm: {
          type: 'string',
          description: 'The 12-hex token returned by the step-1 warning. Omit on the first call. '
            + 'Passing the matching token is the confirmation; the token is single-use and expires after 120s.',
        },
        confirmPidSuffix: {
          type: 'string',
          description: 'Second step only and REQUIRED there: the last 4 digits of the Host PID, exactly as the '
            + 'step-1 warning prints "确认时需提供宿主 PID 后 4 位：XXXX" (also returned as pidSuffix). '
            + 'A missing or wrong value refuses the confirmation without consuming the token, so it can be retried.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: args => {
      const confirming = args !== null && typeof args === 'object'
        && typeof args.confirm === 'string' && args.confirm !== ''
      return {
        card: 'generic',
        title: confirming ? 'Confirm DSH restart' : 'Plan DSH restart',
        kind: confirming ? 'execute' : 'read',
      }
    },
    async execute(args, exec) {
      state.auditActor = 'tool'
      const rawArgs = args !== null && typeof args === 'object' ? args : {}
      const confirm = typeof rawArgs.confirm === 'string' ? rawArgs.confirm.trim() : ''
      if (confirm === '') return executeWarning(rawArgs, exec, state)
      return executeConfirm(rawArgs, exec, state)
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** Replay the handoff on boot, logging the outcome and never rejecting. */
function replayOnBoot(ctx, config, deps) {
  return replayHandoff(ctx, config, deps)
    .then(summary => {
      try {
        if (summary.replayed === true) {
          ctx.logger.info('[dsh-restart] startup replay finished: resumed=' + String(summary.resumed.length)
            + ' failed=' + String(summary.failed.length))
        } else if (summary.reason !== 'no-handoff') {
          ctx.logger.info('[dsh-restart] startup replay skipped: ' + String(summary.reason))
        }
      } catch {
        // logging only
      }
      return summary
    })
    .catch(error => {
      try {
        ctx.logger.warn('[dsh-restart] startup replay failed: ' + String(error))
      } catch {
        // logging only
      }
      return { replayed: false, skipped: true, reason: 'error', error: String(error) }
    })
}

/**
 * Plugin apply.
 * @param ctx - Cordis plugin context.
 * @param config - plugin config from cordis.patch.yml.
 * @param deps - optional injected process primitives (tests only).
 */
export function apply(ctx, config, deps) {
  const settings = normalizeConfig(config)
  const resolvedDeps = normalizeDeps(deps)
  const state = { ctx, settings, deps: resolvedDeps, memoryPending: null, auditActor: 'tool' }

  // Read-only status tool (registered even when the tool itself is disabled).
  ctx.tools.register({
    name: 'restart_status',
    description:
      'Read-only status of the two-step host restart plugin: version, enabled flag, the allowRealRestart safety lock, '
      + 'diagnostics mode, handoff/audit paths, pending token metadata (never the token itself), last boot replay, '
      + 'remote-endpoint registration state, and the effective config. It never restarts anything. Capability index: '
      + 'skill("team-bootstrap") §2 / CAPABILITY_AUDIT.md.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const readJson = (file) => {
        try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
      }
      const pending = readJson(settings.pendingPath)
      return {
        ok: true,
        plugin: 'dsh-restart',
        version: PLUGIN_VERSION,
        enabled: settings.enabled,
        tool: 'restart_dsh',
        allowRealRestart: settings.allowRealRestart,
        diagnostics: settings.diagnostics,
        fence: settings.fence,
        autoResume: settings.autoResume,
        pendingTtlMs: settings.pendingTtlMs,
        handoffTtlMs: settings.handoffTtlMs,
        resumeSettleMs: settings.resumeSettleMs,
        handoffDir: settings.handoffDir,
        auditFile: settings.auditFile,
        handoffExists: existsSync(settings.handoffPath),
        pending: pending === null ? null : {
          issuedAt: pending.issuedAt ?? null,
          expiresAt: pending.expiresAt ?? null,
          callerSessionId: pending.callerSessionId ?? null,
          reasonPreview: typeof pending.reason === 'string' ? pending.reason.slice(0, 120) : null,
        },
        lastReplay: readJson(settings.lastReplayPath),
        remote: {
          service: REMOTE_SERVICE_KEY,
          namespace: REMOTE_NAMESPACE,
          endpoints: ['relaunch/status', 'relaunch/prepare', 'relaunch/confirm'],
          registered: settings.enabled,
        },
        config: { defaults: defaultsOf(Config), fields: fieldDocs(Config) },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Restart status', kind: 'read' }),
  })

  if (!settings.enabled) {
    ctx.logger.info('[dsh-restart] v' + PLUGIN_VERSION + ' disabled by config (enabled=false); status tool only')
    return
  }

  if (settings.fence) installFence(ctx)
  ctx.tools.register(makeRestartTool(state))
  // task-88: register relaunch/status|prepare|confirm for the Web header button.
  installRemoteEndpoints(ctx, state)
  ctx.logger.info('[dsh-restart] v' + PLUGIN_VERSION + ' ready allowRealRestart=' + settings.allowRealRestart
    + ' diagnostics=' + settings.diagnostics + ' handoffDir=' + settings.handoffDir)

  let startupTimer
  try {
    startupTimer = resolvedDeps.setTimeout(() => {
      void replayOnBoot(ctx, config, deps)
    }, settings.resumeSettleMs)
    if (startupTimer !== null && typeof startupTimer === 'object' && typeof startupTimer.unref === 'function') {
      startupTimer.unref()
    }
  } catch (error) {
    try {
      ctx.logger.warn('[dsh-restart] could not schedule startup replay: ' + String(error))
    } catch {
      // ignore
    }
  }

  ctx.effect(() => () => {
    try {
      resolvedDeps.clearTimeout(startupTimer)
    } catch {
      // already cleared
    }
  })
}
