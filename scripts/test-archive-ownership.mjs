#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveManualArchivePath, selectStaleJobs } from '../vendor/context-sentinel/team-hooks2/index.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-archive-ownership-'))
  mkdirSync(join(root, 'team', 'members', 'lead'), { recursive: true })
  mkdirSync(join(root, 'team', 'members', 'other'), { recursive: true })
  writeFileSync(join(root, 'team', 'members', 'lead', 'ARCHIVE_20261118_130000.md'), '# lead\n')
  writeFileSync(join(root, 'team', 'members', 'other', 'ARCHIVE_20261118_120000.md'), '# other\n')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('manual archive path never uses another role archive', (t) => {
  const root = fixture(t)
  const foreign = join(root, 'team', 'members', 'other', 'ARCHIVE_20261118_120000.md')
  const resolved = resolveManualArchivePath({ workspaceDir: root, roleName: 'lead', knownPath: foreign })
  assert.equal(resolved, join(root, 'team', 'members', 'lead', 'ARCHIVE_20261118_130000.md'))
})

test('manual archive path prefers known own-role archive', (t) => {
  const root = fixture(t)
  const own = join(root, 'team', 'members', 'lead', 'ARCHIVE_20261118_130000.md')
  assert.equal(resolveManualArchivePath({ workspaceDir: root, roleName: 'lead', knownPath: own }), own)
})

test('manual archive path falls back to canonical archive in own role dir', (t) => {
  const root = fixture(t)
  const resolved = resolveManualArchivePath({ workspaceDir: root, roleName: 'new-role', knownPath: null })
  assert.match(resolved, /team[\\/]members[\\/]new-role[\\/]ARCHIVE_\d{8}_\d{6}\.md$/u)
})

test('selectStaleJobs only returns live jobs older than the threshold', () => {
  const now = 10_000_000
  const jobs = [
    { id: 'job-old', status: 'running', startedAt: now - 1_000_000 },
    { id: 'job-new', status: 'running', startedAt: now - 1_000 },
    { id: 'job-done', status: 'completed', startedAt: now - 2_000_000 },
    { id: 'job-stopping', status: 'stopping', startedAt: now - 2_000_000 },
  ]
  assert.deepEqual(selectStaleJobs(jobs, { now, staleMs: 900_000 }).map(job => job.id), ['job-old', 'job-stopping'])
})
