/** Reducer tests for the durable operator-sandbox state projection
 * (AUT-340): pure functions over the repository journal. */
import { describe, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import { sandboxStates } from './sandbox-state'

const repo = 'acme/widgets'
let seq = 0

function event(
  type: 'provisioned' | 'resumed' | 'activity' | 'stopped' | 'released' | 'reset',
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
