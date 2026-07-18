import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { claimedOccurrenceKeys, openHarvestRun, reduceHarvest } from './harvest'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'

describe('reduceHarvest', () => {
  test('derives claims, resumable failures, terminal dispositions, and the ledger only from events', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_1',
        observations: [
          { build: 'a', seq: 4 },
          { build: 'b', seq: 9 },
        ],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_1',
        step: 'synthesize',
        round: 1,
        attempt: 1,
        error: 'runner unavailable',
        willRetry: true,
      },
    })

    let state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(openHarvestRun(state)?.run).toBe('h_1')
    expect(state.latest).toMatchObject({
      status: 'running',
      failure: { attempt: 1, willRetry: true },
    })
    expect([...claimedOccurrenceKeys(state)].sort()).toEqual(['a:4', 'b:9'])
    expect(state.ledger).toEqual([])

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.filed',
      payload: {
        run: 'h_1',
        proposalKey: 'cluster-1',
        ticket: { source: 'fake', id: 'T-1', title: 'Cluster one' },
      },
    })
    // Replayed filing facts remain one projected entry per stable key.
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.filed',
      payload: {
        run: 'h_1',
        proposalKey: 'cluster-1',
        ticket: { source: 'fake', id: 'T-1', title: 'Cluster one' },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_1',
        dispositions: [
          {
            occurrence: { build: 'a', seq: 4 },
            action: 'filed',
            proposalKey: 'cluster-1',
            ticket: { source: 'fake', id: 'T-1', title: 'Cluster one' },
          },
          {
            occurrence: { build: 'b', seq: 9 },
            action: 'suppressed',
            proposalKey: 'suppressed:b:9',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      },
    })

    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(openHarvestRun(state)).toBeUndefined()
    expect(state.latest).toMatchObject({ status: 'completed' })
    expect(state.latest?.filed).toHaveLength(1)
    expect(state.ledger).toHaveLength(2)
    expect(state.ledger.map((entry) => entry.action)).toEqual([
      'filed',
      'suppressed',
    ])
  })

  test('a non-retrying infrastructure failure is terminal but preserves the claim', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_failed',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_failed',
        step: 'review',
        round: 2,
        attempt: 2,
        error: 'no-terminal',
        willRetry: false,
      },
    })

    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest).toMatchObject({
      status: 'failed',
      failure: { step: 'review', round: 2, willRetry: false },
    })
    expect(openHarvestRun(state)).toBeUndefined()
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:1'])
  })

  test('validates UUID v4 reservations and restricts them to the kernel actor', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_reservation',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    const id = crypto.randomUUID()
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.id-reserved',
      payload: { run: 'h_reservation', proposalKey: 'cluster-1', id },
    })

    await expect(
      store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.proposal.id-reserved',
        payload: {
          run: 'h_reservation',
          proposalKey: 'cluster-2',
          id: Bun.randomUUIDv5('cluster-2', 'dns'),
        },
      }),
    ).rejects.toThrow(/uuid/i)
    await expect(
      store.appendRepo('/repo', {
        actor: DISPATCHER,
        type: 'harvest.proposal.id-reserved',
        payload: {
          run: 'h_reservation',
          proposalKey: 'cluster-2',
          id: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow(/may not emit/)

    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      reservations: [{ proposalKey: 'cluster-1', id }],
      filed: [],
      dispositions: [],
    })
  })

  test('replays an identical reservation as one logical mapping', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_replay',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    const id = crypto.randomUUID()
    for (let replay = 0; replay < 2; replay += 1) {
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.proposal.id-reserved',
        payload: { run: 'h_replay', proposalKey: 'cluster-1', id },
      })
    }

    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest?.reservations).toEqual([
      { proposalKey: 'cluster-1', id, seq: 2 },
    ])
  })

  for (const contradiction of ['key-remapped', 'id-reused'] as const) {
    test(`throws when a reservation is contradicted by ${contradiction}`, async () => {
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await store.ensureRepo('/repo')
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_contradiction',
          observations: [{ build: 'a', seq: 1 }],
          scan: { kind: 'harvest-scan', rev: 0 },
        },
      })
      const firstId = crypto.randomUUID()
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.proposal.id-reserved',
        payload: {
          run: 'h_contradiction',
          proposalKey: 'cluster-1',
          id: firstId,
        },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.proposal.id-reserved',
        payload: {
          run: 'h_contradiction',
          proposalKey:
            contradiction === 'key-remapped' ? 'cluster-1' : 'cluster-2',
          id: contradiction === 'key-remapped' ? crypto.randomUUID() : firstId,
        },
      })

      const events = await store.getRepoEvents('/repo')
      expect(() => reduceHarvest(events)).toThrow(
        contradiction === 'key-remapped'
          ? /cannot replace it/
          : /cannot reuse it/,
      )
    })
  }

  test('throws on cross-event references to an unknown run', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'missing', step: 'scan' },
    })

    const events = await store.getRepoEvents('/repo')
    expect(() => reduceHarvest(events)).toThrow(/unknown harvest run "missing"/)
  })
})
