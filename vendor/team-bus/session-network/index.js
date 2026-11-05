/**
 * dsh-session-network host plugin (P0 skeleton).
 * Tools/registry/injection are mounted globally; every optional module is loaded
 * lazily and any failure falls back to a degraded, non-blocking behaviour.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDataDir, readConfig } from './src/config.js'
import { readLiveAgents, registerTools } from './src/tools.js'
import { boolean, number, string, defaultsOf, objectSchema } from '../lib/standard-schema.js'

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1, zero dependency). The host
 * validates and normalizes this before `apply`; all keys are optional. The
 * richer session-network config (autoInject/delegation/audit/meeting) lives in
 * `<profileDir>/session-network/config.json` and is edited via the CLI
 * (`session-network config get|set`) or its runtime switch in `state.json`.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the network tools/injector. false = plugin loads but does nothing.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  profileDir: string('', { description: 'Absolute profile directory override (default: host profileContext dir, then DSH_PROFILE_DIR).' }),
  dataDir: string('', { description: 'Absolute data directory override for the SQLite registry (default: <profileDir>/data/session-network).' }),
  globalFallback: boolean(true, { description: 'When the workspace has no team/pipe2/PEERS.json, fall back to the host-wide live-session registry for discovery (zero-config first use). Set false for strict workspace-only privacy.' }),
}, { description: 'Cross-session network plugin configuration (plugin-level only).', schemaVersion: 1 })

export const inject = ['tools']

const log = (ctx, ...args) => {
  try {
    ctx.logger?.info?.('[session-network]', ...args)
  } catch {
    // logging must never break plugin startup
  }
}

const SKILLS_DIR = new URL('./skills/', import.meta.url)

/**
 * Minimal YAML frontmatter reader for bundled SKILL.md files: only `name` and
 * `description` are used. Supports inline values and the folded `>-` / literal
 * `|` block styles; malformed frontmatter degrades to the directory name.
 */
export function readSkillFrontmatter(text, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: fallbackName, description: '' }
  const lines = match[1].split(/\r?\n/)
  let name = fallbackName
  const descriptionLines = []
  let capturing = false
  for (const line of lines) {
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch !== null) { name = nameMatch[1].trim(); capturing = false; continue }
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
  return { name, description: descriptionLines.join(' ').trim() }
}

/** Read every bundled skill directory, fail-safe per entry. */
export function readBundledSkills(ctx) {
  const skills = []
  try {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const file = new URL('./' + entry.name + '/SKILL.md', SKILLS_DIR)
        const content = readFileSync(file, 'utf8')
        const meta = readSkillFrontmatter(content, entry.name)
        skills.push({ name: meta.name, description: meta.description, content })
      } catch (error) {
        log(ctx, 'bundled skill read failed:', entry.name, String(error))
      }
    }
  } catch (error) {
    log(ctx, 'bundled skills directory unavailable:', String(error))
  }
  return skills
}

/**
 * Publish the bundled skills through the host skills service (soft dependency:
 * when the service is not visible, skills can still be installed manually —
 * this never blocks plugin startup).
 */
export function registerBundledSkills(ctx) {
  let service
  try { service = ctx.get?.('skills') } catch { service = undefined }
  if (service === undefined || typeof service.register !== 'function') {
    log(ctx, 'skills service unavailable; bundled skills not registered (install manually or expose ctx.skills)')
    return []
  }
  const registered = []
  for (const skill of readBundledSkills(ctx)) {
    try {
      service.register({
        name: skill.name,
        source: 'runtime',
        description: skill.description === '' ? skill.name : skill.description,
        whenToUse: skill.description === '' ? undefined : skill.description.slice(0, 280),
        content: skill.content,
      })
      registered.push(skill.name)
    } catch (error) {
      log(ctx, 'bundled skill register failed:', skill.name, String(error))
    }
  }
  return registered
}

