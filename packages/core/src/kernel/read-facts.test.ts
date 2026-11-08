import { decodeLog } from './log-index-value'
import { expect, test } from 'bun:test'
import { randomBuildLog } from './generators/build-log'
import { REPLACED_HEADS_CAP, buildReadFactsReducer, buildStreamSeedReducer } from './read-facts'
import { buildReducer, reduceBuild } from './reducer'
import { autoMergeDeferralObservation, currentDeferralObservationReducer } from './auto-merge'
import { mergeDecision } from '../cli/attention'
import { indexLog } from './log-index'
import { publicationStateReducer } from '../processes/publication-state'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts, readBuildStreamSeed } from '../store/reduced-reads'
import { KERNEL, humanActor } from '../events/envelope'

const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value))

// Every prefix is checked against a whole-prefix oracle, so this is quadratic by
// design: ~3 s on a 4-vCPU build sandbox and over 5 s with integration running
// concurrently in verify (AUT-1166).
const QUADRATIC_ORACLE_TIMEOUT_MS = 20_000

test(
  'persisted stream seed preserves every prefix and first-eligibility order through JSON',
  () => {
    for (let id = 1; id <= 12; id++) {
      const events = randomBuildLog(id, 100)
      let seed = buildStreamSeedReducer.initial()
      let carried = roundtrip(seed)
      const expected: number[] = []
      for (let i = 0; i < events.length; i++) {
        seed = buildStreamSeedReducer.advance(carried, [events[i]!])
        const prefix = events.slice(0, i + 1)
        const state = reduceBuild(prefix)
        const decision = mergeDecision(prefix, new Date(0), state)
        if (decision && !expected.includes(decision.pr.number)) expected.push(decision.pr.number)
        expect(buildReducer.finish(seed.build)).toEqual(state)
        expect(seed.deferral).toEqual(currentDeferralObservationReducer.reduce(prefix))
        expect(seed.mergeAttentionPrs).toEqual(expected)
        const before = roundtrip(seed)
        const finished = buildStreamSeedReducer.finish(seed)
        finished.mergeAttentionPrs.push(-1)
        expect(seed).toEqual(before)
        // `before` is a fresh JSON copy equal to `seed`, so it is the next step's input.
        carried = before
      }
    }
  },
  QUADRATIC_ORACLE_TIMEOUT_MS,
)

test('JSON-safe build facts reconstruct collection and publication contracts', () => {
  for (let id = 1; id <= 8; id++) {
    const events = randomBuildLog(id, 150)
    let acc = buildReadFactsReducer.initial()
    for (let i = 0; i < events.length; i += 7) {
      acc = buildReadFactsReducer.advance(roundtrip(acc), events.slice(i, i + 7))
      const prefix = events.slice(0, i + 7)
      const facts = roundtrip(buildReadFactsReducer.finish(acc))
      expect(facts.state).toEqual(roundtrip(reduceBuild(prefix)))
      expect(decodeLog(facts.log)).toEqual(indexLog(prefix))
      const publication = publicationStateReducer.finish(facts.publication)
      const oracle = publicationStateReducer.reduce(prefix)
      expect(publication.pending()).toEqual(oracle.pending())
      expect(publication.latestUncompletedRequest()).toEqual(oracle.latestUncompletedRequest())
      expect(facts.observations).toEqual(
        prefix
          .filter((event) => event.type === 'observation.recorded')
          .map((event) => event.payload),
      )
    }
  }
})

