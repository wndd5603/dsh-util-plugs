#!/usr/bin/env node
// P0 message-bus regression tests: read ownership, peer wake source and unread
// absence detection. Uses only a temporary SQLite DB; never touches the real bus.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  canReadMessage,
  createPeerMessage,
  createPendingReminderHandler,
  isPendingReminderMessage,
  peerSourceForItems,
} from '../vendor/message-bus/index.js'
import { openMessageStore, sha256Of } from '../vendor/message-bus/src/store.js'

const TARGET = 'session-00000000-0000-0000-0000-000000000001'
const SENDER = 'session-00000000-0000-0000-0000-000000000002'
const THIRD = 'session-00000000-0000-0000-0000-000000000003'

function temporaryStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-message-bus-p0-'))
  const store = openMessageStore(join(dir, 'bus.sqlite'))
  t.after(() => {
    try { store.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  return store
}

function insertDeliveryRow(store, { id, at, toSession, fromSession = SENDER, suppressed = false, delivered = true }) {
  const body = 'body-' + id
  const sha = sha256Of(body)
  store.insertMessage({
    id, at, fromSession, toSession, subject: 'subject-' + id,
    body, bytes: Buffer.byteLength(body, 'utf8'), sha256: sha,
  })
  store.insertDelivery({
    messageId: id, at, fromSession, toSession, subject: 'subject-' + id,
    bodyBytes: Buffer.byteLength(body, 'utf8'), bodySha256: sha,
    suppressed, delivered,
    // Suppressed rows are dedupe duplicates, never delivered.
    ...(suppressed ? { duplicate: true } : {}),
  })
}

test('canReadMessage allows only the target or sender session', () => {
  const row = { to_session: TARGET, from_session: SENDER }
  assert.equal(canReadMessage(row, TARGET), true)
  assert.equal(canReadMessage(row, SENDER), true)
  assert.equal(canReadMessage(row, THIRD), false)
  assert.equal(canReadMessage(row, null), false)
  assert.equal(canReadMessage(row, undefined), false)
  assert.equal(canReadMessage(row, ''), false)
  assert.equal(canReadMessage(null, TARGET), false)
  assert.equal(canReadMessage({ to_session: TARGET, from_session: null }, SENDER), false)
})

test('createPeerMessage marks the wake source as peer-message, never user', () => {
  const message = createPeerMessage('hello', { fromSession: SENDER, fromDisplay: 'Sender' })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'peer-message')
  assert.equal(message.source.version, 1)
  assert.equal(message.source.fromSession, SENDER)
  assert.equal(message.source.fromDisplay, 'Sender')
  assert.notEqual(message.source.kind, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])

  const fallback = createPeerMessage('body')
  assert.equal(fallback.source.kind, 'peer-message')
  assert.equal(fallback.source.fromSession, null)
  assert.equal(fallback.source.fromDisplay, null)
})

test('peerSourceForItems refuses mixed A+B and A+null attribution', () => {
  const a = { fromSession: SENDER, from: 'A' }
  const b = { fromSession: THIRD, from: 'B' }
  const remote = { fromSession: null, from: 'Web' }
  assert.deepEqual(peerSourceForItems([a]), { fromSession: SENDER, fromDisplay: 'A' })
  assert.deepEqual(peerSourceForItems([a, { ...a }]), { fromSession: SENDER, fromDisplay: 'A' })
  assert.deepEqual(peerSourceForItems([a, b]), { fromSession: null, fromDisplay: null })
  assert.deepEqual(peerSourceForItems([a, remote]), { fromSession: null, fromDisplay: null })
  assert.deepEqual(peerSourceForItems([]), { fromSession: null, fromDisplay: null })
})

test('unreadSummary counts distinct unread messages per recipient', (t) => {
  const store = temporaryStore(t)
  const oldest = '2026-11-18T00:00:00.000Z'
  // m1: two non-suppressed deliveries, still one distinct unread message.
  insertDeliveryRow(store, { id: 'msg-m1', at: oldest, toSession: TARGET })
  store.insertDelivery({
    messageId: 'msg-m1', at: '2026-11-18T00:00:01.000Z', fromSession: SENDER, toSession: TARGET,
    subject: 'subject-msg-m1', bodyBytes: Buffer.byteLength('body-msg-m1', 'utf8'),
    bodySha256: sha256Of('body-msg-m1'), delivered: true,
  })
  // m2: unread at the next timestamp.
  insertDeliveryRow(store, { id: 'msg-m2', at: '2026-11-18T00:05:00.000Z', toSession: TARGET })
  // m3: read by the target -> excluded.
  insertDeliveryRow(store, { id: 'msg-m3', at: '2026-11-18T00:10:00.000Z', toSession: TARGET })
  store.markRead(TARGET, 'msg-m3')
  // m4: dedupe-suppressed -> excluded.
  insertDeliveryRow(store, {
    id: 'msg-m4', at: '2026-11-18T00:15:00.000Z', toSession: TARGET, suppressed: true, delivered: false,
  })
  // m5: a read receipt written by a non-recipient must not clear the target's unread.
  insertDeliveryRow(store, { id: 'msg-m5', at: '2026-11-18T00:20:00.000Z', toSession: TARGET })
  store.markRead(THIRD, 'msg-m5')

  assert.deepEqual(store.unreadSummary(TARGET), { unread: 3, oldestAt: oldest })
  assert.deepEqual(store.unreadSummary(THIRD), { unread: 0, oldestAt: null })

  const pending = store.pendingSummary(TARGET)
  assert.equal(pending.total, 0) // all counted rows are delivered; legacy semantics stay unchanged
  assert.equal(pending.unread, 3)

  const counts = store.counts()
  assert.equal(counts.unread, 3)
  assert.equal(counts.pending.unread, 3)
  assert.equal(counts.messages, 5)
})

