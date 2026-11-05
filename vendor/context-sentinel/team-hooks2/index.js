/**
 * Team hooks v2 for DeepSeek Harness.
 *
 * 1. Context-archive reminder loop at turn close (`agent/turn-stopping`):
 *    - per-session state machine: idle -> over `archiveThreshold` -> CREATE
 *      archive reminder -> every `reminderEveryNTurns` turns remind to UPDATE
 *      the archive -> context drop >= `dropThreshold` -> READ the latest
 *      archive and continue -> reset -> next over-threshold crossing starts a
 *      NEW archive cycle;
 *    - below the threshold there is no threshold/archive reminder; a big drop
 *      can still request reading the archive (compaction);
 *    - one reminder per turn; state/turn/archive counters persist in
 *      `~/.dsh/team-hooks-state.json` so compaction/restart does not reset the
 *      loop; a context-meter `[ctx]`/threshold advisory pending in the same turn
 *      suppresses the archive reminder (dedupe).
 *
 * 2. State persistence: the per-session measurements live in
 *    ~/.dsh/team-hooks-state.json, so a restart keeps the last baseline and the
 *    first turn after a restart can still detect a >=15 point drop.
 *    A drop baseline older than DROP_WINDOW_MS is ignored as stale.
 *
 * 3. Dispatch guard before `send_message` / `spawn_teammate`
 *    (`tools/pre-execute` waterfall).
 *
 * 4. `team_hooks_status` tool: reports the calling session's measured percent,
 *    archive cycle, last baseline, and whether the turn-stopping listener is
 *    attached (it self-heals by attaching on call).
 *
 * 5. Role-based write policy (`tools/pre-execute`, same waterfall): read-only
 *    roles (default: `cr-*` and `verify`) are denied the write-class tools
 *    (`edit`, `write`, `str_replace`, `apply_patch`, `bash`, `pwsh`) unless the
 *    target is in a whitelisted location (`team/members/<own role>/`, any
 *    `scratch/`, any `file_backups/`). Shell tools are in the default deny list
 *    so they cannot bypass the file-tool deny; an explicit `denyTools` config
 *    without bash/pwsh is the opt-out. The role comes from
 *    `ctx.agentTeams.membership(agent)`.
 *    Fail-open: a missing/throwing membership service, a non-Team caller, or an
 *    internal policy bug only logs a warning and allows the call — it must never
 *    block ordinary writes. `mode: 'warn'` audits without denying for rollout.
 *
 * 6. Delegation advisor (`workspace cross-session rules` §5.2/§5.3/§五): counts the
 *    calling agent's per-turn tool activity in the same `tools/pre-execute`
 *    hook, and at `agent/turn-stopping` ({agent, turn}) decides whether a team
 *    lead did heavy file work without delegating. When
 *    `delegateCalls === 0 && writes >= minWrites` on a non-read-only turn it
 *    injects one <=80 char followup advisory (never blocks/denies). Every turn
 *    appends at most one JSONL audit row (15 frozen top-level fields incl.
 *    taskKind, §5.3) under
 *    `<private-project>/agents/audit/delegation/delegation-<sessionShort>.jsonl`.
 *    Dedupe/rate limits: once per turn, <=1 per 10min, <=3/h; a degraded
 *    (audit-only) mode and arm=off A/B control are supported. Fail-open: any
 *    internal error is logged/audited and the turn proceeds normally.
 *
 * 7. Problem loop (Phase L / task-42, default OFF): observes failed
 *    `tools/post-execute` results, normalizes `family|tool|errorCode|message`
 *    into a problem.mjs-compatible incident (path/UUID/number stripped), applies
 *    expected/verification exclusions + environment-family allowlist, counts
 *    2-session/24h or single-session-1h>=3, and only in `mode: 'advisory'`
 *    injects ONE <=2-line reminder (shared turn key with delegation advisor).
 *    It never creates problem/proposal/routing entries and never blocks.
 *
 * Zero npm imports; Node built-ins only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { boolean, number, string, stringArray, nested, any, enumOf, objectSchema } from '../lib/standard-schema.js'

/**
 * SEC-H1 single source of truth: denied write-class tools. Shell tools are in
 * the default list so a read-only role cannot bypass the file-tool deny via
 * bash/pwsh; deployments may opt out by removing them from `denyTools`.
 * The Config schema default and the frozen runtime default both read THIS list.
 */
const DEFAULT_DENY_TOOLS = Object.freeze(['edit', 'write', 'str_replace', 'apply_patch', 'bash', 'pwsh'])


/**
 * Declarative config schema (Standard Schema v1) for the merged bundle. The
 * host validates/normalizes this before `apply`; defaults mirror the runtime
 * normalization. `roleWritePolicy: false` / `delegationAdvisor: false` /
 * `writeGate: false` / `problemLoop: false` disable the whole block.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the hooks and the team_hooks_status tool. false = plugin does nothing.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  stateFile: string('', { description: 'Archive-reminder state file; empty = $DSH_HOME/team-hooks-state.json.' }),
  roleWritePolicy: nested(objectSchema({
    enabled: boolean(true, { description: 'Enforce the role write policy at all.' }),
    mode: enumOf('deny', ['deny', 'warn'], { description: "'deny' enforces; 'warn' audits + warns only." }),
    denyRoles: stringArray(['cr-*', 'verify'], { description: 'Role name patterns (trailing * = prefix) denied write tools.' }),
    denyTools: stringArray([...DEFAULT_DENY_TOOLS], { description: 'Tool names denied to denied roles (shell tools included; remove bash/pwsh to opt out).' }),
    allowSegments: stringArray(['scratch', 'file_backups'], { description: 'Path segments writable by denied roles.' }),
    allowOwnMemberDir: boolean(true, { description: 'Allow a denied role to write under team/members/<own role>/.' }),
    auditFile: string('', { description: 'Absolute audit JSONL override; empty = <workspace>/team/.role_write_audit.jsonl.' }),
    auditAll: boolean(false, { description: 'Also audit non-denied write decisions (noisy).' }),
    auditFailOpen: boolean(false, { description: 'Audit fail-open decisions.' }),
  }), { description: 'Read-only role write policy.', allowFalse: true }),
  delegationAdvisor: nested(objectSchema({
    enabled: boolean(true, { description: 'Enable the delegation advisor (counters + advisory + audit).' }),
    mode: enumOf('off', ['on', 'off', 'invert'], { description: "'on' injects; 'off' = disabled (safe shipped default); 'invert' = mutation test only." }),
    arm: enumOf('on', ['on', 'off'], { description: 'A/B control arm (env DELEGATION_ARM overrides).' }),
    armFile: any(null, { description: 'Runtime per-turn arm override file; false disables; null = $DSH_HOME/delegation-arm.txt.' }),
    pairId: string('', { description: 'A/B pairing id (env DELEGATION_PAIR_ID).' }),
    degraded: boolean(false, { description: 'Audit-only mode (never injects).' }),
    auditDir: string('', { description: 'Public audit home; empty = $DSH_HOME/audit/delegation. Do not hard-code a project path.' }),
    stateFile: string('', { description: 'Advisor state file; empty = $DSH_HOME/delegation-advisor-state.json.' }),
    verificationRoles: stringArray(['verify-captain', 'verify*'], { description: 'Roles that never receive the advisory.' }),
    readOnlyTools: stringArray(['read', 'grep', 'glob', 'context_usage', 'team_audit', 'team_sessions', 'team_hooks_status', 'list_agents', 'team_task_list', 'team_task_get', 'job_list', 'job_output', 'job_get', 'web_search', 'web_fetch'], { description: 'Tools considered read-only for the false-positive gate.' }),
    verificationTools: stringArray(['verify*', 'verify-relaunch', 'test*', 'check*', 'run-tests', 'run_tests'], { description: 'Tool name patterns that mark a turn as verification work.' }),
    minWrites: number(8, { description: 'Minimum writes in one turn before the advisory is eligible.', int: true, min: 1 }),
    maxDelegateCalls: number(0, { description: 'Maximum delegate calls before the advisory is suppressed.', int: true, min: 0 }),
    minIntervalMs: number(600000, { description: 'Per-session advisory interval.', int: true, min: 0 }),
    maxPerHour: number(3, { description: 'Per-session advisory cap per hour.', int: true, min: 1 }),
    fpDowngradeThreshold: number(3, { description: 'Consecutive false positives that downgrade to audit-only.', int: true, min: 1 }),
  }), { description: 'Delegation advisor.', allowFalse: true }),
  writeGate: nested(objectSchema({
    enabled: boolean(false, { description: 'F1 write gate (default off); observation/audit only unless denyOutsideWorkspace is set.' }),
    denyOutsideWorkspace: boolean(false, { description: 'Only deny workspace-outside paths not in allowOutsidePaths (fail-open otherwise).' }),
    allowOutsidePaths: stringArray([], { description: 'Absolute path prefixes allowed for outside-workspace writes.' }),
    backupDir: string('file_backups', { description: 'Visible-backup dir relative to the session workspace (read-only scan).' }),
    auditFile: string('', { description: 'Absolute write-gate audit JSONL override; empty = <workspace>/team/.write_gate_audit.jsonl.' }),
    tools: stringArray(['edit', 'write', 'str_replace', 'apply_patch'], { description: 'Tool names observed by the write gate.' }),
  }), { description: 'F1 write gate (never creates backups).', allowFalse: true }),
  archiveReminder: nested(objectSchema({
    enabled: boolean(true, { description: 'Context-archive reminder state machine (default on).' }),
    archiveThreshold: number(50, { description: 'Occupancy percent that starts a new archive cycle.', int: true, min: 1, max: 100 }),
    reminderEveryNTurns: number(2, { description: 'After archive creation, remind to update every N turns.', int: true, min: 1 }),
    dropThreshold: number(15, { description: 'Occupancy drop that means compaction: read the archive and reset.', int: true, min: 1, max: 100 }),
    templates: nested(objectSchema({
      create: string('', { description: 'Create-archive template; placeholders {percent}/{threshold}.' }),
      remind: string('', { description: 'Update-archive template; placeholders {turns}/{everyNTurns}/{percent}.' }),
      read: string('', { description: 'Read-archive template; placeholders {previous}/{percent}/{dropThreshold}/{threshold}.' }),
      manualRead: string('', { description: 'Manual-compaction location template; placeholders {path}/{pathNote}/{threshold}.' }),
    }), { description: 'Archive-reminder message templates; empty = built-in defaults.' }),
  }), {
    description: 'task-80 archive-reminder loop; false disables it.',
    allowFalse: true,
    // Live-editable in the plugin console / settings form: the host only
    // projects `volatile` config fields (native `meta.volatile`).
    volatile: true,
  }),
  problemLoop: nested(objectSchema({
    enabled: boolean(false, { description: 'Phase L problem loop (default off); observe records incidents, advisory adds a <=2-line reminder.' }),
    mode: enumOf('observe', ['observe', 'advisory'], { description: "'observe' records only; 'advisory' may inject after frozen thresholds." }),
    familyAllowlist: stringArray([], { description: 'Extra/override environment families observed by the loop.' }),
    denyPrefixes: stringArray(['expected:', 'verify:', 'approval:', 'sandbox-policy:', 'ownership:', 'policy-reject:'], { description: 'Message prefixes excluded from TP counting.' }),
    denySignatures: stringArray([], { description: 'Additional exact signatures excluded (built-in v1.1 32 always apply).' }),
    denyPatterns: stringArray([], { description: 'Additional deny regex sources.' }),
    verificationRoles: stringArray(['verify-captain', 'verify*', 'plugin-verifier'], { description: 'Verification roles whose sessions are ledger:ignore.' }),
    verificationTools: stringArray(['verify*', 'verify-relaunch', 'test*', 'check*', 'run-tests', 'run_tests'], { description: 'Verification tool patterns.' }),
    verificationSessions: stringArray([], { description: 'Explicit verification session ids.' }),
    ledger: boolean(true, { description: 'Append problem.mjs-compatible incidents to the ledger.' }),
    ledgerFile: string('', { description: 'Incident ledger file; empty = $DSH_HOME/toolbox/incidents.jsonl.' }),
    auditDir: string('', { description: 'Audit dir; empty = $DSH_HOME/audit/problem-loop.' }),
    appendExcluded: boolean(true, { description: 'Record excluded incidents with ledger:ignore.' }),
    crossSessionWindowMs: number(86400000, { description: 'Cross-session trigger window.', int: true, min: 1 }),
    crossSessionDistinctSessions: number(2, { description: 'Distinct sessions required for the cross-session trigger.', int: true, min: 1 }),
    singleSessionWindowMs: number(3600000, { description: 'Single-session trigger window.', int: true, min: 1 }),
    singleSessionOccurrences: number(3, { description: 'Occurrences required for the single-session trigger.', int: true, min: 1 }),
    advisoryCooldownMs: number(604800000, { description: 'Per-signature advisory cooldown.', int: true, min: 0 }),
    maxAdvisoriesPerSession: number(2, { description: 'Advisory cap per session.', int: true, min: 1 }),
  }), { description: 'Phase L problem loop (B/C canary only).', allowFalse: true }),
}, { description: 'Team hooks v2 configuration.', schemaVersion: 1 })

const ARCHIVE_PERCENT = 50
const DROP_POINTS = 15
/** A persisted drop baseline older than this is stale and only re-baselines. */
const DROP_WINDOW_MS = 12 * 60 * 60 * 1000
/** Drop state entries not seen for this long. */
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * task-80 archive-reminder state machine defaults. The author loop is:
 * new session -> context >= archiveThreshold -> CREATE archive reminder ->
 * every reminderEveryNTurns turns REMIND to update the archive -> context drop
 * >= dropThreshold (compaction) -> READ the latest archive and continue ->
 * reset cycle -> next over-threshold crossing CREATES a new archive.
 * Templates support `{percent}`, `{threshold}`, `{previous}`, `{dropThreshold}`,
 * `{turns}`, `{everyNTurns}`, `{path}`, `{pathNote}` placeholders.
 */
const DEFAULT_ARCHIVE_TEMPLATES = Object.freeze({
  create: '[team-hooks2] 上下文归档提醒（自动，非用户消息）：当前占用 {percent}%（≥{threshold}%）⇒ 请立即创建本会话归档文件（如 team/members/<你的角色名>/ARCHIVE_<YYYYMMDD_HHMMSS>.md），记录：当前任务 / 已得结论（带 文件:行号）/ 未完成项 / 关键事实 / 下次从哪续。此后本周期内完工只更新该归档，不新建。',
  remind: '[team-hooks2] 上下文归档提醒（自动）：本周期归档已创建；距上次提醒已 {turns} 轮（≥{everyNTurns}）⇒ 请更新归档文件（当前 {percent}%），不要新建。',
  read: '[team-hooks2] 上下文占用从 {previous}% 骤降至 {percent}%（≥{dropThreshold} 点）⇒ 可能已触发记忆压缩：请读取最新归档文件并继续（已得结论/未完成项），把核对结果追加到归档；再次超过 {threshold}% 时会创建新归档。',
  manualRead: '[team-hooks2] 检测到手动压缩（手动压缩会压缩完整会话，Agent 容易忘记归档位置）：本会话最新归档文件位置：{path}。请先读取该归档（核对已得结论/未完成项/关键事实），再继续当前任务；不要在此刻立即新建归档，只有之后再次超过 {threshold}% 才创建新周期。{pathNote}',
})

