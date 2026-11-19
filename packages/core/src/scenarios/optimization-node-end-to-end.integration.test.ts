/** An optimization node end to end (SPEC §13.1.1, RFC 0005 §15): the real
 * dispatcher and runners take every measurement and file every attempt, so
 * the seams between opening, proposing, measuring, landing, rejecting,
 * stopping and landing the node are what these scenarios prove. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { join } from 'node:path'
import { controlBuild } from '../cli/build-control'
import type { AbEvent } from '../events/catalog'
import { humanActor, KERNEL } from '../events/envelope'
import {
  baselineMeasurementDue,
  pendingMeasurementRequest,
  progressMeasurementDue,
} from '../kernel/measurement'
import { reduceBuild } from '../kernel/reducer'
import { reviseObjective, stopObjective } from '../operator/optimization'
import { measureStoreReads } from '../testing/reduced-read-budget'
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
  type Make,
  type SkillHandler,
} from './harness'

const test = scenarioScope({ test: bunTest, afterEach })

// The node holds a slot of its own for its starting measurement and the
// proposer, beside two attempts in flight. Idle node polling is a clocked branch check with its own proven bound
// (`nodePollingReadBudget`); a day between checks keeps it out of the idle
// window, so the window measures the optimization node's own per-tick work.
const CONFIG = CONFIG_TOML.replace('capacity = 2', 'capacity = 4')
  .replace('readyState = "Ready"', 'readyState = "Ready"\nrejectedState = "Rejected"')
  .replace('stallRounds = 3', 'stallRounds = 3\nnodeIdlePollSeconds = 86400')

/** The pinned ruler: three points better per file under `app/gains/`,
 * deterministic so the noise check never fires. */
const MEASURE_SH = `n=$(ls app/gains 2>/dev/null | wc -l | tr -d ' ')\necho "{\\"value\\": $((50 - 3 * n))}"\n`

const commandObjective = (mode: 'abort' | 'drain', concurrency: number) =>
  [
    'purpose = "query latency in milliseconds; results must not change"',
    '',
    '[metric]',
    'kind = "command"',
    'command = "sh bench/measure.sh"',
    'direction = "minimize"',
    'samples = 3',
    'harness = ["bench/**"]',
    '',
    '[target]',
    'threshold = 30',
    'epsilon = { absolute = 2 }',
    '',
    '[budget]',
    'maxAttempts = 20',
    '',
    '[stop]',
    `mode = "${mode}"`,
    '',
    '[proposer]',
    `concurrency = ${concurrency}`,
  ].join('\n')

const objectiveBody = (objective: string) =>
  [CONFORMING_BODY, '', '```autobuild-objective', objective, '```'].join('\n')

const attemptBody = (strategy: string) =>
  [
    `Try ${strategy} to lower query latency.`,
    '',
    '## Acceptance criteria',
    '',
    `- ${strategy} is applied and the benchmark still passes`,
    '',
    '## Out of scope',
    '',
    '- changing the benchmark',
    '',
  ].join('\n')

/** The proposer deposits the next queued proposals, as many as the
 * request has room for. */
function proposer(queue: string[], calls: { count: number }): SkillHandler {
  return async (cli) => {
    await cli.run(['context'])
    calls.count += 1
    const manifest = await Bun.file(join(cli.ws, '.ab', 'propose', 'context.json')).json()
    const ids = queue.splice(0, manifest.optimization.room as number)
    if (ids.length === 0) {
      await cli.run(['propose', '--none', 'no further strategies worth measuring'])
      return
    }
    const file = await writeFileIn(
      cli.ws,
      '.ab/proposals.json',
      JSON.stringify({
        proposals: ids.map((id) => ({
          id,
          title: `Attempt ${id}`,
          strategy: `strategy ${id}`,
          body: attemptBody(id),
        })),
      }),
    )
    await cli.run(['propose', file])
  }
}

async function attemptProposal(cli: Parameters<SkillHandler>[0], phase: string) {
  const manifest = await Bun.file(join(cli.ws, '.ab', phase, 'context.json')).json()
  return manifest.attempt?.proposal as string | undefined
}

/** Attempts act by proposal id: `gain-*` adds a gain, `flat*` changes
 * nothing the ruler sees, `decline` declines, and `stall-*` parks at plan on
 * a question. */
