/**
 * dsh-workbench-bundle meta-bundle runtime entry.
 *
 * The meta bundle's 3 vendored patches provide the 7 component rows. This
 * package's own row adds exactly two UX affordances and no business logic:
 *
 * 1. `workbench_status` — one read-only tool that reports, for every release
 *    package: installed / version / enabled-in-profile / LICENSE presence /
 *    whether the running module matches the file currently on disk (`stale`).
 *    This is the answer to "is the plugin actually loaded, and is my fix live?"
 *    that the host's read-only plugin inventory does not provide.
 * 2. A one-time first-turn pointer injected through `agent/pre-step` (≤3 lines):
 *    what the workbench provides, how to read a message body, and where the
 *    status/disable switches are. Durable dedupe via a session-log marker, so
 *    resume/fork/compaction never re-inject.
 *
 * Zero npm imports; no network, no shell.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boolean, number, string, defaultsOf, objectSchema, fieldDocs } from './lib/standard-schema.js'

export const inject = ['tools']

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1, zero dependency).
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the workbench_status tool and the first-turn pointer.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  pointer: boolean(true, { description: 'Inject a one-time (≤3 line) capability pointer into each new session.' }),
  statusTool: boolean(true, { description: 'Register the read-only workbench_status tool.' }),
  pointerText: string('', { description: 'Optional override for the pointer body (empty = built-in text, max 400 chars).' }),
}, { description: 'Meta-bundle UX entry configuration (pointer + status tool).', schemaVersion: 1 })

const BRIEF_KIND = 'agent-workbench-brief'
const BRIEF_VERSION = 1
const MAX_POINTER_CHARS = 400

/** Release packages this meta bundle is expected to install/see. */
const KNOWN_PACKAGES = [
  { name: 'dsh-context-sentinel', entries: ['context-meter/index.js', 'team-hooks2/index.js'] },
  { name: 'dsh-agent-workflows', entries: ['captain-preset/plugin.js', 'prompt-architect/index.js'] },
  { name: 'dsh-team-bus', entries: ['session-network/index.js', 'message-bus/index.js'] },
  { name: 'dsh-message-bus', entries: ['index.js'] },
  { name: 'dsh-workbench-bundle', entries: ['plugin.js'] },
]

/* ------------------------------------------------------------------ helpers */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function packageDirOf(nodeModulesDir, name) {
  try {
    return join(nodeModulesDir, ...name.split('/'))
  } catch {
    return null
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Resolve the profile directory defensively (host service → env). */
export function resolveProfileDir(ctx) {
  try {
    const dir = ctx?.get?.('profileContext')?.dir
    if (typeof dir === 'string' && dir.trim() !== '') return dir.trim()
  } catch { /* fall through */ }
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const profileName = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
    ? process.env.DSH_PROFILE
    : 'web'
  return join(dshHome(), 'profiles', profileName)
}

/** Build the one-time first-turn pointer text (≤3 lines, ≤400 chars). */
export function createPointerText(config = {}) {
  const configured = typeof config.pointerText === 'string' ? config.pointerText.trim() : ''
  const text = configured !== ''
    ? configured
    : [
      '[agent-workbench] DSH agent workbench 已启用（上下文守卫 + 工作流预设 + 团队总线）。',
      '能力：context_usage/context_guard_status 看上下文；team_hooks_status 看团队 hooks；message_* 收发跨会话消息（信封里用 message_read 取正文）；network_info 看交流网。',
      '状态/开关：workbench_status() 查看版本/健康/开关；关闭组件用其 row id 的 config.enabled=false；不要同时安装组件包与元包。',
    ].join('\n')
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3)
  let normalized = lines.join('\n')
  if (normalized.length > MAX_POINTER_CHARS) normalized = normalized.slice(0, MAX_POINTER_CHARS).trimEnd()
  return normalized
}

function createBriefMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: BRIEF_KIND, version: BRIEF_VERSION }),
  })
}

/** True when one message is this plugin's durable brief marker. */
export function isBriefMessage(message) {
  return isPlainObject(message) && isPlainObject(message.source) && message.source.kind === BRIEF_KIND
}

/** Best-effort committed-event scan (same access paths as the host API). */
function collectSessionEvents(session) {
  if (!isPlainObject(session)) return undefined
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch { /* fall through */ }
  try {
    if (Array.isArray(session.events)) return session.events
  } catch { /* fall through */ }
  return undefined
}

function sessionHasBrief(session) {
  const events = collectSessionEvents(session)
  if (events === undefined) return undefined
  return events.some(event => isPlainObject(event) && event.type === 'user/message' && isBriefMessage(event.data))
}

/* -------------------------------------------------------------- status tool */

