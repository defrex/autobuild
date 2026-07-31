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
  reconcileOriginatingTickets,
  resolveHarvestCreateBlockers,
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

describe('harvest blocker resolution', () => {
  const proposal = {
    action: 'create' as const,
    title: 'Dependent work',
    whatWhy: 'The work requires an existing prerequisite.',
    acceptanceCriteria: ['The work is complete.'],
    outOfScope: ['Unrelated work.'],
    observations: [{ build: 'build-a', seq: 1 }],
  }
  const proposalObservations = [
    {
      occurrence: { build: 'build-a', seq: 1 },
      id: 'obs-a',
      kind: 'followup' as const,
      summary: 'follow-up',
      ts: '2026-08-01T00:00:00.000Z',
    },
  ]

  test('deduplicates valid source-local ids in first-seen order', async () => {
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'fake-8' },
        title: 'Eight',
        body: 'body',
        state: 'Ready',
        labels: [],
      },
      {
        ref: { source: 'fake', id: 'fake-9' },
        title: 'Nine',
        body: 'body',
        state: 'Done',
        labels: [],
      },
    ])

    expect(
      await resolveHarvestCreateBlockers(
        { ...proposal, blockedBy: ['fake-9', 'fake-8', 'fake-9'] },
        proposalObservations,
        tickets,
      ),
    ).toEqual({
      blockedBy: ['fake-9', 'fake-8'],
      provenance: { declared: ['fake-9', 'fake-8'], derived: [] },
    })
    expect(tickets.dependencyQueries).toEqual([['fake-9', 'fake-8']])
  })

  test('an absent or empty set performs no source read', async () => {
    const tickets = new FakeTicketSource()
    expect(await resolveHarvestCreateBlockers(proposal, proposalObservations, tickets)).toEqual({
      blockedBy: [],
      provenance: { declared: [], derived: [] },
    })
    expect(
      await resolveHarvestCreateBlockers(
        { ...proposal, blockedBy: [] },
        proposalObservations,
        tickets,
      ),
    ).toEqual({
      blockedBy: [],
      provenance: { declared: [], derived: [] },
    })
    expect(tickets.dependencyQueries).toEqual([])
  })

  test('rejects an unknown id with proposal, source, and blocker context', async () => {
    const tickets = new FakeTicketSource()
    await expect(
      resolveHarvestCreateBlockers(
        { ...proposal, blockedBy: ['other-404'] },
        proposalObservations,
        tickets,
      ),
    ).rejects.toThrow(
      'cannot file harvest proposal "Dependent work" through ticket source "fake": unknown or invalid blocker "other-404"',
    )
  })

  test('unions unresolved matching origins while retaining overlapping provenance', async () => {
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'fake-8' },
        title: 'Origin',
        body: 'body',
        state: 'Ready',
        labels: [],
      },
    ])
    const observations = [
      {
        occurrence: { build: 'build-a', seq: 1 },
        id: 'obs-a',
        kind: 'followup' as const,
        summary: 'follow-up',
        ts: '2026-08-01T00:00:00.000Z',
        ticket: { source: 'fake', id: 'fake-8' },
      },
    ]

    expect(
      await resolveHarvestCreateBlockers(
        { ...proposal, blockedBy: ['fake-8'] },
        observations,
        tickets,
      ),
    ).toEqual({
      blockedBy: ['fake-8'],
      provenance: { declared: ['fake-8'], derived: ['fake-8'] },
    })
    expect(tickets.dependencyQueries).toEqual([['fake-8']])
  })

  test('drops missing, resolved, foreign-source, and absent origins', async () => {
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'fake-done' },
        title: 'Done origin',
        body: 'body',
        state: 'Done',
        labels: [],
      },
    ])
    const observations = [
      {
        occurrence: { build: 'missing', seq: 1 },
        id: 'missing',
        kind: 'followup' as const,
        summary: 'missing origin',
        ts: '2026-08-01T00:00:00.000Z',
        ticket: { source: 'fake', id: 'fake-missing' },
      },
      {
        occurrence: { build: 'done', seq: 1 },
        id: 'done',
        kind: 'followup' as const,
        summary: 'resolved origin',
        ts: '2026-08-01T00:00:00.000Z',
        ticket: { source: 'fake', id: 'fake-done' },
      },
      {
        occurrence: { build: 'foreign', seq: 1 },
        id: 'foreign',
        kind: 'followup' as const,
        summary: 'foreign origin',
        ts: '2026-08-01T00:00:00.000Z',
        ticket: { source: 'linear', id: 'AUT-1' },
      },
      {
        occurrence: { build: 'none', seq: 1 },
        id: 'none',
        kind: 'followup' as const,
        summary: 'no origin',
        ts: '2026-08-01T00:00:00.000Z',
      },
    ]
    const clustered = {
      ...proposal,
      observations: observations.map((item) => item.occurrence),
    }

    expect(await resolveHarvestCreateBlockers(clustered, observations, tickets)).toEqual({
      blockedBy: [],
      provenance: { declared: [], derived: [] },
    })
    expect(tickets.dependencyQueries).toEqual([['fake-missing', 'fake-done']])
  })
})