const DEFAULT_ARCHIVE_REMINDER = Object.freeze({
  enabled: true,
  archiveThreshold: ARCHIVE_PERCENT,
  reminderEveryNTurns: 2,
  dropThreshold: DROP_POINTS,
  templates: DEFAULT_ARCHIVE_TEMPLATES,
})

function archiveInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function normalizeArchiveReminderConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config.archiveReminder : undefined
  const disabled = raw === false
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const templates = { ...DEFAULT_ARCHIVE_TEMPLATES }
  if (source.templates !== null && typeof source.templates === 'object') {
    for (const key of Object.keys(DEFAULT_ARCHIVE_TEMPLATES)) {
      if (typeof source.templates[key] === 'string' && source.templates[key].trim() !== '') {
        templates[key] = source.templates[key]
      }
    }
  }
  return {
    enabled: !disabled && source.enabled !== false,
    archiveThreshold: archiveInteger(source.archiveThreshold, DEFAULT_ARCHIVE_REMINDER.archiveThreshold, 1, 100),
    reminderEveryNTurns: archiveInteger(source.reminderEveryNTurns, DEFAULT_ARCHIVE_REMINDER.reminderEveryNTurns, 1, 1000),
    dropThreshold: archiveInteger(source.dropThreshold, DEFAULT_ARCHIVE_REMINDER.dropThreshold, 1, 100),
    templates,
  }
}

function renderArchiveTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z]+)\}/gu, (match, key) =>
    values[key] === undefined ? match : String(values[key]))
}

/** Text of one user message without importing the LLM package. */
function archiveMessageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const parts = Array.isArray(message.content) ? message.content : []
  const first = parts.find(part => part !== null && typeof part === 'object' && typeof part.text === 'string')
  return first === undefined ? '' : first.text
}

/** Pending inbox messages (context-meter injects its threshold advisory there). */
function archivePendingMessages(agent) {
  try {
    const inbox = agent?.inbox
    if (inbox === null || typeof inbox !== 'object') return []
    return [
      ...(Array.isArray(inbox.nextStep) ? inbox.nextStep : []),
      ...(Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []),
    ]
  } catch {
    return []
  }
}

/** task-80 dedupe: a context-meter threshold advisory or [ctx N%] is already pending. */
function archiveHasContextMeterReminder(agent) {
  return archivePendingMessages(agent).some(message => {
    const text = archiveMessageText(message).trim()
    return /^\[context-meter\]/iu.test(text) || /^\[ctx \d+%\]/u.test(text)
  })
}

/** Migrate persisted legacy `cycle` state into the explicit phase machine. */
function normalizeArchiveSessionState(value) {
  const s = value !== null && typeof value === 'object' ? { ...value } : {}
  if (s.phase !== 'archive' && s.phase !== 'idle') {
    s.phase = s.cycle === true ? 'archive' : 'idle'
  }
  s.cycle = s.phase === 'archive'
  if (!Number.isInteger(s.archiveTurn)) s.archiveTurn = null
  if (!Number.isInteger(s.lastReminderTurn)) s.lastReminderTurn = null
  if (!Number.isInteger(s.lastTurn)) s.lastTurn = null
  s.pendingRead = s.pendingRead === true
  s.pendingReadKind = s.pendingReadKind === 'manual' ? 'manual' : (s.pendingRead ? 'drop' : null)
  if (typeof s.archivePath !== 'string' || s.archivePath.trim() === '') s.archivePath = null
  if (typeof s.lastManualCompactAt !== 'string' || s.lastManualCompactAt.trim() === '') s.lastManualCompactAt = null
  if (!Number.isInteger(s.lastManualCompactTurn)) s.lastManualCompactTurn = null
  if (!Number.isInteger(s.lastManualCompactSeq)) s.lastManualCompactSeq = null
  if (typeof s.archivePathObservedAt !== 'string' || s.archivePathObservedAt.trim() === '') s.archivePathObservedAt = null
  return s
}

/** File name convention for per-session archives. */
const ARCHIVE_FILE_RE = /(?:^|[\\/])ARCHIVE_[^\\/]+\.md$/iu

/** One archive path string from a write/edit tool argument object. */
function archivePathFromArguments(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of ['file_path', 'path', 'file', 'filename', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && ARCHIVE_FILE_RE.test(value)) return value
  }
  return null
}

/** Latest `ARCHIVE_*.md` under `<workspace>/team/members/**`, absolute path. */
function findLatestArchivePath(workspaceDir) {
  const root = join(workspaceDir, 'team', 'members')
  let best = null
  let bestMtime = -1
  const visit = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full, depth + 1)
      } else if (entry.isFile() && ARCHIVE_FILE_RE.test(entry.name)) {
        try {
          const mtime = statSync(full).mtimeMs
          if (mtime > bestMtime) {
            best = full
            bestMtime = mtime
          }
        } catch {
          // ignore unreadable file
        }
      }
    }
  }
  visit(root, 0)
  return best
}

/** Canonical absolute archive path when no archive exists yet. */
function canonicalArchivePath(workspaceDir, roleName) {
  const now = new Date()
  const two = value => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  const role = typeof roleName === 'string' && roleName.trim() !== '' ? roleName.trim() : 'member'
  return join(workspaceDir, 'team', 'members', role, `ARCHIVE_${stamp}.md`)
}

/** Role-based write policy defaults: read-only roles may not edit/write files. */
const DEFAULT_ROLE_WRITE_POLICY = Object.freeze({
  enabled: true,
  /** 'deny' enforces; 'warn' audits + warns but still allows (rollout safety). */
  mode: 'deny',
  /** Role names from `agentTeams.membership().name`; a trailing `*` is a prefix. */
  denyRoles: Object.freeze(['cr-*', 'verify']),
  denyTools: DEFAULT_DENY_TOOLS,
  /** Any path segment with one of these names is writable by a denied role. */
  allowSegments: Object.freeze(['scratch', 'file_backups']),
  allowOwnMemberDir: true,
  /** Absolute audit file override; default is `<session workspace>/team/.role_write_audit.jsonl`. */
  auditFile: null,
  /** Audit also the non-denied write decisions (noisy; off by default). */
  auditAll: false,
  /** Audit the fail-open decisions (off by default: ordinary user sessions are not Team members). */
  auditFailOpen: false,
})

/** Default audit location, relative to the calling session's workspace. */
const ROLE_WRITE_AUDIT_RELATIVE = join('team', '.role_write_audit.jsonl')

/** Build one frozen user-role message without importing the LLM package. */
function createUserMessage(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'user' }),
  })
}

// ---------------------------------------------------------------------------
// Role-based write policy helpers (see section 5 in the header)
// ---------------------------------------------------------------------------

/** Normalize `config.roleWritePolicy`; `roleWritePolicy: false` disables it. */
function normalizeRoleWritePolicy(config) {
  const raw = config !== null && typeof config === 'object' ? config.roleWritePolicy : undefined
  if (raw === false) return { ...DEFAULT_ROLE_WRITE_POLICY, enabled: false }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const stringList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback]
    const items = value
      .filter(item => typeof item === 'string' && item.trim() !== '')
      .map(item => item.trim())
    return items.length > 0 ? items : [...fallback]
  }
  return {
    enabled: source.enabled !== false,
    mode: source.mode === 'warn' ? 'warn' : 'deny',
    denyRoles: stringList(source.denyRoles, DEFAULT_ROLE_WRITE_POLICY.denyRoles)
      .map(item => item.toLowerCase()),
    denyTools: stringList(source.denyTools, DEFAULT_ROLE_WRITE_POLICY.denyTools)
      .map(item => item.toLowerCase()),
    allowSegments: stringList(source.allowSegments, DEFAULT_ROLE_WRITE_POLICY.allowSegments)
      .map(item => item.toLowerCase()),
    allowOwnMemberDir: source.allowOwnMemberDir !== false,
    auditFile: typeof source.auditFile === 'string' && source.auditFile.trim() !== ''
      ? source.auditFile.trim()
      : null,
    auditAll: source.auditAll === true,
    auditFailOpen: source.auditFailOpen === true,
  }
}

// ---------------------------------------------------------------------------
// Write gate (F1 / task-33): pre-execute observation + audit + optional
// dangerous-path deny. Default OFF. Backup creation remains the sole authority
// of dsh-auto-backup; this gate only reads backup *visibility* and never writes
// a backup file. See DESIGN_write_gate.md for the full boundary.
// ---------------------------------------------------------------------------

const DEFAULT_WRITE_GATE = Object.freeze({
  enabled: false,
  denyOutsideWorkspace: false,
  allowOutsidePaths: Object.freeze([]),
  backupDir: 'file_backups',
  auditFile: null,
  tools: Object.freeze(['edit', 'write', 'str_replace', 'apply_patch']),
})

/** Normalize `config.writeGate`; `writeGate: false` / omitted => disabled. */
function normalizeWriteGate(config) {
  const raw = config !== null && typeof config === 'object' ? config.writeGate : undefined
  if (raw === false) return { ...DEFAULT_WRITE_GATE, enabled: false }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const stringList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback]
    const items = value.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    return items.length > 0 ? items : [...fallback]
  }
  return {
    enabled: source.enabled === true,
    denyOutsideWorkspace: source.denyOutsideWorkspace === true,
    allowOutsidePaths: stringList(source.allowOutsidePaths, DEFAULT_WRITE_GATE.allowOutsidePaths),
    backupDir: typeof source.backupDir === 'string' && source.backupDir.trim() !== ''
      ? source.backupDir.trim()
      : DEFAULT_WRITE_GATE.backupDir,
    auditFile: typeof source.auditFile === 'string' && source.auditFile.trim() !== ''
      ? source.auditFile.trim()
      : null,
    tools: stringList(source.tools, DEFAULT_WRITE_GATE.tools).map(item => item.toLowerCase()),
  }
}

/** Append one write-gate audit row; best effort (appendJsonLine never throws). */
function appendWriteGateAudit(ctx, gate, agent, entry) {
  const file = gate.auditFile !== null
    ? gate.auditFile
    : join(sessionWorkspaceDir(agent), 'team', '.write_gate_audit.jsonl')
  const ok = appendJsonLine(file, { ts: new Date().toISOString(), event: 'write-gate', ...entry })
  if (!ok) {
    try { ctx.logger.warn('[team-hooks2] write-gate audit append failed (ignored)') } catch { /* ignore */ }
  }
}

/** True when `child` is the same as, or below, `parent` (both absolute). */
function pathInside(parent, child) {
  try {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

/** Prefix match against the explicit outside-workspace allow list. */
function pathInAllowList(resolvedPath, allowList) {
  if (typeof resolvedPath !== 'string' || resolvedPath === '') return false
  const candidate = resolvedPath.replace(/\\/g, '/').toLowerCase()
  return allowList.some(prefix => {
    const normalized = String(prefix).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    if (normalized === '') return false
    return candidate === normalized || candidate.startsWith(normalized + '/')
  })
}

/** Scan auto-backup's visible `_改前_*_<basename>` files. Read-only; never writes. */
function writeGateBackupInfo(workspaceDir, resolvedPath, backupDir) {
  if (typeof resolvedPath !== 'string' || resolvedPath === '') return { found: false, count: 0, latest: null }
  const dir = isAbsolute(backupDir) ? resolve(backupDir) : resolve(workspaceDir, backupDir)
  if (!existsSync(dir)) return { found: false, count: 0, latest: null }
  const name = basename(resolvedPath)
  if (name === '') return { found: false, count: 0, latest: null }
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return { found: false, count: 0, latest: null, unreadable: true }
  }
  const suffix = '_' + name
  const matches = entries
    .filter(entry => entry.startsWith('_改前_') && entry.endsWith(suffix))
    .map(entry => {
      try { return { entry, mtime: statSync(join(dir, entry)).mtimeMs } } catch { return { entry, mtime: 0 } }
    })
    .sort((left, right) => right.mtime - left.mtime)
  return { found: matches.length > 0, count: matches.length, latest: matches.length > 0 ? matches[0].entry : null }
}

/**
 * Judge one write-class tool call for the write gate. Always returns null
 * (continue the waterfall) unless the explicit dangerous-path deny is enabled
 * and the resolved target is outside the workspace without authorization.
 * Observation/audit failures must never block the call (caller catches).
 */
function judgeWriteGate(ctx, exec, gate, dedupe) {
  const toolName = String(exec?.name ?? '').toLowerCase()
  if (!gate.tools.includes(toolName)) return null
  const agent = exec?.agent
  const workspace = sessionWorkspaceDir(agent)
  const { raw, resolved } = resolveWriteTarget(agent, exec.arguments)
  const insideWorkspace = resolved !== null && pathInside(workspace, resolved)
  const allowedOutside = resolved !== null && !insideWorkspace && pathInAllowList(resolved, gate.allowOutsidePaths)
  const dangerous = resolved !== null && !insideWorkspace && !allowedOutside
  const targetExists = resolved !== null && existsSync(resolved)
  const backup = insideWorkspace
    ? writeGateBackupInfo(workspace, resolved, gate.backupDir)
    : { found: false, count: 0, latest: null }
  const deny = dangerous && gate.denyOutsideWorkspace
  let decision = 'allow'
  let reason = null
  if (deny) {
    decision = 'deny'
    reason = 'outside-workspace-unallowed'
  } else if (dangerous) {
    decision = 'warn'
    reason = 'outside-workspace'
  } else if (targetExists && !backup.found) {
    decision = 'warn'
    reason = 'backup-not-visible'
  } else if (!targetExists) {
    reason = 'new-file'
  }
  const sessionId = (() => {
    try {
      const id = agent?.session?.id
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  })()
  appendWriteGateAudit(ctx, gate, agent, {
    tool: toolName,
    target: raw,
    resolvedPath: resolved,
    insideWorkspace,
    allowedOutside,
    targetExists,
    backupFound: backup.found,
    backupCount: backup.count,
    latestBackup: backup.latest,
    decision,
    reason,
    sessionId,
    pid: process.pid,
  })
  if (decision === 'warn') {
    const key = String(raw ?? '(unknown-target)')
    if (!dedupe.warned.has(key)) {
      dedupe.warned.add(key)
      try {
        if (reason === 'backup-not-visible') {
          ctx.logger.warn('[team-hooks2] write-gate: 未发现可见的 _改前_ 备份（target=' + key
            + '）。备份唯一权威是 dsh-auto-backup（本门禁不创建备份）；如确有风险，请先确认备份或改用 env-safe-edit preflight。')
        } else {
          ctx.logger.warn('[team-hooks2] write-gate: target=' + key
            + ' 在 workspace 外（未配置 deny；仅审计）。备份仍由 dsh-auto-backup 负责。')
        }
      } catch { /* logger must never break the gate */ }
    }
  }
  if (decision === 'deny') {
    return {
      kind: 'deny',
      reason: '[team-hooks2] 写入门禁：目标 ' + JSON.stringify(raw) + ' 在 workspace 外且未授权（denyOutsideWorkspace=true）。'
        + '写入门禁只做路径安全判断，不替代 auto-backup；备份仍由 auto-backup 负责。',
    }
  }
  return null
}

/** Match a role name against one policy pattern (exact, or a trailing `*` prefix). */
function roleNameMatches(pattern, roleName) {  const normalized = String(pattern).trim().toLowerCase()
  const name = String(roleName).trim().toLowerCase()
  if (normalized === '' || name === '') return false
  if (normalized.endsWith('*')) return name.startsWith(normalized.slice(0, -1))
  return name === normalized
}

/** One-line error text that keeps a structured error code when present. */
function errorText(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code + ': ' : ''
    const message = typeof error.message === 'string' ? error.message : String(error)
    return code + message
  }
  return String(error)
}

/** Split a path into lower-cased segments (`\` and `/` both work). */
function pathSegments(file) {
  return String(file)
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => segment.toLowerCase())
}

