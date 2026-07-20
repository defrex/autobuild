import { describe, expect, test } from 'bun:test'
import { DISPATCHER, agentActor, humanActor, KERNEL } from '../events/envelope'
import {
  claimedOccurrenceKeys,
  decideHarvestControl,
  openHarvestRun,
  reduceHarvest,
} from './harvest'
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

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('completed')
    expect(openHarvestRun(state)).toBeUndefined()
  })

  test('ignores interleaved dispatcher settings without changing harvest decisions', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_mixed',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    const before = reduceHarvest(await store.getRepoEvents('/repo'))
    const beforeDecision = decideHarvestControl(before)

    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })
    const after = reduceHarvest(await store.getRepoEvents('/repo'))
    const { lastSeq: _beforeSeq, ...beforeWorkflow } = before
    const { lastSeq: _afterSeq, ...afterWorkflow } = after
    expect(afterWorkflow).toEqual(beforeWorkflow)
    expect(after.lastSeq).toBe(3)
    expect(decideHarvestControl(after)).toEqual(beforeDecision)
  })

  test('reduces durable pause commands without terminalizing or replacing the open run', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_paused',
        observations: [{ build: 'a', seq: 7 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })

    let state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.paused).toBe(false)
    expect(state.pendingCommands).toEqual([
      {
        command: 'pause',
        seq: 2,
        actor: humanActor('operator'),
      },
    ])
    expect(decideHarvestControl(state)).toEqual({
      kind: 'acknowledge',
      command: 'pause',
    })

    const acknowledged = await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state).toMatchObject({
      paused: true,
      pausedSeq: acknowledged.seq,
      pausedAt: acknowledged.ts,
      pendingCommands: [],
    })
    expect(decideHarvestControl(state)).toEqual({ kind: 'park' })
    expect(openHarvestRun(state)).toMatchObject({
      run: 'h_paused',
      status: 'running',
      observations: [{ build: 'a', seq: 7 }],
    })

    // A duplicate pause cannot resurrect after the opposing resume command.
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.pendingCommands.map((command) => command.command)).toEqual([
      'resume',
    ])
    expect(decideHarvestControl(state)).toEqual({
      kind: 'acknowledge',
      command: 'resume',
    })

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.paused).toBe(false)
    expect(state.pausedSeq).toBeUndefined()
    expect(state.pausedAt).toBeUndefined()
    expect(state.pendingCommands).toEqual([])
    expect(openHarvestRun(state)?.run).toBe('h_paused')
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:7'])
  })

  test('an errored run requests automatic recovery and reopens the same durable snapshot', async () => {
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
      type: 'harvest.step.completed',
      payload: {
        run: 'h_failed',
        step: 'synthesize',
        round: 2,
        outcome: 'completed',
        artifact: { kind: 'harvest-proposals', rev: 1 },
      },
    })
    await store.appendRepo('/repo', {
      actor: agentActor('harvest', 'hs_2'),
      type: 'harvest.proposals.submitted',
      payload: {
        run: 'h_failed',
        round: 2,
        artifact: { kind: 'harvest-proposals', rev: 1 },
      },
    })
    await store.appendRepo('/repo', {
      actor: agentActor('harvest-review', 'hr_2'),
      type: 'harvest.review.verdict',
      payload: {
        run: 'h_failed',
        round: 2,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'harvest-review', rev: 1 },
      },
    })
    const reserved = crypto.randomUUID()
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.id-reserved',
      payload: { run: 'h_failed', proposalKey: 'cluster-a', id: reserved },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.filed',
      payload: {
        run: 'h_failed',
        proposalKey: 'cluster-a',
        ticket: { source: 'fake', id: 'T-1', title: 'Already filed' },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_failed',
        step: 'file',
        attempt: 2,
        error: 'ticket provider unavailable',
        willRetry: false,
      },
    })

    let state = reduceHarvest(await store.getRepoEvents('/repo'))
    const preserved = structuredClone({
      observations: state.latest?.observations,
      scan: state.latest?.scan,
      steps: state.latest?.steps,
      proposals: state.latest?.proposals,
      reviews: state.latest?.reviews,
      reservations: state.latest?.reservations,
      filed: state.latest?.filed,
    })
    expect(state.latest).toMatchObject({
      run: 'h_failed',
      status: 'failed',
      failure: { step: 'file', attempt: 2, willRetry: false },
    })
    expect(state.latest?.terminalSeq).toBeUndefined()
    expect(openHarvestRun(state)).toBeUndefined()
    expect(decideHarvestControl(state)).toEqual({
      kind: 'request-recovery',
      run: 'h_failed',
      attempt: 1,
      limit: 2,
    })
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:1'])

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_failed', attempt: 1, limit: 2 },
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('failed')
    expect(decideHarvestControl(state)).toEqual({
      kind: 'acknowledge',
      command: 'resume',
    })

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest).toMatchObject({
      run: 'h_failed',
      status: 'running',
      recoveryRequests: [
        { attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) },
      ],
    })
    expect(state.latest?.failure).toBeUndefined()
    expect(state.latest?.terminalSeq).toBeUndefined()
    expect(openHarvestRun(state)?.run).toBe('h_failed')
    expect(decideHarvestControl(state)).toEqual({ kind: 'proceed' })
    expect({
      observations: state.latest?.observations,
      scan: state.latest?.scan,
      steps: state.latest?.steps,
      proposals: state.latest?.proposals,
      reviews: state.latest?.reviews,
      reservations: state.latest?.reservations,
      filed: state.latest?.filed,
    }).toEqual(preserved)
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:1'])
  })

  test('one resume clears both a pause gate and an errored run', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_paused_failed',
        observations: [{ build: 'a', seq: 2 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_paused_failed',
        step: 'review',
        round: 1,
        attempt: 1,
        error: 'provider rejected the turn',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })

    expect(decideHarvestControl(reduceHarvest(await store.getRepoEvents('/repo')))).toEqual({
      kind: 'acknowledge',
      command: 'resume',
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state).toMatchObject({
      paused: false,
      latest: { run: 'h_paused_failed', status: 'running' },
    })
    expect(state.latest?.failure).toBeUndefined()
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:2'])
  })

  test('exhaustion selectively releases pending work and requires one human acknowledgement', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_exhausted',
        observations: [
          { build: 'a', seq: 1 },
          { build: 'b', seq: 2 },
        ],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_exhausted',
        step: 'file',
        attempt: 2,
        error: 'provider unavailable',
        willRetry: false,
      },
    })
    for (const attempt of [1, 2]) {
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.recovery-requested',
        payload: { run: 'h_exhausted', attempt, limit: 2 },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.resumed',
        payload: {},
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run: 'h_exhausted',
          step: 'file',
          attempt: attempt + 2,
          error: 'provider unavailable',
          willRetry: false,
        },
      })
    }

    expect(
      decideHarvestControl(
        reduceHarvest(await store.getRepoEvents('/repo')),
      ),
    ).toEqual({
      kind: 'exhaust-recovery',
      run: 'h_exhausted',
      attempts: 2,
      limit: 2,
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: 'h_exhausted',
        step: 'file',
        error: 'provider unavailable',
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'b', seq: 2 }],
        committedDispositions: [
          {
            occurrence: { build: 'a', seq: 1 },
            action: 'filed',
            proposalKey: 'filed-a',
            ticket: { source: 'fake', id: 'T-1' },
          },
        ],
        pendingProposals: [
          {
            proposalKey: 'pending-b',
            action: 'create',
            observations: [{ build: 'b', seq: 2 }],
          },
        ],
      },
    })

    let state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect([...claimedOccurrenceKeys(state)]).toEqual(['a:1'])
    expect(state.ledger).toEqual([
      expect.objectContaining({
        run: 'h_exhausted',
        action: 'filed',
        occurrence: { build: 'a', seq: 1 },
      }),
    ])
    expect(state.latest).toMatchObject({
      status: 'failed',
      failure: { step: 'file', error: 'provider unavailable' },
      recoveryExhaustion: {
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'b', seq: 2 }],
        pendingProposals: [{ proposalKey: 'pending-b' }],
      },
      terminalSeq: expect.any(Number),
    })
    expect(decideHarvestControl(state)).toEqual({ kind: 'park' })

    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    expect(
      decideHarvestControl(
        reduceHarvest(await store.getRepoEvents('/repo')),
      ),
    ).toEqual({ kind: 'acknowledge', command: 'resume' })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('failed')
    expect(
      state.latest?.recoveryExhaustion?.attentionAcknowledgedSeq,
    ).toEqual(expect.any(Number))
    expect(decideHarvestControl(state)).toEqual({ kind: 'proceed' })
  })

  test('rejects non-monotonic automatic recovery request facts', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_invalid',
        observations: [{ build: 'a', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_invalid',
        step: 'review',
        round: 1,
        attempt: 2,
        error: 'down',
        willRetry: false,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: 'h_invalid', attempt: 2, limit: 2 },
    })
    const events = await store.getRepoEvents('/repo')
    expect(() => reduceHarvest(events)).toThrow(/must be 1/)
  })

  test('repository gate resume never reopens a deliberate escalation', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_escalated',
        observations: [{ build: 'a', seq: 3 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: 'h_escalated',
        source: 'agent',
        reason: 'human judgment required',
        observations: [{ build: 'a', seq: 3 }],
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })

    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest).toMatchObject({
      run: 'h_escalated',
      status: 'escalated',
      escalation: { source: 'agent' },
    })
    expect(openHarvestRun(state)).toBeUndefined()
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
