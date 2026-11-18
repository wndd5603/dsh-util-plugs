#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddedSubenv } from '../vendor/message-bus/src/subenv/embedded.mjs'

function provider(enabled = true) {
  return {
    enabled,
    describe: () => ({ configured: true, id: 'mock', model: 'm', hasApiKey: enabled, llmEnabled: enabled }),
    chat: async () => ({ ok: true, text: 'done' }),
  }
}

test('embedded subenv exposes status and completes a task', async () => {
  const subenv = createEmbeddedSubenv({ provider: provider(true) })
  assert.equal(subenv.status().mode, 'embedded')
  assert.equal(subenv.status().state, 'online')
  assert.equal(subenv.status().provider.model, 'm')
  const submitted = subenv.submit({ prompt: 'hello' })
  assert.equal(submitted.ok, true)
  await new Promise(resolve => setTimeout(resolve, 30))
  const got = subenv.get({ id: submitted.task.id })
  assert.equal(got.task.status, 'completed')
  assert.equal(got.task.result, 'done')
})

test('embedded subenv degrades without an enabled provider', () => {
  const subenv = createEmbeddedSubenv({ provider: provider(false) })
  assert.equal(subenv.status().state, 'degraded')
  assert.equal(subenv.submit({ prompt: 'x' }).code, 'LLM_DISABLED')
})

test('embedded subenv cancel is terminal and list is bounded to task summaries in status', () => {
  const subenv = createEmbeddedSubenv({ provider: provider(true) })
  const submitted = subenv.submit({ prompt: 'x' })
  assert.equal(subenv.cancel({ id: submitted.task.id }).task.status, 'cancelled')
  assert.equal(JSON.stringify(subenv.status()).includes('result'), false)
})