function attemptHandlers(queue: string[], calls: { count: number }) {
  const happy = happyHandlers()
  return {
    ...happy,
    propose: proposer(queue, calls),
    plan: async (cli: Parameters<SkillHandler>[0]) => {
      await cli.run(['context'])
      if ((await attemptProposal(cli, 'plan'))?.startsWith('stall-')) {
        await cli.run(['escalate', 'which benchmark?'])
        return
      }
      await happy.plan!(cli)
    },
    implement: async (cli: Parameters<SkillHandler>[0]) => {
      await cli.run(['context'])
      const proposal = (await attemptProposal(cli, 'implement'))!
      const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', `${proposal}\n`)
      if (proposal === 'decline') {
        await cli.run([
          'done',
          '--no-improvement',
          'the cache missed every query',
          '--notes',
          notes,
        ])
        return
      }
      const path = proposal.startsWith('gain-') ? `app/gains/${proposal}` : `app/notes/${proposal}`
      await writeFileIn(cli.ws, path, `${proposal}\n`)
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
      await commitAll(cli.ws, `implement: ${proposal}`)
      await cli.run(['done', '--notes', notes])
    },
  }
}

async function setup(
  makeHarness: Make,
  opts: { objective: string; queue: string[]; seed: Record<string, string>; capacity?: number },
) {
  const calls = { count: 0 }
  const h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG.replace('capacity = 4', `capacity = ${opts.capacity ?? 4}`),
    handlers: attemptHandlers(opts.queue, calls),
    tickets: [
      {
        ...readyTicket('OPT', { title: 'Faster queries', body: objectiveBody(opts.objective) }),
        kind: 'node',
      },
    ],
  })
  // The harness exists at the opening commit, so the pin carries it.
  for (const [path, content] of Object.entries(opts.seed))
    await writeFileIn(h.origin, path, content)
  await commitAll(h.origin, 'bench harness')
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'OPT')!
  return { h, node, calls }
}

async function tick(h: E2eHarness) {
  h.clock.advance(60_000)
  return h.dispatcher.tick()
}

const ran = new WeakMap<E2eHarness, Set<unknown>>()

/** Run every launch not yet run to its park point, in launch order. A
 * launch `held` refuses stays unrun until a later call. */
async function runLaunches(
  h: E2eHarness,
  held: (slug: string) => Promise<boolean> = async () => false,
) {
  const done = ran.get(h) ?? new Set()
  ran.set(h, done)
  for (const entry of h.launched) {
    if (done.has(entry) || (await held(entry.slug))) continue
    done.add(entry)
    await entry.runner.run()
    await h.store.releaseLease(entry.slug, entry.instance)
  }
}

/** Every write so far: each build's log and the repository journal. */
async function written(h: E2eHarness) {
  let count = (await h.store.getRepoStateEvents(h.origin)).length
  for (const record of await h.store.listBuilds()) count += (await h.events(record.slug)).length
  return count
}

/** Tick `advance` apart until a pass writes nothing. */
async function settle(h: E2eHarness, advance: number) {
  for (let i = 0; i < 6; i++) {
    const before = await written(h)
    h.clock.advance(advance)
    await h.dispatcher.tick()
    await runLaunches(h)
    if ((await written(h)) === before) return
  }
  throw new Error('the repository never settled')
}

/** Tick and run launches until `until` holds. */
async function drive(
  h: E2eHarness,
  until: () => Promise<boolean>,
  what: string,
  limit = 12,
  panels?: { judge: () => Promise<void>; held: (slug: string) => Promise<boolean> },
) {
  for (let i = 0; i < limit; i++) {
    await panels?.judge()
    await runLaunches(h, panels?.held)
    if (await until()) return
    await tick(h)
  }
  await panels?.judge()
  await runLaunches(h, panels?.held)
  if (await until()) return
  const dump = await Promise.all(
    (await h.store.listBuilds()).map(async (record) => {
      const events = await h.events(record.slug)
      return `${record.ticket?.id}: ${events
        .slice(-12)
        .map((event) => event.type)
        .join(', ')}`
    }),
  )
  throw new Error(`never reached: ${what}\n${dump.join('\n')}\n${h.cliErrors.join('\n')}`)
}