describe('harvest deterministic scan and ledger', () => {
  test('projects distinct origin lifecycle without querying foreign sources', async () => {
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'origin-open' },
        title: 'Open',
        body: 'body',
        state: 'Doing',
        labels: [],
      },
      {
        ref: { source: 'fake', id: 'origin-done' },
        title: 'Done',
        body: 'body',
        state: 'Done',
        labels: [],
      },
    ])
    const base = {
      id: 'obs',
      kind: 'followup' as const,
      summary: 'follow-up',
      ts: '2026-08-01T00:00:00.000Z',
    }
    const origins = await reconcileOriginatingTickets(
      [
        {
          ...base,
          occurrence: { build: 'a', seq: 1 },
          ticket: { source: 'fake', id: 'origin-open' },
        },
        {
          ...base,
          occurrence: { build: 'b', seq: 1 },
          ticket: { source: 'fake', id: 'origin-open' },
        },
        {
          ...base,
          occurrence: { build: 'c', seq: 1 },
          ticket: { source: 'linear', id: 'AUT-1' },
        },
        {
          ...base,
          occurrence: { build: 'd', seq: 1 },
          ticket: { source: 'fake', id: 'origin-done' },
        },
        {
          ...base,
          occurrence: { build: 'e', seq: 1 },
          ticket: { source: 'fake', id: 'origin-missing' },
        },
      ],
      tickets,
    )

    expect(origins).toEqual([
      {
        ticket: { source: 'fake', id: 'origin-open' },
        sourceMatches: true,
        exists: true,
        resolved: false,
      },
      {
        ticket: { source: 'linear', id: 'AUT-1' },
        sourceMatches: false,
        exists: false,
        resolved: false,
      },
      {
        ticket: { source: 'fake', id: 'origin-done' },
        sourceMatches: true,
        exists: true,
        resolved: true,
      },
      {
        ticket: { source: 'fake', id: 'origin-missing' },
        sourceMatches: true,
        exists: false,
        resolved: false,
      },
    ])
    expect(tickets.dependencyQueries).toEqual([['origin-open', 'origin-done', 'origin-missing']])
  })

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
    for (const build of ['filed', 'missing', 'joined', 'tombstone', 'suppressed']) {
      await observation(store, build, `${build}-observation`)
    }
    const initial = await scanUnclaimedObservations(store, '/repo')
    const byBuild = new Map(initial.observations.map((item) => [item.occurrence.build, item]))
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
    // A later terminal run must not hide this older run from recovery or make
    // its selective release invalid.
    await observation(store, 'later-completed', 'later-observation')
    await claim(store, 'h_later_completed', [{ build: 'later-completed', seq: 1 }])
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-report', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.completed',
        payload: {
          run: 'h_later_completed',
          dispositions: [
            {
              occurrence: { build: 'later-completed', seq: 1 },
              action: 'suppressed',
              proposalKey: 'later-completed',
            },
          ],
          report: artifactRef(deposited[0]!),
        },
      }),
    )
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
    expect(
      state.ledger.filter((item) => item.run === 'h_partial').map((item) => item.action),
    ).toEqual(['filed', 'joined', 'suppressed'])
    const nextPacket = await makeHarvestScanPacket({
      store,
      tickets: new FakeTicketSource(),
      repo: '/repo',
      run: 'h_next',
      observations: released.observations,
      state,
    })
    expect(nextPacket.ledger.map((entry) => entry.proposalKey)).toEqual(
      [filedKey, 'prior-key'].sort(),
    )
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
    expect(await partitionHarvestExhaustion({ store, repo: '/repo', run })).toEqual({
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
    expect(await partitionHarvestExhaustion({ store, repo: '/repo', run })).toEqual({
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
                observations: scan.observations.map((item) => item.occurrence),
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
    await expect(partitionHarvestExhaustion({ store, repo: '/repo', run })).rejects.toThrow(
      'temporary artifact transport outage',
    )

    store.getRepoArtifact = async (repo, kind, rev) => {
      if (kind === 'harvest-scan') {
        throw new Error('temporary scan transport outage')
      }
      return read(repo, kind, rev)
    }
    await expect(partitionHarvestExhaustion({ store, repo: '/repo', run })).rejects.toThrow(
      'temporary scan transport outage',
    )
    store.getRepoArtifact = read
  })
})