export function resolveProfileDir(ctx, config) {
  const fromConfig = typeof config?.profileDir === 'string' ? config.profileDir.trim() : ''
  if (fromConfig !== '') return fromConfig
  try {
    const fromCtx = ctx.get?.('profileContext')?.dir
    if (typeof fromCtx === 'string' && fromCtx.trim() !== '') return fromCtx.trim()
  } catch {
    // fall through
  }
  const fromEnv = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  return fromEnv !== '' ? fromEnv : null
}

async function loadOptional(path) {
  try {
    return await import(path)
  } catch {
    return undefined
  }
}

export async function apply(ctx, config = {}) {
  const rowConfig = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  if (rowConfig.enabled === false) {
    log(ctx, 'disabled by config (enabled=false); no tools/injector registered')
    return
  }
  // Bundled skills are registered at runtime when the host skills service is
  // visible, so a moved install directory can never silently lose them.
  const bundledSkills = registerBundledSkills(ctx)
  if (bundledSkills.length > 0) log(ctx, 'bundled skills registered:', bundledSkills.join(','))
  const profileDir = resolveProfileDir(ctx, rowConfig)
  if (profileDir === null) {
    // No profile context: never write into cwd. Register tools in degraded read-only mode.
    log(ctx, 'profileContext unavailable; degraded read-only mode (no config/data writes)')
    const fallbackConfig = { schemaVersion: 1, dataDir: null, autoInject: { enabled: false } }
    registerTools(ctx, { config: fallbackConfig, profileDir: null, dataDir: null, source: 'unavailable', modules: {}, audit: () => {}, logger: ctx.logger })
    return
  }
  const { config: cfg, source, error } = readConfig(profileDir)
  if (error) log(ctx, 'config fallback:', error)
  const rowDataDir = typeof rowConfig.dataDir === 'string' && rowConfig.dataDir.trim() !== ''
    ? resolve(rowConfig.dataDir.trim())
    : null
  const dataDir = rowDataDir ?? resolveDataDir(profileDir, cfg)

  let auditDb = null
  const AUDIT_META_KEYS = ['source', 'reason', 'idempotency', 'briefStore', 'injectionReason', 'markFailed', 'markerHeal', 'healCount', 'section', 'count', 'alias', 'code', 'resultKeys', 'pointerLines', 'pointerChars', 'templateVersion', 'sessionKind', 'turn', 'step']
  const pickAuditMeta = record => {
    const meta = { source: 'session-network' }
    if (record === null || typeof record !== 'object') return meta
    for (const key of AUDIT_META_KEYS) {
      const value = record[key]
      if (value === null || value === undefined) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') meta[key] = value
      else if (Array.isArray(value) && value.every(item => typeof item === 'string')) meta[key] = value
    }
    return meta
  }

  const audit = record => {
    try {
      log(ctx, 'audit', JSON.stringify(record))
      if (typeof modules.db?.openDb === 'function' && dataDir !== null) {
        if (auditDb === null) auditDb = modules.db.openDb({ dataDir })
        modules.db.useDb?.(auditDb)
        modules.db.insertAudit?.({
          at: new Date().toISOString(),
          actor: record?.caller ?? { sessionId: record?.sessionId ?? null, displayName: record?.displayName ?? null, roleName: record?.roleName ?? null },
          action: typeof record?.action === 'string' ? record.action : 'event',
          target: typeof record?.target === 'string' ? record.target : null,
          result: typeof record?.result === 'string' ? record.result : 'ok',
          meta: pickAuditMeta(record),
        })
      }
    } catch {
      // audit must never break the plugin
    }
  }

  const modules = {
    db: await loadOptional('./src/db.js'),
    state: await loadOptional('./src/state.js'),
    inject: await loadOptional('./src/inject.js'),
    networkInfo: await loadOptional('./src/network-info.js'),
    pitfalls: await loadOptional('./src/pitfalls.js'),
  }

  // Initialize state.json so the documented default (autoInject enabled) is the effective value,
  // while state.js keeps its fail-safe (missing/corrupt => disabled) semantics.
  try {
    if (dataDir !== null && modules.state?.writeState) {
      const stateFile = join(dataDir, 'state.json')
      if (!existsSync(stateFile)) {
        mkdirSync(dataDir, { recursive: true })
        modules.state.writeState(dataDir, { autoInject: { enabled: cfg.autoInject.enabled } })
        audit({ action: 'state_init', enabled: cfg.autoInject.enabled })
      }
    }
  } catch (error3) {
    log(ctx, 'state init failed (fail-open):', String(error3))
  }

  registerTools(ctx, { config: cfg, profileDir, dataDir, source, modules, audit, logger: ctx.logger })

  // Injector is best-effort: absence of a module or a hook API must not break the host.
  try {
    if (modules.inject?.createInjector) {
      // Persisted idempotency (R3): sessions.briefed_at via db briefStore when available.
      let injectorDb = null
      let briefStore
      try {
        if (modules.db?.openDb && dataDir !== null) {
          injectorDb = modules.db.openDb({ dataDir })
          if (typeof modules.db.getSessionBrief === 'function' && typeof modules.db.markBriefed === 'function') {
            briefStore = {
              isBriefed: sessionId => {
                modules.db.useDb?.(injectorDb)
                const brief = modules.db.getSessionBrief(sessionId)
                return Boolean(brief?.briefedAt ?? brief?.briefed_at ?? brief?.isBriefed)
              },
              markBriefed: ({ sessionId, reason, at }) => {
                modules.db.useDb?.(injectorDb)
                return modules.db.markBriefed({ sessionId, reason, at })
              },
            }
          }
        }
      } catch (error4) {
        log(ctx, 'briefStore unavailable (fail-open, log-scan fallback):', String(error4))
        briefStore = undefined
      }
      const injector = modules.inject.createInjector({
        getConfig: () => readConfig(profileDir).config,
        getState: () => (modules.state?.readState ? modules.state.readState(dataDir) : { autoInject: { enabled: false } }),
        hasProfileContext: () => true,
        networkAvailable: session => {
          try {
            const cwd = session?.header?.cwd ?? session?.cwd ?? session?.workspaceDir
            if (typeof cwd !== 'string' || cwd === '') return undefined
            return existsSync(join(cwd, 'team', 'pipe2', 'PEERS.json'))
          } catch {
            return undefined
          }
        },
        briefStore,
        recordSessionKind: (sessionId, kind) => {
          try {
            if (injectorDb === null || typeof modules.db?.upsertSession !== 'function') return
            modules.db.useDb?.(injectorDb)
            modules.db.upsertSession({ sessionId, kind })
          } catch { /* advisory */ }
        },
        getSessionKind: (sessionId) => {
          try {
            if (injectorDb === null || typeof modules.db?.getSession !== 'function') return undefined
            modules.db.useDb?.(injectorDb)
            return modules.db.getSession(sessionId)?.kind
          } catch {
            return undefined
          }
        },
        heartbeat: ({ sessionId, at }) => {
          try {
            if (injectorDb === null || typeof modules.db?.upsertHeartbeat !== 'function') return
            modules.db.useDb?.(injectorDb)
            modules.db.upsertHeartbeat({ sessionId, at })
          } catch { /* heartbeat is advisory; fail-open */ }
        },
        audit,
        logger: ctx.logger,
        now: () => new Date(),
      })
      try {
        ctx.on?.('dispose', () => {
          if (injectorDb !== null) {
            try { modules.db.closeDb?.(injectorDb) } catch { /* best-effort */ }
            injectorDb = null
          }
        })
      } catch { /* dispose optional */ }
      ctx.on?.('agent/pre-step', injector.handler)
      log(ctx, 'injector registered')
    } else {
      log(ctx, 'injector module not present; injection disabled (fail-open)')
    }
  } catch (error2) {
    log(ctx, 'injector registration failed (fail-open):', String(error2))
  }

  log(ctx, 'plugin ready; version=', PLUGIN_VERSION, 'profileDir=', profileDir, 'dataDir=', dataDir, 'configSource=', source)
}

export { readLiveAgents }