/** The node's filed attempts, proposal id to ticket id. */
async function filed(h: E2eHarness, node: string) {
  return new Map(
    ofType(await h.events(node), 'optimization.attempts-proposed').flatMap((event) =>
      event.payload.proposals.map((entry) => [entry.id, entry.ticket.id] as const),
    ),
  )
}

/** The build claimed for ticket `id`, with merge consent recorded so it
 * lands when its measurement qualifies. */
async function claimed(h: E2eHarness, id: string) {
  await drive(h, async () => (await buildOf(h, id)) !== undefined, `claim of ${id}`)
  const slug = (await buildOf(h, id))!
  await h.store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  return slug
}

const settledOutcomes = async (h: E2eHarness, node: string) =>
  ofType(await h.events(node), 'attempt.settled').map(
    (event) => [event.payload.attempt.proposal, event.payload.outcome] as const,
  )

const buildOf = async (h: E2eHarness, id: string) =>
  (await h.store.listBuilds()).find((record) => record.ticket?.id === id)?.slug

const stateOf = async (h: E2eHarness, slug: string) => reduceBuild(await h.events(slug))

const types = (events: AbEvent[]) => events.map((event) => event.type)

test('a command optimization node runs from opening to landing', async (makeHarness) => {
  const { h, node, calls } = await setup(makeHarness, {
    objective: commandObjective('abort', 2),
    queue: ['gain-a', 'gain-b', 'flat', 'decline', 'stall-1', 'stall-2'],
    seed: { 'bench/measure.sh': MEASURE_SH },
  })
  try {
    // Opening: the objective is accepted with the opening commit as the pin.
    const opening = await git(['rev-parse', 'main'], h.origin)
    const accepted = ofType(await h.events(node.slug), 'optimization.objective-accepted')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.payload).toMatchObject({ harnessPin: opening })

    // The node's runner takes the real starting measurement.
    await drive(
      h,
      async () => ofType(await h.events(node.slug), 'optimization.baseline-measured').length > 0,
      'starting measurement',
    )
    const nodeEvents = await h.events(node.slug)
    expect(ofType(nodeEvents, 'optimization.baseline-measured')[0]!.payload).toMatchObject({
      head: opening,
      harnessPin: opening,
      samples: 3,
      median: 50,
      spread: 0,
    })
    expect(ofType(nodeEvents, 'optimization.noise-exceeded')).toEqual([])
    expect(types(nodeEvents)).toContain('node.opened')

    // The proposer is requested, deposits, and the dispatcher files ready
    // attempts targeting the node.
    await drive(h, async () => (await filed(h, node.slug)).size === 2, 'first attempts filed')
    const requested = ofType(await h.events(node.slug), 'optimization.proposal-requested')
    expect(requested[0]!.payload).toMatchObject({ room: 2 })
    const first = await filed(h, node.slug)
    for (const id of first.values()) {
      const ticket = await h.tickets.get(id)
      // Filed ready, and claimed by the same pass that filed them.
      expect(ticket).toMatchObject({ kind: 'work', target: 'OPT' })
      expect(['Ready', 'Doing']).toContain(ticket?.state ?? '')
    }

    // Both attempts are claimed and run to their PRs with merge consent.
    const gainA = await claimed(h, first.get('gain-a')!)
    const gainB = await claimed(h, first.get('gain-b')!)
    await drive(
      h,
      async () =>
        (await stateOf(h, gainA)).pr !== undefined && (await stateOf(h, gainB)).pr !== undefined,
      'attempt PRs',
    )
    // gain-a is measured first, so it lands first; gain-b's request is then
    // stale, skipped or overtaken, and it is measured again on the new head.
    await drive(h, async () => (await stateOf(h, gainA)).outcome === 'merged', 'gain-a merged')
    const afterA = await git(['rev-parse', node.branch!], h.origin)
    expect(ofType(await h.events(gainA), 'attempt.measured')[0]!.payload).toMatchObject({
      baseline: opening,
      medians: { baseline: 50, candidate: 47 },
      decision: 'improved',
    })
    await drive(h, async () => (await stateOf(h, gainB)).outcome === 'merged', 'gain-b merged')
    const bRequests = ofType(await h.events(gainB), 'attempt.measurement-requested')
    expect(bRequests.length).toBeGreaterThanOrEqual(2)
    expect(bRequests.at(-1)!.payload.baseline).toBe(afterA)
    expect(ofType(await h.events(gainB), 'attempt.measured').at(-1)!.payload).toMatchObject({
      baseline: afterA,
      medians: { baseline: 47, candidate: 44 },
      decision: 'improved',
    })
    const settledAccepted = ofType(await h.events(node.slug), 'attempt.settled')
    expect(settledAccepted.map((event) => event.payload.outcome)).toEqual(['accepted', 'accepted'])
    expect((await stateOf(h, node.slug)).optimization).toMatchObject({ current: 44 })
    expect(bRequests[0]!.payload.baseline).toBe(opening)

    // Each settlement frees room, so the proposer files `flat` and
    // `decline`: one measured without improvement, one declined.
    await drive(
      h,
      async () => (await settledOutcomes(h, node.slug)).length === 4,
      'flat and decline settled',
      20,
    )
    const outcomes = new Map(await settledOutcomes(h, node.slug))
    expect(outcomes.get('flat')).toBe('no-improvement')
    expect(outcomes.get('decline')).toBe('declined')
    const proposals = await filed(h, node.slug)
    const flat = (await buildOf(h, proposals.get('flat')!))!
    expect(ofType(await h.events(flat), 'attempt.measured').at(-1)!.payload).toMatchObject({
      medians: { baseline: 44, candidate: 44 },
      decision: 'no-improvement',
    })
    expect((await stateOf(h, flat)).outcome).toBe('closed-unmerged')
    const decline = (await buildOf(h, proposals.get('decline')!))!
    expect(types(await h.events(decline))).not.toContain('attempt.measurement-requested')
    expect((await stateOf(h, decline)).pr).toBeUndefined()
    await drive(
      h,
      async () =>
        (await h.tickets.get(proposals.get('flat')!))?.state === 'Rejected' &&
        (await h.tickets.get(proposals.get('decline')!))?.state === 'Rejected',
      'rejected role moves',
    )
    const rejected = ofType(await h.events(node.slug), 'attempt.ticket-rejected')
    expect(rejected.map((event) => event.payload.proposal).sort()).toEqual(['decline', 'flat'])
    const afterB = await git(['rev-parse', node.branch!], h.origin)
    expect(await git(['ls-tree', '-r', '--name-only', afterB], h.origin)).not.toContain(
      'app/notes/flat',
    )
    expect((await stateOf(h, node.slug)).optimization).toMatchObject({ plateau: 2, current: 44 })

    // The stalled attempts fill the node's concurrency, each blocked on a
    // question: an idle optimization node.
    const stalls = await drive(
      h,
      async () => {
        const filedNow = await filed(h, node.slug)
        const slugs = await Promise.all(
          ['stall-1', 'stall-2'].map(async (id) =>
            filedNow.has(id) ? buildOf(h, filedNow.get(id)!) : undefined,
          ),
        )
        if (slugs.some((slug) => slug === undefined)) return false
        const states = await Promise.all(slugs.map((slug) => stateOf(h, slug!)))
        return states.every((state) => state.status === 'blocked')
      },
      'stalled attempts blocked',
    ).then(async () => {
      const filedNow = await filed(h, node.slug)
      return Promise.all(
        ['stall-1', 'stall-2'].map(async (id) => (await buildOf(h, filedNow.get(id)!))!),
      )
    })
    // Settle until a pass writes nothing, then past the node's quiet period
    // so its polling has gone idle too.
    await settle(h, 60_000)
    await settle(h, 15 * 60_000)
    const idleFrom = (await h.events(node.slug)).length
    for (const advance of [60_000, 2 * 3_600_000]) {
      h.clock.advance(advance)
      const metrics = await measureStoreReads(h.store, async () => {
        await h.dispatcher.tick()
      })
      expect(metrics.rows).toBe(0)
    }
    expect(await h.events(node.slug)).toHaveLength(idleFrom)

    // Landing waits for a stop; raising the threshold past the head value
    // stops the node in its abort mode.
    await expect(
      controlBuild({ store: h.store, repo: h.origin, slug: node.slug, action: { kind: 'land' } }),
    ).rejects.toThrow('has not stopped')
    const revised = await reviseObjective({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      user: 'op',
      changes: { threshold: 45 },
    })
    expect(revised.revision).toBe(2)
    await drive(
      h,
      async () =>
        (await settledOutcomes(h, node.slug)).filter(([, outcome]) => outcome === 'stopped')
          .length === 2,
      'stalled attempts stopped',
    )
    const nodeAfterStop = await h.events(node.slug)
    expect(ofType(nodeAfterStop, 'optimization.stopped').map((event) => event.payload)).toEqual([
      { cause: 'threshold', mode: 'abort' },
    ])
    const stoppedAt = ofType(nodeAfterStop, 'optimization.stopped')[0]!.seq
    for (const stall of stalls) {
      const events = await h.events(stall)
      expect(ofType(events, 'build.abort-requested')[0]!.payload.reason).toBe(
        `optimization node ${node.slug} stopped (threshold, abort)`,
      )
      expect(types(events)).toContain('build.aborted')
    }

    // Stopping is not consent: the node completes and waits for a land.
    const all = await filed(h, node.slug)
    await drive(
      h,
      async () => {
        const state = await stateOf(h, node.slug)
        return (
          state.optimization?.inFlight.length === 0 &&
          ofType(await h.events(node.slug), 'integration.prepared').length > 0 &&
          (await h.tickets.get(all.get('stall-1')!))?.state === 'Rejected' &&
          (await h.tickets.get(all.get('stall-2')!))?.state === 'Rejected'
        )
      },
      'node completion',
    )
    await tick(h)
    await runLaunches(h)
    await tick(h)
    const completed = await h.events(node.slug)
    expect(types(completed)).not.toContain('build.land-requested')
    expect(
      ofType(completed, 'optimization.proposal-requested').filter((event) => event.seq > stoppedAt),
    ).toEqual([])
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      action: { kind: 'land' },
      ticketSource: async () => h.tickets,
      rejectedState: async () => 'Rejected',
    })
    await drive(h, async () => (await stateOf(h, node.slug)).status === 'done', 'node landed')
    const main = await git(['ls-tree', '-r', '--name-only', 'main'], h.origin)
    expect(main).toContain('app/gains/gain-a')
    expect(main).toContain('app/gains/gain-b')
    expect(main).not.toContain('app/notes/')
    // Every proposer run deposited strategies; the queue was never exhausted.
    const deposits = ofType(await h.events(node.slug), 'propose.completed')
    expect(deposits).toHaveLength(calls.count)
    expect(deposits.flatMap((event) => event.payload.proposals)).toEqual([
      'gain-a',
      'gain-b',
      'flat',
      'decline',
      'stall-1',
      'stall-2',
    ])
    expect(h.cliErrors).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 120_000)

