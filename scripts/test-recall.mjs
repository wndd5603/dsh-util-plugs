#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readMemoryRecall, readArtifactRecall } from '../vendor/agent-apartment/src/collab.js'

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recall-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('recall reads memory keys without bodies', (t) => {
  const dir = home(t)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'memory', 'memory.sqlite'))
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT, key TEXT, content TEXT, updated_at TEXT, superseded_by TEXT)')
  db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,NULL)').run('m1', 'project', 'k1', 'secret body', '2026-01-01')
  db.close()
  const result = readMemoryRecall()
  assert.equal(result.available, true)
  assert.equal(result.total, 1)
  assert.equal(result.keys[0].key, 'k1')
  assert.equal(JSON.stringify(result).includes('secret body'), false)
  assert.equal(result.contentOmitted, true)
})

test('recall reads the artifact current pointer without scanning', (t) => {
  const dir = home(t)
  mkdirSync(join(dir, 'artifacts'), { recursive: true })
  writeFileSync(join(dir, 'artifacts', 'current.json'), JSON.stringify({
    artifactId: 'a1', sha256: 'a'.repeat(64), size: 3, file: 'C:/tmp/a.bin', buildId: 'b1', createdAt: '2026-01-01',
  }))
  const result = readArtifactRecall()
  assert.equal(result.available, true)
  assert.equal(result.artifactId, 'a1')
  assert.equal(result.file, 'a.bin')
  assert.equal(result.sha256, 'a'.repeat(64))
})
