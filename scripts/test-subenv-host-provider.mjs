#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostProvider } from '../vendor/message-bus/src/subenv/host-provider.mjs'

test('host provider degrades when ctx.llm is absent', async () => {
  const provider = createHostProvider({ getLlm: () => undefined })
  assert.equal(provider.enabled, false)
  assert.equal(provider.describe().configured, false)
  assert.equal((await provider.chat({ messages: [{ role: 'user', content: 'x' }] })).code, 'LLM_UNAVAILABLE')
})

test('host provider uses the host llm stream and configured route', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ id: 'm' }],
    async * stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: 'hel' }
      yield { type: 'text-delta', index: 0, text: 'lo' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const provider = createHostProvider({ getLlm: () => llm, providerId: 'p', modelId: 'm' })
  assert.equal(provider.enabled, true)
  assert.equal(provider.describe().source, 'dsh-llm')
  const result = await provider.chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'hello')
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].model, 'm')
  assert.equal(JSON.stringify(provider.describe()).includes('key'), false)
})