test('drain mode lets a running attempt merge only because it improved the node head', async (makeHarness) => {
  // Two slots: the third proposal is filed but never claimed.
  const { h, node } = await setup(makeHarness, {
    objective: commandObjective('drain', 3),
    queue: ['gain-c', 'flat-d', 'queued'],
    seed: { 'bench/measure.sh': MEASURE_SH },
    capacity: 2,
  })
  try {
    const opening = await git(['rev-parse', 'main'], h.origin)
    await drive(h, async () => (await filed(h, node.slug)).size === 3, 'attempts filed')
    const proposals = await filed(h, node.slug)
    const gainC = await claimed(h, proposals.get('gain-c')!)
    const flatD = await claimed(h, proposals.get('flat-d')!)
    expect(await buildOf(h, proposals.get('queued')!)).toBeUndefined()

    expect(
      await stopObjective({ store: h.store, repo: h.origin, slug: node.slug, user: 'op' }),
    ).toEqual({ slug: node.slug, cause: 'operator', mode: 'drain' })
    await drive(
      h,
      async () => (await h.tickets.get(proposals.get('queued')!))?.state === 'Rejected',
      'queued attempt rejected',
    )
    expect(await buildOf(h, proposals.get('queued')!)).toBeUndefined()
    expect(new Map(await settledOutcomes(h, node.slug))).toEqual(new Map([['queued', 'stopped']]))
    for (const slug of [gainC, flatD])
      expect(ofType(await h.events(slug), 'build.abort-requested')).toEqual([])
    await expect(
      controlBuild({ store: h.store, repo: h.origin, slug: node.slug, action: { kind: 'land' } }),
    ).rejects.toThrow('attempts still in flight')

    // Both running attempts finish and are measured; only the improvement lands.
    await drive(
      h,
      async () => (await settledOutcomes(h, node.slug)).length === 3,
      'running attempts settled',
      20,
    )
    const outcomes = new Map(await settledOutcomes(h, node.slug))
    expect(outcomes.get('gain-c')).toBe('accepted')
    expect(outcomes.get('flat-d')).toBe('no-improvement')
    expect((await stateOf(h, gainC)).outcome).toBe('merged')
    expect(ofType(await h.events(gainC), 'attempt.measured').at(-1)!.payload).toMatchObject({
      baseline: opening,
      medians: { baseline: 50, candidate: 47 },
      decision: 'improved',
    })
    expect((await stateOf(h, flatD)).outcome).toBe('closed-unmerged')
    expect(ofType(await h.events(flatD), 'attempt.measured').at(-1)!.payload).toMatchObject({
      decision: 'no-improvement',
    })
    await drive(
      h,
      async () => (await h.tickets.get(proposals.get('flat-d')!))?.state === 'Rejected',
      'flat-d rejected',
    )

    // The node completes, and lands by consent.
    await drive(
      h,
      async () => ofType(await h.events(node.slug), 'integration.prepared').length > 0,
      'node completion',
    )
    await tick(h)
    await runLaunches(h)
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      action: { kind: 'land' },
      ticketSource: async () => h.tickets,
      rejectedState: async () => 'Rejected',
    })
    await drive(h, async () => (await stateOf(h, node.slug)).status === 'done', 'node landed')
    const main = await git(['ls-tree', '-r', '--name-only', 'main'], h.origin)
    expect(main).toContain('app/gains/gain-c')
    expect(main).not.toContain('app/notes/flat-d')
    expect(h.cliErrors).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 120_000)