test('message_read denies third parties and only marks authorized reads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-message-bus-p0-apply-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const wakes = []
  const targetAgent = {
    session: { id: TARGET },
    status: 'idle',
    followup(message) { wakes.push(message) },
  }
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    get(name) {
      if (name === 'agents') {
        return {
          get: id => (id === TARGET ? targetAgent : undefined),
          list: () => [targetAgent],
        }
      }
      return undefined
    },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  try {
    apply(ctx, { dbPath: join(dir, 'bus.sqlite'), strictMode: false, autoResume: false, legacyTools: true, allowPurge: true })
    const sent = await tools.get('message_send').execute(
      { to: TARGET, body: 'p0 body', subject: 'p0', priority: true },
      { agent: { session: { id: SENDER } } },
    )
    assert.equal(sent.ok, true)
    assert.equal(sent.delivered, true)
    assert.equal(wakes.length, 1)
    assert.equal(wakes[0].source.kind, 'peer-message')
    assert.equal(wakes[0].source.fromSession, SENDER)
    assert.match(wakes[0].content[0].text, new RegExp(sent.messageId))
    const sendAudit = join(dir, 'send-audit.jsonl')
    assert.ok(existsSync(sendAudit))
    const auditText = readFileSync(sendAudit, 'utf8')
    assert.match(auditText, new RegExp(sent.messageId))
    assert.doesNotMatch(auditText, /p0 body/)

    const read = tools.get('message_read')
    const status = tools.get('message_bus_status')
    const ack = tools.get('message_ack')
    const deniedAck = ack.execute({ ids: [sent.messageId] }, { agent: { session: { id: THIRD } } })
    assert.equal(deniedAck.ok, false)
    assert.deepEqual(deniedAck.denied, [sent.messageId])
    assert.equal(status.execute().counts.readState, 0)

    const queue = tools.get('message_queue')
    const modernCrossQueue = queue.execute({ to: TARGET }, { agent: { session: { id: THIRD } } })
    assert.equal(modernCrossQueue.ok, false)
    assert.equal(modernCrossQueue.code, 'FORBIDDEN')
    const ownQueue = queue.execute({}, { agent: { session: { id: THIRD } } })
    assert.equal(ownQueue.ok, true)
    assert.equal(ownQueue.total, 0)
    assert.equal(JSON.stringify(ownQueue.items ?? []).includes('p0 body'), false)

    const forbidden = read.execute({ messageId: sent.messageId }, { agent: { session: { id: THIRD } } })
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.code, 'FORBIDDEN')
    assert.equal(status.execute().counts.readState, 0)
    assert.equal(status.execute().counts.unread, 1)

    const missing = read.execute({ messageId: sent.messageId }, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'FORBIDDEN')
    assert.equal(status.execute().counts.readState, 0)

    const asSender = read.execute({ messageId: sent.messageId }, { agent: { session: { id: SENDER } } })
    assert.equal(asSender.ok, true)
    assert.equal(asSender.body, 'p0 body')
    assert.equal(status.execute().counts.readState, 1)
    // A sender's read receipt must not clear the target's unread count.
    assert.equal(status.execute().counts.unread, 1)

    const legacyQueue = tools.get('pipe2_queue')
    assert.ok(legacyQueue, 'legacy pipe2_queue is registered when legacyTools=true')
    const thirdQueue = legacyQueue.execute({}, { agent: { session: { id: THIRD } } })
    assert.equal(thirdQueue.ok, true)
    assert.equal(thirdQueue.count, 0) // caller-scoped: no third-party body
    const crossQueue = legacyQueue.execute({ to: TARGET }, { agent: { session: { id: THIRD } } })
    assert.equal(crossQueue.ok, false)
    assert.equal(crossQueue.code, 'FORBIDDEN')
    const targetQueue = legacyQueue.execute({}, { agent: { session: { id: TARGET } } })
    assert.equal(targetQueue.ok, true)
    assert.equal(targetQueue.count, 1)
    assert.match(JSON.stringify(targetQueue.items), /p0 body/)

    const asTarget = read.execute({ messageId: sent.messageId }, { agent: { session: { id: TARGET } } })
    assert.equal(asTarget.ok, true)
    assert.equal(status.execute().counts.unread, 0)

    const purge = tools.get('message_purge')
    assert.ok(purge, 'message_purge is registered when allowPurge=true')
    const purged = purge.execute({ confirm: 'PURGE', all: true }, { agent: { session: { id: SENDER } } })
    assert.equal(purged.ok, true)
    assert.equal(purged.deletedMessages, 1)
    const purgeAudit = join(dir, 'purge-audit.jsonl')
    assert.ok(existsSync(purgeAudit))
    assert.match(readFileSync(purgeAudit, 'utf8'), /deletedMessages/)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('pending reminder also fires for unread-only sessions', async () => {
  const handler = createPendingReminderHandler({
    getConfig: () => ({ enabled: true, intervalMinutes: 15 }),
    pendingSummary: () => ({ total: 0, unread: 3, queued: 0, undeliverable: 0, oldestAt: null, byReason: {} }),
    logger: { info() {}, warn() {} },
  })
  try {
    const decision = await handler.handler(
      { agent: { session: { id: TARGET } }, messages: [] },
      async () => ({ messages: [] }),
    )
    const reminder = decision.messages.find(isPendingReminderMessage)
    assert.ok(reminder, 'unread-only pending summary must inject one reminder')
    assert.match(reminder.content[0].text, /3 unread/u)
  } finally {
    handler.dispose()
  }
})
