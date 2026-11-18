/** An optimization node's proposer phase (SPEC §13.1.1, RFC 0005 §5): the
 * dispatcher requests, the proposer deposits, the dispatcher files ready
 * attempts targeting the node, over real git and the fake ticket source. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { attemptCreationKey } from '../kernel/optimization'
import { reduceBuild } from '../kernel/reducer'
import type { BuildRecord } from '../store/types'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  type E2eHarness,
  happyHandlers,
  ofType,
  openWorkspacePath,
  readyTicket,
  type SkillHandler,
  scenarioScope,
  writeFileIn,
} from './harness'

const test = scenarioScope({ test: bunTest, afterEach })

const objective = (budget: string, concurrency: number) =>
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
    '',
    '[proposer]',
    `concurrency = ${concurrency}`,
    '```',
  ].join('\n')

const attemptBody = (strategy: string) =>
  [
    `Try ${strategy} to lower search latency.`,
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

/** A proposer that deposits the given ids, or nothing. */
function proposer(ids: string[] | (() => string[]), seen?: { files: string[] }): SkillHandler {
  return async (cli) => {
    await cli.run(['context'])
    const dir = join(cli.ws, '.ab', 'propose')
    if (seen) {
      const manifest = JSON.parse(await readFile(join(dir, 'context.json'), 'utf8'))
      seen.files = Object.keys(manifest.materialized).sort()
    }
    const chosen = typeof ids === 'function' ? ids() : ids
    if (chosen.length === 0) {
      await cli.run(['propose', '--none', 'no further strategies worth measuring'])
      return
    }
    const file = await writeFileIn(
      cli.ws,
      '.ab/proposals.json',
      JSON.stringify({
        proposals: chosen.map((id) => ({
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

async function openNode(
  makeHarness: (opts: Parameters<typeof import('./harness').makeHarness>[0]) => Promise<E2eHarness>,
  opts: {
    budget?: string
    concurrency?: number
    capacity?: number
    leaf?: boolean
    propose?: SkillHandler
  } = {},
): Promise<{ h: E2eHarness; node: BuildRecord }> {
  const h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG_TOML.replace('capacity = 2', `capacity = ${opts.capacity ?? 4}`).replace(
      'readyState = "Ready"',
      'readyState = "Ready"\nrejectedState = "Rejected"',
    ),
    handlers: { ...happyHandlers(), propose: opts.propose ?? proposer(['cache', 'index']) },
    tickets: [
      {
        ...readyTicket('OPT', {
          title: 'Faster search',
          body: [
            CONFORMING_BODY,
            '',
            objective(opts.budget ?? 'maxAttempts = 20', opts.concurrency ?? 2),
          ].join('\n'),
        }),
        kind: 'node',
      },
      ...(opts.leaf ? [readyTicket('LEAF', { title: 'Unrelated work' })] : []),
    ],
  })
  const report = await h.dispatcher.tick()
  const node = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'OPT')
  if (node === undefined) throw new Error(`node not opened: ${JSON.stringify(report)}`)
  return { h, node }
}

/** Record the starting measurement, as the measurement sibling will. */
async function measure(h: E2eHarness, slug: string): Promise<void> {
  const opened = ofType(await h.events(slug), 'node.opened')[0]!
  await h.store.append(slug, {
    actor: KERNEL,
    type: 'optimization.baseline-measured',
    payload: {
      revision: 1,
      head: opened.payload.sha,
      harnessPin: opened.payload.sha,
      samples: 5,
      median: 50,
      spread: 1,
    },
  })
}

async function revise(h: E2eHarness, slug: string, changes: Record<string, number>) {
  const revision = reduceBuild(await h.events(slug)).optimization!.revision + 1
  await h.store.append(slug, {
    actor: humanActor('ada'),
    type: 'optimization.objective-revised',
    payload: { changes, revision },
  })
}

test('the proposer is requested, deposits, and its attempts are filed ready and targeted', async (makeHarness) => {
  const seen = { files: [] as string[] }
  const { h, node } = await openNode(makeHarness, { propose: proposer(['cache', 'index'], seen) })
  try {
    // No starting measurement: no request.
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(ofType(await h.events(node.slug), 'optimization.proposal-requested')).toHaveLength(0)

    await measure(h, node.slug)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const requested = ofType(await h.events(node.slug), 'optimization.proposal-requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]!.payload).toMatchObject({ room: 2, budgetUsed: { attempts: 0 } })
    expect(h.launched.at(-1)?.slug).toBe(node.slug)

    await h.runLatest()
    const events = await h.events(node.slug)
    expect(ofType(events, 'propose.started')).toHaveLength(1)
    expect(ofType(events, 'propose.completed')[0]!.payload.proposals).toEqual(['cache', 'index'])
    expect(seen.files).toEqual(
      expect.arrayContaining(['ledger.json', 'objective.json', 'progress.json', 'spec.md']),
    )
    expect(h.cliErrors).toEqual([])

    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const filed = ofType(await h.events(node.slug), 'optimization.attempts-proposed')
    expect(filed).toHaveLength(1)
    expect(filed[0]!.payload.proposals.map((entry) => entry.id)).toEqual(['cache', 'index'])
    const created = filed[0]!.payload.proposals.map((entry) => entry.ticket.id)
    for (const [index, id] of created.entries()) {
      const ticket = (await h.tickets.listAll()).tickets.find(
        (candidate) => candidate.ref.id === id,
      )!
      expect(ticket).toMatchObject({ kind: 'work', target: 'OPT', labels: ['autobuild'] })
      expect(ticket.creationKey).toBe(
        attemptCreationKey(h.origin, node.slug, ['cache', 'index'][index]!),
      )
    }
    const state = reduceBuild(await h.events(node.slug))
    expect(state.optimization?.attempts.filed).toBe(2)
    expect(state.optimization?.proposal).toBeUndefined()

    // Concurrency is full: no further request.
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(ofType(await h.events(node.slug), 'optimization.proposal-requested')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('a crash between creation and record adopts the same tickets and holds them from intake', async (makeHarness) => {
  const { h, node } = await openNode(makeHarness)
  try {
    await measure(h, node.slug)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    // The record fails after both tickets were created; meanwhile a stop lands.
    const append = h.store.appendIfCurrent.bind(h.store)
    let failures = 1
    h.store.appendIfCurrent = (async (slug, seq, write) => {
      if (write.type === 'optimization.attempts-proposed' && failures-- > 0)
        throw new Error('injected crash before the record')
      return append(slug, seq, write)
    }) as typeof h.store.appendIfCurrent
    h.clock.advance(60_000)
    const crashed = await h.dispatcher.tick()
    expect((await h.tickets.listAll()).tickets.filter((t) => t.target === 'OPT')).toHaveLength(2)
    expect(crashed.creationWithheld).toBe(2)
    expect(
      (await h.store.listBuilds()).filter((record) => record.ticket?.id !== 'OPT'),
    ).toHaveLength(0)
    await h.store.append(node.slug, {
      actor: humanActor('ada'),
      type: 'optimization.stopped',
      payload: { cause: 'operator', mode: 'drain' },
    })

    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const events = await h.events(node.slug)
    const filed = ofType(events, 'optimization.attempts-proposed')
    expect(filed).toHaveLength(1)
    expect(filed[0]!.payload.proposals).toHaveLength(2)
    expect((await h.tickets.listAll()).tickets.filter((t) => t.target === 'OPT')).toHaveLength(2)
    expect(ofType(events, 'optimization.proposal-withdrawn')).toHaveLength(0)
    const state = reduceBuild(events)
    expect(state.optimization?.attempts.filed).toBe(2)
    expect(state.optimization?.emptyProposals).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('a crash after the filing record still releases the proposer workspace', async (makeHarness) => {
  const { h, node } = await openNode(makeHarness)
  try {
    await measure(h, node.slug)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    expect(openWorkspacePath(await h.events(node.slug))).not.toBeNull()
    // The record commits, then the dispatcher fails before its release.
    const append = h.store.appendIfCurrent.bind(h.store)
    let failures = 1
    h.store.appendIfCurrent = (async (slug, seq, write) => {
      const result = await append(slug, seq, write)
      if (write.type === 'optimization.attempts-proposed' && failures-- > 0)
        throw new Error('injected crash after the record')
      return result
    }) as typeof h.store.appendIfCurrent
    // The proposal is gone, so filing is no longer due; the stranded
    // workspace itself is the durable condition that releases it.
    for (let tick = 0; tick < 2; tick += 1) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    const events = await h.events(node.slug)
    expect(failures).toBe(0)
    expect(reduceBuild(events).optimization?.proposal).toBeUndefined()
    expect(ofType(events, 'optimization.attempts-proposed')).toHaveLength(1)
    expect(openWorkspacePath(events)).toBeNull()
    expect(ofType(events, 'workspace.released').at(-1)!.seq).toBeGreaterThan(
      ofType(events, 'optimization.attempts-proposed')[0]!.seq,
    )
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('two consecutive empty proposals stop the node as exhausted', async (makeHarness) => {
  const { h, node } = await openNode(makeHarness, { propose: proposer([]) })
  try {
    await measure(h, node.slug)
    for (let round = 0; round < 2; round += 1) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      await h.runLatest()
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    const events = await h.events(node.slug)
    expect(ofType(events, 'optimization.attempts-proposed')).toHaveLength(2)
    expect(ofType(events, 'optimization.stopped').map((e) => e.payload)).toEqual([
      { cause: 'exhausted', mode: 'abort' },
    ])
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(ofType(await h.events(node.slug), 'optimization.proposal-requested')).toHaveLength(2)
    expect(h.cliErrors).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 60_000)

for (const change of ['hours', 'budget', 'concurrency', 'stopped'] as const)
  test(`a request waiting for a slot is withdrawn when ${change} makes it ineligible`, async (makeHarness) => {
    const { h, node } = await openNode(makeHarness, {
      capacity: 1,
      leaf: true,
      concurrency: 3,
      budget: 'maxAttempts = 20\nmaxHours = 2',
    })
    try {
      // The leaf holds the only slot; the request waits.
      await measure(h, node.slug)
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      expect(ofType(await h.events(node.slug), 'optimization.proposal-requested')).toHaveLength(1)
      expect(ofType(await h.events(node.slug), 'propose.started')).toHaveLength(0)
      expect(h.launched.some((entry) => entry.slug === node.slug)).toBe(false)

      if (change === 'hours') h.clock.advance(3 * 3_600_000)
      if (change === 'budget') await revise(h, node.slug, { maxAttempts: 0 + 1 })
      if (change === 'concurrency') await revise(h, node.slug, { concurrency: 2 })
      if (change === 'stopped')
        await h.store.append(node.slug, {
          actor: DISPATCHER,
          type: 'optimization.stopped',
          payload: { cause: 'operator', mode: 'abort' },
        })
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const events = await h.events(node.slug)
      const withdrawn = ofType(events, 'optimization.proposal-withdrawn')
      expect(withdrawn.map((event) => event.payload.reason)).toEqual([
        change === 'hours' ? 'budget' : change,
      ])
      expect(ofType(events, 'propose.started')).toHaveLength(0)
      expect(h.launched.some((entry) => entry.slug === node.slug)).toBe(false)

      // A shrink to a smaller positive room requests again at that room;
      // a stop or a spent budget requests nothing.
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const requests = ofType(await h.events(node.slug), 'optimization.proposal-requested')
      if (change === 'budget' || change === 'concurrency') {
        expect(requests).toHaveLength(2)
        expect(requests[1]!.payload.room).toBe(change === 'budget' ? 1 : 2)
      } else expect(requests).toHaveLength(1)
      expect(reduceBuild(await h.events(node.slug)).optimization?.emptyProposals).toBe(0)
    } finally {
      await h.cleanup()
    }
  }, 60_000)

test('a deposit larger than the request room is refused', async (makeHarness) => {
  const { h, node } = await openNode(makeHarness, {
    propose: async (cli) => {
      await cli.run(['context'])
      const file = await writeFileIn(
        cli.ws,
        '.ab/proposals.json',
        JSON.stringify({
          proposals: ['a', 'b', 'c'].map((id) => ({
            id,
            title: `Attempt ${id}`,
            strategy: `strategy ${id}`,
            body: attemptBody(id),
          })),
        }),
      )
      await expect(cli.run(['propose', file])).rejects.toThrow(/exceed this request's room of 2/)
      await cli.run(['propose', '--none', 'nothing fits'])
    },
  })
  try {
    await measure(h, node.slug)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    expect(ofType(await h.events(node.slug), 'propose.completed')[0]!.payload.proposals).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 60_000)
