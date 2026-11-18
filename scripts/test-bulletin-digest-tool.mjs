#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../vendor/bulletin-board/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000031'
const exec = { agent: { session: { id: SESSION } } }

test('bulletin_digest default applies a 24h stale SLA', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bulletin-digest-'))
  const dbPath = join(dir, 'board.sqlite')
  const previous = process.env.DSH_BULLETIN_DB
  process.env.DSH_BULLETIN_DB = dbPath
  const tools = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      return undefined
    },
  }
  apply(ctx)
  t.after(() => {
    for (const d of cleanups.reverse()) d()
    if (previous === undefined) delete process.env.DSH_BULLETIN_DB
    else process.env.DSH_BULLETIN_DB = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const board = await tools.get('bulletin_board_create').execute({ title: 'digest' }, exec)
  const task = await tools.get('bulletin_task_add').execute({ boardId: board.id, title: 'stale', assigneeSession: SESSION }, exec)
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', task.id)
  db.close()
  const digest = await tools.get('bulletin_digest').execute({ session: SESSION }, exec)
  assert.ok(digest.tasks.some(item => item.id === task.id))
})
