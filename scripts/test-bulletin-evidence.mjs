#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../vendor/bulletin-board/src/store.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000011'
const other = 'session-00000000-0000-0000-0000-000000000012'
const exec = { agent: { session: { id: SESSION } } }
const sha = 'a'.repeat(64)

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bulletin-evidence-'))
  const store = createStore(join(dir, 'board.sqlite'))
  t.after(() => { try { store.close() } finally { rmSync(dir, { recursive: true, force: true }) } })
  const board = store.createBoard({ title: 'P0 evidence' }, exec)
  const task = store.addTask(board.id, { title: 'needs proof' }, exec)
  return { store, task }
}

test('completeTask requires artifact evidence and rejects bad hashes', (t) => {
  const { store, task } = fixture(t)
  assert.throws(() => store.completeTask(task.id, exec, {}), /evidence/i)
  assert.throws(() => store.completeTask(task.id, exec, { evidence: { artifactId: 'a', sha256: 'nope', checkResult: 'PASS' } }), /sha256/i)
  assert.throws(() => store.completeTask(task.id, exec, { evidence: { artifactId: '', sha256: sha, checkResult: 'PASS' } }), /artifactId/i)
  assert.throws(() => store.completeTask(task.id, exec, { evidence: { artifactId: 'a', sha256: sha, checkResult: '' } }), /checkResult/i)
  assert.equal(store.getTask(task.id).status, 'pending')
})

test('completeTask stores evidence and emits a task.complete event', (t) => {
  const { store, task } = fixture(t)
  const done = store.completeTask(task.id, exec, { evidence: { artifactId: 'dist/index.js', sha256: sha, checkResult: 'PASS 13/13' } })
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.metadata.completion.evidence, { artifactId: 'dist/index.js', sha256: sha, checkResult: 'PASS 13/13' })
  const event = store.db.prepare("SELECT * FROM events WHERE action='task.complete' AND entity_id=?").get(task.id)
  assert.ok(event)
  assert.match(event.detail, /dist\/index\.js/)
})

test('generic updateTask cannot mark a task completed', (t) => {
  const { store, task } = fixture(t)
  assert.throws(() => store.updateTask(task.id, { status: 'completed' }, exec), /bulletin_task_complete/i)
  assert.equal(store.getTask(task.id).status, 'pending')
})

test('digest returns stale tasks when an SLA is applied', (t) => {
  const { store, task } = fixture(t)
  store.updateTask(task.id, { assigneeSession: SESSION }, exec, { operator: true })
  store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', task.id)
  const stale = store.digest({ session: SESSION, staleAfterHours: 24 })
  assert.ok(stale.some(item => item.id === task.id))
})
