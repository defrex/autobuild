/** Optimization node stopping and completion (SPEC §13.1.1), over real git.
 * Recorded proposals stand in for the proposer and landing siblings. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { controlBuild } from '../cli/build-control'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { reviseObjective, stopObjective } from '../operator/optimization'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  type E2eHarness,
  happyHandlers,
  ofType,
  readyTicket,
  scenarioScope,
} from './harness'

const test = scenarioScope({ test: bunTest, afterEach })

const WITH_REJECTED = CONFIG_TOML.replace(
  'readyState = "Ready"',
  'readyState = "Ready"\nrejectedState = "Rejected"',
)

const objective = (budget = 'maxAttempts = 20', extra = '') =>
  [
    '```autobuild-objective',
    'purpose = "p95 latency of the search query; results must not change"',
    '',
    '[metric]',
    'kind = "command"',
    'command = "bun bench/search.ts"',
    'direction = "minimize"',
    'samples = 5',
    'harness = ["bench/**"]',
    '',
    '[target]',
    'threshold = 40',
    'epsilon = { relative = 0.03 }',
    '',
    '[budget]',
    budget,
    extra,
    '```',
  ].join('\n')

const optimizationNode = (body = objective()) => ({
  ...readyTicket('OPT', { title: 'Faster search', body: [CONFORMING_BODY, '', body].join('\n') }),
  kind: 'node' as const,
})

const attemptTicket = (id: string) => ({
  ...readyTicket(id, { title: `Attempt ${id}` }),
  target: 'OPT',
})

async function openNode(h: E2eHarness): Promise<string> {
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'OPT')!
  expect(reduceBuild(await h.events(node.slug)).optimization).toBeDefined()
  return node.slug
}

async function propose(h: E2eHarness, node: string, ids: string[]): Promise<void> {
  await h.store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: {
      request: `r-${ids.join('-')}`,
      proposals: ids.map((id) => ({
        id: `p-${id}`,
        ticket: { source: 'fake', id },
        title: `Attempt ${id}`,
        strategy: `strategy ${id}`,
      })),
    },
  })
}

async function tick(h: E2eHarness) {
  h.clock.advance(60_000)
  return h.dispatcher.tick()
}

const buildFor = async (h: E2eHarness, id: string) =>
  (await h.store.listBuilds()).find((r) => r.ticket?.id === id)

test('budget, hours and threshold stops are recorded once on the next tick', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode(objective('maxAttempts = 2\nmaxHours = 2'))],
  })
  try {
    const node = await openNode(h)
    await propose(h, node, ['A1'])
    await tick(h)
    expect(ofType(await h.events(node), 'optimization.stopped')).toHaveLength(0)

    // Lowering the attempts budget below what was filed stops on the next tick.
    await reviseObjective({
      store: h.store,
      repo: h.origin,
      slug: node,
      user: 'op',
      changes: { maxAttempts: 1 },
    })
    await tick(h)
    await tick(h)
    const events = await h.events(node)
    const stopped = ofType(events, 'optimization.stopped')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({
      actor: { kind: 'dispatcher' },
      payload: { cause: 'budget', mode: 'abort' },
    })
    // The unbuilt attempt is cancelled and settles stopped exactly once.
    const settled = ofType(events, 'attempt.settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.payload).toEqual({
      attempt: { proposal: 'p-A1', ticket: { source: 'fake', id: 'A1' } },
      outcome: 'stopped',
    })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('the hours budget fires on an idle node from the clock alone', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode(objective('maxHours = 1'))],
  })
  try {
    const node = await openNode(h)
    await tick(h)
    expect(ofType(await h.events(node), 'optimization.stopped')).toHaveLength(0)
    h.clock.advance(3_600_000)
    await h.dispatcher.tick()
    expect(ofType(await h.events(node), 'optimization.stopped')[0]?.payload).toEqual({
      cause: 'budget',
      mode: 'abort',
    })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('lowering the threshold below the head value stops with cause threshold', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode(objective('maxAttempts = 20', '[stop]\nmode = "drain"'))],
  })
  try {
    const node = await openNode(h)
    await h.store.append(node, {
      actor: KERNEL,
      type: 'optimization.baseline-measured',
      payload: {
        revision: 1,
        head: 'a'.repeat(40),
        harnessPin: 'a'.repeat(40),
        samples: 5,
        median: 50,
        spread: 1,
      },
    })
    await tick(h)
    expect(ofType(await h.events(node), 'optimization.stopped')).toHaveLength(0)
    await reviseObjective({
      store: h.store,
      repo: h.origin,
      slug: node,
      user: 'op',
      changes: { threshold: 60 },
    })
    await tick(h)
    await tick(h)
    const stopped = ofType(await h.events(node), 'optimization.stopped')
    expect(stopped.map((e) => e.payload)).toEqual([{ cause: 'threshold', mode: 'drain' }])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('abort mode aborts a claimed attempt, cancels an unclaimed one and refuses its claim', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode()],
  })
  try {
    const node = await openNode(h)
    await propose(h, node, ['A1', 'A2'])
    h.tickets.add(attemptTicket('A1'))
    await tick(h)
    const a1 = (await buildFor(h, 'A1'))!
    expect(a1).toBeDefined()

    expect(await stopObjective({ store: h.store, repo: h.origin, slug: node, user: 'op' })).toEqual(
      { slug: node, cause: 'operator', mode: 'abort' },
    )
    h.tickets.add(attemptTicket('A2'))
    const report = await tick(h)
    await tick(h)
    await tick(h)

    const a1Events = await h.events(a1.slug)
    const requested = ofType(a1Events, 'build.abort-requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      actor: { kind: 'dispatcher' },
      payload: { reason: `optimization node ${node} stopped (operator, abort)` },
    })
    expect(ofType(a1Events, 'build.aborted')).toHaveLength(1)

    expect(await buildFor(h, 'A2')).toBeUndefined()
    expect(report.dependencyDiagnostics.join(' ')).toContain(
      'target optimization node OPT has stopped; attempt A2 is cancelled',
    )

    const nodeEvents = await h.events(node)
    const settled = ofType(nodeEvents, 'attempt.settled')
    expect(settled.map((e) => [e.payload.attempt.proposal, e.payload.outcome]).sort()).toEqual([
      ['p-A1', 'stopped'],
      ['p-A2', 'stopped'],
    ])
    expect(settled.find((e) => e.payload.attempt.proposal === 'p-A1')!.payload.attempt.build).toBe(
      a1.slug,
    )
    const state = reduceBuild(nodeEvents)
    expect(state.optimization?.inFlight).toEqual([])
    expect(state.optimization?.stoppedTickets?.map((t) => t.id).sort()).toEqual(['A1', 'A2'])
    // Later ticks write nothing more.
    const before = nodeEvents.length
    await tick(h)
    expect(
      (await h.events(node))
        .slice(before)
        .filter((e) => e.type === 'attempt.settled' || e.type === 'optimization.stopped'),
    ).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('drain mode lets a running attempt finish and cancels a queued one', async (makeHarness) => {
  const handlers = happyHandlers()
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: {
      ...handlers,
      plan: async (cli) => {
        await cli.run(['context'])
        await cli.run(['escalate', 'which benchmark?'])
      },
    },
    tickets: [optimizationNode()],
  })
  try {
    const node = await openNode(h)
    await propose(h, node, ['A1', 'A2'])
    h.tickets.add(attemptTicket('A1'))
    await tick(h)
    const a1 = (await buildFor(h, 'A1'))!
    await h.runLatest()
    expect(reduceBuild(await h.events(a1.slug)).currentPhase).toBeDefined()
    h.tickets.add(attemptTicket('A2'))
    await tick(h)
    const a2 = (await buildFor(h, 'A2'))!
    expect(a2).toBeDefined()

    expect(
      await stopObjective({
        store: h.store,
        repo: h.origin,
        slug: node,
        user: 'op',
        mode: 'drain',
      }),
    ).toEqual({ slug: node, cause: 'operator', mode: 'drain' })
    await tick(h)
    await tick(h)
    await tick(h)

    expect(ofType(await h.events(a1.slug), 'build.abort-requested')).toHaveLength(0)
    expect(ofType(await h.events(a2.slug), 'build.abort-requested')).toHaveLength(1)
    expect(ofType(await h.events(a2.slug), 'build.aborted')).toHaveLength(1)
    const state = reduceBuild(await h.events(node))
    expect(state.optimization?.inFlight.map((a) => a.ticket.id)).toEqual(['A1'])
    expect(
      ofType(await h.events(node), 'attempt.settled').map((e) => e.payload.attempt.proposal),
    ).toEqual(['p-A2'])
    await expect(
      controlBuild({ store: h.store, repo: h.origin, slug: node, action: { kind: 'land' } }),
    ).rejects.toThrow('attempts still in flight: A1')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a recorded exhausted stop is enforced with the same modes', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode()],
  })
  try {
    const node = await openNode(h)
    await propose(h, node, ['A1'])
    h.tickets.add(attemptTicket('A1'))
    await tick(h)
    const a1 = (await buildFor(h, 'A1'))!
    await h.store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.stopped',
      payload: { cause: 'exhausted', mode: 'drain' },
    })
    await tick(h)
    await tick(h)
    // Queued, so cancelled even in drain mode.
    expect(ofType(await h.events(a1.slug), 'build.abort-requested')[0]?.payload.reason).toBe(
      `optimization node ${node} stopped (exhausted, drain)`,
    )
    expect(ofType(await h.events(node), 'attempt.settled')[0]?.payload).toMatchObject({
      attempt: { proposal: 'p-A1', build: a1.slug },
      outcome: 'stopped',
    })
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an optimization node completes only after it stops; stopping is not consent', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [optimizationNode()],
  })
  try {
    const node = await openNode(h)
    // A human-filed child of a stopped node is still admitted; here one lands
    // before the stop so the node has a contribution.
    h.tickets.add({ ...readyTicket('CHILD', { title: 'Bench harness' }), target: 'OPT' })
    await propose(h, node, ['A1'])
    await tick(h)
    const child = (await buildFor(h, 'CHILD'))!
    await h.runLatest()
    const childState = reduceBuild(await h.events(child.slug))
    await h.forgeAdapter.squashMerge(h.origin, childState.pr!.number, childState.pr!.headSha)
    await tick(h)
    await tick(h)
    await tick(h)
    expect(ofType(await h.events(node), 'integration.prepared')).toHaveLength(0)
    await expect(
      controlBuild({ store: h.store, repo: h.origin, slug: node, action: { kind: 'land' } }),
    ).rejects.toThrow('the optimization node has not stopped')

    await stopObjective({ store: h.store, repo: h.origin, slug: node, user: 'op' })
    await tick(h)
    // The landing sibling moves the stopped attempt's ticket to the rejected
    // role; the test stands in for it.
    h.tickets.add({ ...attemptTicket('A1'), state: 'Rejected' })
    await tick(h)
    await tick(h)
    const events = await h.events(node)
    expect(reduceBuild(events).optimization?.inFlight).toEqual([])
    expect(ofType(events, 'integration.prepared').length).toBeGreaterThan(0)
    expect(ofType(events, 'build.land-requested')).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)