test('one persisted seed includes transient attention even when consent is armed at the boundary', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'seed', repo: 'repo' })
  await store.append('seed', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://example.test/7', headSha: 'abc' } },
  })
  await store.append('seed', {
    actor: KERNEL,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'abc', parent: 'base', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
  const gateCommand = await store.append('seed', {
    actor: humanActor('human'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await store.append(
    'seed',
    autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'disabled' },
      7,
      gateCommand.seq,
      'gate',
    ),
  )
  await store.append('seed', {
    actor: humanActor('human'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  const current = await readBuildStreamSeed(store, 'seed')
  expect(current.value.mergeAttentionPrs).toEqual([7])
  expect(mergeDecision(await store.getEvents('seed'), new Date(0))).toBeNull()
  const facts = await readBuildFacts(store, 'seed')
  expect(facts.cursor).toBe(current.cursor)
  expect(facts.value.state).toEqual(reduceBuild(await store.getEvents('seed')))
})

test('repository run correlation stays bounded as stopped run history grows', async () => {
  const { DISPATCHER } = await import('../events/envelope')
  const { readRepositoryFacts, readDispatcherRunFacts } = await import('../store/reduced-reads')
  const { readDispatcherLiveness } = await import('../cli/dispatcher-liveness')
  const { projectDispatcherLiveness } = await import('./dispatcher-liveness')
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const start = (run: string, pid = 1) =>
    store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid,
        host: 'host',
        roleWarnings: [],
        effectiveConfig: { kind: 'config', rev: 0 },
      },
    })
  await start('owner', 7)
  await store.claimRepoLease('repo', 'owner', 60000)
  let baseline = 0
  for (let i = 0; i < 1000; i++) {
    const run = `run-${String(i).padStart(4, '0')}`
    await start(run)
    await store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run, outcome: 'normal' },
    })
    if (i === 255)
      baseline = JSON.stringify((await readRepositoryFacts(store, 'repo')).value).length
  }
  const facts = (await readRepositoryFacts(store, 'repo')).value
  expect(JSON.stringify(facts).length).toBeLessThanOrEqual(baseline + 512)
  expect(facts.recentRuns).toHaveLength(16)
  const owner = (await readDispatcherRunFacts(store, 'repo', 'owner')).value
  expect(owner.start?.type).toBe('dispatcher.run-started')
  expect(JSON.stringify(owner).length).toBeLessThan(1500)
  // A late stop for an evicted owner must not replace its historical identity
  // with an incomplete recent entry.
  await store.appendRepo('repo', {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'owner', outcome: 'normal' },
  })
  const now = new Date()
  expect((await readDispatcherLiveness(store, 'repo', now)).dispatcher).toEqual(
    projectDispatcherLiveness(await store.getRepo('repo'), await store.getRepoEvents('repo'), now),
  )
})

test('published rewrites retire checkpoints while repeated provisioning retains them', () => {
  const event = (seq: number, type: string, payload: unknown) =>
    ({
      seq,
      type,
      payload,
      ts: '2026-01-01T00:00:00Z',
      actor: KERNEL,
    }) as import('../events/catalog').AbEvent
  const receipt = event(1, 'workspace.commits-preserved', {
    workspace: 1,
    execution: 0,
    ref: 'old',
    branch: 'ab/build',
    phase: 'implement',
    round: 1,
    heads: [
      {
        role: 'branch',
        sha: 'a'.repeat(40),
        remoteRef: 'refs/autobuild/archive/build/a',
        commits: ['a'.repeat(40)],
      },
    ],
  }) as Extract<import('../events/catalog').AbEvent, { type: 'workspace.commits-preserved' }>
  let acc = buildReadFactsReducer.advance(buildReadFactsReducer.initial(), [receipt])
  expect(buildReadFactsReducer.finish(acc).workspacePreservation).toEqual(receipt)
  acc = buildReadFactsReducer.advance(roundtrip(acc), [
    event(2, 'workspace.provisioned', {
      provider: 'git-worktree',
      ref: 'new',
      path: '/new',
      branch: 'ab/build',
      base: { source: 'existing', sha: 'a'.repeat(40) },
    }),
  ])
  expect(buildReadFactsReducer.finish(acc).workspacePreservation).toEqual(receipt)
  acc = buildReadFactsReducer.advance(roundtrip(acc), [
    event(3, 'reconcile.rewritten', {
      id: 'rewrite',
      attempt: 1,
      branch: 'ab/build',
      oldHead: 'a'.repeat(40),
      oldBase: 'c'.repeat(40),
      targetBase: 'd'.repeat(40),
      changeSha: 'e'.repeat(40),
      workspaceHead: 'a'.repeat(40),
      localBranchHead: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      conflicted: false,
      archives: [],
    }),
    event(4, 'workspace.commits-lost', {
      workspace: 2,
      execution: 0,
      ref: 'new',
      branch: 'ab/build',
      phase: 'reconcile',
      round: 1,
      shas: ['b'.repeat(40)],
      inventory: 'additional-shas-unavailable',
      reason: 'absent after published rewrite',
    }),
  ])
  expect(buildReadFactsReducer.finish(acc).workspacePreservation).toBeUndefined()
  acc = buildReadFactsReducer.advance(roundtrip(acc), [
    event(5, 'workspace.provisioned', {
      provider: 'git-worktree',
      ref: 'replacement',
      path: '/replacement',
      branch: 'ab/build',
      base: { source: 'existing', sha: 'b'.repeat(40) },
    }),
  ])
  expect(buildReadFactsReducer.finish(acc).workspacePreservation).toBeUndefined()
  expect(buildReadFactsReducer.finish(acc).latestWorkspace?.payload.base.sha).toBe('b'.repeat(40))
})

