/**
 * Prompt Architect core: project state, phase gating, progress disclosure, and
 * empty-context subagent verification records. Host-free by design so the same
 * logic serves the preset tools, the CLI, and the selftest.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ARTIFACTS, ARTIFACT_ORDER, DIMENSIONS, PHASES, nextPhaseId, phaseById } from './workflow.js'

const STATE_DIR = '.prompt-forge'
const STATE_FILE = 'state.json'
const LEDGER_FILE = 'ledger.jsonl'
const RUNS_DIR = 'subagent-runs'
const ARCHIVE_DIR = 'subagent-runs-archive'

const now = () => new Date().toISOString()
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Validate a verification run id and confine it under .prompt-forge/subagent-runs. */
function resolveRunDir(project, rawRunId) {
  const runId = String(rawRunId ?? '').trim()
  if (!RUN_ID_RE.test(runId)) throw new Error('invalid runId: use letters/digits/_/- (max 64), got ' + JSON.stringify(runId))
  const runsRoot = join(project, STATE_DIR, RUNS_DIR)
  const runDir = resolve(runsRoot, runId)
  const rel = relative(runsRoot, runDir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid runId path: ' + runId)
  return { runId, runDir }
}

/** Resolve an existing project directory and ensure the private state dirs exist. */
export function openProject(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    throw new Error('projectDir is required (absolute path to the working project)')
  }
  if (!isAbsolute(projectDir)) throw new Error('projectDir must be an absolute path: ' + projectDir)
  const abs = resolve(projectDir)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error('projectDir does not exist or is not a directory: ' + abs)
  }
  const root = join(abs, STATE_DIR)
  for (const dir of [root, join(root, RUNS_DIR), join(root, ARCHIVE_DIR)]) mkdirSync(dir, { recursive: true })
  return abs
}

const statePath = project => join(project, STATE_DIR, STATE_FILE)
const ledgerPath = project => join(project, STATE_DIR, LEDGER_FILE)

/** Read state, or null for a fresh project. */
export function readState(project) {
  const path = statePath(project)
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (state === null || typeof state !== 'object' || typeof state.phase !== 'string') {
    throw new Error('invalid state file: ' + path)
  }
  return state
}

