#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { revealMemory } from '../vendor/message-bus/index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-reveal-'))
  const path = join(dir, 'memory.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', source_session TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, superseded_by TEXT
  )`)
  db.prepare('INSERT INTO memories (id,scope,key,content,tags,source_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('mem-1', 'project', 'k', 'sensitive body', '["x"]', 'session-s', 't0', 't1')
  db.close()
  const previous = process.env.DSH_MEMORY_DB
  process.env.DSH_MEMORY_DB = path
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_MEMORY_DB
    else process.env.DSH_MEMORY_DB = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir }
}

test('memory reveal requires operator config and explicit confirm', (t) => {
  fixture(t)
  assert.equal(revealMemory({ id: 'mem-1', confirm: 'REVEAL' }, { allow: false }).code, 'REVEAL_DISABLED')
  assert.equal(revealMemory({ id: 'mem-1' }, { allow: true }).code, 'CONFIRM_REQUIRED')
})

test('memory reveal returns one body and writes audit without content', (t) => {
  const { dir } = fixture(t)
  const result = revealMemory({ id: 'mem-1', confirm: 'REVEAL' }, { allow: true })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'sensitive body')
  assert.deepEqual(result.tags, ['x'])
  const audit = join(dir, 'reveal-audit.jsonl')
  assert.ok(existsSync(audit))
  const text = readFileSync(audit, 'utf8')
  assert.match(text, /mem-1/)
  assert.equal(text.includes('sensitive body'), false)
})
