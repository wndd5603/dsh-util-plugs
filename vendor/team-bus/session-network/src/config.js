/** Self-managed JSON config for dsh-session-network (no schemastery; see INTERFACES_v1 §1). */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'

export const CONFIG_DIR_NAME = 'session-network'

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  dataDir: null,
  dataDirAck: { acknowledgedAt: null, dir: null },
  autoInject: { enabled: true, pointerTemplateVersion: 1 },
  agvAsk: { enabled: true, timeoutMs: 30000 },
  alias: { autoDerive: true, maxRename: 2, historyHours: 72 },
  delegation: { shadow: true, minLines: 150, minBytes: 8192, minInputFiles: 3 },
  audit: { hotDays: 90, aggregateMonths: 12 },
  meeting: { defaultDeadlineHours: 24 },
})

export function configDir(profileDir) {
  return join(profileDir, CONFIG_DIR_NAME)
}

export function configPath(profileDir) {
  return join(configDir(profileDir), 'config.json')
}

export function resolveDataDir(profileDir, config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim()
  return join(profileDir, 'data', CONFIG_DIR_NAME)
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = Array.isArray(base) ? [] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value
  }
  return out
}

/** Read config; missing/corrupt file falls back to defaults (fail-safe, audited by caller via warning). */
export function readConfig(profileDir) {
  const file = configPath(profileDir)
  try {
    if (!existsSync(file)) return { config: structuredClone(DEFAULT_CONFIG), source: 'default', path: file }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config is not an object')
    return { config: deepMerge(structuredClone(DEFAULT_CONFIG), parsed), source: 'file', path: file }
  } catch (error) {
    return { config: structuredClone(DEFAULT_CONFIG), source: 'fallback', path: file, error: String(error) }
  }
}

/** Validate a configured dataDir: absolute, not the profile config dir, parent writable. */
export function validateDataDir(profileDir, dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return { ok: true }
  const value = dataDir.trim()
  if (!isAbsolute(value)) return { ok: false, error: 'dataDir must be an absolute path' }
  const cfgDir = configDir(profileDir)
  if (value === cfgDir || value.startsWith(cfgDir + sep)) return { ok: false, error: 'dataDir must not be the plugin config directory' }
  try {
    if (existsSync(value)) {
      const stat = statSync(value)
      if (!stat.isDirectory()) return { ok: false, error: 'dataDir exists and is not a directory' }
      accessSync(value, constants.W_OK)
    } else {
      // Validation must be zero-write (F11 dry-run): check the nearest existing parent instead of creating.
      const parent = dirname(value)
      if (!existsSync(parent)) return { ok: false, error: 'dataDir parent does not exist' }
      accessSync(parent, constants.W_OK)
    }
    return { ok: true, path: value }
  } catch (error) {
    return { ok: false, error: 'dataDir is not writable: ' + String(error) }
  }
}

/** Atomic config write (tmp+rename); creates the config dir when needed. */
export function writeConfig(profileDir, patch) {
  const { config } = readConfig(profileDir)
  const next = deepMerge(config, patch ?? {})
  if (next.dataDir !== null && next.dataDir !== undefined) {
    const validation = validateDataDir(profileDir, next.dataDir)
    if (!validation.ok) throw new Error(validation.error)
  }
  const file = configPath(profileDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return { config: next, path: file }
}
