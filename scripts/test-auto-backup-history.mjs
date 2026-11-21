#!/usr/bin/env node
// Lossless backup history: snapshots are never deleted, older ones are gzipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackupManager } from '../vendor/auto-backup/index.js'

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auto-backup-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const target = join(root, 'src', 'file.js')
  const manager = createBackupManager({
    projectRoot: root,
    backupDir: 'file_backups',
    keepUncompressedPerFile: 2,
    compressWhenFilesOver: 999,
    compressWhenTotalMBOver: 999,
    ...options,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, target, manager }
}

test('compaction gzips older snapshots and keeps every version', (t) => {
  const { target, manager } = fixture(t)
  for (let index = 0; index < 6; index += 1) {
    writeFileSync(target, 'content-' + String(index))
    assert.equal(manager.backup(target).ok, true)
  }
  const snapshots = manager.allBackupFiles()
  assert.equal(snapshots.length, 6, 'no snapshot may be deleted')
  const plain = snapshots.filter(snapshot => snapshot.compressed !== true)
  const gz = snapshots.filter(snapshot => snapshot.compressed === true)
  assert.equal(plain.length, 2, 'only the configured plain window stays uncompressed')
  assert.equal(gz.length, 4)
  for (const snapshot of snapshots) {
    assert.ok(manager.readSnapshot(snapshot).length > 0, 'every snapshot must stay readable')
  }
})

test('dedupe compares against a compressed latest snapshot', (t) => {
  const { target, manager } = fixture(t, { keepUncompressedPerFile: 5 })
  writeFileSync(target, 'same-bytes')
  manager.backup(target)
  writeFileSync(target, 'other')
  manager.backup(target)
  const newest = manager.existingBackups(target)[0]
  assert.equal(newest.compressed, false)
  assert.equal(manager.compressOne(newest), true)
  const compressedNewest = manager.existingBackups(target)[0]
  assert.equal(compressedNewest.compressed, true)
  writeFileSync(target, 'other')
  const result = manager.backup(target)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'identical')
})

test('global threshold compaction never deletes by default', (t) => {
  const { target, manager } = fixture(t, { keepUncompressedPerFile: 99, compressWhenFilesOver: 2 })
  for (let index = 0; index < 5; index += 1) {
    writeFileSync(target, 'body-' + String(index))
    manager.backup(target)
  }
  const snapshots = manager.allBackupFiles()
  assert.equal(snapshots.length, 5)
  assert.ok(snapshots.some(snapshot => snapshot.compressed === true), 'threshold must trigger compression')
  assert.equal(manager.allowDelete, false, 'deletion stays off unless explicitly enabled')
})
