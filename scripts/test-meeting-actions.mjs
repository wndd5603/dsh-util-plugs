#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMeetingDigest, meetingSidecarFile, pendingActionsOf, updateMeetingActionInStore } from '../vendor/team-bus/session-network/src/meeting-digest.js'

test('meeting action update closes one row and digest stops counting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-meeting-actions-'))
  try {
    const store = { meetingId: 'm1', actions: ['first', { id: 'A2', text: 'second', owner: null, status: 'pending' }] }
    const updated = updateMeetingActionInStore(store, { actionId: 'A1', status: 'completed', owner: 'lead' })
    assert.equal(updated.ok, true)
    assert.equal(updated.action.status, 'completed')
    assert.equal(updated.action.owner, 'lead')
    assert.deepEqual(pendingActionsOf(store).map(action => action.id), ['A2'])
    const invalid = updateMeetingActionInStore(store, { actionId: 'A2', status: 'bogus' })
    assert.equal(invalid.code, 'INVALID_ARGUMENT')
    mkdirSync(join(dir, 'meetings'), { recursive: true })
    writeFileSync(join(dir, 'meetings', meetingSidecarFile('m1')), JSON.stringify(store))
    const digest = buildMeetingDigest({
      db: { listMeetings: () => [{ meeting_id: 'm1', title: 't', status: 'final', convener: 'lead' }] },
      dataDir: dir,
    })
    assert.equal(digest.counts.pendingActions, 1)
    assert.deepEqual(digest.meetings[0].pendingActions.map(action => action.id), ['A2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