function writeState(project, state) {
  const path = statePath(project)
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Append one audit line; never rewrites history. */
export function appendLedger(project, entry) {
  writeFileSync(ledgerPath(project), JSON.stringify({ at: now(), ...entry }) + '\n', { encoding: 'utf8', flag: 'a' })
}

/** Hash one artifact file. */
function fingerprint(project, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('artifact path must be a non-empty string')
  const abs = isAbsolute(value) ? resolve(value) : resolve(project, value)
  const rel = relative(project, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('artifact must live inside the project: ' + value)
  if (!existsSync(abs)) throw new Error('artifact file does not exist: ' + rel)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error('artifact is not a regular file: ' + rel)
  return {
    path: rel.replace(/\\/g, '/'),
    sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
    bytes: stat.size,
    at: now(),
  }
}

const phaseIdOf = state => (state === null ? 'S0' : state.phase)

/** Compact progress view: phase, produced artifacts, next phase. */
export function status(projectDir) {
  const project = openProject(projectDir)
  const state = readState(project)
  const phase = phaseIdOf(state)
  const def = phaseById(phase)
  return {
    project,
    phase,
    title: def === null ? { zh: '已完成', en: 'Done' } : { zh: def.zh, en: def.en },
    artifacts: state === null ? {} : state.artifacts,
    verification: state === null || state.verify === undefined ? null : state.verify,
    nextPhase: nextPhaseId(phase),
    stateFile: statePath(project),
    ledgerFile: ledgerPath(project),
  }
}

/** Full next-step disclosure for the current phase (the progress-aware guide). */
export function nextStep(projectDir) {
  const project = openProject(projectDir)
  const state = readState(project)
  const phase = phaseIdOf(state)
  if (phase === 'done') {
    return {
      project,
      phase,
      done: true,
      message: { zh: '流程已完成；如需新一轮优化，建立新的 project 目录并重新从 S0 开始。', en: 'Workflow is done; start a new project directory for another round.' },
    }
  }
  const def = phaseById(phase)
  const artifacts = state === null ? {} : state.artifacts
  const missing = def.required.filter(key => artifacts[key] === undefined)
  return {
    project,
    phase,
    title: { zh: def.zh, en: def.en },
    purpose: def.purpose,
    inputs: def.required
      .filter(key => artifacts[key] !== undefined)
      .map(key => ({ key, ...artifacts[key] })),
    steps: def.steps,
    produce: def.produce.map(key => ({ key, label: ARTIFACTS[key] })),
    missingBeforeAdvance: missing,
    acceptance: def.acceptance,
    pitfalls: def.pitfalls,
    toolCalls: {
      zh: [
        '按 steps 产出文件后，调用 prompt_forge_advance({ projectDir, artifacts: { ' + def.produce.map(key => key + ': "<相对路径>"').join(', ') + ' } })',
        def.needsVerification === true
          ? 'S6 必须先 prompt_forge_verify_dispatch → 用 `subagent`（空上下文，勿用 subagent_fork）投递 → prompt_forge_verify_record → 再 advance。'
          : '若缺少前置产物，advance 会拒绝并列出缺失项。',
      ],
      en: [
        'After producing the files, call prompt_forge_advance with the artifacts object.',
        def.needsVerification === true
          ? 'S6 requires verify-dispatch → fresh `subagent` run → verify-record before advancing.'
          : 'advance refuses and lists missing prerequisites when incomplete.',
      ],
    },
    ...(def.needsVerification === true ? { verificationProtocol: verificationProtocol() } : {}),
    nextPhase: nextPhaseId(phase),
  }
}

/** Shared verification protocol text, surfaced in S6 and by the dispatch tool. */
export function verificationProtocol() {
  return {
    zh: [
      '验证必须由「空上下文子智能体」执行：使用 subagent 工具（新会话，不继承当前会话历史），把 packet 原文作为 prompt 投递。',
      '禁止使用 subagent_fork（会继承本会话上下文，结论会受污染）。',
      '子智能体只读：不得修改任何文件；每条 verdict 必须引用文件与行号证据。',
      '把子智能体返回的 JSON verdicts 交给 prompt_forge_verify_record 记录；有 ❌ 必修项则回到 S4 补丁并重跑 S5/S6。',
      '子智能体上下文天然按调用隔离；prompt_forge_reset_subagent 用于归档某次 run 的本地产物并标记关闭（不是删除会话记录）。',
    ],
    en: [
      'Verification must run in a fresh empty-context subagent: use the subagent tool, not the current session.',
      'Never use subagent_fork; inherited context contaminates the verdict.',
      'The verifier is read-only; every verdict cites file and line evidence.',
      'Feed the returned JSON verdicts to prompt_forge_verify_record; fix must-fix ❌ items and re-run S4→S6.',
      'Subagent context is per-call isolated; prompt_forge_reset_subagent archives a run artifacts and closes it (it does not delete session records).',
    ],
  }
}

const artifactRecordOf = (state, key) => (state.artifacts === undefined ? undefined : state.artifacts[key])

/** Record phase artifacts and advance the state machine. */
export function advance(projectDir, options = {}) {
  const project = openProject(projectDir)
  const previous = readState(project)
  let state = previous
  if (state === null) {
    state = { schema: 1, project, phase: 'S0', createdAt: now(), updatedAt: now(), artifacts: {}, verify: { mode: null, runs: [] }, history: [] }
  }
  const current = phaseIdOf(state)
  if (current === 'done') throw new Error('workflow is already done')
  const def = phaseById(current)
  const provided = options.artifacts ?? {}
  if (typeof provided !== 'object' || provided === null || Array.isArray(provided)) throw new Error('artifacts must be an object')
  const allowed = new Set(def.produce)
  for (const key of Object.keys(provided)) {
    if (!allowed.has(key)) throw new Error('phase ' + current + ' does not produce artifact "' + key + '" (allowed: ' + [...allowed].join(', ') + ')')
  }
  for (const [key, value] of Object.entries(provided)) state.artifacts[key] = fingerprint(project, value)
  const missing = def.required.filter(key => state.artifacts[key] === undefined)
  if (missing.length > 0) {
    const label = missing.map(key => key + ' (' + ARTIFACTS[key].zh + ')').join('、')
    throw new Error('phase ' + current + ' is missing required artifacts: ' + label + '; produce them and call advance again')
  }
  let fallback = null
  if (def.needsVerification === true) {
    const runs = state.verify?.runs ?? []
    const verified = runs.some(run => run.mode === 'subagent' && run.summary?.fail === 0)
    if (!verified) {
      const reason = typeof options.verifyFallbackReason === 'string' ? options.verifyFallbackReason.trim() : ''
      if (reason === '') {
        throw new Error('S6 requires an empty-context subagent verification record with no must-fix ❌; '
          + 'run prompt_forge_verify_dispatch → subagent → prompt_forge_verify_record, '
          + 'or pass verifyFallbackReason to record an explicit fallback')
      }
      fallback = reason
      appendLedger(project, { action: 'verify-fallback', phase: current, reason })
    }
  }
  const from = current
  const to = nextPhaseId(current) ?? 'done'
  state.phase = to
  state.updatedAt = now()
  state.history.push({
    at: now(),
    from,
    to,
    artifacts: Object.keys(provided),
    ...(fallback === null ? {} : { verifyFallbackReason: fallback }),
    ...(typeof options.note === 'string' && options.note.trim() !== '' ? { note: options.note.trim() } : {}),
  })
  writeState(project, state)
  appendLedger(project, { action: 'advance', from, to, artifacts: Object.keys(provided), fallback })
  return status(project)
}

/** Build a self-contained verification packet for a fresh subagent. */
export function verifyDispatch(projectDir, options = {}) {
  const project = openProject(projectDir)
  const state = readState(project)
  if (state === null) throw new Error('no state yet; run S0–S5 first')
  if (state.phase !== 'S5' && state.phase !== 'S6') {
    throw new Error('verification packet is available in S5/S6 only (current: ' + state.phase + ')')
  }
  const assembled = artifactRecordOf(state, 'assembled')
  if (assembled === undefined) throw new Error('missing assembled prompt artifact; finish S5 first')
  const drill = artifactRecordOf(state, 'drill')
  const issues = artifactRecordOf(state, 'issues')
  const stamp = now().replace(/[-:.TZ]/g, '').slice(0, 14)
  const runId = 'v' + stamp + '-' + assembled.sha256.slice(0, 8)
  const runDir = join(project, STATE_DIR, RUNS_DIR, runId)
  mkdirSync(runDir, { recursive: true })
  const focus = typeof options.focus === 'string' && options.focus.trim() !== '' ? options.focus.trim() : '全部九维'
  const lines = [
    '# 空上下文验证任务（Prompt Architect / empty-context verification）',
    '',
    '你是独立验证者。你没有、也不应读取任何前序会话历史；只能依据本任务包中的文件与指令工作。',
    'You are an independent verifier with NO prior context. Use only the files and instructions below.',
    '',
    '## 只读约束 / Read-only rules',
    '- 不得修改任何文件；不得创建除本任务结果之外的文件。',
    '- 每条结论必须引用 文件:行号 或文件片段；无证据的结论视为无效。',
    '',
    '## 输入 / Inputs',
    '- 新版人格提示词全文: ' + assembled.path + '（sha256 ' + assembled.sha256 + '）',
    drill === undefined ? '- 演练结果: （缺）' : '- 演练结果: ' + drill.path,
    issues === undefined ? '- 疏漏清单: （缺）' : '- 疏漏清单: ' + issues.path,
    '',
    '## 重点 / Focus',
    focus,
    '',
    '## 九维核对 / Nine dimensions',
    ...DIMENSIONS.map(dim => '- ' + dim.id + '（' + dim.zh + ' / ' + dim.en + '）'),
    '',
    '## 输出格式 / Output (JSON only)',
    '```json',
    '{',
    '  "runId": "' + runId + '",',
    '  "verdicts": [',
    '    { "dimension": "coverage", "verdict": "pass|warn|fail", "evidence": "file:line 或片段", "note": "..." }',
    '  ],',
    '  "mustFix": ["复述必修 ❌ 项，没有则空数组"],',
    '  "summary": "一句话结论"',
    '}',
    '```',
    '',
    '覆盖全部九个维度；不得只挑好答的维度。',
  ]
  const packet = lines.join('\n') + '\n'
  writeFileSync(join(runDir, 'packet.md'), packet, 'utf8')
  appendLedger(project, { action: 'verify-dispatch', phase: state.phase, runId, assembled: assembled.path })
  return {
    runId,
    runDir: relative(project, runDir).replace(/\\/g, '/'),
    packetPath: relative(project, join(runDir, 'packet.md')).replace(/\\/g, '/'),
    packet,
    dispatch: {
      tool: 'subagent',
      mode: 'fresh-empty-context',
      forbid: ['subagent_fork'],
      instruction: {
        zh: '用 subagent 工具把 packet 原文作为 prompt 投递（新上下文，勿用 subagent_fork）；子智能体返回后调用 prompt_forge_verify_record({ projectDir, runId, verdicts }) 记录。',
        en: 'Dispatch the packet text with the subagent tool (fresh context; never subagent_fork), then call prompt_forge_verify_record.',
      },
    },
  }
}

const normalizeVerdict = value => {
  const text = String(value ?? '').trim().toLowerCase()
  if (['pass', 'ok', '✅'].includes(text)) return 'pass'
  if (['warn', 'warning', '⚠️', '⚠'].includes(text)) return 'warn'
  if (['fail', 'error', '❌'].includes(text)) return 'fail'
  throw new Error('invalid verdict "' + String(value) + '"; use pass|warn|fail (or ✅/⚠️/❌)')
}

/** Record verdicts returned by the fresh subagent. */
export function verifyRecord(projectDir, options = {}) {
  const project = openProject(projectDir)
  const state = readState(project)
  if (state === null) throw new Error('no state yet')
  const { runId, runDir } = resolveRunDir(project, options.runId)
  if (!existsSync(runDir)) throw new Error('unknown verification run: ' + runId)
  const verdicts = Array.isArray(options.verdicts) ? options.verdicts : []
  if (verdicts.length === 0) throw new Error('verdicts must be a non-empty array')
  const known = new Set(DIMENSIONS.map(dim => dim.id))
  const normalized = verdicts.map(entry => {
    if (entry === null || typeof entry !== 'object') throw new Error('each verdict must be an object')
    const dimension = String(entry.dimension ?? '').trim()
    if (!known.has(dimension)) throw new Error('unknown dimension "' + dimension + '"')
    return {
      dimension,
      verdict: normalizeVerdict(entry.verdict),
      evidence: String(entry.evidence ?? '').trim(),
      note: typeof entry.note === 'string' ? entry.note : '',
    }
  })
  const covered = new Set(normalized.map(entry => entry.dimension))
  const missingDims = [...known].filter(dim => !covered.has(dim))
  if (missingDims.length > 0) throw new Error('verdicts must cover all nine dimensions; missing: ' + missingDims.join(', '))
  const summary = {
    pass: normalized.filter(entry => entry.verdict === 'pass').length,
    warn: normalized.filter(entry => entry.verdict === 'warn').length,
    fail: normalized.filter(entry => entry.verdict === 'fail').length,
  }
  const result = {
    runId,
    recordedAt: now(),
    summary,
    mustFix: Array.isArray(options.mustFix) ? options.mustFix : normalized.filter(entry => entry.verdict === 'fail').map(entry => entry.dimension),
    verdicts: normalized,
    notes: typeof options.notes === 'string' ? options.notes : '',
  }
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  const run = { runId, mode: 'subagent', at: result.recordedAt, summary, resultFile: relative(project, join(runDir, 'results.json')).replace(/\\/g, '/') }
  state.verify = state.verify ?? { mode: null, runs: [] }
  state.verify.mode = 'subagent'
  state.verify.runs = [...(state.verify.runs ?? []).filter(entry => entry.runId !== runId), run]
  state.updatedAt = now()
  writeState(project, state)
  appendLedger(project, { action: 'verify-record', runId, summary })
  return { runId, summary, verdicts: normalized, resultsFile: run.resultFile }
}

/** Archive one verification run directory and mark it closed (context hygiene). */
export function resetSubagentRun(projectDir, options = {}) {
  const project = openProject(projectDir)
  const { runId, runDir } = resolveRunDir(project, options.runId)
  if (!existsSync(runDir)) throw new Error('unknown verification run: ' + runId)
  const stamp = now().replace(/[-:.TZ]/g, '').slice(0, 14)
  const target = join(project, STATE_DIR, ARCHIVE_DIR, runId + '-' + stamp)
  renameSync(runDir, target)
  appendLedger(project, { action: 'subagent-run-archive', runId, archivedTo: relative(project, target).replace(/\\/g, '/'), reason: String(options.reason ?? '') })
  return {
    runId,
    archivedTo: relative(project, target).replace(/\\/g, '/'),
    note: {
      zh: '已归档该 run 的本地产物并标记关闭。注意：空上下文子智能体本身按次隔离，不存在需要“清空”的继承上下文；不要用 subagent_fork。',
      en: 'Run artifacts archived and closed. Fresh subagents are per-call isolated; there is no inherited context to clear, and subagent_fork must not be used.',
    },
  }
}

/** Convenience for CLIs/tests: full artifact checklist order. */
export function artifactChecklist() {
  return ARTIFACT_ORDER.map(key => ({ key, label: ARTIFACTS[key] }))
}
