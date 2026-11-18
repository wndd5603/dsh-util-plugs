#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApartment } from '../vendor/agent-apartment/src/store.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lease-fencing-'))
  const apartment = createApartment({ root: dir })
  t.after(() => { try { apartment.close() } finally { rmSync(dir, { recursive: true, force: true }) } })
  return apartment
}

test('only one active lease per task and fencing tokens increase', (t) => {
  const apartment = fixture(t)
  const first = apartment.claimLease({ agentId: 'agent-a', workspace: 'ws', taskId: 'task-1' })
  assert.equal(first.fencing_token, 1)
  assert.throws(() => apartment.claimLease({ agentId: 'agent-b', workspace: 'ws', taskId: 'task-1' }), /active lease/i)
  assert.equal(apartment.releaseLease(first.id, { agentId: 'agent-a' }).released, true)
  const second = apartment.claimLease({ agentId: 'agent-b', workspace: 'ws', taskId: 'task-1' })
  assert.equal(second.fencing_token, 2)
})

test('release requires the owner and is idempotent', (t) => {
  const apartment = fixture(t)
  const lease = apartment.claimLease({ agentId: 'agent-a', workspace: 'ws', taskId: 'task-2' })
  assert.throws(() => apartment.releaseLease(lease.id, { agentId: 'agent-b' }), /only the lease owner/i)
  assert.equal(apartment.releaseLease(lease.id, { agentId: 'agent-a' }).released, true)
  assert.equal(apartment.releaseLease(lease.id, { agentId: 'agent-a' }).released, false)
})
