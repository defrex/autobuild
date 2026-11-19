/** The measurement landing gate and attempt settlement (SPEC §15.7, RFC 0005
 * §6.3–§7.5), over real git. The test plays the proposer, by recording the
 * node's proposals, and the measurer, by answering recorded requests. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import { reduceBuild } from '../kernel/reducer'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  commitAll,
  git,
  happyHandlers,
  ofType,
  readyTicket,
  scenarioScope,
  writeFileIn,
  type E2eHarness,
  type SkillHandlers,
} from './harness'

const test = scenarioScope({ test: bunTest, afterEach })

// The node holds a slot of its own for its starting measurement (AUT-1225),
// which no runner here records, so two children need a third slot.
const WITH_REJECTED = CONFIG_TOML.replace('capacity = 2', 'capacity = 3').replace(
  'readyState = "Ready"',
  'readyState = "Ready"\nrejectedState = "Rejected"',
)

const OBJECTIVE = [
  'purpose = "p95 latency of the search query"',
  '',
  '[metric]',
  'kind = "command"',
  'command = "bun bench/search.ts"',
  'direction = "minimize"',
  'samples = 5',
  'harness = ["bench/**"]',
  '',
  '[target]',
  'epsilon = { absolute = 2 }',
  '',
  '[budget]',
  'maxAttempts = 20',
  '',
  '[proposer]',
  'concurrency = 3',
].join('\n')

const PANEL_OBJECTIVE = [
  'purpose = "clearer onboarding prose"',
  '',
  '[metric]',
  'kind = "panel"',
  'judges = 5',
  'rubric = "evals/rubric.md"',
  'harness = ["evals/**"]',
  '',
  '[target]',
  'epsilon = { absolute = 0.1 }',
  '',
  '[budget]',
  'maxAttempts = 20',
].join('\n')

const objectiveBody = (objective: string) =>
  [CONFORMING_BODY, '', '```autobuild-objective', objective, '```'].join('\n')
const nodeBody = objectiveBody(OBJECTIVE)

/** Each build changes its own file, so siblings never conflict; a build whose
 * slug matches `harness` also edits a harness path. */
function handlers(harness?: RegExp): SkillHandlers {
  const happy = happyHandlers()
  return {
    ...happy,
    implement: async (cli) => {
      await cli.run(['context'])
      await writeFileIn(cli.ws, `${cli.env.build}.txt`, `change r${cli.round}\n`)
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
      if (harness?.test(cli.env.build)) await writeFileIn(cli.ws, 'bench/search.ts', 'cheat\n')
      await commitAll(cli.ws, `implement: ${cli.env.build} r${cli.round}`)
      const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', 'Done.\n')
      await cli.run(['done', '--notes', notes])
    },
  }
}

async function setup(
  makeHarness: (opts: never) => Promise<E2eHarness>,
  attempts: string[],
  others: string[] = [],
  harness?: RegExp,
  body = nodeBody,
) {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: handlers(harness),
    tickets: [
      { ...readyTicket('OPT', { title: 'Faster search', body }), kind: 'node' },
      ...[...attempts, ...others].map((id) => ({
        ...readyTicket(id, { title: `Change ${id}` }),
        target: 'OPT',
      })),
    ],
  } as never)
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'OPT')!
  if (attempts.length > 0) await propose(h, node.slug, attempts)
  return { h, node }
}

/** Record the node's proposals naming the tickets `ids`. */
async function propose(h: E2eHarness, node: string, ids: string[], request = 'r1') {
  const proposals = await Promise.all(
    ids.map(async (id) => ({
      id: `p-${id}`,
      ticket: (await h.tickets.get(id))!.ref,
      title: `Change ${id}`,
      strategy: `strategy ${id}`,
    })),
  )
  await h.store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: { request, proposals },
  })
}

const slugOf = async (h: E2eHarness, id: string) =>
  (await h.store.listBuilds()).find((r) => r.ticket?.id === id)!.slug

/** The dispatcher's launches of `slug`; the node relaunches for its starting
 * measurement on its own schedule, so only a build's own launches count. */
const launchesOf = (h: E2eHarness, slug: string) =>
  h.launched.filter((entry) => entry.slug === slug)

/** Tick until `slug` has `count` landing measurement requests, running each
 * new launch of it to its park point. */
