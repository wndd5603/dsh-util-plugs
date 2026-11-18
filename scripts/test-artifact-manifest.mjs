#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordArtifact, readArtifactCurrent } from '../vendor/workbench-bundle/plugin.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-manifest-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const file = join(dir, 'index-abc.js')
  writeFileSync(file, 'console.log("artifact")\n', 'utf8')
  t.after(() => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, file }
}

test('recordArtifact writes a content-addressed manifest without current by default', (t) => {
  const { dir, file } = fixture(t)
  const result = recordArtifact({ file, buildId: 'build-1', testRunId: 'qa-1' })
  assert.equal(result.ok, true)
  assert.equal(result.manifest.sha256.length, 64)
  assert.equal(result.manifest.file, 'index-abc.js')
  assert.equal(result.manifest.buildId, 'build-1')
  assert.ok(existsSync(result.manifestFile))
  assert.equal(result.current, null)
  assert.equal(readArtifactCurrent(), null)
  assert.ok(!existsSync(join(dir, 'artifacts', 'current.json')))
})

test('promote updates the single current pointer and archives the previous one', (t) => {
  const { dir, file } = fixture(t)
  const first = recordArtifact({ file, buildId: 'build-1', promote: true })
  assert.ok(first.current)
  assert.equal(readArtifactCurrent().manifest.sha256, first.manifest.sha256)
  writeFileSync(file, 'console.log("artifact v2")\n', 'utf8')
  const second = recordArtifact({ file, buildId: 'build-2', promote: true })
  assert.notEqual(first.manifest.sha256, second.manifest.sha256)
  assert.equal(readArtifactCurrent().manifest.buildId, 'build-2')
  const history = readdirSync(join(dir, 'artifacts', 'history'))
  assert.equal(history.length, 1)
  assert.match(history[0], new RegExp(first.manifest.sha256.slice(0, 12)))
})

test('missing or non-file paths are rejected', (t) => {
  const { file } = fixture(t)
  assert.throws(() => recordArtifact({ file: file + '.missing', buildId: 'x' }), /not found/i)
  assert.throws(() => recordArtifact({ file, buildId: '' }), /buildId/i)
})
