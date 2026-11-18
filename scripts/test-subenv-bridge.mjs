#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeSubenv } from '../vendor/message-bus/index.js'

test('probeSubenv reports missing token without network', async () => {
  const result = await probeSubenv({ token: '' })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'unavailable')
  assert.equal(result.code, 'SUBENV_TOKEN_MISSING')
})

test('probeSubenv reads health/capabilities/provider/tasks and never returns token', async () => {
  const calls = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.method)
    const results = {
      health: { ok: true, service: 'dsh-subenv', at: 't' },
      capabilities: { ok: true, methods: ['health'], llm: true },
      'provider.describe': { ok: true, provider: { configured: true, hasApiKey: true, llmEnabled: true } },
      'task.list': { ok: true, tasks: [{ id: 'task-1', status: 'completed' }] },
    }
    return { ok: true, json: async () => ({ result: results[body.method] }) }
  }
  const result = await probeSubenv({ token: 'secret', url: 'http://127.0.0.1:47831/rpc', fetchImpl })
  assert.equal(result.state, 'online')
  assert.equal(result.provider.llmEnabled, true)
  assert.equal(result.tasks.length, 1)
  assert.deepEqual(calls.sort(), ['capabilities', 'health', 'provider.describe', 'task.list'].sort())
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('probeSubenv reports offline instead of throwing', async () => {
  const result = await probeSubenv({ token: 'x', fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(result.state, 'unavailable')
  assert.equal(result.code, 'SUBENV_OFFLINE')
})
