#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../vendor/agent-memory/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000021'

function fixture(t, config, mode = 'danger-full-access') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-forget-'))
  process.env.DSH_MEMORY_DB = join(dir, 'memory.sqlite')
  const tools = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    on() { return () => {} },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      return undefined
    },
  }
  apply(ctx, config)
  t.after(() => {
    for (const d of cleanups.reverse()) d()
    delete process.env.DSH_MEMORY_DB
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, tools }
}

test('memory_forget is disabled unless allowForget=true', async (t) => {
  const { tools } = fixture(t, {})
  const remembered = await tools.get('memory_remember').execute({ content: 'forget me', key: 'f1' }, { agent: { session: { id: SESSION } } })
  const result = await tools.get('memory_forget').execute({ id: remembered.id, confirm: 'FORGET' }, { agent: { session: { id: SESSION } } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FORBIDDEN')
})

test('memory_forget requires operator policy even when allowForget=true', async (t) => {
  const { tools } = fixture(t, { allowForget: true }, 'workspace-write')
  const remembered = await tools.get('memory_remember').execute({ content: 'forget me', key: 'f3' }, { agent: { session: { id: SESSION } } })
  const result = await tools.get('memory_forget').execute({ id: remembered.id, confirm: 'FORGET' }, { agent: { session: { id: SESSION } } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FORBIDDEN')
})

test('memory_forget requires confirm and writes an audit row when enabled', async (t) => {
  const { dir, tools } = fixture(t, { allowForget: true })
  const remembered = await tools.get('memory_remember').execute({ content: 'forget me', key: 'f2' }, { agent: { session: { id: SESSION } } })
  const refused = await tools.get('memory_forget').execute({ id: remembered.id }, { agent: { session: { id: SESSION } } })
  assert.equal(refused.code, 'INVALID_ARGUMENT')
  const deleted = await tools.get('memory_forget').execute({ id: remembered.id, confirm: 'FORGET' }, { agent: { session: { id: SESSION } } })
  assert.equal(deleted.ok, true)
  const audit = join(dir, 'forget-audit.jsonl')
  assert.ok(existsSync(audit))
  assert.match(readFileSync(audit, 'utf8'), new RegExp(remembered.id))
})
