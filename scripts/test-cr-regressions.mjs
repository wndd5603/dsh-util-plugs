#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyBus } from '../vendor/message-bus/index.js'
import { apply as applyApartment } from '../vendor/agent-apartment/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000041'

function baseCtx(tools, services = {}) {
  const cleanups = []
  return {
    cleanups,
    ctx: {
      logger: { info() {}, warn() {} },
      tools: { register(tool) { tools.set(tool.name, tool) } },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
      provide(key, value) { services[key] = value },
      get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
        if (name === 'agents') return { get: () => undefined, list: () => [] }
        return undefined
      },
      on() { return () => {} },
    },
  }
}

test('web message delete is disabled by default and requires operator opt-in', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-delete-'))
  const tools = new Map()
  const services = {}
  const { ctx, cleanups } = baseCtx(tools, services)
  applyBus(ctx, { dbPath: join(dir, 'bus.sqlite'), webUi: { allowDelete: false } })
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); rmSync(dir, { recursive: true, force: true }) })
  const remote = services.messageBusRemote
  assert.ok(remote !== undefined)
  assert.match((await remote.delete('missing', 'DELETE')).error, /disabled/i)
})

test('collaboration_recall without sessionId is caller-scoped, not operator-forbidden', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cr-recall-'))
  const tools = new Map()
  const { ctx, cleanups } = baseCtx(tools)
  applyApartment(ctx, { root: dir })
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); rmSync(dir, { recursive: true, force: true }) })
  const tool = tools.get('collaboration_recall')
  assert.ok(tool !== undefined)
  const result = await tool.execute({}, { agent: { session: { id: SESSION } } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNBOUND_SESSION')
  assert.match(result.hint, /apartment_agent_bind/)
})