/** The session workspace that relative tool paths resolve against. */
function sessionWorkspaceDir(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch {
    // fall through to the process cwd
  }
  return process.cwd()
}

/** Resolve one write tool call's target path against the session workspace. */
function resolveWriteTarget(agent, args) {
  if (args === null || typeof args !== 'object') return { raw: null, resolved: null }
  for (const key of ['file_path', 'path', 'file', 'filename', 'target']) {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const raw = value.trim()
    try {
      return { raw, resolved: resolve(sessionWorkspaceDir(agent), raw) }
    } catch {
      return { raw, resolved: null }
    }
  }
  return { raw: null, resolved: null }
}

/** Resolve the calling Agent's Team role without throwing. */
function resolveTeamRole(ctx, agent) {
  if (agent === undefined || agent === null) {
    return { ok: false, reason: 'no caller agent', role: null, name: null }
  }
  let team
  try {
    team = ctx.get('agentTeams')
  } catch (error) {
    return { ok: false, reason: 'agentTeams lookup threw: ' + errorText(error), role: null, name: null }
  }
  if (team === null || typeof team !== 'object' || typeof team.membership !== 'function') {
    return { ok: false, reason: 'agentTeams.membership is unavailable', role: null, name: null }
  }
  try {
    const membership = team.membership(agent)
    if (membership === null || typeof membership !== 'object'
      || typeof membership.name !== 'string' || membership.name === '') {
      return { ok: false, reason: 'membership returned no name', role: null, name: null }
    }
    return {
      ok: true,
      reason: null,
      role: typeof membership.role === 'string' ? membership.role : null,
      name: membership.name,
    }
  } catch (error) {
    return { ok: false, reason: 'membership threw: ' + errorText(error), role: null, name: null }
  }
}

/** Is the resolved target inside a location a denied role may still write? */
function matchRoleWriteWhitelist(policy, roleName, rawTarget, resolvedTarget) {
  // Judge the RESOLVED absolute path only: `..` must not let `team/members/
  // <self>/../../verify/x` look like the caller's own member directory. The raw
  // target is used only when it could not be resolved.
  let candidate = resolvedTarget
  if (candidate === null && rawTarget !== null) candidate = rawTarget
  if (candidate === null) return null
  const segments = pathSegments(candidate)
  const name = String(roleName).toLowerCase()
  for (const allowed of policy.allowSegments) {
    if (segments.includes(allowed)) return 'segment:' + allowed
  }
  if (policy.allowOwnMemberDir) {
    for (let index = 0; index + 2 < segments.length; index += 1) {
      if (segments[index] === 'team' && segments[index + 1] === 'members'
        && segments[index + 2] === name) {
        return 'own-member-dir'
      }
    }
  }
  return null
}

/** The model-facing deny reason for one role-denied write attempt. */
function roleWriteDenyReason(policy, roleName, pattern, toolName, rawTarget) {
  const target = rawTarget === null ? '(无法识别目标路径)' : String(rawTarget)
  return '[team-hooks2] 角色写权限：当前角色 "' + roleName + '" 命中只读角色策略（' + pattern
    + '），不允许用 ' + toolName + ' 写项目文件（目标：' + target + '）。'
    + '允许的例外：team/members/' + roleName + '/、任意 scratch/ 与 file_backups/ 目录。'
    + '如需改其他文件，请把改动计划交给有写权限的成员（或让 Lead 指派）执行，不要尝试绕过。'
}

/** Append one audit line; best effort and never throws. */
function appendRoleWriteAudit(ctx, policy, exec, entry) {
  let file = policy.auditFile
  if (file === null) file = join(sessionWorkspaceDir(exec.agent), ROLE_WRITE_AUDIT_RELATIVE)
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      event: 'role-write-policy',
      ...entry,
    }) + '\n', 'utf8')
  } catch (error) {
    try {
      ctx.logger.warn('[team-hooks2] role-write audit append failed: ' + errorText(error))
    } catch {
      // audit logging must never break the tool pipeline
    }
  }
}

/**
 * Evaluate the role write policy for one pending tool call.
 * @returns `{ kind: 'deny', reason }` when the call must be blocked, else null
 *   (not a write-class tool, allowed role, whitelisted target, warn mode, or
 *   fail-open because the role cannot be established).
 */
function judgeRoleWritePolicy(ctx, exec, policy, dedupe) {
  const toolName = String(exec?.name ?? '').toLowerCase()
  // Only tools explicitly listed in `denyTools` are judged. bash/pwsh are NOT
  // judged by default (README: file-write tools only; shell writes are out of
  // scope for this hook). A deployment may opt in by adding bash/pwsh to
  // denyTools — then they are treated like any other listed write tool.
  if (toolName === '' || !policy.denyTools.includes(toolName)) return null

  const role = resolveTeamRole(ctx, exec.agent)
  const { raw, resolved } = resolveWriteTarget(exec.agent, exec.arguments)
  const sessionId = (() => {
    try {
      const id = exec.agent?.session?.id
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  })()
  const baseEntry = { tool: toolName, target: raw, resolvedPath: resolved, sessionId, pid: process.pid }

  if (!role.ok) {
    // FAIL-OPEN: an unknown role (non-Team session, missing service, thrown
    // membership) must never block ordinary writes. Warn once per cause (NOT
    // per session): the dedupe is in-memory per plugin instance, so a shared
    // on-disk state file cannot make the count drift.
    const warnKey = 'fail-open|' + String(role.reason)
    if (!dedupe.warned.has(warnKey)) {
      dedupe.warned.add(warnKey)
      try {
        ctx.logger.warn('[team-hooks2] role-write-policy fail-open (allow): ' + role.reason
          + ' tool=' + toolName + ' session=' + String(sessionId))
      } catch {
        // ignore
      }
    }
    if (policy.auditFailOpen && !dedupe.audited.has(String(sessionId))) {
      dedupe.audited.add(String(sessionId))
      appendRoleWriteAudit(ctx, policy, exec, {
        ...baseEntry, decision: 'fail-open', mode: policy.mode, role: null, hit: null, reason: role.reason,
      })
    }
    return null
  }

  // The Team Lead is never write-restricted by this policy.
  if (role.role === 'lead') {
    if (policy.auditAll) {
      appendRoleWriteAudit(ctx, policy, exec, {
        ...baseEntry, decision: 'allow', mode: policy.mode, role: role.name, teamRole: role.role, hit: null,
      })
    }
    return null
  }

  const hit = policy.denyRoles.find(pattern => roleNameMatches(pattern, role.name)) ?? null
  if (hit === null) {
    if (policy.auditAll) {
      appendRoleWriteAudit(ctx, policy, exec, {
        ...baseEntry, decision: 'allow', mode: policy.mode, role: role.name, teamRole: role.role, hit: null,
      })
    }
    return null
  }

  const whitelist = matchRoleWriteWhitelist(policy, role.name, raw, resolved)
  if (whitelist !== null) {
    appendRoleWriteAudit(ctx, policy, exec, {
      ...baseEntry, decision: 'allow-whitelist', mode: policy.mode, role: role.name,
      teamRole: role.role, hit, whitelist,
    })
    try {
      ctx.logger.info('[team-hooks2] role-write-policy allow (whitelist=' + whitelist + '): role='
        + role.name + ' tool=' + toolName + ' target=' + String(raw))
    } catch {
      // ignore
    }
    return null
  }

  const reason = roleWriteDenyReason(policy, role.name, hit, toolName, raw)
  appendRoleWriteAudit(ctx, policy, exec, {
    ...baseEntry,
    decision: policy.mode === 'warn' ? 'warn-only' : 'deny',
    mode: policy.mode,
    role: role.name,
    teamRole: role.role,
    hit,
  })
  if (policy.mode === 'warn') {
    try {
      ctx.logger.warn('[team-hooks2] role-write-policy WARN (mode=warn, allowing): role=' + role.name
        + ' tool=' + toolName + ' target=' + String(raw))
    } catch {
      // ignore
    }
    return null
  }
  try {
    ctx.logger.warn('[team-hooks2] role-write-policy deny: role=' + role.name
      + ' tool=' + toolName + ' target=' + String(raw))
  } catch {
    // ignore
  }
  return { kind: 'deny', reason }
}

// ---------------------------------------------------------------------------
// Delegation advisor (contract: workspace cross-session rules §5.2/§5.3/§五)
// ---------------------------------------------------------------------------

/** FROZEN schema/rule versions — bump only with an explicit contract change. */
const DELEGATION_HOOK_VERSION = 'team-hooks2/delegation-advisor/1'
const DELEGATION_RULE_VERSION = 'delegation-rule/2026-10-25'
/** Threshold snapshot version for the exported samples (T10 / verify schema v1). */
const DELEGATION_THRESHOLDS_VERSION = 'v1'
/** Public audit home from the task contract (tests/config override it). */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const DELEGATION_DEFAULT_AUDIT_DIR = join(DSH_HOME, 'audit', 'delegation')
const DELEGATION_LOAD_FILE = 'delegation-hook-load.jsonl'
/** File-name prefix of the per-session audit JSONL files. */
const DELEGATION_AUDIT_PREFIX = 'delegation-'
/** `writeCalls` = the write tool only; `editCalls` = the edit-class tools. */
const DELEGATION_WRITE_TOOL = 'write'
const DELEGATION_EDIT_TOOLS = new Set(['edit', 'str_replace', 'apply_patch'])
/** Runtime A/B arm override file (block randomization without reinstalling). */
const DELEGATION_DEFAULT_ARM_FILE = join(DSH_HOME, 'delegation-arm.txt')
/** Read-only tools: a turn made only of these is a read-only turn (FP gate). */
const DELEGATION_DEFAULT_READ_ONLY_TOOLS = Object.freeze([
  'read', 'grep', 'glob', 'context_usage', 'team_audit', 'team_sessions',
  'team_hooks_status', 'list_agents', 'team_task_list', 'team_task_get',
  'job_list', 'job_output', 'job_get', 'web_search', 'web_fetch',
])
/** Verification tools: a mixed turn containing these is taskKind=verification. */
const DELEGATION_DEFAULT_VERIFICATION_TOOLS = Object.freeze([
  'verify*', 'verify-relaunch', 'test*', 'check*', 'run-tests', 'run_tests',
])
/**
 * F6: verifier roles (resolved via agentTeams.membership) always classify a
 * turn as `verification` (FP gate: never advise the verifier).
 */
const DELEGATION_DEFAULT_VERIFICATION_ROLES = Object.freeze(['verify-captain', 'verify*'])
/** F6: bash/pwsh command content that marks a turn as verification work. */
const DELEGATION_BASH_VERIFICATION_PATTERN = /\b(?:verify|test|check|run[-_ ]?tests?)\b/i
/** F6: write-path hints that mark a turn as verification work. */
const DELEGATION_VERIFICATION_PATH_HINTS = Object.freeze([
  'flow-project/**/VERIFY*',
  '*verify*.js',
  'delegation_verify/**',
  '*VERIFY_REPORT*',
])
/** Per-session-tail recovery bound for restart dedupe restore. */
const DELEGATION_AUDIT_RECOVER_BYTES = 64 * 1024
/** Keep the processed-turn dedupe set bounded. */
const DELEGATION_MAX_TRACKED_TURNS = 400

/** Normalize `config.delegationAdvisor`; `delegationAdvisor: false` disables it. */
function normalizeDelegationConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config.delegationAdvisor : undefined
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const disabled = raw === false || source.enabled === false
  const integer = (value, fallback, minimum) => (Number.isInteger(value) && value >= minimum ? value : fallback)
  const arm = source.arm === 'off' || source.arm === 'on'
    ? source.arm
    : (process.env.DELEGATION_ARM === 'off' ? 'off' : 'on')
  const pairId = typeof source.pairId === 'string' && source.pairId !== ''
    ? source.pairId
    : (typeof process.env.DELEGATION_PAIR_ID === 'string' && process.env.DELEGATION_PAIR_ID !== ''
      ? process.env.DELEGATION_PAIR_ID
      : null)
  const readOnlyTools = Array.isArray(source.readOnlyTools)
    ? source.readOnlyTools.filter(item => typeof item === 'string' && item !== '')
    : [...DELEGATION_DEFAULT_READ_ONLY_TOOLS]
  const verificationTools = Array.isArray(source.verificationTools)
    ? source.verificationTools.filter(item => typeof item === 'string' && item !== '')
    : [...DELEGATION_DEFAULT_VERIFICATION_TOOLS]
  const verificationRoles = Array.isArray(source.verificationRoles)
    ? source.verificationRoles.filter(item => typeof item === 'string' && item !== '')
    : [...DELEGATION_DEFAULT_VERIFICATION_ROLES]
  // Runtime A/B arm override file: default path, `armFile: false` disables it.
  const armFile = source.armFile === false || source.armFile === null
    ? null
    : (typeof source.armFile === 'string' && source.armFile !== ''
      ? source.armFile
      : DELEGATION_DEFAULT_ARM_FILE)
  return {
    enabled: !disabled,
    // 'on' injects; 'off' is the hook-uninstalled mutation; 'invert' is the
    // decision-inversion mutation used by the acceptance tests.
    mode: source.mode === 'off' ? 'off' : (source.mode === 'invert' ? 'invert' : 'on'),
    arm,
    armFile,
    pairId,
    degraded: source.degraded === true,
    thresholdsVersion: DELEGATION_THRESHOLDS_VERSION,
    auditDir: typeof source.auditDir === 'string' && source.auditDir !== ''
      ? source.auditDir
      : DELEGATION_DEFAULT_AUDIT_DIR,
    stateFile: typeof source.stateFile === 'string' && source.stateFile !== ''
      ? source.stateFile
      : join(DSH_HOME, 'delegation-advisor-state.json'),
    minWrites: integer(source.minWrites, 8, 1),
    maxDelegateCalls: integer(source.maxDelegateCalls, 0, 0),
    minIntervalMs: integer(source.minIntervalMs, 10 * 60 * 1000, 0),
    maxPerHour: integer(source.maxPerHour, 3, 1),
    fpDowngradeThreshold: integer(source.fpDowngradeThreshold, 3, 1),
    readOnlyTools,
    verificationTools,
    verificationRoles,
    advisoryText: typeof source.advisoryText === 'function' ? source.advisoryText : null,
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
  }
}

