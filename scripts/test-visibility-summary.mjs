#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { safeTaskView, visibilitySummaryOf } from '../vendor/message-bus/index.js'

test('visibility summary requires profile and workspace scope', () => {
  const result = visibilitySummaryOf({})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SCOPE_REQUIRED')
})

test('visibility summary maps ready/empty/unavailable without bodies', () => {
  const ready = visibilitySummaryOf({
    profileId: 'p', workspaceId: 'w',
    messageCounts: { messages: 2, unread: 1 },
    tasks: { total: 3, counts: { stale: 1, blocked: 1 } },
    memory: { total: 4 },
    meetings: { total: 0 },
    subenv: null,
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.cards.messages.state, 'ready')
  assert.equal(ready.cards.messages.unread, 1)
  assert.equal(ready.cards.tasks.stale, 1)
  assert.equal(ready.cards.meetings.state, 'empty')
  assert.equal(ready.cards.memory.state, 'ready')
  assert.equal(ready.cards.subenv.state, 'unavailable')
  assert.equal(JSON.stringify(ready).includes('body'), false)
})

test('safeTaskView removes description and metadata', () => {
  const view = safeTaskView({ id: 't1', title: 'x', description: 'secret', metadata: { a: 1 }, status: 'pending' })
  assert.equal(view.id, 't1')
  assert.equal('description' in view, false)
  assert.equal('metadata' in view, false)
  assert.equal(view.redacted, true)
})

test('visibility summary isolates an unavailable domain', () => {
  const result = visibilitySummaryOf({
    profileId: 'p', workspaceId: 'w',
    messageCounts: { messages: 1, unread: 0 },
    tasks: null, memory: { total: 1 }, meetings: { total: 1 }, subenv: null,
  })
  assert.equal(result.cards.tasks.state, 'unavailable')
  assert.equal(result.cards.messages.state, 'ready')
})
