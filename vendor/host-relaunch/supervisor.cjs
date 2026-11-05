#!/usr/bin/env node
/**
 * dsh-restart detached supervisor (CommonJS helper, HANDOFF_VERSION 2).
 *
 * Usage: node supervisor.cjs <handoffPath>
 *
 * Started by the dsh-restart host plugin right before the Host process exits
 * itself. This helper is the Windows stand-in for a systemd `Restart=always`
 * unit:
 *
 *   1. poll process.kill(hostPid, 0) until the old Host process is gone;
 *   2. wait SETTLE_MS so Windows process teardown and file handles settle;
 *   3. relaunch the Host as `spawn(execPath, [...execArgv, ...argv], ...)`.
 *      `execArgv` is REQUIRED: Node keeps interpreter flags such as
 *      `--import tsx/esm` out of `process.argv`, and relaunching a TypeScript
 *      entry point without them crashes instantly (P0 incident 2026-10-24);
 *   4. health-check the fresh Host for VERIFY_MS (>= 8s by default); if it dies
 *      early, log its exit code/signal plus a stderr tail and retry up to
 *      MAX_ATTEMPTS (5) times, RETRY_MS (3s) apart;
 *   5. if every attempt fails, write `restart-failed.json` (attempt evidence)
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
 * a bare `node supervisor.cjs` from the handoff directory, without a package
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
  const compact = tail.replace(/\r\n/g, ' | ').replace(/[\r\n]+/g, ' | ').replace(/\s+/g, ' ').trim()
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
