#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vendor/agent-memory/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000051'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-supersede-'))
  process.env.DSH_MEMORY_DB = join(dir, 'memory.sqlite')
  const tools = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    on() { return () => {} },
  }
  apply(ctx, {})
  t.after(() => {
    for (const d of cleanups.reverse()) d()
    delete process.env.DSH_MEMORY_DB
    rmSync(dir, { recursive: true, force: true })
  })
  return tools
}

test('memory_supersede retains the old row but hides it from default search', async (t) => {
  const tools = fixture(t)
  const old = await tools.get('memory_remember').execute({ content: 'old fact', key: 'fact' }, { agent: { session: { id: SESSION } } })
  const replacement = await tools.get('memory_supersede').execute({ id: old.id, content: 'new fact' }, { agent: { session: { id: SESSION } } })
  assert.equal(replacement.ok, true)
  assert.equal(replacement.superseded, old.id)
  const active = await tools.get('memory_search').execute({ query: 'fact' }, { agent: { session: { id: SESSION } } })
  assert.equal(active.memories.some(row => row.id === old.id), false)
  assert.equal(active.memories.some(row => row.id === replacement.id), true)
  const all = await tools.get('memory_search').execute({ query: 'fact', includeSuperseded: true }, { agent: { session: { id: SESSION } } })
  assert.equal(all.memories.some(row => row.id === old.id), true)
  const again = await tools.get('memory_supersede').execute({ id: old.id, content: 'third' }, { agent: { session: { id: SESSION } } })
  assert.equal(again.code, 'CONFLICT')
})