test('rewrites keep a bounded record of the latest replaced heads', () => {
  const event = (seq: number, type: string, payload: unknown) =>
    ({
      seq,
      type,
      payload,
      ts: '2026-01-01T00:00:00Z',
      actor: KERNEL,
    }) as import('../events/catalog').AbEvent
  const oid = (n: number) => n.toString(16).padStart(40, '0')
  const leaf = (type: 'reconcile.rewritten' | 'restack.rewritten', seq: number) =>
    event(seq, type, {
      id: `rewrite-${seq}`,
      ...(type === 'reconcile.rewritten'
        ? { attempt: 1, conflicted: false }
        : { trigger: 'verify-entry', cycle: 0, observation: 1, message: 'restack' }),
      branch: 'ab/build',
      oldHead: oid(1001),
      oldBase: oid(1),
      targetBase: oid(2),
      changeSha: oid(3),
      workspaceHead: oid(1002),
      localBranchHead: oid(1002),
      headSha: oid(1003),
      archives: [],
    })
  // A minimal valid node restack whose only effect is replacing `previous`.
  const node = (seq: number, previous: string) => {
    const id = `node-${seq}`
    const head = oid(9000 + seq)
    return [
      event(seq, 'node.writer-reserved', {
        id,
        operation: 'restack',
        expected: previous,
        parent: head,
        oldBase: oid(1),
        archive: 'archive',
        changes: [],
        upstreamBuilds: [],
        merges: [],
      }),
      event(seq, 'node.publish-intended', { id, head }),
      event(seq, 'node.rewritten', { id, previous, head }),
      event(seq, 'node.writer-settled', { id, outcome: 'completed' }),
    ]
  }
  const finish = (acc: ReturnType<typeof buildReadFactsReducer.initial>) =>
    buildReadFactsReducer.finish(acc).replacedHeads
  // The Evidence ordering: the receipt naming `previous` lands after the rewrite.
  let acc = buildReadFactsReducer.advance(buildReadFactsReducer.initial(), [
    ...node(1, oid(500)),
    event(2, 'workspace.commits-preserved', {
      workspace: 1,
      execution: 0,
      ref: 'old',
      branch: 'ab/build',
      phase: 'reconcile',
      round: 1,
      heads: [
        {
          role: 'branch',
          sha: oid(500),
          remoteRef: `refs/autobuild/archive/build/${oid(500)}`,
          commits: [oid(500)],
        },
      ],
    }),
  ])
  expect(finish(acc)).toEqual([oid(500)])
  acc = buildReadFactsReducer.advance(roundtrip(acc), [
    leaf('reconcile.rewritten', 3),
    leaf('restack.rewritten', 4),
  ])
  // Leaf rewrites retire the checkpoint, never the record; duplicates move newest.
  expect(buildReadFactsReducer.finish(acc).workspacePreservation).toBeUndefined()
  expect(finish(acc)).toEqual([oid(500), oid(1001), oid(1002)])
  acc = buildReadFactsReducer.advance(roundtrip(acc), node(5, oid(500)))
  expect(finish(acc)).toEqual([oid(1001), oid(1002), oid(500)])
  acc = buildReadFactsReducer.advance(
    roundtrip(acc),
    Array.from({ length: 70 }, (_, i) => node(10 + i, oid(2000 + i))).flat(),
  )
  expect(finish(acc)).toHaveLength(REPLACED_HEADS_CAP)
  expect(finish(acc)).toEqual(Array.from({ length: 64 }, (_, i) => oid(2006 + i)))
})
