#!/usr/bin/env node
/**
 * Verify the composed Web client bundle without a browser.
 *
 * Runs client.js in a vm with a fake `window.__ModuleLoader__`, materializes the
 * factory with a fake React, then applies it with a mock Cordis-like client
 * context and records locale namespaces, slot registrations and Remote mounts.
 *
 * Usage: node scripts/verify-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

let registration
const window = {
  __ModuleLoader__: {
    load(value) { registration = value },
  },
}
runInNewContext(readFileSync(join(repoRoot, 'client.js'), 'utf8'), { window })
check(registration !== undefined, 'client.js must call window.__ModuleLoader__.load once')
check(registration?.id === pkg.name, `client registration id must equal the package name (${pkg.name}), got ${registration?.id}`)
check(typeof registration?.factory === 'function', 'client registration must carry a factory')

const React = new Proxy({}, {
  get(_target, key) {
    if (key === 'createElement') return (type, props, ...children) => ({ type, props, children })
    if (key === 'useState') return initial => [typeof initial === 'function' ? initial() : initial, () => {}]
    if (key === 'useRef') return () => ({ current: null })
    if (key === 'useCallback') return fn => fn
    if (key === 'useEffect') return () => {}
    if (key === 'useMemo') return fn => fn()
    return undefined
  },
})
const moduleExports = registration.factory(specifier => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
check(typeof moduleExports.apply === 'function', 'materialized client module must export apply()')
check(Array.isArray(moduleExports.inject), 'materialized client module must export inject[]')

const seen = { locales: [], slots: [], remotes: [] }
const mockCtx = {
  effect(fn) { const result = fn(); return result },
  locale: { register(ns) { seen.locales.push(ns) } },
  plugin(fn) { const result = fn({ remote: { $mount: async contribution => { seen.remotes.push(contribution?.package) } } }); return result },
  inject(_deps, cb) { cb(scope) },
}
const scope = {
  locale: { bind: () => (key, vars) => key },
  remoteAccess: {
    whenAccess(_name, generator) {
      const iterator = generator()
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') step = iterator.next(step.value())
        else step = iterator.next(step.value)
      }
    },
  },
  slots: {
    register(target, component) { seen.slots.push({ name: target.name, id: target.id, key: target.key, component }); return { name: target.name } },
    inject(name, create) { return create() },
  },
}
moduleExports.apply(mockCtx)

check(seen.locales.includes('messageBusClient'), 'message center locale namespace must register (messageBusClient)')
check(seen.locales.includes('hostRelaunch'), 'restart button locale namespace must register (hostRelaunch)')
const panel = seen.slots.find(slot => slot.name === 'sidebar.panellist' && slot.id === 'messages')
check(panel !== undefined, 'message center must register the sidebar.panellist "messages" entry')
const page = seen.slots.find(slot => slot.name === 'main' && slot.key === 'messages')
check(page !== undefined, 'message center must register the main "messages" page')
const button = seen.slots.find(slot => slot.name === 'conversation.session.header.utilities' && slot.id === 'host-relaunch')
check(button !== undefined, 'host relaunch must register the conversation header utilities button')
check(seen.remotes.includes('dsh-message-bus'), 'message center must mount its messageBus Remote contribution')
check(seen.remotes.includes('dsh-host-relaunch'), 'restart button must mount its relaunch Remote contribution')
for (const service of ['slots', 'locale', 'remote', 'remoteAccess']) {
  check(moduleExports.inject.includes(service), 'client inject must include ' + service)
}
const declared = new Set(pkg.dsh?.client?.inject ?? [])
for (const dependency of [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-api-remote-access',
]) {
  check(declared.has(dependency), 'dsh.client.inject must declare ' + dependency)
}
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')

if (failures.length > 0) {
  console.error('CLIENT-FAILED')
  for (const message of failures) console.error(' - ' + message)
  process.exitCode = 1
} else {
  console.log('CLIENT-OK: one client module "' + pkg.name + '" composes 2 halves; '
    + seen.slots.length + ' slots, ' + seen.remotes.length + ' Remotes, ' + seen.locales.length + ' locales')
}

