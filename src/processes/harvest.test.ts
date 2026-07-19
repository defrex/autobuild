import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import { reduceHarvest } from '../kernel/harvest'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import {
  artifactRef,
  harvestProposalKey,
  makeHarvestScanPacket,
  partitionHarvestExhaustion,
  scanUnclaimedObservations,
} from './harvest'

async function observation(store: MemoryBuildStore, build: string, id: string): Promise<void> {
  if ((await store.getBuild(build)) === null) {
    await store.createBuild({ slug: build, repo: '/repo' })
  }
  await store.append(build, {
    actor: agentActor('implement', `s-${build}`),
    type: 'observation.recorded',
    payload: { id, kind: 'followup', summary: id },
  })
}

async function claim(
  store: MemoryBuildStore,
  run: string,
  observations: Array<{ build: string; seq: number }>,
): Promise<void> {
  await store.ensureRepo('/repo')
  await store.appendRepoWithArtifacts(
    '/repo',
    [{ kind: 'harvest-scan', content: '{}' }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: { run, observations, scan: artifactRef(deposited[0]!) },
    }),
  )
}

describe('harvest deterministic scan and ledger', () => {
  test('per-build seq collisions are distinct; a started snapshot claims only its immutable members', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    await observation(store, 'b', 'b1')
    const first = await scanUnclaimedObservations(store, '/repo')
    expect(first.observations.map((item) => item.occurrence)).toEqual([
      { build: 'a', seq: 1 },
      { build: 'b', seq: 1 },
    ])
    await claim(store, 'h_1', [{ build: 'a', seq: 1 }])
    await observation(store, 'a', 'a2-late')
    const next = await scanUnclaimedObservations(store, '/repo')
    expect(next.observations.map((item) => item.occurrence)).toEqual([
      { build: 'a', seq: 2 },
      { build: 'b', seq: 1 },
    ])
  })

  test('terminal dispositions reduce into the authoritative ledger and never rescan', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    await claim(store, 'h_1', [{ build: 'a', seq: 1 }])
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-report', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.completed',
        payload: {
          run: 'h_1',
          dispositions: [
            {
              occurrence: { build: 'a', seq: 1 },
              action: 'suppressed',
              proposalKey: 'key',
              reason: 'duplicate',
            },
          ],
          report: artifactRef(deposited[0]!),
        },
      }),
    )
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('completed')
    expect(state.ledger).toHaveLength(1)
    expect((await scanUnclaimedObservations(store, '/repo')).observations).toEqual([])
  })

  test('exhaustion commits filed/joined/suppressed members and releases only a missing create', async () => {
    const store = new MemoryBuildStore()
    for (const build of [
      'filed',
      'missing',
      'joined',
      'tombstone',
      'suppressed',
    ]) {
      await observation(store, build, `${build}-observation`)
    }
    const initial = await scanUnclaimedObservations(store, '/repo')
    const byBuild = new Map(
      initial.observations.map((item) => [item.occurrence.build, item]),
    )
    const proposals = {
      proposals: [
        {
          action: 'create' as const,
          title: 'Filed proposal',
          whatWhy: 'Already committed before the provider stopped.',
          acceptanceCriteria: ['The filed issue is resolved.'],
          outOfScope: ['Unrelated work.'],
          observations: [byBuild.get('filed')!.occurrence],
        },
        {
          action: 'create' as const,
          title: 'Pending proposal',
          whatWhy: 'Still needs a ticket after recovery gives up.',
          acceptanceCriteria: ['The pending issue is resolved.'],
          outOfScope: ['Unrelated work.'],
          observations: [byBuild.get('missing')!.occurrence],
        },
        {
          action: 'join' as const,
          ticket: { source: 'fake', id: 'T-old' },
          observations: [byBuild.get('joined')!.occurrence],
          reason: 'Covered by the prior proposal.',
        },
        {
          action: 'join' as const,
          ticket: { source: 'fake', id: 'T-gone' },
          observations: [byBuild.get('tombstone')!.occurrence],
          reason: 'The frozen target is now a tombstone.',
        },
        {
          action: 'suppress' as const,
          observations: [byBuild.get('suppressed')!.occurrence],
          reason: 'Not actionable.',
        },
      ],
    }
    const packet = {
      repo: '/repo',
      run: 'h_partial',
      observations: initial.observations,
      ledger: [
        {
          proposalKey: 'prior-key',
          ticket: { source: 'fake', id: 'T-old' },
          exists: true,
          resolved: false,
        },
        {
          proposalKey: 'gone-key',
          ticket: { source: 'fake', id: 'T-gone' },
          exists: true,
          resolved: true,
        },
      ],
    }
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_partial',
          observations: initial.observations.map((item) => item.occurrence),
          scan: artifactRef(deposited[0]!),
        },
      }),
    )
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-proposals', content: JSON.stringify(proposals) }],
      (deposited) => ({
        actor: agentActor('harvest', 'hs_1'),
        type: 'harvest.proposals.submitted',
        payload: {
          run: 'h_partial',
          round: 1,
          artifact: artifactRef(deposited[0]!),
        },
      }),
    )
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-review', content: 'approved' }],
      (deposited) => ({
        actor: agentActor('harvest-review', 'hr_1'),
        type: 'harvest.review.verdict',
        payload: {
          run: 'h_partial',
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: artifactRef(deposited[0]!),
        },
      }),
    )
    const filedKey = harvestProposalKey(proposals.proposals[0]!)
    const pendingKey = harvestProposalKey(proposals.proposals[1]!)
    const tombstoneKey = harvestProposalKey(proposals.proposals[3]!)
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.filed',
      payload: {
        run: 'h_partial',
        proposalKey: filedKey,
        ticket: { source: 'fake', id: 'T-new' },
      },
    })

    let state = reduceHarvest(await store.getRepoEvents('/repo'))
    const partition = await partitionHarvestExhaustion({
      store,
      repo: '/repo',
      run: state.latest!,
    })
    expect(partition.releasedObservations).toEqual([
      byBuild.get('missing')!.occurrence,
      byBuild.get('tombstone')!.occurrence,
    ])
    expect(partition.pendingProposals).toEqual([
      {
        proposalKey: pendingKey,
        action: 'create',
        observations: [byBuild.get('missing')!.occurrence],
      },
      {
        proposalKey: tombstoneKey,
        action: 'join',
        observations: [byBuild.get('tombstone')!.occurrence],
      },
    ])
    expect(partition.committedDispositions.map((item) => item.action)).toEqual([
      'filed',
      'joined',
      'suppressed',
    ])

    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: 'h_partial',
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
        payload: { run: 'h_partial', attempt, limit: 2 },
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
          run: 'h_partial',
          step: 'file',
          attempt: attempt + 2,
          error: 'provider unavailable',
          willRetry: false,
        },
      })
    }
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: 'h_partial',
        step: 'file',
        error: 'provider unavailable',
        attempts: 2,
        limit: 2,
        ...partition,
      },
    })

    const released = await scanUnclaimedObservations(store, '/repo')
    expect(released.observations.map((item) => item.occurrence)).toEqual([
      byBuild.get('missing')!.occurrence,
      byBuild.get('tombstone')!.occurrence,
    ])
    state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.ledger.map((item) => item.action)).toEqual([
      'filed',
      'joined',
      'suppressed',
    ])
    const nextPacket = await makeHarvestScanPacket({
      store,
      tickets: new FakeTicketSource(),
      repo: '/repo',
      run: 'h_next',
      observations: released.observations,
      state,
    })
    expect(nextPacket.ledger.map((entry) => entry.proposalKey)).toEqual([
      filedKey,
      'prior-key',
    ].sort())
  })

  test('pre-approval and malformed approved exhaustion release the whole snapshot', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    await observation(store, 'b', 'b1')
    const scan = await scanUnclaimedObservations(store, '/repo')
    const packet = {
      repo: '/repo',
      run: 'h_unapproved',
      observations: scan.observations,
      ledger: [],
    }
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_unapproved',
          observations: scan.observations.map((item) => item.occurrence),
          scan: artifactRef(deposited[0]!),
        },
      }),
    )
    let run = reduceHarvest(await store.getRepoEvents('/repo')).latest!
    expect(
      await partitionHarvestExhaustion({ store, repo: '/repo', run }),
    ).toEqual({
      releasedObservations: scan.observations.map((item) => item.occurrence),
      committedDispositions: [],
      pendingProposals: [],
    })

    await store.appendRepoWithArtifacts(
      '/repo',
      [
        {
          kind: 'harvest-proposals',
          content: JSON.stringify({
            proposals: [
              {
                action: 'suppress',
                observations: [scan.observations[0]!.occurrence],
                reason: 'only half covered',
              },
            ],
          }),
        },
      ],
      (deposited) => ({
        actor: agentActor('harvest', 'hs_bad'),
        type: 'harvest.proposals.submitted',
        payload: {
          run: 'h_unapproved',
          round: 1,
          artifact: artifactRef(deposited[0]!),
        },
      }),
    )
    await store.appendRepo('/repo', {
      actor: agentActor('harvest-review', 'hr_bad'),
      type: 'harvest.review.verdict',
      payload: {
        run: 'h_unapproved',
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'harvest-review', rev: 0 },
      },
    })
    run = reduceHarvest(await store.getRepoEvents('/repo')).latest!
    expect(
      await partitionHarvestExhaustion({ store, repo: '/repo', run }),
    ).toEqual({
      releasedObservations: scan.observations.map((item) => item.occurrence),
      committedDispositions: [],
      pendingProposals: [],
    })
  })

  test('transient artifact read failures keep exhaustion settlement retryable', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    const scan = await scanUnclaimedObservations(store, '/repo')
    const packet = {
      repo: '/repo',
      run: 'h_transient',
      observations: scan.observations,
      ledger: [],
    }
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_transient',
          observations: scan.observations.map((item) => item.occurrence),
          scan: artifactRef(deposited[0]!),
        },
      }),
    )
    await store.appendRepoWithArtifacts(
      '/repo',
      [
        {
          kind: 'harvest-proposals',
          content: JSON.stringify({
            proposals: [
              {
                action: 'suppress',
                observations: scan.observations.map(
                  (item) => item.occurrence,
                ),
                reason: 'not actionable',
              },
            ],
          }),
        },
      ],
      (deposited) => ({
        actor: agentActor('harvest', 'hs_transient'),
        type: 'harvest.proposals.submitted',
        payload: {
          run: 'h_transient',
          round: 1,
          artifact: artifactRef(deposited[0]!),
        },
      }),
    )
    await store.appendRepo('/repo', {
      actor: agentActor('harvest-review', 'hr_transient'),
      type: 'harvest.review.verdict',
      payload: {
        run: 'h_transient',
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'harvest-review', rev: 0 },
      },
    })
    const run = reduceHarvest(await store.getRepoEvents('/repo')).latest!
    const read = store.getRepoArtifact.bind(store)

    store.getRepoArtifact = async () => {
      throw new Error('temporary artifact transport outage')
    }
    await expect(
      partitionHarvestExhaustion({ store, repo: '/repo', run }),
    ).rejects.toThrow('temporary artifact transport outage')

    store.getRepoArtifact = async (repo, kind, rev) => {
      if (kind === 'harvest-scan') {
        throw new Error('temporary scan transport outage')
      }
      return read(repo, kind, rev)
    }
    await expect(
      partitionHarvestExhaustion({ store, repo: '/repo', run }),
    ).rejects.toThrow('temporary scan transport outage')
    store.getRepoArtifact = read
  })
})
