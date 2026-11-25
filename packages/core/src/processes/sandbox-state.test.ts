/** Reducer tests for the durable operator-sandbox state projection
 * (AUT-340): pure functions over the repository journal. */
import { describe, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { checkIncremental } from '../kernel/incremental-contract'
import {
  sandboxStates as sandboxStatesWhole,
  sandboxStatesReducer,
  type SandboxEnvironmentSnapshot,
} from './sandbox-state'

/** Every fixture log reduced here is also held to the incremental contract
 * (every split point, JSON round trip), once per distinct log array. */
const checkedLogs = new WeakSet<object>()
function sandboxStates(events: readonly RepositoryEvent[]): SandboxEnvironmentSnapshot[] {
  if (!checkedLogs.has(events)) {
    checkedLogs.add(events)
    checkIncremental(sandboxStatesReducer, events, { stepwise: false })
  }
  return sandboxStatesWhole(events)
}

const repo = 'acme/widgets'
let seq = 0

function event(
  type:
    | 'provisioned'
    | 'resumed'
    | 'activity'
    | 'stopped'
    | 'released'
    | 'reset'
    | 'provisioning'
    | 'provision-failed'
    | 'closed'
    | 'refreshed',
  payload: Record<string, unknown>,
  ts: string,
) {
  seq += 1
  return {
    repo,
    seq,
    ts,
    actor: humanActor('ops'),
    type: `orchestrator.sandbox.${type}`,
    payload,
  } as never
}

const PROVISIONED = {
  operator: 'ops',
  environmentId: 'env-1',
  provider: 'vercel-sandbox',
  sessionId: 'session-1',
  workspacePath: '/vercel/sandbox/workspace',
}

describe('sandboxStates', () => {
  test('lifecycle facts: provisioning settles live or failed; closed stops; refreshed moves the base (#1223)', () => {
    const env = { operator: 'ops', environmentId: 'env-1' }
    const pending = { ...env, provider: 'git-worktree', kind: 'provision' }
    const base = 'a'.repeat(40)
    const refreshed = 'b'.repeat(40)
    const states = (events: unknown[]) => sandboxStates(events as never).at(-1)
    const opening = event('provisioning', pending, '2026-11-24T00:00:00Z')
    expect(states([opening])).toMatchObject({ state: 'provisioning', pendingKind: 'provision' })
    const failed = [
      opening,
      event(
        'provision-failed',
        { ...env, stage: 'setup', message: 'boom' },
        '2026-11-24T00:01:00Z',
      ),
    ]
    const failedState = states(failed)
    expect(failedState).toMatchObject({
      state: 'failed',
      failure: { stage: 'setup', message: 'boom' },
    })
    expect(failedState?.pendingKind).toBeUndefined()
    const retried = states([...failed, event('provisioning', pending, '2026-11-24T00:02:00Z')])
    expect(retried).toMatchObject({ state: 'provisioning' })
    expect(retried?.failure).toBeUndefined()
    const lived = [
      ...failed,
      event('provisioning', pending, '2026-11-24T00:02:00Z'),
      event(
        'provisioned',
        { ...env, provider: 'git-worktree', workspacePath: '/w', baseSha: base },
        '2026-11-24T00:03:00Z',
      ),
    ]
    expect(states(lived)).toMatchObject({ state: 'live', baseSha: base })
    expect(states(lived)?.failure).toBeUndefined()
    const cycle = [...lived, event('closed', env, '2026-11-24T00:04:00Z')]
    expect(states(cycle)).toMatchObject({ state: 'stopped', baseSha: base })
    const resumed = [
      ...cycle,
      event('resumed', { ...env, provider: 'git-worktree' }, '2026-11-24T00:05:00Z'),
      event(
        'refreshed',
        { ...env, baseSha: refreshed, headSha: refreshed },
        '2026-11-24T00:06:00Z',
      ),
    ]
    expect(states(resumed)).toMatchObject({
      state: 'live',
      baseSha: refreshed,
      lastEvidenceTs: '2026-11-24T00:06:00Z',
    })
  })

  test('provisioned opens a live environment; resumed refreshes evidence', () => {
    const states = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event(
        'resumed',
        { operator: 'ops', environmentId: 'env-1', provider: 'vercel-sandbox' },
        '2026-09-15T01:00:00Z',
      ),
    ])
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      operator: 'ops',
      environmentId: 'env-1',
      provider: 'vercel-sandbox',
      state: 'live',
      lastEvidenceTs: '2026-09-15T01:00:00Z',
      sessionId: 'session-1',
    })
  })

  test('activity refreshes evidence without changing state', () => {
    const states = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event('activity', { operator: 'ops', environmentId: 'env-1' }, '2026-09-15T02:00:00Z'),
      event('activity', { operator: 'ops', environmentId: 'env-1' }, '2026-09-15T03:00:00Z'),
    ])
    expect(states[0]).toMatchObject({ state: 'live', lastEvidenceTs: '2026-09-15T03:00:00Z' })
  })

  test('stopped closes; released closes; reset followed by provisioned reopens', () => {
    const stopped = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event(
        'stopped',
        { operator: 'ops', environmentId: 'env-1', reason: 'idle' },
        '2026-09-15T04:00:00Z',
      ),
    ])
    expect(stopped[0]).toMatchObject({ state: 'stopped', lastEvidenceTs: '2026-09-15T04:00:00Z' })

    const released = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event(
        'released',
        {
          operator: 'ops',
          environmentId: 'env-1',
          snapshots: { outcome: 'confirmed', deleted: 1 },
        },
        '2026-09-15T05:00:00Z',
      ),
    ])
    expect(released[0]).toMatchObject({ state: 'released', provider: 'vercel-sandbox' })

    const reopened = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event('reset', { operator: 'ops', environmentId: 'env-1' }, '2026-09-15T06:00:00Z'),
      event(
        'released',
        { operator: 'ops', environmentId: 'env-1', snapshots: { outcome: 'confirmed' } },
        '2026-09-15T07:00:00Z',
      ),
      event('provisioned', PROVISIONED, '2026-09-15T08:00:00Z'),
    ])
    expect(reopened[0]).toMatchObject({ state: 'live', lastEvidenceTs: '2026-09-15T08:00:00Z' })
  })

  test('baseSha is set on provisioned, carried forward, and overwritten by a later provision', () => {
    const withBase = { ...PROVISIONED, baseSha: 'a'.repeat(40) }
    const states = sandboxStates([
      event('provisioned', withBase, '2026-09-15T00:00:00Z'),
      event(
        'resumed',
        { operator: 'ops', environmentId: 'env-1', provider: 'vercel-sandbox' },
        '2026-09-15T01:00:00Z',
      ),
      event(
        'stopped',
        { operator: 'ops', environmentId: 'env-1', reason: 'idle' },
        '2026-09-15T02:00:00Z',
      ),
      event(
        'released',
        { operator: 'ops', environmentId: 'env-1', snapshots: { outcome: 'confirmed' } },
        '2026-09-15T03:00:00Z',
      ),
    ])
    expect(states[0]).toMatchObject({ baseSha: 'a'.repeat(40) })

    // A fresh provision overwrites the carried-forward value.
    const reprovisioned = sandboxStates([
      event('provisioned', withBase, '2026-09-15T00:00:00Z'),
      event('provisioned', { ...PROVISIONED, baseSha: 'b'.repeat(40) }, '2026-09-15T04:00:00Z'),
    ])
    expect(reprovisioned[0]).toMatchObject({ state: 'live', baseSha: 'b'.repeat(40) })

    // A snapshot provisioned before the field existed has no baseSha.
    const legacy = sandboxStates([event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z')])
    expect(legacy[0]).not.toHaveProperty('baseSha')
  })

  test('operators and environments track independently', () => {
    const states = sandboxStates([
      event('provisioned', PROVISIONED, '2026-09-15T00:00:00Z'),
      event(
        'provisioned',
        { ...PROVISIONED, operator: 'other', environmentId: 'env-2' },
        '2026-09-15T00:30:00Z',
      ),
      event(
        'stopped',
        { operator: 'ops', environmentId: 'env-1', reason: 'idle' },
        '2026-09-15T01:00:00Z',
      ),
    ])
    expect(states).toHaveLength(2)
    expect(states.find((state) => state.operator === 'ops')).toMatchObject({ state: 'stopped' })
    expect(states.find((state) => state.operator === 'other')).toMatchObject({ state: 'live' })
  })
})