const PANEL_OBJECTIVE = [
  'purpose = "clearer onboarding prose; every step must stay accurate"',
  '',
  '[metric]',
  'kind = "panel"',
  'judges = 5',
  'rubric = "evals/rubric.md"',
  'harness = ["evals/**"]',
  '',
  '[target]',
  'threshold = 0.7',
  'epsilon = { absolute = 0.1 }',
  '',
  '[budget]',
  'maxAttempts = 10',
  '',
  '[proposer]',
  'concurrency = 1',
].join('\n')

/** The test stands in for the judges, whose run `panel-run.integration.test.ts`
 * proves: before any runner runs, every panel the node or an attempt owes is
 * recorded with the given win rate, exactly as the runner records it. */
async function judgePanels(h: E2eHarness, winRates: { attempt: number; progress?: number }) {
  for (const record of await h.store.listBuilds()) {
    const state = await stateOf(h, record.slug)
    if (baselineMeasurementDue(state)) {
      const pin = state.optimization!.accepted.harnessPin
      await h.store.append(record.slug, {
        actor: KERNEL,
        type: 'optimization.baseline-measured',
        payload: {
          revision: state.optimization!.revision,
          head: pin,
          harnessPin: pin,
          samples: 5,
          median: 0.5,
          spread: 0,
        },
      })
    }
    const progress = progressMeasurementDue(state)
    if (progress !== undefined && winRates.progress !== undefined)
      await h.store.append(record.slug, {
        actor: KERNEL,
        type: 'optimization.progress-measured',
        payload: {
          revision: progress.revision,
          head: progress.head,
          start: progress.start,
          winRate: winRates.progress,
          judges: 5,
        },
      })
    const request = pendingMeasurementRequest(state)
    if (request !== undefined)
      await h.store.append(record.slug, {
        actor: KERNEL,
        type: 'attempt.sampled',
        payload: {
          request: request.id,
          candidate: request.candidate,
          baseline: request.baseline,
          harnessPin: request.harnessPin,
          revision: request.revision,
          samples: 5,
          winRate: winRates.attempt,
          report: { kind: 'measurement-samples', rev: 0 },
        },
      })
  }
}