/** Read-only package/health facts for the status tool (never throws). */
export function buildStatus(ctx, config, snapshot) {
  const profileDir = resolveProfileDir(ctx)
  const profile = readJson(join(profileDir, 'package.json'))
  const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
  const nodeModules = join(profileDir, 'node_modules')
  const packages = KNOWN_PACKAGES.map((known) => {
    const dir = packageDirOf(nodeModules, known.name)
    const manifest = dir === null ? null : readJson(join(dir, 'package.json'))
    const installed = manifest !== null
    const changed = []
    if (installed && snapshot !== undefined) {
      const before = snapshot.get(known.name)
      const current = {
        packageJson: sha256File(join(dir, 'package.json')),
        entries: Object.fromEntries(known.entries.map(entry => [entry, sha256File(join(dir, entry))])),
      }
      if (before !== undefined) {
        if (before.packageJson !== current.packageJson) changed.push('package.json')
        for (const entry of known.entries) {
          if (before.entries[entry] !== current.entries[entry]) changed.push(entry)
        }
      }
    }
    return {
      name: known.name,
      installed,
      version: installed && typeof manifest.version === 'string' ? manifest.version : null,
      enabledInProfile: bundles.includes(known.name),
      license: installed && existsSync(join(dir, 'LICENSE')),
      entries: installed ? known.entries.filter(entry => existsSync(join(dir, entry))) : [],
      stale: changed.length > 0,
      changed,
    }
  })
  const dataHome = dshHome()
  const dataFacts = {
    messageBusDb: fileFacts(join(dataHome, 'message-bus', 'bus.sqlite')),
    restartAudit: fileFacts(join(dataHome, 'restart', 'audit.jsonl')),
  }
  return {
    ok: true,
    plugin: 'dsh-workbench-bundle',
    version: PLUGIN_VERSION,
    enabled: config.enabled !== false,
    profileDir,
    profile: { bundles: bundles.length, bundlesWithLocal: bundles.filter(name => typeof name === 'string' && name.startsWith('@local/')).length },
    packages,
    stalePackages: packages.filter(item => item.stale).map(item => item.name),
    data: dataFacts,
    pointer: {
      enabled: config.pointer !== false,
      kind: BRIEF_KIND,
      lines: createPointerText(config).split('\n').length,
      chars: createPointerText(config).length,
    },
    tools: { workbench_status: config.statusTool !== false },
    config: { defaults: defaultsOf(Config), fields: fieldDocs(Config) },
  }
}

function fileFacts(file) {
  try {
    if (!existsSync(file)) return { path: file, exists: false, bytes: null }
    return { path: file, exists: true, bytes: statSync(file).size }
  } catch {
    return { path: file, exists: false, bytes: null }
  }
}

/** Snapshot hashes at load time, used to flag "running module differs from disk". */
export function createSnapshot(ctx) {
  const profileDir = resolveProfileDir(ctx)
  const nodeModules = join(profileDir, 'node_modules')
  const snapshot = new Map()
  for (const known of KNOWN_PACKAGES) {
    const dir = packageDirOf(nodeModules, known.name)
    if (dir === null || !existsSync(join(dir, 'package.json'))) continue
    snapshot.set(known.name, {
      packageJson: sha256File(join(dir, 'package.json')),
      entries: Object.fromEntries(known.entries.map(entry => [entry, sha256File(join(dir, entry))])),
    })
  }
  return snapshot
}

/* ------------------------------------------------------------------- apply */

/**
 * One `agent/pre-step` listener. Runs the downstream waterfall first, then
 * prepends the brief when the session does not already carry the durable
 * marker. Never throws into the pre-step path.
 */
export function createPreStepHandler(getConfig, logger) {
  const injectedThisProcess = new WeakSet()

  return async function handler(first, next) {
    const isPayload = isPlainObject(first) && isPlainObject(first.agent) && Array.isArray(first.messages)
    if (!isPayload) {
      // Unknown/legacy invocation shape: never interfere.
      return typeof next === 'function' ? next() : first
    }
    let decision
    // Run the downstream waterfall first; its failures are not ours.
    decision = typeof next === 'function' ? await next() : undefined
    try {
      const config = getConfig()
      if (config.enabled === false || config.pointer === false) return decision
      if (isPlainObject(decision) && decision.kind === 'reject') return decision
      const claimed = first.messages
      if (claimed.some(isBriefMessage)) return decision
      const agent = first.agent
      const session = isPlainObject(agent.session) ? agent.session : undefined
      if (session !== undefined) {
        if (injectedThisProcess.has(session)) return decision
        const durable = sessionHasBrief(session)
        if (durable === true) return decision
        if (durable === false) injectedThisProcess.add(session)
      }
      const text = createPointerText(config)
      if (text === '') return decision
      const downstream = Array.isArray(decision?.messages) ? decision.messages : []
      return { ...(isPlainObject(decision) ? decision : {}), messages: [createBriefMessage(text), ...downstream] }
    } catch (error) {
      try { logger?.warn?.('[agent-workbench] pointer injection failed (fail-open): ' + String(error)) } catch { /* best effort */ }
      return decision
    }
  }
}

export function apply(ctx, config) {
  config = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[agent-workbench] disabled by config (enabled=false); no status tool/pointer registered')
    return
  }
  const snapshot = createSnapshot(ctx)
  let currentConfig = config
  if (config.statusTool !== false) {
    ctx.tools.register({
      name: 'workbench_status',
      description:
        'Read-only status of the DSH agent workbench meta bundle: per-package installed version / enabled-in-profile / '
        + 'LICENSE / whether the loaded module differs from the file on disk (stale, useful right after an upgrade), '
        + 'known data file sizes, the first-turn pointer settings and the effective config. Use it to verify what is '
        + 'actually loaded before blaming a component. Capability index: skill("team-bootstrap") §2 / '
        + 'CAPABILITY_AUDIT.md.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        return buildStatus(ctx, currentConfig, snapshot)
      },
      presentCall: () => ({ card: 'generic', title: 'Workbench status', kind: 'read' }),
    })
  }
  if (config.pointer !== false) {
    ctx.on?.('agent/pre-step', createPreStepHandler(() => currentConfig, ctx.logger))
  }
  ctx.logger?.info?.('[agent-workbench] v' + PLUGIN_VERSION + ' ready pointer=' + (config.pointer !== false)
    + ' statusTool=' + (config.statusTool !== false) + ' profileDir=' + resolveProfileDir(ctx))
}
