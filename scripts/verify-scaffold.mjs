#!/usr/bin/env node
// Static verification for the dsh-plugs release scaffold. Run from the repo root:
//   node scripts/verify-scaffold.mjs
// It never installs, pushes or starts a host.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const read = rel => readFileSync(join(root, rel), 'utf8')
const exists = rel => existsSync(join(root, rel))

const EXPECTED_VERSION = '2026.11.5-1'
const pkg = JSON.parse(read('package.json'))
check(pkg.name === 'dsh-plugs', 'package name must be dsh-plugs')
check(pkg.version === EXPECTED_VERSION, 'package version must be ' + EXPECTED_VERSION)
check(pkg.license === 'MIT', 'license must be MIT')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at cordis.patch.yml')
check((pkg.dependencies ?? {}) && Object.keys(pkg.dependencies ?? {}).length === 0, 'bundle must have no npm dependencies')
check(Array.isArray(pkg.files) && pkg.files.includes('vendor'), 'files whitelist must include vendor')
for (const doc of ['CAPABILITY_AUDIT.md', 'OPERATOR_ONLY_BOUNDARIES.md', 'PRIVACY.md', 'PUBLISHING.md']) {
  check(pkg.files.includes(doc), 'files whitelist must include ' + doc)
  check(exists(doc), 'missing public doc ' + doc)
}

const patch = read('cordis.patch.yml')
const ids = [...patch.matchAll(/^\s*- id: ([a-z0-9-]+)/gmu)].map(match => match[1])
const expected = ['context-sentinel', 'message-bus', 'team-bus', 'agent-workflows', 'workbench-bundle', 'auto-backup', 'host-relaunch']
check(ids.length === 7, 'bundle patch must insert exactly 7 rows, got ' + String(ids.length))
check(JSON.stringify(ids) === JSON.stringify(expected), 'row ids/order mismatch: ' + JSON.stringify(ids))
check(new Set(ids).size === ids.length, 'row ids must be unique')
const rootRows = [...patch.matchAll(/^\s*- id: [a-z0-9-]+\n\s+name: dsh-plugs$/gmu)]
check(rootRows.length === 1, 'exactly one row must mount the package root (dsh.client visibility), got ' + String(rootRows.length))

const modules = {
  'context-sentinel': './plugins/context-sentinel.js',
  'message-bus': './plugins/message-bus.js',
  'team-bus': './plugins/team-bus.js',
  'agent-workflows': './plugins/agent-workflows.js',
  'workbench-bundle': './index.js',
  'auto-backup': './plugins/auto-backup.js',
  'host-relaunch': './plugins/host-relaunch.js',
}
for (const [id, rel] of Object.entries(modules)) {
  check(exists(rel), id + ' plugin module missing: ' + rel)
  try {
    const mod = await import(pathToFileURL(join(root, rel)).href)
    check(typeof mod.apply === 'function', id + ' must export apply()')
    check(Array.isArray(mod.inject), id + ' must export inject[]')
  } catch (error) {
    failures.push(id + ' import failed: ' + String(error))
  }
  check(exists('vendor/' + id + '/README.md'), id + ' vendor README missing')
}
for (const rel of ['README.md', 'CHANGELOG.md', 'PRIVACY.md', 'LICENSE', 'client.js']) check(exists(rel), 'missing ' + rel)
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
check(pkg.exports?.['./client'] === './client.js', 'exports must expose ./client')

// One client module registered under the bundle name, composing both browser halves.
const client = read('client.js')
check(new RegExp('id: "' + pkg.name + '"').test(client), 'client.js must register id "' + pkg.name + '"')
check(client.includes('sidebar.panellist'), 'client.js must register the message center sidebar entry')
check(/PANEL_ID = 'messages'|PANEL_ID = "messages"/.test(client), 'message center panel id must be messages')
check(client.includes('conversation.session.header.utilities'), 'client.js must register the restart header button')
check(client.includes('dsh-message-bus'), 'client.js must mount the messageBus Remote contribution')
check(client.includes('dsh-host-relaunch'), 'client.js must mount the relaunch Remote contribution')

// Shipped files must not leak internal workspace paths.
const SHIPPED_TEXT = [
  'README.md', 'CHANGELOG.md', 'PRIVACY.md', 'PUBLISHING.md', 'CAPABILITY_AUDIT.md',
  'OPERATOR_ONLY_BOUNDARIES.md', 'client.js', 'cordis.patch.yml', 'package.json',
]
const walkShipped = dir => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const rel = join(dir, entry)
    if (entry === 'node_modules' || entry === '.git') continue
    if (statSync(rel).isDirectory()) out.push(...walkShipped(rel))
    else if (/\.(md|json|ya?ml|js|mjs|cjs|svg)$/i.test(entry)) out.push(rel)
  }
  return out
}
const shipped = [...SHIPPED_TEXT, ...walkShipped('vendor'), ...walkShipped('plugins')]
const banned = [
  { re: /docs\/toolbox|docs\/publish/, label: 'internal docs path' },
  { re: /default-workspace|\u5343\u661f\u5947\u57df|\u7e41\u661f\u4e4b\u79cd/, label: 'private workspace path' },
  { re: /[A-Za-z]:\\Users\\(?!<)|C:\/Users\/(?!<)/, label: 'absolute user path' },
  { re: /link:[A-Za-z]:\\/, label: 'profile link path' },
]
for (const rel of shipped) {
  if (!exists(rel)) continue
  const text = read(rel)
  for (const rule of banned) {
    if (rule.re.test(text)) failures.push(rel + ' contains ' + rule.label)
  }
}

if (failures.length > 0) {
  console.error('SCAFFOLD-FAILED')
  for (const message of failures) console.error(' - ' + message)
  process.exitCode = 1
} else {
  console.log('SCAFFOLD-OK: one bundle, ' + String(ids.length) + ' rows, zero npm dependencies, one composed client module')
}