const owesPanel = (state: ReturnType<typeof reduceBuild>) =>
  baselineMeasurementDue(state) ||
  progressMeasurementDue(state) !== undefined ||
  pendingMeasurementRequest(state) !== undefined

test('a panel node accepts by win rate and stops on a win-rate threshold against its starting head', async (makeHarness) => {
  const { h, node } = await setup(makeHarness, {
    objective: PANEL_OBJECTIVE,
    // `stall-p` keeps the proposer from coming back empty, so only the
    // threshold can stop the node.
    queue: ['gain-p', 'stall-p'],
    seed: { 'evals/rubric.md': '# Rubric\n\nPrefer the clearer setup steps.\n' },
  })
  // Progress panels are held back until the test has seen one owed.
  let progress: number | undefined
  const judged = (until: () => Promise<boolean>, what: string) =>
    drive(h, until, what, 12, {
      judge: () => judgePanels(h, { attempt: 0.6, progress }),
      // No runner runs a panel the test has not stood in for.
      held: async (slug) => owesPanel(await stateOf(h, slug)),
    })
  try {
    const opening = await git(['rev-parse', 'main'], h.origin)
    await judged(
      async () => (await stateOf(h, node.slug)).optimization?.starting !== undefined,
      'starting panel',
    )
    expect(ofType(await h.events(node.slug), 'optimization.noise-exceeded')).toEqual([])

    // The proposer files one attempt; its landing panel judges it against
    // the node head, and 0.6 meets 0.5 + ε.
    await judged(async () => (await filed(h, node.slug)).has('gain-p'), 'gain-p filed')
    const gainP = await claimed(h, (await filed(h, node.slug)).get('gain-p')!)
    await judged(
      async () => ofType(await h.events(gainP), 'attempt.measurement-requested').length > 0,
      'panel request',
    )
    expect(
      ofType(await h.events(gainP), 'attempt.measurement-requested')[0]!.payload,
    ).toMatchObject({
      baseline: opening,
      metric: { kind: 'panel', judges: 5, rubric: 'evals/rubric.md' },
      purpose: 'clearer onboarding prose; every step must stay accurate',
    })
    // The landing alone does not stop the node: 0.6 was judged against the
    // old head, and the threshold is judged against the starting head.
    await judged(async () => (await stateOf(h, gainP)).outcome === 'merged', 'gain-p merged')
    const nodeAfterLanding = await h.events(node.slug)
    expect(ofType(await h.events(gainP), 'attempt.measured')[0]!.payload).toMatchObject({
      winRate: 0.6,
      decision: 'improved',
    })
    const landed = ofType(nodeAfterLanding, 'attempt.settled')[0]!.payload
    expect(landed).toMatchObject({ outcome: 'accepted' })
    expect(ofType(nodeAfterLanding, 'optimization.stopped')).toEqual([])
    expect(progressMeasurementDue(reduceBuild(nodeAfterLanding))).toMatchObject({
      head: landed.head,
      start: opening,
    })

    // The progress panel of the landed head against the starting head
    // reaches the threshold, and the node stops in abort mode.
    progress = 0.8
    await judged(
      async () => ofType(await h.events(node.slug), 'optimization.stopped').length > 0,
      'threshold stop',
    )
    const stoppedEvents = await h.events(node.slug)
    expect(ofType(stoppedEvents, 'optimization.progress-measured')[0]!.payload).toMatchObject({
      head: landed.head,
      start: opening,
      winRate: 0.8,
    })
    expect(ofType(stoppedEvents, 'optimization.stopped').map((event) => event.payload)).toEqual([
      { cause: 'threshold', mode: 'abort' },
    ])
    expect(reduceBuild(stoppedEvents).optimization).toMatchObject({ current: 0.8 })

    // The stopped node completes and waits for consent: idle, it reads no
    // event rows on a tick.
    await judged(
      async () => ofType(await h.events(node.slug), 'integration.prepared').length > 0,
      'node completion',
    )
    await settle(h, 60_000)
    await settle(h, 15 * 60_000)
    for (const advance of [60_000, 2 * 3_600_000]) {
      h.clock.advance(advance)
      const metrics = await measureStoreReads(h.store, async () => {
        await h.dispatcher.tick()
      })
      expect(metrics.rows).toBe(0)
    }
    expect(types(await h.events(node.slug))).not.toContain('build.land-requested')
    expect(h.cliErrors).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 120_000)