async function driveToRequest(h: E2eHarness, slug: string, count: number) {
  let ran = launchesOf(h, slug).length
  for (let i = 0; i < 6 && (await requests(h, slug)).length < count; i++) {
    const launches = launchesOf(h, slug)
    if (launches.length > ran) {
      ran = launches.length
      const entry = launches.at(-1)!
      await entry.runner.run().catch(() => undefined)
      await h.store.releaseLease(slug, entry.instance)
    }
    await tick(h)
  }
}

const stateOf = async (h: E2eHarness, slug: string) => reduceBuild(await h.events(slug))

/** Run a claimed child to its PR with merge consent. */
async function toPr(h: E2eHarness, slug: string) {
  await h.store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  const launched = h.launched.find((entry) => entry.slug === slug)!
  await launched.runner.run()
  await h.store.releaseLease(slug, launched.instance)
  expect((await stateOf(h, slug)).pr).toBeDefined()
}

const requests = async (h: E2eHarness, slug: string) =>
  ofType(await h.events(slug), 'attempt.measurement-requested')

/** Answer the child's latest request with medians giving `delta`. */
async function measure(h: E2eHarness, slug: string, delta: number) {
  const request = (await requests(h, slug)).at(-1)!.payload
  await h.store.append(slug, {
    actor: KERNEL,
    type: 'attempt.measured',
    payload: {
      request: request.id,
      candidate: request.candidate,
      baseline: request.baseline,
      harnessPin: request.harnessPin,
      revision: request.revision,
      samples: 5,
      medians: { baseline: 50, candidate: 50 - delta },
      delta,
      decision: delta >= 2 ? 'improved' : 'no-improvement',
    },
  })
  return request
}

/** Answer the child's latest panel request with the judges' win rate, as
 * the attempt runner records it; the dispatcher decides. */
async function judge(h: E2eHarness, slug: string, winRate: number) {
  const request = (await requests(h, slug)).at(-1)!.payload
  await h.store.append(slug, {
    actor: KERNEL,
    type: 'attempt.sampled',
    payload: {
      request: request.id,
      candidate: request.candidate,
      baseline: request.baseline,
      harnessPin: request.harnessPin,
      revision: request.revision,
      samples: 5,
      winRate,
      report: { kind: 'measurement-samples', rev: 0 },
    },
  })
  return request
}

async function tick(h: E2eHarness) {
  h.clock.advance(60_000)
  await h.dispatcher.tick()
}

const settled = async (h: E2eHarness, node: string) =>
  ofType(await h.events(node), 'attempt.settled').map((event) => event.payload)

const types = (events: AbEvent[]) => events.map((event) => event.type)