/** F6: does a bash/pwsh command look like verification/test work? */
function delegationBashLooksVerification(command) {
  const text = typeof command === 'string' ? command : ''
  if (text === '') return false
  return DELEGATION_BASH_VERIFICATION_PATTERN.test(text)
}

/** F6: does a write target look like verification/evidence output? */
function delegationPathLooksVerification(rawPath) {
  const text = String(rawPath === undefined || rawPath === null ? '' : rawPath).replace(/\\/g, '/')
  if (text === '') return false
  const segments = text.split('/').filter(segment => segment !== '')
  const base = segments.length === 0 ? '' : segments[segments.length - 1]
  // flow-project/**/VERIFY*
  if (/(?:^|\/)flow-project\//i.test(text) && /^VERIFY/i.test(base)) return true
  // *VERIFY_REPORT*
  if (/VERIFY_REPORT/i.test(base)) return true
  // *verify*.js
  if (/verify/i.test(base) && /\.js$/i.test(base)) return true
  // delegation_verify/**
  if (/(?:^|\/)delegation_verify\//i.test(text)) return true
  return false
}

/**
 * F6: classify one turn for the audit `taskKind` field and record WHY
 * (`taskKindSource`, one of role|tool|bash-heuristic|path-heuristic|default).
 * Priority: role > explicit verify tool > bash heuristic > write-path heuristic
 * > read-only tool set > normal.
 */
function delegationTaskKind(bucket, settings, ctx, agent) {
  // 1) verifier role (resolved via agentTeams; fail-open).
  try {
    const role = resolveTeamRole(ctx, agent)
    if (role.ok === true) {
      const roleName = role.name
      if (settings.verificationRoles.some(pattern => roleNameMatches(pattern, roleName))) {
        return { taskKind: 'verification', taskKindSource: 'role' }
      }
    }
  } catch {
    // fail-open: role lookup never decides the turn
  }
  // 2) explicit verification tool name.
  const hasVerificationTool = bucket.toolNames.some(toolName =>
    settings.verificationTools.some(pattern => roleNameMatches(pattern, toolName)))
  if (hasVerificationTool) return { taskKind: 'verification', taskKindSource: 'tool' }
  // 3) bash/pwsh command content heuristic.
  if (bucket.bashCommands.some(command => delegationBashLooksVerification(command))) {
    return { taskKind: 'verification', taskKindSource: 'bash-heuristic' }
  }
  // 4) write-path heuristic.
  if (bucket.writeTargets.some(target => delegationPathLooksVerification(target))) {
    return { taskKind: 'verification', taskKindSource: 'path-heuristic' }
  }
  // 5) pure read-only turn (verification-like without a verifier role).
  if (bucket.toolCalls > 0 && bucket.toolNames.every(toolName => settings.readOnlyTools.includes(toolName))) {
    return { taskKind: 'read-only', taskKindSource: 'default' }
  }
  // 6) ordinary work.
  return { taskKind: 'normal', taskKindSource: 'default' }
}

/** F2: the rule version carries a `-invert` suffix in mutation mode. */
function delegationRuleVersion(mode) {
  return mode === 'invert' ? DELEGATION_RULE_VERSION + '-invert' : DELEGATION_RULE_VERSION
}

/** First 8 chars of the session uuid (the frozen `<sessionShort>` convention). */
function delegationSessionShort(sessionId) {
  const text = String(sessionId)
  const uuid = text.startsWith('session-') ? text.slice('session-'.length) : text
  return uuid.slice(0, 8) || text.slice(0, 8)
}

/** Default Chinese advisory text; always <=80 chars (CJK counts as one). */
function defaultDelegationAdvisoryText(writes) {
  const text = '[分派提醒] 本回合已修改 ' + String(writes)
    + ' 处文件但未分派队伍：可考虑把可并行/独立的活交给队员（建议，不强制）。'
  return Array.from(text).slice(0, 80).join('')
}

/** Low-confidence "this shell command writes files" heuristic (metrics only). */
function shellCommandLooksWriteful(args) {
  try {
    const command = args !== null && typeof args === 'object'
      ? (typeof args.command === 'string' ? args.command : (typeof args.cmd === 'string' ? args.cmd : ''))
      : ''
    if (command === '') return false
    return /(?:^|[;&|]\s*)(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|tee|sed\s+-i|rm|del|copy|move|mkdir)\b/i
      .test(command) || />{1,2}\s*\S/.test(command)
  } catch {
    return false
  }
}

/** Append one JSON line, best effort; returns true on success. */
function appendJsonLine(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Delegation advisor: per-turn metrics -> advisory + one audit row per turn.
 * @param ctx - plugin context (logger only).
 * @param config - raw plugin config (`config.delegationAdvisor`).
 * @param hooks - optional `{ contextPercent(agent): number|null }` measurement.
 */
function createDelegationAdvisor(ctx, config, hooks = {}) {
  const settings = normalizeDelegationConfig(config)
  const contextPercent = typeof hooks.contextPercent === 'function'
    ? hooks.contextPercent
    : () => null
  /** sessionId -> current turn bucket. */
  const buckets = new Map()
  /** sessionId -> Set<turnId> already evaluated (one row/injection per turn). */
  const processedTurns = new Map()
  /** sessionId -> injection timestamps (ms) inside the last hour. */
  const advisoryTimes = new Map()
  /** sessionId -> last injection timestamp (ms) for status. */
  const lastAdvisoryAt = new Map()
  /** Sessions whose audit tail was already scanned for restart recovery. */
  const recovered = new Set()

  const warn = message => {
    try {
      ctx.logger.warn('[team-hooks2] ' + message)
    } catch {
      // logging must never throw into the pipeline
    }
  }

  const auditFileFor = sessionId => join(settings.auditDir, DELEGATION_AUDIT_PREFIX + delegationSessionShort(sessionId) + '.jsonl')

  /**
   * Resolve the A/B arm for THIS turn: the runtime override file wins when it
   * contains a valid `on`/`off`; a missing/unreadable/garbled file falls back to
   * the config/env arm without throwing (experiments switch blocks without a
   * reinstall; production simply never creates the file).
   */
  const resolveArm = () => {
    if (settings.armFile !== null) {
      try {
        const raw = readFileSync(settings.armFile, 'utf8').trim().toLowerCase()
        if (raw === 'on' || raw === 'off') return { arm: raw, source: 'file' }
      } catch {
        // missing/unreadable override file: fall back to the config arm
      }
    }
    return { arm: settings.arm, source: 'config' }
  }

  /** Read the manual/script-driven degradation state (never auto-learns). */
  const loadState = () => {
    try {
      const parsed = JSON.parse(readFileSync(settings.stateFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  const isDegraded = () => {
    if (!settings.enabled) return true
    if (settings.degraded) return true
    const state = loadState()
    if (state.degraded === true) return true
    const consecutiveFp = Number(state.consecutiveFp)
    return Number.isFinite(consecutiveFp) && consecutiveFp >= settings.fpDowngradeThreshold
  }

  /** F2: one WARN audit row when the hook runs in `invert` mutation mode. */
  const writeInvertWarn = () => {
    const ruleVersion = delegationRuleVersion('invert')
    try {
      ctx.logger.warn('[team-hooks2] delegation-advisor mode=invert (MUTATION for counter-proof; '
        + 'never use in production) ruleVersion=' + ruleVersion)
    } catch {
      // logging must never break loading
    }
    return appendJsonLine(join(settings.auditDir, 'delegation-invert-warn.jsonl'), {
      at: new Date(settings.now()).toISOString(),
      event: 'invert-warn',
      invert: true,
      mode: 'invert',
      hookVersion: DELEGATION_HOOK_VERSION,
      ruleVersion,
      auditDir: settings.auditDir,
      pid: process.pid,
    })
  }

  /** Startup audit (L0 loading evidence). */
  const startup = () => {
    if (!settings.enabled) return false
    const armInfo = resolveArm()
    const ruleVersion = delegationRuleVersion(settings.mode)
    const ok = appendJsonLine(join(settings.auditDir, DELEGATION_LOAD_FILE), {
      at: new Date(settings.now()).toISOString(),
      event: 'hook-load',
      hookLoaded: true,
      enabled: true,
      hookVersion: DELEGATION_HOOK_VERSION,
      ruleVersion,
      invert: settings.mode === 'invert',
      arm: armInfo.arm,
      armSource: armInfo.source,
      armFile: settings.armFile,
      pairId: settings.pairId,
      mode: settings.mode,
      thresholdsVersion: settings.thresholdsVersion,
      verificationRoles: settings.verificationRoles,
      degraded: isDegraded(),
      auditDir: settings.auditDir,
      pid: process.pid,
    })
    if (settings.mode === 'invert') writeInvertWarn()
    return ok
  }

  /** Restore dedupe/rate-limit state from the session's own audit tail. */
  const recoverFromAudit = sessionId => {
    try {
      const file = auditFileFor(sessionId)
      if (!existsSync(file)) return
      let text = readFileSync(file, 'utf8')
      if (text.length > DELEGATION_AUDIT_RECOVER_BYTES) text = text.slice(-DELEGATION_AUDIT_RECOVER_BYTES)
      const times = []
      let newest = null
      for (const line of text.split('\n')) {
        if (line === '') continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row === null || typeof row !== 'object' || row.injected !== true) continue
        const at = Date.parse(row.at)
        if (!Number.isFinite(at)) continue
        times.push(at)
        if (newest === null || at > newest) newest = at
      }
      times.sort((left, right) => left - right)
      advisoryTimes.set(sessionId, times)
      if (newest !== null) lastAdvisoryAt.set(sessionId, newest)
    } catch (error) {
      warn('delegation-advisor recovery failed: ' + errorText(error))
    }
  }

  /** Count one pending tool call into the session's current turn bucket. */
  const recordToolCall = exec => {
    if (!settings.enabled) return
    try {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      const toolName = String(exec?.name ?? '')
      const now = settings.now()
      let bucket = buckets.get(sessionId)
      if (bucket === undefined) {
        bucket = {
          startedAt: null, toolCalls: 0, writes: 0, edits: 0, spawns: 0, msgs: 0,
          bashWrites: 0, toolNames: [], bashCommands: [], writeTargets: [],
        }
        buckets.set(sessionId, bucket)
      }
      if (bucket.startedAt === null) bucket.startedAt = now
      bucket.toolCalls += 1
      bucket.toolNames.push(toolName)
      // Split reasons: writeCalls = `write` only; editCalls = edit-class tools.
      if (toolName === DELEGATION_WRITE_TOOL) bucket.writes += 1
      else if (DELEGATION_EDIT_TOOLS.has(toolName)) bucket.edits += 1
      if (toolName === 'spawn_teammate') bucket.spawns += 1
      if (toolName === 'send_message' || toolName.startsWith('team_task_')) bucket.msgs += 1
      if (toolName === 'bash' || toolName === 'pwsh') {
        // F6 heuristics: keep the command text for the verification classifier.
        const command = exec?.arguments !== null && typeof exec?.arguments === 'object'
          ? (typeof exec.arguments.command === 'string'
            ? exec.arguments.command
            : (typeof exec.arguments.cmd === 'string' ? exec.arguments.cmd : ''))
          : ''
        if (command !== '') bucket.bashCommands.push(command)
        if (shellCommandLooksWriteful(exec.arguments)) bucket.bashWrites += 1
      }
      // F6 heuristics: keep write targets for the verification-path classifier.
      const writeTarget = resolveWriteTarget(exec?.agent, exec?.arguments)
      if (writeTarget.raw !== null) bucket.writeTargets.push(writeTarget.raw)
    } catch (error) {
      warn('delegation-advisor counter failed (fail-open): ' + errorText(error))
    }
  }

  /** The decision function (kept separate for mutation testing). */
  const decide = (bucket, taskKind) => {
    // FP hard gate: advisory only on ordinary heavy file-work turns.
    // "Write-ish" work = write + edit-class calls (T10 split).
    let advisory = (bucket.spawns + bucket.msgs) <= settings.maxDelegateCalls
      && (bucket.writes + bucket.edits) >= settings.minWrites
      && taskKind === 'normal'
    if (settings.mode === 'off') advisory = false
    if (settings.mode === 'invert') advisory = !advisory
    return advisory
  }

  /** hookLoaded evidence: only an enabled ON-arm, non-mutation hook counts. */
  const hookLoaded = arm => settings.enabled && arm === 'on' && settings.mode !== 'off'

  /**
   * Append the single per-turn audit row. The TOP LEVEL has exactly the 15
   * frozen fields from the contract (verification samples compare rows, so no
   * extra top-level keys); every extension lives under `metrics`:
   * `writeCalls (write only), editCalls (edit-class), writeishCalls, bashWrites,
   *  thresholds, contextPressure, hookLoaded, advisoryTextHash, armSource,
   *  noToolCalls, degraded, mode, error` (error always present; null = none).
   */
  const writeAuditRow = (sessionId, session, turnId, bucket, row) => {
    const durationMs = (bucket.startedAt === null || bucket.toolCalls === 0)
      ? 0
      : Math.max(0, settings.now() - bucket.startedAt)
    const delegateCalls = bucket.spawns + bucket.msgs
    const armInfo = row.armInfo ?? { arm: settings.arm, source: 'config' }
    let pressure = null
    try {
      const measured = row.agent === undefined ? null : contextPercent(row.agent)
      if (typeof measured === 'number' && Number.isFinite(measured)) pressure = measured
    } catch {
      pressure = null
    }
    const record = {
      at: new Date(settings.now()).toISOString(),
      session,
      turnId,
      // Top-level `writes` stays the total write-ish count (T9-compatible);
      // metrics.writeCalls/editCalls expose the T10 split.
      writes: bucket.writes + bucket.edits,
      spawns: bucket.spawns,
      msgs: bucket.msgs,
      decision: row.decision === 'advisory' ? 'advisory' : 'none',
      injected: row.injected === true,
      hookVersion: DELEGATION_HOOK_VERSION,
      ruleVersion: delegationRuleVersion(settings.mode),
      arm: armInfo.arm,
      pairId: settings.pairId,
      metrics: {
        toolCalls: bucket.toolCalls,
        durationMs,
        delegateCalls,
        writeCalls: bucket.writes,
        editCalls: bucket.edits,
        writeishCalls: bucket.writes + bucket.edits,
        bashWrites: bucket.bashWrites,
        thresholds: {
          minWrites: settings.minWrites,
          maxDelegateCalls: settings.maxDelegateCalls,
          minIntervalMs: settings.minIntervalMs,
          maxPerHour: settings.maxPerHour,
          version: settings.thresholdsVersion,
        },
        contextPressure: pressure,
        hookLoaded: hookLoaded(armInfo.arm),
        armSource: armInfo.source,
        advisoryTextHash: row.advisoryTextHash === undefined ? null : row.advisoryTextHash,
        // F6: why taskKind was chosen (role|tool|bash-heuristic|path-heuristic|default).
        taskKindSource: typeof row.taskKindSource === 'string' ? row.taskKindSource : 'default',
        // §5.5 delivery contract: `injected` only proves followup() returned; it is
        // NOT evidence of delivery. delivery.deliveredAt stays null until an
        // external audit post-processor proves it.
        delivery: row.delivery === undefined ? null : row.delivery,
        noToolCalls: bucket.toolCalls === 0,
        degraded: isDegraded(),
        mode: settings.mode,
        error: row.error === undefined || row.error === null ? null : String(row.error),
      },
      dedupe: {
        key: turnId,
        suppressed: row.suppressed === true,
        reason: row.reason === undefined ? null : row.reason,
      },
      taskKind: row.taskKind === 'read-only' || row.taskKind === 'verification' ? row.taskKind : 'normal',
    }
    const ok = appendJsonLine(auditFileFor(sessionId), record)
    if (!ok) warn('delegation-advisor audit append failed: ' + auditFileFor(sessionId))
    return ok
  }

  /**
   * Handle one closed turn: evaluate, inject at most once, audit at most once.
   * Synchronous and fully fail-open — never throws, never blocks/denies.
   */
  const handleTurnStopping = payload => {
    if (!settings.enabled) return
    try {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      const sessionId = agent?.session?.id
      const turn = payload !== null && typeof payload === 'object' ? payload.turn : undefined
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (!Number.isInteger(turn)) return
      const session = delegationSessionShort(sessionId)
      const turnId = session + ':' + String(turn)
      if (!recovered.has(sessionId)) {
        recoverFromAudit(sessionId)
        recovered.add(sessionId)
      }
      const seen = processedTurns.get(sessionId) ?? new Set()
      if (!processedTurns.has(sessionId)) processedTurns.set(sessionId, seen)
      if (seen.has(turnId)) return
      seen.add(turnId)
      if (seen.size > DELEGATION_MAX_TRACKED_TURNS) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }

      const emptyBucket = {
        startedAt: null, toolCalls: 0, writes: 0, edits: 0, spawns: 0, msgs: 0,
        bashWrites: 0, toolNames: [], bashCommands: [], writeTargets: [],
      }
      const bucket = buckets.get(sessionId) ?? emptyBucket
      buckets.delete(sessionId)
      const classification = delegationTaskKind(bucket, settings, ctx, agent)
      const taskKind = classification.taskKind
      const taskKindSource = classification.taskKindSource
      const armInfo = resolveArm()
      const advisory = decide(bucket, taskKind)
      const now = settings.now()
      let injected = false
      let suppressed = false
      let reason = null
      let error = null
      let advisoryTextHash = null
      let delivery = null
      // decision is constrained to "advisory" | "none" (frozen contract).
      // The control arm (arm=off) always audits decision "none".
      let decision = advisory ? 'advisory' : 'none'

      if (!advisory) {
        reason = settings.mode === 'off'
          ? 'mode-off'
          : (taskKind === 'read-only' ? 'read-only-turn'
            : (taskKind === 'verification' ? 'verification-turn' : 'conditions-not-met'))
      } else if (isDegraded()) {
        suppressed = true
        reason = 'degraded-audit-only'
      } else if (armInfo.arm !== 'on') {
        // F1: `arm-off` ONLY means "would have triggered but the arm suppressed it".
        decision = 'none'
        suppressed = true
        reason = 'arm-off'
      } else {
        const times = (advisoryTimes.get(sessionId) ?? []).filter(at => now - at < 60 * 60 * 1000)
        if (times.length >= settings.maxPerHour) {
          suppressed = true
          reason = 'rate-limit-1h'
        } else if (times.length > 0 && now - times[times.length - 1] < settings.minIntervalMs) {
          suppressed = true
          reason = 'rate-limit-10min'
        } else {
          let renderedText = ''
          try {
            const text = settings.advisoryText !== null
              ? String(settings.advisoryText(bucket))
              : defaultDelegationAdvisoryText(bucket.writes + bucket.edits)
            renderedText = Array.from(text).slice(0, 80).join('')
            // Hash of the EXACT text handed to followup() (schema v1 + delivery).
            advisoryTextHash = 'sha256:' + createHash('sha256').update(renderedText, 'utf8').digest('hex')
            // §5.5 debt: injected only proves the followup() call returned. The
            // plugin cannot verify delivery, so deliveredAt stays null.
            delivery = {
              attemptedAt: new Date(now).toISOString(),
              deliveredAt: null,
              evidence: 'unverified',
              advisoryTextHash,
            }
            agent.followup(createUserMessage(renderedText))
            injected = true
            times.push(now)
            advisoryTimes.set(sessionId, times)
            lastAdvisoryAt.set(sessionId, now)
            // Shared turn key with problemLoop: at most one advisory per turn
            // across delegation-advisor and problem-loop (no double reminder).
            try { hooks.onAdvisoryInjected?.(sessionId, turnId) } catch { /* advisory already delivered */ }
            try {
              ctx.logger.info('[team-hooks2] delegation advisory injected session=' + sessionId
                + ' turn=' + String(turn) + ' writes=' + String(bucket.writes + bucket.edits))
            } catch {
              // ignore
            }
          } catch (injectError) {
            // Fail-open: keep decision in the frozen enum; record the error.
            if (delivery === null) {
              delivery = {
                attemptedAt: new Date(now).toISOString(),
                deliveredAt: null,
                evidence: 'unverified',
                advisoryTextHash,
              }
            }
            error = errorText(injectError)
            reason = 'inject-failed'
          }
        }
        if (!injected) advisoryTimes.set(sessionId, times)
      }
      writeAuditRow(sessionId, session, turnId, bucket, {
        decision, injected, suppressed, reason, error, taskKind, taskKindSource,
        agent, armInfo, advisoryTextHash, delivery,
      })
    } catch (outerError) {
      // Fail-open: the turn must complete normally. Best-effort error audit.
      try {
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        const sessionId = agent?.session?.id
        if (typeof sessionId === 'string' && sessionId !== '') {
          writeAuditRow(sessionId, delegationSessionShort(sessionId), 'error:' + String(settings.now()), {
            startedAt: null, toolCalls: 0, writes: 0, edits: 0, spawns: 0, msgs: 0,
            bashWrites: 0, toolNames: [], bashCommands: [], writeTargets: [],
          }, {
            decision: 'none', injected: false, suppressed: false, reason: 'internal-error',
            error: errorText(outerError), taskKind: 'normal', taskKindSource: 'default',
            agent, armInfo: resolveArm(),
          })
          warn('delegation-advisor failed (fail-open, audited): ' + errorText(outerError))
          return
        }
      } catch {
        // fall through to the warning below
      }
      warn('delegation-advisor failed (fail-open): ' + errorText(outerError))
    }
  }

  /** Status payload for `team_hooks_status`. */
  const status = agent => {
    let sessionId = null
    try {
      sessionId = agent?.session?.id ?? null
    } catch {
      sessionId = null
    }
    const lastAt = sessionId === null ? undefined : lastAdvisoryAt.get(sessionId)
    const armInfo = resolveArm()
    return {
      enabled: settings.enabled,
      loaded: settings.enabled,
      hookLoaded: hookLoaded(armInfo.arm),
      mode: settings.mode,
      // `arm` is the arm that will be used for the next turn (runtime file wins).
      arm: armInfo.arm,
      armSource: armInfo.source,
      armFile: settings.armFile,
      configArm: settings.arm,
      pairId: settings.pairId,
      degraded: isDegraded(),
      hookVersion: DELEGATION_HOOK_VERSION,
      ruleVersion: delegationRuleVersion(settings.mode),
      thresholdsVersion: settings.thresholdsVersion,
      verificationRoles: settings.verificationRoles,
      taskKindSources: ['role', 'tool', 'bash-heuristic', 'path-heuristic', 'default'],
      auditDir: settings.auditDir,
      lastAdvisoryAt: lastAt === undefined ? null : new Date(lastAt).toISOString(),
      minWrites: settings.minWrites,
      maxDelegateCalls: settings.maxDelegateCalls,
      minIntervalMs: settings.minIntervalMs,
      maxPerHour: settings.maxPerHour,
      readOnlyTools: settings.readOnlyTools,
      verificationTools: settings.verificationTools,
      taskKinds: ['read-only', 'verification', 'normal'],
    }
  }

  return { settings, startup, recordToolCall, handleTurnStopping, status, decide }
}

// ---------------------------------------------------------------------------
// Problem loop (Phase L / task-42): observe tool failures, append incident
// JSONL compatible with packages/dsh-env-toolbox/src/problem.mjs, and (only in
// advisory mode) inject ONE <=2-line reminder after the frozen thresholds.
// Default OFF. It never creates problems/proposals and never routes; those
// require human triage (`problem consolidate --confirm`). Fail-open throughout.
// ---------------------------------------------------------------------------
const PROBLEM_HOOK_VERSION = 'team-hooks2/problem-loop/1'
const PROBLEM_LEDGER_SCHEMA = 1
const PROBLEM_DEFAULT_FAMILY_ALLOWLIST = Object.freeze([
  'i-edit-guard', 'i-read-path', 'i-acl', 'i-pwsh', 'i-encoding', 'i-stream',
  'i-plugin-hmr', 'i-port', 'i-cordis', 'i-session-api', 'i-silent',
])
const PROBLEM_DEFAULT_EXPECTED_PATTERNS = Object.freeze([
  // Phase L FP examples: approval cancellation + declarative sandbox refusal.
  'approval for escalating to "[^"]+" was cancelled',
  '\\[sandbox: file access denied under workspace-write mode\\][^\\n]*escalation available',
  'declarative (?:policy|sandbox|permission)[^\\n]*(?:deny|denied|reject|cancel)',
])
// New verifier name: toolbox-verify. 'plugin-verifier' stays as a legacy
// alias so existing verifier sessions remain ledger:ignore during migration.
const PROBLEM_DEFAULT_VERIFICATION_ROLES = Object.freeze(['verify-captain', 'verify*', 'toolbox-verify', 'plugin-verifier'])
const PROBLEM_DEFAULT_VERIFICATION_TOOLS = Object.freeze(['verify*'])
/**
 * Lead task-49: generated from PHASE_L_LABELED_SET_v1.1.jsonl's 32 prefixed
 * deny signatures (32/32: expected 18 + verification 14). The JSON is shipped
 * next to this module; the core three are an in-code fail-safe if the file is
 * unavailable (pl-061 approval / pl-063 sandbox-policy / pl-157 ownership).
 */
const PROBLEM_CORE_DENY_SIGNATURES = Object.freeze([
  'approval:tool/Error: approval for escalating to "danger-full-access" was cancelled',
  'sandbox-policy:tool/Error: [sandbox: file access denied under workspace-write mode] [sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification]',
  'ownership:tool/Error: team task "task-21" is owned by another member',
])
function loadProblemDenySignatures() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./problem-deny-signatures.v1.1.json', import.meta.url), 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.signatures
    const signatures = Array.isArray(list)
      ? list.map(item => (typeof item === 'string' ? item : item?.denySignature)).filter(item => typeof item === 'string' && item !== '')
      : []
    return signatures.length > 0 ? signatures : [...PROBLEM_CORE_DENY_SIGNATURES]
  } catch {
    return [...PROBLEM_CORE_DENY_SIGNATURES]
  }
}
const PROBLEM_DEFAULT_DENY_SIGNATURES = Object.freeze(loadProblemDenySignatures())
/**
 * Lead canary decision (task-43/v1.1 follow-up): only the B/C gate may be
 * enabled. These Phase L v1.1 deny prefixes are policy-reject exclusions;
 * A/D variants (no exclusions / cross-session only) stay disabled until the
 * v1.1 label ruling is superseded. The list is configurable.
 */
const PROBLEM_DEFAULT_DENY_PREFIXES = Object.freeze([
  'expected:', 'verify:', 'approval:', 'sandbox-policy:', 'ownership:', 'policy-reject:',
])
const PROBLEM_DEFAULT_DENY_PATTERNS = Object.freeze([
  // pl-157-like: a task claimed/owned by another member is a policy rejection.
  'team task "[^"]+" is owned by another member',
])

/** Normalize a free-form message exactly like problem.mjs (compat contract). */
function normalizeProblemMessage(message) {
  let text = String(message ?? '').toLowerCase()
  text = text.replace(/[a-z]:[\\/][^\s"'<>|,;)]*/gu, '<path>')
  text = text.replace(/\/[^\s"'<>|,;)]+\/[^\s"'<>|,;)]*/gu, '<path>')
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<id>')
  text = text.replace(/\b\d+\b/gu, '<n>')
  text = text.replace(/\s+/gu, ' ').trim()
  return text.slice(0, 160)
}

/** Normalize one signature token exactly like problem.mjs. */
function normalizeProblemToken(value, fallback) {
  const text = String(value ?? '').toLowerCase().trim().replace(/[^a-z0-9._:/-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return text === '' ? fallback : text.slice(0, 48)
}

/** `sig-<sha256(family|tool|errorCode|normalizedMessage)[:16]>` (problem.mjs). */
export function normalizeProblemSignature({ family, tool, errorCode, message } = {}) {
  const parts = {
    family: normalizeProblemToken(family, 'other'),
    tool: normalizeProblemToken(tool, 'unknown'),
    errorCode: normalizeProblemToken(errorCode, 'none'),
    normalizedMessage: normalizeProblemMessage(message ?? ''),
  }
  const digest = createHash('sha256')
    .update(`${parts.family}|${parts.tool}|${parts.errorCode}|${parts.normalizedMessage}`)
    .digest('hex').slice(0, 16)
  return { signature: `sig-${digest}`, ...parts }
}

/**
 * Lightweight Phase L family classifier (environment families only). Families
 * outside the allowlist (notably R-OTHER, and I-READ-OFFSET which is evidence-
 * only in PHASE_L_GATE) are observed-suppressed and never reminded.
 */
export function classifyProblemFamily({ tool, errorCode, message } = {}) {
  const msg = String(message ?? '').toLowerCase()
  const code = String(errorCode ?? '').toLowerCase()
  const name = String(tool ?? '').toLowerCase()
  if (/offset \d+ is out of range for /.test(msg)) return 'I-READ-OFFSET'
  if (/read-before-write|file has not been read|fs_not_observed|read the file, then retry/.test(msg) || code === 'fs_not_observed') return 'I-EDIT-GUARD'
  if (/eaddrinuse|address already in use|port [^ ]* ?(?:already )?in use/.test(msg)) return 'I-PORT'
  if (/utf-?8|bom|encoding|invalid byte sequence|mojibake|gbk/.test(msg)) return 'I-ENCODING'
  if (/epipe|econnreset|stream (?:closed|error)|write after end|stdout[^\n]*closed/.test(msg)) return 'I-STREAM'
  if (/hmr|hot.?reload|never started|plugin[^\n]*(?:not (?:started|found|loaded))/.test(msg)) return 'I-PLUGIN-HMR'
  if (/cordis|fiber|service[^\n]*(?:not (?:started|available))|inject[^\n]*(?:fail|error)/.test(msg)) return 'I-CORDIS'
  if (/eacces|eperm|access denied|permission denied|acl|sandbox: file access denied|not permitted/.test(msg)) return 'I-ACL'
  if (/cannot read|enoent|no such file|does not exist|not found|invalid path/.test(msg)
    && ['read', 'glob', 'grep', 'read_image'].includes(name)) return 'I-READ-PATH'
  if (name === 'bash' || name === 'pwsh' || /powershell|pwsh|shell/.test(msg)) return 'I-PWSH'
  if (/typert|sessioncontroller|session api|rpc[^\n]*(?:error|fail)/.test(msg)) return 'I-SESSION-API'
  if (msg.trim() === '') return 'I-SILENT'
  return 'R-OTHER'
}

function compileProblemPatterns(value, fallback) {
  const source = Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '') : [...fallback]
  const compiled = []
  for (const item of source) {
    try { compiled.push(new RegExp(item, 'i')) } catch { /* skip malformed config regex */ }
  }
  return compiled
}

/** Return the matching deny rule (prefix/pattern) or null; policy-reject wins. */
function problemDenyRule(message, settings) {
  const text = String(message ?? '').trim()
  const lowered = text.toLowerCase()
  for (const prefix of settings.denyPrefixes) {
    if (lowered.startsWith(prefix)) return 'prefix:' + prefix
  }
  for (const pattern of settings.denyPatterns) {
    if (pattern.test(text)) return 'pattern:' + pattern.source
  }
  return null
}

/**
 * Exact deny-signature match (task-49): v1.1 has 32 prefixed scan signatures.
 * Live incidents do not carry the scan's literal `tool/Error:` surface, so the
 * exact comparison uses both the canonical sig-* and raw scan candidates
 * (`<tool>/Error: <message>` / `tool/Error: <message>`); config entries may also
 * be plain `sig-*` values. Substring matching is deliberately NOT used.
 */
function problemDenySignatureRule(parts, tool, message, settings) {
  const text = String(message ?? '')
  const candidates = new Set([
    parts.signature,
    String(tool) + '/Error: ' + text,
    'tool/Error: ' + text,
    text,
  ])
  for (const entry of settings.denySignatures) {
    if (candidates.has(entry)) return entry
    const colon = entry.indexOf(':')
    if (colon > 0) {
      const payload = entry.slice(colon + 1)
      if (candidates.has(payload)) return entry
    }
  }
  return null
}

/** verificationRoles matching: exact OR startsWith (toolbox-verify*; legacy plugin-verifier*). */
function problemVerificationRoleMatches(pattern, roleName) {
  const patternText = String(pattern ?? '').toLowerCase()
  const roleText = String(roleName ?? '').toLowerCase()
  if (patternText === '' || roleText === '') return false
  if (roleText === patternText) return true
  if (patternText.endsWith('*')) return roleText.startsWith(patternText.slice(0, -1))
  return roleText.startsWith(patternText)
}

function normalizeProblemLoopConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config.problemLoop : undefined
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const strings = (value, fallback) => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item !== '')
    : [...fallback]
  const integer = (value, fallback, minimum) => (Number.isInteger(value) && value >= minimum ? value : fallback)
  return {
    enabled: raw !== false && source.enabled === true,
    mode: source.mode === 'advisory' ? 'advisory' : 'observe',
    familyAllowlist: strings(source.familyAllowlist, PROBLEM_DEFAULT_FAMILY_ALLOWLIST)
      .map(item => item.toLowerCase()),
    expectedPatterns: compileProblemPatterns(source.expectedPatterns, PROBLEM_DEFAULT_EXPECTED_PATTERNS),
    expectedPatternSources: Array.isArray(source.expectedPatterns) ? source.expectedPatterns : [...PROBLEM_DEFAULT_EXPECTED_PATTERNS],
    denyPrefixes: strings(source.denyPrefixes, PROBLEM_DEFAULT_DENY_PREFIXES).map(item => item.toLowerCase()),
    denyPatterns: compileProblemPatterns(source.denyPatterns, PROBLEM_DEFAULT_DENY_PATTERNS),
    denyPatternSources: Array.isArray(source.denyPatterns) ? source.denyPatterns : [...PROBLEM_DEFAULT_DENY_PATTERNS],
    // Built-in v1.1 32 prefixed signatures always apply; config may add more.
    denySignatures: [...new Set([...PROBLEM_DEFAULT_DENY_SIGNATURES, ...strings(source.denySignatures, [])])],
    verificationRoles: strings(source.verificationRoles, PROBLEM_DEFAULT_VERIFICATION_ROLES),
    verificationTools: strings(source.verificationTools, PROBLEM_DEFAULT_VERIFICATION_TOOLS),
    verificationSessions: strings(source.verificationSessions, []),
    ledger: source.ledger !== false,
    ledgerFile: typeof source.ledgerFile === 'string' && source.ledgerFile !== ''
      ? source.ledgerFile
      : join(DSH_HOME, 'toolbox', 'incidents.jsonl'),
    auditDir: typeof source.auditDir === 'string' && source.auditDir !== ''
      ? source.auditDir
      : join(DSH_HOME, 'audit', 'problem-loop'),
    appendExcluded: source.appendExcluded !== false,
    crossSessionWindowMs: integer(source.crossSessionWindowMs, 24 * 60 * 60 * 1000, 1),
    crossSessionDistinctSessions: integer(source.crossSessionDistinctSessions, 2, 1),
    singleSessionWindowMs: integer(source.singleSessionWindowMs, 60 * 60 * 1000, 1),
    singleSessionOccurrences: integer(source.singleSessionOccurrences, 3, 1),
    advisoryCooldownMs: integer(source.advisoryCooldownMs, 7 * 24 * 60 * 60 * 1000, 0),
    maxAdvisoriesPerSession: integer(source.maxAdvisoriesPerSession, 2, 1),
    maxLines: 2,
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
  }
}

function problemErrorCode(result) {
  const info = result !== null && typeof result === 'object' ? result.error?.info : undefined
  const fallback = result !== null && typeof result === 'object' ? result.error?.code : undefined
  return String(info?.code ?? fallback ?? 'none')
}

function problemErrorMessage(result) {
  if (result === null || typeof result !== 'object') return ''
  const message = result.error?.message
  if (typeof message === 'string' && message !== '') return message
  try {
    return (Array.isArray(result.content) ? result.content : [])
      .map(block => block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : '')
      .join(' ').trim()
  } catch {
    return ''
  }
}

function problemRecordId(now, randomBytesFn) {
  const stamp = new Date(now()).toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)
  return `inc-${stamp}-${randomBytesFn(2).toString('hex')}`
}

/**
 * One problem-loop instance. Default off; no imports from dsh-env-toolbox, but
 * signature/session/record fields match its contract (verified by tests).
 */
export function createProblemLoop(ctx, config, deps = {}) {
  const settings = normalizeProblemLoopConfig(config)
  const now = typeof deps.now === 'function' ? deps.now : settings.now
  const randomBytesFn = typeof deps.randomBytes === 'function' ? deps.randomBytes : randomBytes
  const sharedAdvisoryTurns = deps.sharedAdvisoryTurns instanceof Set ? deps.sharedAdvisoryTurns : new Set()
  const recent = []
  const pendingBySession = new Map()
  const advisoryBySignature = new Map()
  const advisoryCountBySession = new Map()
  const processedTurns = new Set()
  let ledgerLoaded = false
  let ledgerError = null
  let lastIncidentAt = null
  let lastAdvisoryAt = null

  const warn = message => {
    try { ctx.logger.warn('[team-hooks2] ' + message) } catch { /* logging must never throw */ }
  }
  const auditFileFor = sessionId => join(settings.auditDir, 'problem-' + delegationSessionShort(sessionId) + '.jsonl')
  const writeAudit = (sessionId, row) => {
    try {
      appendJsonLine(auditFileFor(sessionId), {
        at: new Date(now()).toISOString(),
        event: 'problem-loop',
        hookVersion: PROBLEM_HOOK_VERSION,
        mode: settings.mode,
        ...row,
      })
    } catch (error) {
      warn('problem-loop audit append failed: ' + errorText(error))
    }
  }

  /** Seed in-memory counters from the shared ledger (previous sessions/restart). */
  const loadLedger = () => {
    if (ledgerLoaded) return
    ledgerLoaded = true
    if (!settings.ledger) return
    try {
      if (!existsSync(settings.ledgerFile)) return
      const size = statSync(settings.ledgerFile).size
      let text = readFileSync(settings.ledgerFile, 'utf8')
      if (size > 4 * 1024 * 1024) text = text.slice(-4 * 1024 * 1024)
      const nowMs = now()
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line)
          if (row === null || typeof row !== 'object' || row.type !== 'incident' || row.excluded === true) continue
          const atMs = Date.parse(row.at)
          if (!Number.isFinite(atMs)) continue
          if (nowMs - atMs > settings.crossSessionWindowMs) continue
          if (!settings.familyAllowlist.includes(String(row.family ?? '').toLowerCase())) continue
          if (recent.length >= 2000) recent.shift()
          recent.push({ signature: row.signature, family: row.family, session: row.session, atMs, excluded: false })
        } catch { /* tolerate malformed ledger lines */ }
      }
    } catch (error) {
      ledgerError = errorText(error)
      warn('problem-loop ledger read failed (fail-open): ' + ledgerError)
    }
  }

  const appendIncident = record => {
    if (!settings.ledger) return false
    try {
      mkdirSync(dirname(settings.ledgerFile), { recursive: true })
      appendFileSync(settings.ledgerFile, JSON.stringify(record) + '\n', 'utf8')
      return true
    } catch (error) {
      ledgerError = errorText(error)
      warn('problem-loop ledger append failed (fail-open): ' + ledgerError)
      return false
    }
  }

  const isVerificationSession = agent => {
    try {
      const sessionId = agent?.session?.id
      if (typeof sessionId === 'string' && sessionId !== '') {
        const short = delegationSessionShort(sessionId)
        if (settings.verificationSessions.some(item => item === sessionId || item === short)) return true
      }
      const role = resolveTeamRole(ctx, agent)
      if (role.ok === true) {
        return settings.verificationRoles.some(pattern => problemVerificationRoleMatches(pattern, role.name))
      }
    } catch { /* role lookup fail-open */ }
    return false
  }

  const buildIncident = ({ parts, tool, errorCode, session, excluded, excludeReason }) => ({
    schema: PROBLEM_LEDGER_SCHEMA,
    type: 'incident',
    id: problemRecordId(now, randomBytesFn),
    at: new Date(now()).toISOString(),
    signature: parts.signature,
    family: parts.family,
    tool: parts.tool,
    errorCode: parts.errorCode,
    session,
    excluded,
    excludeReason,
    evidenceRefs: ['tool:' + String(tool).slice(0, 48), 'error-code:' + String(errorCode).slice(0, 48), 'session:' + session],
    source: 'hook',
  })

  /** Record one failed tool result (post-execute); never throws. */
  const recordToolResult = (exec, result) => {
    if (!settings.enabled) return
    try {
      if (result === null || typeof result !== 'object' || result.isError !== true) return
      const agent = exec?.agent
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      const tool = String(exec?.name ?? 'unknown')
      const errorCode = problemErrorCode(result)
      const message = problemErrorMessage(result)
      const session = delegationSessionShort(sessionId)
      loadLedger()

      if (isVerificationSession(agent)) {
        writeAudit(sessionId, {
          session, tool, errorCode, excluded: true, excludeReason: 'verification',
          action: 'ignored', reason: 'verification-session-ledger-ignore',
        })
        return
      }
      const denyRule = problemDenyRule(message, settings)
      if (denyRule !== null) {
        const parts = normalizeProblemSignature({
          family: classifyProblemFamily({ tool, errorCode, message }),
          tool, errorCode, message,
        })
        const record = buildIncident({ parts, tool, errorCode, session, excluded: true, excludeReason: 'policy-reject' })
        const written = settings.appendExcluded ? appendIncident(record) : false
        writeAudit(sessionId, {
          session, tool, errorCode, signature: parts.signature, family: parts.family,
          excluded: true, excludeReason: 'policy-reject', denyRule, ledgerWritten: written,
          action: 'excluded',
        })
        return
      }
      const expected = settings.expectedPatterns.some(pattern => pattern.test(message))
      if (expected) {
        const parts = normalizeProblemSignature({
          family: classifyProblemFamily({ tool, errorCode, message }),
          tool, errorCode, message,
        })
        const record = buildIncident({ parts, tool, errorCode, session, excluded: true, excludeReason: 'expected' })
        const written = settings.appendExcluded ? appendIncident(record) : false
        writeAudit(sessionId, {
          session, tool, errorCode, signature: parts.signature, family: parts.family,
          excluded: true, excludeReason: 'expected', ledgerWritten: written,
          action: 'excluded',
        })
        return
      }

      const family = classifyProblemFamily({ tool, errorCode, message })
      const parts = normalizeProblemSignature({ family, tool, errorCode, message })
      // task-49: v1.1 32 prefixed deny signatures — exact match only, before the
      // family allowlist/trigger counters, so a known FP can never remind.
      const denySignature = problemDenySignatureRule(parts, tool, message, settings)
      if (denySignature !== null) {
        const record = buildIncident({ parts, tool, errorCode, session, excluded: true, excludeReason: 'policy-reject' })
        const written = settings.appendExcluded ? appendIncident(record) : false
        writeAudit(sessionId, {
          session, tool, errorCode, signature: parts.signature, family: parts.family,
          excluded: true, excludeReason: 'policy-reject', denyRule: 'signature',
          denySignature: denySignature.slice(0, 160), ledgerWritten: written,
          action: 'excluded',
        })
        return
      }
      if (!settings.familyAllowlist.includes(String(family).toLowerCase())) {
        writeAudit(sessionId, {
          session, tool, errorCode, family, excluded: false,
          action: 'suppressed', reason: 'family-not-allowed',
        })
        return
      }
      const record = buildIncident({ parts, tool, errorCode, session, excluded: false, excludeReason: null })
      const written = appendIncident(record)
      const atMs = now()
      lastIncidentAt = record.at
      if (recent.length >= 2000) recent.shift()
      recent.push({ signature: parts.signature, family: parts.family, session, atMs, excluded: false })
      let pending = pendingBySession.get(sessionId)
      if (pending === undefined) {
        pending = new Set()
        pendingBySession.set(sessionId, pending)
      }
      pending.add(parts.signature)
      writeAudit(sessionId, {
        session, tool, errorCode, signature: parts.signature, family: parts.family,
        excluded: false, ledgerWritten: written, ledgerError,
        action: 'recorded', severity: 'info',
      })
    } catch (error) {
      warn('problem-loop record failed (fail-open): ' + errorText(error))
    }
  }

  const evaluateTrigger = signature => {
    const nowMs = now()
    const rows = recent.filter(row => row.signature === signature && row.excluded !== true)
    const in24 = rows.filter(row => nowMs - row.atMs <= settings.crossSessionWindowMs)
    const sessions24 = new Set(in24.map(row => row.session))
    const in1h = rows.filter(row => nowMs - row.atMs <= settings.singleSessionWindowMs)
    const perSession = new Map()
    for (const row of in1h) perSession.set(row.session, (perSession.get(row.session) ?? 0) + 1)
    const hot = [...perSession.entries()].filter(([, count]) => count >= settings.singleSessionOccurrences)
    return {
      signature,
      family: rows[0]?.family ?? null,
      occurrences24h: in24.length,
      sessions24h: sessions24.size,
      occurrences1h: in1h.length,
      singleSessionHot: hot.length > 0,
      crossSessionTriggered: sessions24.size >= settings.crossSessionDistinctSessions,
    }
  }

  const buildAdvisoryText = trigger => {
    const signature = String(trigger.signature ?? '')
    const family = String(trigger.family ?? 'unknown')
    const line1 = '[team-hooks2] 同类工具失败重复（' + signature + '，' + family + '，'
      + trigger.sessions24h + ' 会话/24h 或 ' + trigger.occurrences1h + ' 次/1h）：已记录 incident，未建单。'
    const line2 = '请人工 triage（problem status / problem-to-tool）；不自动路由、不自动修，同类签名将去重。'
    return line1 + '\n' + line2
  }

  /** Evaluate at turn close (after delegation advisor); advisory only if threshold. */
  const handleTurnStopping = payload => {
    if (!settings.enabled) return
    try {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      const sessionId = agent?.session?.id
      const turn = payload !== null && typeof payload === 'object' ? payload.turn : undefined
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (!Number.isInteger(turn)) return
      loadLedger()
      const session = delegationSessionShort(sessionId)
      const turnId = session + ':' + String(turn)
      if (processedTurns.has(turnId)) return
      processedTurns.add(turnId)
      if (processedTurns.size > 400) processedTurns.delete(processedTurns.values().next().value)
      const pending = pendingBySession.get(sessionId)
      if (pending === undefined || pending.size === 0) return
      pendingBySession.delete(sessionId)
      let advisoryDone = false
      for (const signature of pending) {
        const trigger = evaluateTrigger(signature)
        if (!trigger.crossSessionTriggered && !trigger.singleSessionHot) continue
        if (settings.mode !== 'advisory') {
          writeAudit(sessionId, { session, signature, action: 'trigger-observe', trigger })
          continue
        }
        if (advisoryDone) continue
        const lastAt = advisoryBySignature.get(signature)
        if (lastAt !== undefined && now() - lastAt < settings.advisoryCooldownMs) {
          writeAudit(sessionId, { session, signature, action: 'suppressed', reason: 'signature-cooldown', trigger })
          continue
        }
        if ((advisoryCountBySession.get(sessionId) ?? 0) >= settings.maxAdvisoriesPerSession) {
          writeAudit(sessionId, { session, signature, action: 'suppressed', reason: 'session-advisory-limit', trigger })
          continue
        }
        if (sharedAdvisoryTurns.has(turnId)) {
          writeAudit(sessionId, { session, signature, action: 'suppressed', reason: 'delegation-advisor-same-turn', trigger })
          continue
        }
        try {
          const text = buildAdvisoryText(trigger)
          agent.followup(createUserMessage(text))
          advisoryDone = true
          advisoryBySignature.set(signature, now())
          advisoryCountBySession.set(sessionId, (advisoryCountBySession.get(sessionId) ?? 0) + 1)
          sharedAdvisoryTurns.add(turnId)
          lastAdvisoryAt = new Date(now()).toISOString()
          writeAudit(sessionId, { session, signature, action: 'advisory', trigger, lines: 2 })
          try {
            ctx.logger.info('[team-hooks2] problem-loop advisory injected session=' + sessionId
              + ' turn=' + String(turn) + ' signature=' + signature)
          } catch { /* ignore logging */ }
        } catch (error) {
          writeAudit(sessionId, { session, signature, action: 'suppressed', reason: 'inject-failed', error: errorText(error), trigger })
        }
      }
    } catch (error) {
      warn('problem-loop turn handling failed (fail-open): ' + errorText(error))
    }
  }

  const status = agent => {
    let sessionId = null
    try { sessionId = agent?.session?.id ?? null } catch { sessionId = null }
    return {
      enabled: settings.enabled,
      mode: settings.mode,
      hookVersion: PROBLEM_HOOK_VERSION,
      // Lead task-43 follow-up: only the B/C gate is implemented. A/D variants
      // stay disabled until the v1.1 label ruling; no config switch exists for them.
      canaryBasis: 'B/C',
      canaryConditions: [
        'expected/verification excluded',
        'environment-family allowlist (R-OTHER excluded)',
        'deny prefixes expected:/verify:/approval:/sandbox-policy:/ownership:/policy-reject:',
        'v1.1 32 prefixed deny signatures (exact match)',
        'human triage only (no auto problem/proposal/route)',
      ],
      aEnabled: false,
      dEnabled: false,
      ledger: settings.ledger,
      ledgerFile: settings.ledgerFile,
      auditDir: settings.auditDir,
      familyAllowlist: settings.familyAllowlist,
      denyPrefixes: settings.denyPrefixes,
      denyPatterns: settings.denyPatternSources,
      denySignaturesCount: settings.denySignatures.length,
      verificationRoles: settings.verificationRoles,
      thresholds: {
        crossSessionWindowMs: settings.crossSessionWindowMs,
        crossSessionDistinctSessions: settings.crossSessionDistinctSessions,
        singleSessionWindowMs: settings.singleSessionWindowMs,
        singleSessionOccurrences: settings.singleSessionOccurrences,
        advisoryCooldownMs: settings.advisoryCooldownMs,
        maxAdvisoriesPerSession: settings.maxAdvisoriesPerSession,
      },
      recentIncidents: recent.length,
      pendingSessions: pendingBySession.size,
      lastIncidentAt,
      lastAdvisoryAt,
      sessionAdvisories: sessionId === null ? 0 : (advisoryCountBySession.get(sessionId) ?? 0),
      ledgerError,
    }
  }

  return { settings, recordToolResult, handleTurnStopping, status, evaluateTrigger }
}

export const inject = ['tools', 'tokenMeter']

export function apply(ctx, config) {
  if (config !== null && typeof config === 'object' && config.enabled === false) return
  const stateFile = config !== null && typeof config === 'object' && typeof config.stateFile === 'string'
    ? config.stateFile
    : join(DSH_HOME, 'team-hooks-state.json')

  const roleWritePolicy = normalizeRoleWritePolicy(config)
  /** Write gate (task-33): default off; observation/audit only unless explicitly enabled. */
  const writeGate = normalizeWriteGate(config)
  /** task-80 archive-reminder state machine config (defaults preserve v2 behavior). */
  const archiveReminder = normalizeArchiveReminderConfig(config)
  const writeGateDedupe = { warned: new Set() }
  /** Warnings/audits already emitted for repeated fail-open causes. */
  const roleWriteDedupe = { warned: new Set(), audited: new Set() }

  // Delegation advisor: per-turn metrics + advisory injection + frozen audit.
  // `contextPercent` is resolved lazily (measurePercent is defined below; the
  // hook is only called at turn boundaries, after apply() has returned).
  // The shared set carries the SAME turn key into problemLoop so the two hooks
  // never inject two reminders into one turn (task-42 dedupe requirement).
  const sharedAdvisoryTurns = new Set()
  const delegationAdvisor = createDelegationAdvisor(ctx, config, {
    contextPercent: agent => measurePercent(agent),
    onAdvisoryInjected: (_sessionId, turnId) => sharedAdvisoryTurns.add(turnId),
  })
  delegationAdvisor.startup()
  // Phase L problem loop (task-42): default off, observe/advisory only; writes
  // incident JSONL/audit only, never creates problem/proposal/routes.
  const problemLoop = createProblemLoop(ctx, config, { sharedAdvisoryTurns })

  let persisted = {}
  try {
    persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch { /* first run or unreadable: start empty */ }

  const state = new Map()
  if (persisted !== null && typeof persisted === 'object' && persisted.sessions !== null
    && typeof persisted.sessions === 'object') {
    const cutoff = Date.now() - STATE_TTL_MS
    for (const [key, value] of Object.entries(persisted.sessions)) {
      if (value === null || typeof value !== 'object') continue
      const updated = Date.parse(value.updatedAt || '')
      if (Number.isFinite(updated) && updated < cutoff) continue
      state.set(key, normalizeArchiveSessionState(value))
    }
  }

  let saveTimer
  const save = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(stateFile), { recursive: true })
        writeFileSync(stateFile, JSON.stringify({
          version: 1,
          sessions: Object.fromEntries(state),
        }, null, 2), 'utf8')
      } catch (error) {
        ctx.logger.warn('[team-hooks2] state save failed: ' + String(error))
      }
    }, 50)
  }

  const disposers = new Map()

  /**
   * task-92: observe an agent-created/updated `ARCHIVE_*.md` through the
   * write/edit tool arguments and persist its absolute path per session. This
   * path is the primary source for the manual-compaction "read your archive
   * first" reminder; `findLatestArchivePath` is the filesystem fallback.
   */
  const observeArchivePath = (exec) => {
    try {
      const toolName = String(exec?.name ?? '').toLowerCase()
      if (toolName !== 'write' && toolName !== 'edit') return
      const raw = archivePathFromArguments(exec?.arguments)
      if (raw === null) return
      const agent = exec?.agent
      const sessionId = agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(sessionWorkspaceDir(agent), raw)
      const s = normalizeArchiveSessionState(state.get(sessionId) ?? { phase: 'idle', cycle: false })
      s.archivePath = resolved
      s.archivePathObservedAt = new Date().toISOString()
      s.updatedAt = s.archivePathObservedAt
      state.set(sessionId, s)
      save()
      ctx.logger.info('[team-hooks2] archive path observed session=' + sessionId + ' path=' + resolved)
    } catch (error) {
      try {
        ctx.logger.warn('[team-hooks2] archive path observation failed (ignored): ' + errorText(error))
      } catch {
        // ignore
      }
    }
  }

  /**
   * task-92: a manual compaction appends `compaction/start` with a
   * `sourceCommandId`; automatic compaction omits it. Reset the archive cycle,
   * remember the manual compact time and archive location, and arm exactly one
   * next-step reminder. No archive CREATE is emitted here.
   */
  const handleManualCompact = (session, event) => {
    const key = session?.id
    if (typeof key !== 'string' || key === '') return
    const data = event?.data !== null && typeof event?.data === 'object' ? event.data : {}
    const seq = Number.isInteger(event?.seq) ? event.seq : null
    const s = normalizeArchiveSessionState(state.get(key) ?? { phase: 'idle', cycle: false })
    if (seq !== null && s.lastManualCompactSeq === seq) return
    let workspaceDir
    try {
      workspaceDir = session.header?.cwd
    } catch {
      workspaceDir = undefined
    }
    if (typeof workspaceDir !== 'string' || workspaceDir === '') workspaceDir = process.cwd()
    const knownPath = typeof s.archivePath === 'string' && ARCHIVE_FILE_RE.test(s.archivePath) ? s.archivePath : null
    s.phase = 'idle'
    s.cycle = false
    s.archiveTurn = null
    s.lastReminderTurn = null
    s.pendingRead = true
    s.pendingReadKind = 'manual'
    s.lastManualCompactAt = new Date().toISOString()
    s.lastManualCompactSeq = seq
    s.lastManualCompactTurn = Number.isInteger(data.turn) ? data.turn : null
    s.lastAction = 'manual-compact'
    s.lastDedupeReason = null
    s.archivePath = knownPath ?? findLatestArchivePath(workspaceDir) ?? canonicalArchivePath(workspaceDir)
    s.updatedAt = s.lastManualCompactAt
    state.set(key, s)
    save()
    try {
      ctx.logger.info('[team-hooks2] manual compaction detected session=' + key
        + ' seq=' + String(seq) + ' archivePath=' + s.archivePath)
    } catch {
      // ignore logging
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      if (event?.type !== 'compaction/start') return
      if (event?.data?.sourceCommandId === undefined) return
      handleManualCompact(session, event)
    } catch (error) {
      try {
        ctx.logger.warn('[team-hooks2] manual-compaction detection failed (ignored): ' + errorText(error))
      } catch {
        // ignore logging
      }
    }
  }
  // Subscribe on both this plugin context and the root context so the
  // manual-compaction marker is observed whether the loader mounted us as a
  // child fiber or the host publishes on the root bus; the seq dedupe in
  // handleManualCompact makes a double delivery harmless.
  const sessionEventDisposers = []
  for (const target of [ctx, ctx.root]) {
    if (target === undefined || typeof target.on !== 'function') continue
    try {
      sessionEventDisposers.push(target.on('session/event', onSessionEvent))
    } catch (error) {
      try {
        ctx.logger.warn('[team-hooks2] session/event subscription failed (ignored): ' + errorText(error))
      } catch {
        // ignore logging
      }
    }
  }
  ctx.effect(() => () => {
    for (const dispose of sessionEventDisposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    sessionEventDisposers.length = 0
  }, 'team-hooks2: manual-compaction session events')

  const measurePercent = (agent) => {
    try {
      const measurement = ctx.tokenMeter.measure(agent.session)
      const routed = agent.session.requestContext()
      const pressure = ctx.get('sessionProjections')?.stateOf(agent.session, 'contextPressure')
      const window = routed?.contextWindow ?? pressure?.contextWindow
      if (window === undefined || window <= 0) return null
      return Math.min(100, Math.round((measurement.totalTokens / window) * 100))
    } catch {
      return null
    }
  }

  const injectText = (agent, text, tag) => {
    try {
      agent.inject(createUserMessage(text))
      ctx.logger.info('[team-hooks2] reminder (' + tag + ') session=' + agent.session.id)
      return true
    } catch (error) {
      ctx.logger.warn('[team-hooks2] failed to inject (' + tag + '): ' + String(error))
      return false
    }
  }

  /**
   * task-80 per-session archive loop. At most one reminder per turn; fail-open;
   * only an over-threshold crossing creates a new archive. A context drop resets
   * the cycle and asks the agent to READ the latest archive; the next crossing
   * creates a new archive. Context-meter threshold advisory/[ctx] pending
   * messages suppress this turn's archive reminder (state is retried later).
   */
  const evaluate = (agent, percent, turn) => {
    const key = agent.session.id
    let s = state.get(key) ?? { phase: 'idle', cycle: false }
    s = normalizeArchiveSessionState(s)
    state.set(key, s)
    if (!archiveReminder.enabled) {
      s.lastPercent = percent
      s.updatedAt = new Date().toISOString()
      save()
      return
    }
    const turnNumber = Number.isInteger(turn) ? turn : null
    if (turnNumber !== null && Number.isInteger(s.lastTurn) && turnNumber <= s.lastTurn) {
      s.lastPercent = percent
      s.updatedAt = new Date().toISOString()
      save()
      return
    }
    const prev = typeof s.lastPercent === 'number' ? s.lastPercent : undefined
    const prevAt = Date.parse(s.updatedAt || '')
    const baselineFresh = Number.isFinite(prevAt) ? Date.now() - prevAt <= DROP_WINDOW_MS : false
    const nowIso = new Date().toISOString()
    const manualPending = s.pendingReadKind === 'manual'
    let manualPath = null
    let manualPathNote = ''
    if (manualPending) {
      const workspaceDir = sessionWorkspaceDir(agent)
      manualPath = typeof s.archivePath === 'string' && ARCHIVE_FILE_RE.test(s.archivePath)
        ? s.archivePath
        : findLatestArchivePath(workspaceDir)
      if (manualPath === null) {
        let roleName
        try {
          roleName = ctx.get('agentTeams')?.membership(agent)?.name
        } catch {
          roleName = undefined
        }
        manualPath = canonicalArchivePath(workspaceDir, roleName)
      }
      if (!existsSync(manualPath)) {
        manualPathNote = '（该路径当前尚未发现归档文件；请按此规范路径创建/补全归档并读取后再继续，不要在此刻新建其他归档。）'
      }
    }
    const values = {
      percent,
      threshold: archiveReminder.archiveThreshold,
      previous: prev === undefined ? percent : prev,
      dropThreshold: archiveReminder.dropThreshold,
      path: manualPath === null ? '' : manualPath,
      pathNote: manualPathNote,
      turns: turnNumber !== null && Number.isInteger(s.lastReminderTurn)
        ? Math.max(0, turnNumber - s.lastReminderTurn)
        : archiveReminder.reminderEveryNTurns,
      everyNTurns: archiveReminder.reminderEveryNTurns,
    }
    let action = null
    let resetForRead = false
    const dropping = prev !== undefined && baselineFresh && prev - percent >= archiveReminder.dropThreshold
    if (manualPending) {
      // Manual compaction takes priority over the automatic drop/read branch:
      // it carries the concrete archive location the agent must read first.
      action = 'manual-read'
    } else if (s.pendingRead === true) {
      action = 'read'
      resetForRead = true
    } else if (dropping) {
      action = 'read'
      resetForRead = true
    } else if (s.phase !== 'archive' && percent >= archiveReminder.archiveThreshold) {
      action = 'create'
    } else if (s.phase === 'archive' && percent >= archiveReminder.archiveThreshold) {
      if (turnNumber === null || !Number.isInteger(s.lastReminderTurn)
        || turnNumber - s.lastReminderTurn >= archiveReminder.reminderEveryNTurns) {
        action = 'remind'
      }
    } else if (s.phase === 'archive' && percent < archiveReminder.archiveThreshold) {
      s.phase = 'idle'
      s.cycle = false
      s.archiveTurn = null
      s.lastReminderTurn = null
    }

    if (action !== null) {
      if (archiveHasContextMeterReminder(agent)) {
        s.lastDedupeReason = 'context-meter'
        if (resetForRead) {
          s.pendingRead = true
          s.pendingReadKind = 'drop'
          s.phase = 'idle'
          s.cycle = false
          s.archiveTurn = null
          s.lastReminderTurn = null
        } else if (manualPending) {
          s.pendingRead = true
          s.pendingReadKind = 'manual'
        }
      } else {
        const templateKey = action === 'manual-read' ? 'manualRead' : action
        const injected = injectText(
          agent,
          renderArchiveTemplate(archiveReminder.templates[templateKey], values),
          'archive-' + action,
        )
        if (injected) {
          s.lastAction = action
          s.lastDedupeReason = null
          s.lastInjectedAt = nowIso
          if (action === 'create') {
            s.phase = 'archive'
            s.cycle = true
            s.archiveTurn = turnNumber
            s.lastReminderTurn = turnNumber
            s.archiveCreatedAt = nowIso
            s.lastRemindPercent = percent
          } else if (action === 'remind') {
            s.lastReminderTurn = turnNumber
            s.lastRemindPercent = percent
          } else if (action === 'read') {
            s.phase = 'idle'
            s.cycle = false
            s.archiveTurn = null
            s.lastReminderTurn = null
            s.pendingRead = false
            s.pendingReadKind = null
            s.lastRemindPercent = undefined
          } else if (action === 'manual-read') {
            s.phase = 'idle'
            s.cycle = false
            s.archiveTurn = null
            s.lastReminderTurn = null
            s.pendingRead = false
            s.pendingReadKind = null
            s.lastRemindPercent = undefined
            s.lastManualReadAt = nowIso
          }
        } else if (resetForRead) {
          s.pendingRead = true
          s.pendingReadKind = 'drop'
        } else if (manualPending) {
          s.pendingRead = true
          s.pendingReadKind = 'manual'
        }
      }
    }

    if (turnNumber !== null) s.lastTurn = turnNumber
    s.lastPercent = percent
    s.updatedAt = nowIso
    save()
  }

  const install = (agent) => {
    const key = agent.session.id
    if (disposers.has(key)) return
    state.set(key, normalizeArchiveSessionState(state.get(key) ?? { phase: 'idle', cycle: false }))
    let dispose
    try {
      dispose = agent.ctx.on('agent/turn-stopping', payload => {
        // Delegation advisor first (fully fail-open), then problem-loop (shares
        // its turn dedupe key; never a second reminder), then archive reminders.
        try {
          delegationAdvisor.handleTurnStopping(payload)
        } catch (error) {
          try {
            ctx.logger.warn('[team-hooks2] delegation-advisor escaped (ignored): ' + errorText(error))
          } catch {
            // ignore
          }
        }
        try {
          problemLoop.handleTurnStopping(payload)
        } catch (error) {
          try {
            ctx.logger.warn('[team-hooks2] problem-loop escaped (ignored): ' + errorText(error))
          } catch {
            // ignore
          }
        }
        const percent = measurePercent(agent)
        if (percent === null) return
        try {
          evaluate(agent, percent, payload !== null && typeof payload === 'object' ? payload.turn : undefined)
        } catch (error) {
          try {
            ctx.logger.warn('[team-hooks2] archive reminder escaped (ignored): ' + errorText(error))
          } catch {
            // ignore
          }
        }
      })
    } catch (error) {
      ctx.logger.warn('[team-hooks2] failed to attach listener for ' + key + ': ' + String(error))
      return
    }
    disposers.set(key, dispose)
    ctx.logger.info('[team-hooks2] archive listener attached session=' + key)
  }

  ctx.on('agent/created', ({ agent }) => { install(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    const key = agent.session.id
    const dispose = disposers.get(key)
    if (dispose === undefined) return
    disposers.delete(key)
    try { dispose() } catch { /* already gone with the agent context */ }
  })

  const agents = ctx.get('agents')
  if (agents !== undefined) {
    for (const agent of agents.list()) install(agent)
  }

  // ---- diagnostic tool ---------------------------------------------------
  ctx.tools.register({
    name: 'team_hooks_status',
    description:
      'Report the team-hooks state for the calling session: measured context percent, archive-loop state '
      + '(phase/cycle/archiveTurn/lastReminderTurn/pendingRead/pendingReadKind/lastAction/archivePath/'
      + 'lastManualCompactAt), and whether the turn-stopping listener is attached. Attaches the listener on '
      + 'call (self-heal), so calling this tool proves the hook can be attached. Read-only otherwise. Capability '
      + 'index: skill("team-bootstrap") §2 / CAPABILITY_AUDIT.md.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('team_hooks_status requires an Agent-backed session')
      install(agent)
      const s = normalizeArchiveSessionState(state.get(agent.session.id) ?? { phase: 'idle', cycle: false })
      const percent = measurePercent(agent)
      return {
        session: agent.session.id,
        percent: percent === null ? null : percent,
        cycle: s.cycle === true,
        lastPercent: typeof s.lastPercent === 'number' ? s.lastPercent : null,
        lastRemindPercent: typeof s.lastRemindPercent === 'number' ? s.lastRemindPercent : null,
        archiveReminder: {
          enabled: archiveReminder.enabled,
          archiveThreshold: archiveReminder.archiveThreshold,
          reminderEveryNTurns: archiveReminder.reminderEveryNTurns,
          dropThreshold: archiveReminder.dropThreshold,
          phase: s.phase,
          cycle: s.cycle === true,
          archiveTurn: Number.isInteger(s.archiveTurn) ? s.archiveTurn : null,
          lastReminderTurn: Number.isInteger(s.lastReminderTurn) ? s.lastReminderTurn : null,
          lastTurn: Number.isInteger(s.lastTurn) ? s.lastTurn : null,
          archiveCreatedAt: typeof s.archiveCreatedAt === 'string' ? s.archiveCreatedAt : null,
          lastAction: typeof s.lastAction === 'string' ? s.lastAction : null,
          lastDedupeReason: typeof s.lastDedupeReason === 'string' ? s.lastDedupeReason : null,
          lastInjectedAt: typeof s.lastInjectedAt === 'string' ? s.lastInjectedAt : null,
          pendingRead: s.pendingRead === true,
          pendingReadKind: typeof s.pendingReadKind === 'string' ? s.pendingReadKind : null,
          archivePath: typeof s.archivePath === 'string' ? s.archivePath : null,
          lastManualCompactAt: typeof s.lastManualCompactAt === 'string' ? s.lastManualCompactAt : null,
          lastManualCompactSeq: Number.isInteger(s.lastManualCompactSeq) ? s.lastManualCompactSeq : null,
          templates: Object.keys(archiveReminder.templates),
        },
        listener: disposers.has(agent.session.id),
        stateFile,
        roleWritePolicy: {
          enabled: roleWritePolicy.enabled,
          mode: roleWritePolicy.mode,
          denyRoles: roleWritePolicy.denyRoles,
          denyTools: roleWritePolicy.denyTools,
          allowSegments: roleWritePolicy.allowSegments,
        },
        delegationAdvisor: delegationAdvisor.status(agent),
        problemLoop: problemLoop.status(agent),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Team hooks status', kind: 'read' }),
  })

  // ---- post-execute: problem-loop failure observation (fail-open) ----------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      problemLoop.recordToolResult(exec, result)
    } catch (error) {
      try {
        ctx.logger.warn('[team-hooks2] problem-loop record escaped (ignored): ' + errorText(error))
      } catch {
        // ignore
      }
    }
    // task-92: record agent write/edit targets named ARCHIVE_*.md (path basis
    // for the manual-compaction reminder). Fully fail-open.
    observeArchivePath(exec)
    return next()
  })

  // ---- pre-execute waterfall: role write policy + dispatch guard ----------
  const GUARDED = new Set(['send_message', 'spawn_teammate'])

  ctx.on('tools/pre-execute', async (exec, next) => {
    // 0) Delegation advisor counter: cumulative per-turn tool metrics.
    //    Counting never changes the decision and is fully fail-open.
    try {
      delegationAdvisor.recordToolCall(exec)
    } catch (error) {
      try {
        ctx.logger.warn('[team-hooks2] delegation-advisor counter escaped (ignored): ' + errorText(error))
      } catch {
        // ignore
      }
    }

    // 1) Write gate (F1/task-33, default off): observe write-class targets and
    //    backup visibility, append a JSONL audit row; only the explicit
    //    dangerous-path deny can block. Ownership: backups belong to
    //    dsh-auto-backup — this gate never creates/prunes one. Errors fail open.
    if (writeGate.enabled) {
      try {
        const gateDecision = judgeWriteGate(ctx, exec, writeGate, writeGateDedupe)
        if (gateDecision !== null) return gateDecision
      } catch (error) {
        try {
          ctx.logger.warn('[team-hooks2] write-gate error (fail-open): ' + errorText(error))
        } catch {
          // ignore
        }
      }
    }

    // 2) Role-based write policy: read-only roles may not edit/write project
    // files. `judgeRoleWritePolicy` returns null on every allow/fail-open path;
    // an internal error is fail-open too, so a policy bug can never block every
    // write in the Host (the deny protocol itself is verified: PreToolDecision
    // `{kind:'deny', reason}` — the dispatch guard below already uses it).
    if (roleWritePolicy.enabled) {
      try {
        const roleDecision = judgeRoleWritePolicy(ctx, exec, roleWritePolicy, roleWriteDedupe)
        if (roleDecision !== null) return roleDecision
      } catch (error) {
        try {
          ctx.logger.warn('[team-hooks2] role-write-policy error (fail-open): ' + errorText(error))
        } catch {
          // ignore
        }
      }
    }

    // 3) Dispatch guard before send_message / spawn_teammate.
    if (!GUARDED.has(exec.name)) return next()
    const team = ctx.get('agentTeams')
    const caller = exec.agent
    if (team === undefined || caller === undefined) return next()
    let members
    try {
      members = team.listMembers(caller)
    } catch {
      return next()
    }
    const names = members.map(member => member.name)
    const known = new Set([...names, ...members.map(member => String(member.id))])
    const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}

    if (exec.name === 'send_message') {
      const target = typeof args.target === 'string'
        ? args.target
        : typeof args.agent_id === 'string' ? args.agent_id : undefined
      if (target === undefined || target === '') return next()
      if (known.has(target)) {
        ctx.logger.info('[team-hooks2] dispatch allow name=send_message target=' + target)
        return next()
      }
      return {
        kind: 'deny',
        reason: '[team-hooks2] 派活校验：目标 ' + JSON.stringify(target)
          + ' 不在当前团队成员名单中（可用：' + names.join(', ') + '）。请先用 list_agents 核对再发。',
      }
    }

    const name = args.name
    if (typeof name === 'string' && names.includes(name)) {
      return {
        kind: 'deny',
        reason: '[team-hooks2] 派活校验：成员 ' + JSON.stringify(name)
          + ' 已存在，不能重复 spawn（可用：' + names.join(', ') + '）。',
      }
    }
    ctx.logger.info('[team-hooks2] dispatch allow name=spawn_teammate target=' + String(name))
    return next()
  })

  ctx.effect(() => () => {
    clearTimeout(saveTimer)
    for (const dispose of disposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    disposers.clear()
  })
}
