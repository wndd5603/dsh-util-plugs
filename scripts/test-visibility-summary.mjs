#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { safeTaskView, visibilityDetailOf, visibilityPageMeta, visibilitySummaryOf } from '../vendor/message-bus/index.js'

test('visibility summary exposes an enforced host scope', () => {
  const result = visibilitySummaryOf({})
  assert.equal(result.ok, true)
  assert.equal(result.scope.mode, 'host')
  assert.equal(result.scope.enforced, true)
})

test('visibility summary maps ready/empty/unavailable without bodies', () => {
  const ready = visibilitySummaryOf({
    messageCounts: { messages: 2, unread: 1 },
    tasks: { total: 3, counts: { stale: 1, blocked: 1 } },
    memory: { total: 4 },
    meetings: { total: 0 },
    subenv: null,
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.scope.mode, 'host')
  assert.equal(ready.state, 'partial')
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

test('visibilityPageMeta exposes stable cursor/version/error fields', () => {
  const first = visibilityPageMeta(10, 0, 5)
  assert.equal(first.nextCursor, '5')
  assert.equal(first.version, 'v1')
  assert.equal(first.error, null)
  assert.equal(visibilityPageMeta(10, 5, 5).nextCursor, null)
})

test('visibilityDetailOf strips body and reads nested evidence', () => {
  const message = visibilityDetailOf({
    domain: 'messages', id: 'm1',
    getMessage: () => ({ id: 'm1', at: 't', subject: 's', body: 'secret', sha256: 'abc' }),
  })
  assert.equal(message.ok, true)
  assert.equal(JSON.stringify(message).includes('secret'), false)
  assert.equal(message.evidence.hash, 'abc')
  const task = visibilityDetailOf({
    domain: 'tasks', id: 't1',
    readTaskDetail: () => ({ task: { id: 't1', title: 'x', description: 'd', metadata: { completion: { evidence: { sha256: 'a'.repeat(64) } } } } }),
  })
  assert.equal(task.ok, true)
  assert.equal(JSON.stringify(task.item).includes('description'), false)
  assert.equal(task.evidence.sha256, 'a'.repeat(64))
  const sqliteShape = visibilityDetailOf({
    domain: 'tasks', id: 't2',
    readTaskDetail: () => ({ task: { id: 't2', title: 'x', metadata: JSON.stringify({ completion: { evidence: { sha256: 'b'.repeat(64) } } }) } }),
  })
  assert.equal(sqliteShape.evidence.sha256, 'b'.repeat(64))
  const corrupt = visibilityDetailOf({
    domain: 'tasks', id: 't3',
    readTaskDetail: () => ({ task: { id: 't3', title: 'x', metadata: '{bad json' } }),
  })
  assert.equal(corrupt.evidence, null)
  assert.equal(visibilityDetailOf({ domain: 'messages', id: 'x', getMessage: () => undefined }).code, 'NOT_FOUND')
})

test('visibility summary isolates an unavailable domain', () => {
  const result = visibilitySummaryOf({
    messageCounts: { messages: 1, unread: 0 },
    tasks: null, memory: { total: 1 }, meetings: { total: 1 }, subenv: null,
  })
  assert.equal(result.cards.tasks.state, 'unavailable')
  assert.equal(result.cards.messages.state, 'ready')
})