test('an improved attempt requests its first measurement, then lands only on its exact pair', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    // Ready with no measurement: readiness admits the gate, which requests.
    await tick(h)
    const [request] = await requests(h, child)
    expect(request).toBeDefined()
    const nodeHead = await git(['rev-parse', node.branch!], h.origin)
    const childState = await stateOf(h, child)
    expect(request!.payload).toMatchObject({
      node: node.slug,
      candidate: childState.pr!.headSha,
      baseline: nodeHead,
      revision: 1,
    })
    // Pending: no second request and no landing.
    await tick(h)
    expect(await requests(h, child)).toHaveLength(1)
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)

    await measure(h, child, 2)
    await tick(h)
    const landed = await stateOf(h, child)
    expect(landed.status).toBe('done')
    expect(landed.outcome).toBe('merged')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(childState.pr!.headSha)
    expect(await settled(h, node.slug)).toEqual([
      {
        attempt: { proposal: 'p-A1', ticket: expect.objectContaining({ id: 'A1' }), build: child },
        outcome: 'accepted',
        measurement: { revision: 1, baseline: 50, candidate: 48, delta: 2 },
        head: childState.pr!.headSha,
      },
    ])
    const digest = (await stateOf(h, node.slug)).optimization!
    expect(digest).toMatchObject({ inFlight: [], rejections: [], current: 48 })
    expect((await h.tickets.get('A1'))?.state).toBe('Done')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a panel attempt lands when its win rate reaches 0.5 + ε against the node head', async (makeHarness) => {
  const panel = objectiveBody(PANEL_OBJECTIVE)
  const { h, node } = await setup(makeHarness as never, ['A1'], [], undefined, panel)
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await tick(h)
    const [request] = await requests(h, child)
    const nodeHead = await git(['rev-parse', node.branch!], h.origin)
    expect(request!.payload).toMatchObject({
      baseline: nodeHead,
      metric: { kind: 'panel', judges: 5, rubric: 'evals/rubric.md', harness: ['evals/**'] },
      purpose: 'clearer onboarding prose',
    })
    // 3 of 5 judges: exactly 0.5 + ε, which float subtraction misses.
    await judge(h, child, 3 / 5)
    await tick(h)
    await tick(h)
    const [measured] = ofType(await h.events(child), 'attempt.measured')
    expect(measured?.payload).toMatchObject({ winRate: 0.6, decision: 'improved' })
    expect(measured?.payload).not.toHaveProperty('medians')
    const landed = await stateOf(h, child)
    expect(landed.outcome).toBe('merged')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(landed.pr!.headSha)
    expect(await settled(h, node.slug)).toEqual([
      expect.objectContaining({
        outcome: 'accepted',
        measurement: { revision: 1, baseline: 0.5, candidate: 0.6, delta: 3 / 5 - 0.5 },
      }),
    ])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a panel attempt below 0.5 + ε closes unmerged and settles no-improvement', async (makeHarness) => {
  const panel = objectiveBody(PANEL_OBJECTIVE)
  const { h, node } = await setup(makeHarness as never, ['A1'], [], undefined, panel)
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await tick(h)
    const nodeHead = await git(['rev-parse', node.branch!], h.origin)
    await judge(h, child, 0.5)
    await tick(h)
    await tick(h)
    const state = await stateOf(h, child)
    expect(state.outcome).toBe('closed-unmerged')
    expect(state.prState).toBe('closed')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)
    expect(await settled(h, node.slug)).toEqual([
      expect.objectContaining({
        outcome: 'no-improvement',
        measurement: { revision: 1, baseline: 0.5, candidate: 0.5, delta: 0 },
      }),
    ])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an interrupted landing recovers only while its measurement still qualifies', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await tick(h)
    await measure(h, child, 3)
    const nodeHead = await git(['rev-parse', node.branch!], h.origin)
    // Fail the destination write after the reservation, before publication.
    const rewrite = h.forgeAdapter.kernelRewrite ?? h.forgeAdapter.rewrite!
    Object.defineProperty(h.forgeAdapter, 'rewrite', { value: rewrite, configurable: true })
    const replace = rewrite.replace.bind(rewrite)
    rewrite.replace = async () => {
      throw new Error('injected failure before publication')
    }
    await tick(h)
    expect((await stateOf(h, node.slug)).nodeRestack?.active?.source).toBe(child)
    rewrite.replace = replace
    // Epsilon rises past the measured delta while the landing is reserved.
    await h.store.append(node.slug, {
      actor: humanActor('operator'),
      type: 'optimization.objective-revised',
      payload: { revision: 2, changes: { epsilon: { absolute: 10 } } },
    })
    await tick(h)
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)
    expect((await stateOf(h, node.slug)).nodeRestack?.active).toBeUndefined()
    expect(
      ofType(await h.events(node.slug), 'node.writer-settled').map((e) => e.payload.outcome),
    ).toEqual(['abandoned'])
    await tick(h)
    const state = await stateOf(h, child)
    expect(state.prState).toBe('closed')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)
    expect((await settled(h, node.slug)).map((s) => s.outcome)).toEqual(['no-improvement'])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a sibling landing makes a measurement stale: the attempt restacks and measures again', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1', 'A2'])
  try {
    await tick(h)
    const first = await slugOf(h, 'A1')
    const second = await slugOf(h, 'A2')
    await toPr(h, first)
    await toPr(h, second)
    await tick(h)
    expect(await requests(h, first)).toHaveLength(1)
    expect(await requests(h, second)).toHaveLength(1)
    await measure(h, first, 3)
    // The second attempt's result is for the node head the first replaces.
    const stale = await measure(h, second, 5)
    await tick(h)
    expect((await stateOf(h, first)).outcome).toBe('merged')
    const moved = await git(['rev-parse', node.branch!], h.origin)
    expect(moved).not.toBe(stale.baseline)
    // Drive the second attempt until it has restacked and asked again.
    await driveToRequest(h, second, 2)
    const again = (await requests(h, second)).at(-1)!.payload
    expect(again.baseline).toBe(moved)
    // A restack changed the candidate; a clean restack kept verification.
    expect(again.candidate).not.toBe(stale.candidate)
    expect(again.candidate).toBe((await stateOf(h, second)).pr!.headSha)
    expect((await stateOf(h, second)).landingMeasurement?.overtakes).toBe(1)
    expect((await stateOf(h, second)).status).not.toBe('done')
    await measure(h, second, 2)
    await tick(h)
    expect((await stateOf(h, second)).outcome).toBe('merged')
    expect((await settled(h, node.slug)).map((s) => s.outcome)).toEqual(['accepted', 'accepted'])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a request a sibling landing superseded before sampling is skipped, never measured', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1', 'A2'])
  try {
    await tick(h)
    const first = await slugOf(h, 'A1')
    const second = await slugOf(h, 'A2')
    await toPr(h, first)
    await toPr(h, second)
    await tick(h)
    const [stale] = await requests(h, second)
    expect(stale).toBeDefined()
    // Only the first is measured; the second's request is still unsampled.
    await measure(h, first, 3)
    await tick(h)
    expect((await stateOf(h, first)).outcome).toBe('merged')
    const moved = await git(['rev-parse', node.branch!], h.origin)
    expect(moved).not.toBe(stale!.payload.baseline)
    await driveToRequest(h, second, 2)
    const events = await h.events(second)
    // The stale request was never sampled and raised no measurement failure.
    expect(
      ofType(events, 'attempt.sampled').filter((e) => e.payload.request === stale!.payload.id),
    ).toEqual([])
    expect(
      ofType(events, 'escalation.raised').filter(
        (e) => e.payload.policyCause === 'measurement-failed',
      ),
    ).toEqual([])
    const again = (await requests(h, second)).at(-1)!.payload
    expect(again.id).not.toBe(stale!.payload.id)
    expect(again.baseline).toBe(moved)
    await measure(h, second, 2)
    await tick(h)
    expect((await stateOf(h, second)).outcome).toBe('merged')
    expect((await settled(h, node.slug)).map((s) => s.outcome)).toEqual(['accepted', 'accepted'])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('no improvement closes the PR, settles once and moves the ticket to rejected', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await tick(h)
    const nodeHead = await git(['rev-parse', node.branch!], h.origin)
    await measure(h, child, 1.9)
    const launches = launchesOf(h, child).length
    await tick(h)
    await tick(h)
    const state = await stateOf(h, child)
    expect(state.status).toBe('done')
    expect(state.outcome).toBe('closed-unmerged')
    expect(state.prState).toBe('closed')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)
    expect(await settled(h, node.slug)).toEqual([
      expect.objectContaining({
        outcome: 'no-improvement',
        measurement: { revision: 1, baseline: 50, candidate: 48.1, delta: 1.9 },
      }),
    ])
    // No further implement round, and never a triage hand-back.
    expect(launchesOf(h, child)).toHaveLength(launches)
    const childEvents = await h.events(child)
    expect(types(childEvents)).not.toContain('build.ticket-returned')
    expect(ofType(childEvents, 'implement.started')).toHaveLength(1)
    expect((await h.tickets.get('A1'))?.state).toBe('Rejected')
    const nodeEvents = await h.events(node.slug)
    expect(ofType(nodeEvents, 'attempt.ticket-rejected').map((e) => e.payload)).toEqual([
      { proposal: 'p-A1', ticket: expect.objectContaining({ id: 'A1' }), state: 'Rejected' },
    ])
    const digest = reduceBuild(nodeEvents).optimization!
    expect(digest).toMatchObject({ inFlight: [], rejections: [], plateau: 1 })
    // The published attempt's branch is deleted before the move, and only it.
    const branch = (await h.store.getBuild(child))!.branch!
    expect(await settled(h, node.slug)).toEqual([
      expect.objectContaining({ attempt: expect.objectContaining({ branch }) }),
    ])
    expect(ofType(nodeEvents, 'attempt.branch-deleted').map((e) => e.payload)).toEqual([
      { proposal: 'p-A1', build: child, branch },
    ])
    expect(types(nodeEvents).indexOf('attempt.branch-deleted')).toBeLessThan(
      types(nodeEvents).indexOf('attempt.ticket-rejected'),
    )
    expect((await git(['branch', '--list', branch], h.origin)).trim()).toBe('')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(nodeHead)
    // Settled once, across further polls.
    await tick(h)
    expect(await settled(h, node.slug)).toHaveLength(1)
    expect(ofType(await h.events(node.slug), 'attempt.branch-deleted')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an operator abort settles the attempt aborted and rejects its ticket, not triage', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await h.store.append(child, {
      actor: humanActor('operator'),
      type: 'build.abort-requested',
      payload: { reason: 'wrong idea' },
    })
    await tick(h)
    // A parked build acknowledges the abort in a runner, then the janitor cleans up.
    if (h.launched.at(-1)?.slug === child && (await stateOf(h, child)).status !== 'aborted')
      await h.runLatest()
    await tick(h)
    await tick(h)
    const state = await stateOf(h, child)
    expect(state.status).toBe('done')
    expect(state.outcome).toBe('abandoned')
    expect(await settled(h, node.slug)).toEqual([
      expect.objectContaining({ outcome: 'aborted', note: 'wrong idea' }),
    ])
    const childEvents = await h.events(child)
    expect(types(childEvents)).not.toContain('abort.ticket-returned')
    expect((await h.tickets.get('A1'))?.state).toBe('Rejected')
    expect((await h.tickets.get('A1'))?.labels).not.toContain('autobuild:aborted')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a child that is not an attempt lands at non-regression and escalates when regressed', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, [], ['B1', 'B2'])
  try {
    await tick(h)
    const flat = await slugOf(h, 'B1')
    const worse = await slugOf(h, 'B2')
    await toPr(h, flat)
    await toPr(h, worse)
    await tick(h)
    await measure(h, worse, -2.5)
    await tick(h)
    const [raised] = ofType(await h.events(worse), 'escalation.raised')
    const request = (await requests(h, worse))[0]!.payload
    expect(raised?.payload).toMatchObject({
      id: `landing-regressed-${request.id}`,
      phase: 'finalize',
      source: 'agent',
    })
    expect(raised!.payload.question).toContain('delta -2.5, epsilon 2')
    // Still escalated on later polls: raised once, never landed.
    await tick(h)
    expect(ofType(await h.events(worse), 'escalation.raised')).toHaveLength(1)
    expect((await stateOf(h, worse)).prState).toBe('open')

    // The flat sibling is within −ε of the node head and lands.
    await measure(h, flat, -2)
    await tick(h)
    expect((await stateOf(h, flat)).outcome).toBe('merged')

    // An answer asks for a fresh measurement without re-running finalize.
    await h.store.append(worse, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: raised!.payload.id, answer: 'measure again', resolution: 'guidance' },
    })
    await driveToRequest(h, worse, 2)
    expect(await requests(h, worse)).toHaveLength(2)
    expect(ofType(await h.events(worse), 'finalize.started')).toHaveLength(1)

    const digest = (await stateOf(h, node.slug)).optimization!
    expect(digest.attempts.filed).toBe(0)
    expect(await settled(h, node.slug)).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an attempt that edits a harness path escalates instead of being measured', async (makeHarness) => {
  // `ab done` refuses an attempt's harness edit, so this head reaches its PR
  // while A1 is still an ordinary child; the proposal that makes it an
  // attempt comes after, and only the landing gate stands in the way.
  const { h, node } = await setup(makeHarness as never, [], ['A1'], /./)
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await propose(h, node.slug, ['A1'])
    await tick(h)
    await tick(h)
    expect(await requests(h, child)).toEqual([])
    const raised = ofType(await h.events(child), 'escalation.raised')
    expect(raised).toHaveLength(1)
    const head = (await stateOf(h, child)).pr!.headSha
    expect(raised[0]!.payload).toMatchObject({ id: `landing-harness-${head}`, phase: 'finalize' })
    expect(raised[0]!.payload.question).toContain('bench/search.ts')
    // Answered, the same head is still never measured.
    await h.store.append(child, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: raised[0]!.payload.id, answer: 'measure it anyway', resolution: 'guidance' },
    })
    await tick(h)
    await tick(h)
    expect(await requests(h, child)).toEqual([])
    expect(ofType(await h.events(child), 'escalation.raised')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an attempt overtaken three times holds the turn: a ready sibling waits behind it', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['H', 'S'])
  try {
    await tick(h)
    const holder = await slugOf(h, 'H')
    const sibling = await slugOf(h, 'S')
    await toPr(h, holder)
    await toPr(h, sibling)
    await tick(h)
    // Recorded history: the node head moved under the holder three times.
    // Each was measured, so no request is left for the holder's runner.
    const first = (await requests(h, holder))[0]!.payload
    for (const [i, base] of ['1', '2', '3'].entries()) {
      await h.store.append(holder, {
        actor: DISPATCHER,
        type: 'attempt.measurement-requested',
        payload: { ...first, id: `seeded-${i}`, baseline: base.repeat(40) },
      })
      await measure(h, holder, 3)
    }
    expect((await stateOf(h, holder)).landingMeasurement?.overtakes).toBe(3)
    await measure(h, sibling, 5)
    await tick(h)
    // The holder asks again for the current pair; the sibling neither lands
    // nor requests while it waits.
    expect((await requests(h, holder)).at(-1)!.payload.baseline).toBe(first.baseline)
    expect((await stateOf(h, sibling)).prState).toBe('open')
    expect(await requests(h, sibling)).toHaveLength(1)
    await tick(h)
    expect((await stateOf(h, sibling)).prState).toBe('open')

    await measure(h, holder, 3)
    await tick(h)
    expect((await stateOf(h, holder)).outcome).toBe('merged')
    expect((await stateOf(h, sibling)).outcome).toBeUndefined()
    expect(ofType(await h.events(node.slug), 'attempt.settled')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

/** Whether the node is in the janitor's work set, from its digest alone. */
async function nodeIsWork(h: E2eHarness, slug: string) {
  const { readBuildDigests } = await import('../store/reduced-reads')
  const { isWorkDigest } = await import('../processes/repo-view')
  const digest = (await readBuildDigests(h.store, h.origin)).get(slug)!
  return { work: isWorkDigest(digest), digest }
}

async function abortBuild(h: E2eHarness, slug: string) {
  await h.store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.abort-requested',
    payload: { reason: 'stop' },
  })
}

test('a node that completes before its attempt settles rejoins the work set to reject the ticket', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    // The attempt is claimed and still queued when its node is aborted.
    await abortBuild(h, node.slug)
    for (let i = 0; i < 4 && (await stateOf(h, node.slug)).status !== 'done'; i++) await tick(h)
    expect((await stateOf(h, node.slug)).status).toBe('done')
    expect((await stateOf(h, child)).status).not.toBe('done')
    expect((await nodeIsWork(h, node.slug)).work).toBe(false)
    // The attempt's own abort cleanup settles it on the completed node's log.
    await abortBuild(h, child)
    for (let i = 0; i < 4 && (await stateOf(h, child)).status !== 'done'; i++) await tick(h)
    expect((await stateOf(h, child)).status).toBe('done')
    expect(await settled(h, node.slug)).toEqual([expect.objectContaining({ outcome: 'aborted' })])
    for (let i = 0; i < 3 && (await h.tickets.get('A1'))?.state !== 'Rejected'; i++) await tick(h)
    expect((await h.tickets.get('A1'))?.state).toBe('Rejected')
    expect(ofType(await h.events(node.slug), 'attempt.ticket-rejected')).toHaveLength(1)
    expect(ofType(await h.events(child), 'abort.ticket-returned')).toEqual([])
    const after = await nodeIsWork(h, node.slug)
    expect(after.digest.rejectionsPending).toBeUndefined()
    expect(after.work).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a failing rejected-role move keeps a completed node polled until it succeeds', async (makeHarness) => {
  const { h, node } = await setup(makeHarness as never, ['A1'])
  try {
    await tick(h)
    const child = await slugOf(h, 'A1')
    await toPr(h, child)
    await tick(h)
    const transition = h.tickets.transition.bind(h.tickets)
    let refusing = true
    h.tickets.transition = async (id, state) => {
      if (refusing && state === 'Rejected') throw new Error('tracker refused the move')
      return transition(id, state)
    }
    await measure(h, child, 0)
    await tick(h)
    await tick(h)
    expect((await stateOf(h, child)).status).toBe('done')
    expect((await stateOf(h, node.slug)).optimization?.rejections).toHaveLength(1)
    // The node completes while the move is pending.
    await abortBuild(h, node.slug)
    for (let i = 0; i < 6 && (await stateOf(h, node.slug)).status !== 'done'; i++) await tick(h)
    expect((await stateOf(h, node.slug)).status).toBe('done')
    for (let i = 0; i < 3; i++) await tick(h)
    const pending = await nodeIsWork(h, node.slug)
    expect(pending.work).toBe(true)
    expect(pending.digest.rejectionsPending).toBe(true)
    expect((await h.tickets.get('A1'))?.state).not.toBe('Triage')
    expect((await h.tickets.get('A1'))?.state).not.toBe('Rejected')

    refusing = false
    for (let i = 0; i < 12 && (await h.tickets.get('A1'))?.state !== 'Rejected'; i++) {
      h.clock.advance(600_000)
      await h.dispatcher.tick()
    }
    expect((await h.tickets.get('A1'))?.state).toBe('Rejected')
    const cleared = await nodeIsWork(h, node.slug)
    expect(cleared.digest.rejectionsPending).toBeUndefined()
    expect(cleared.work).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)
