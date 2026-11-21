/** An optimization attempt's implementer declines (RFC 0005 §6.2): the build
 * ends unmerged without review, verification or measurement, and the
 * dispatcher settles the attempt `declined` on the node exactly once. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { readOptimizationLedger } from '../store/reduced-reads'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  happyHandlers,
  ofType,
  readyTicket,
  scenarioScope,
  writeFileIn,
  type E2eHarness,
} from './harness'

const test = scenarioScope({ test: bunTest, afterEach })

const OBJECTIVE = [
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
  'epsilon = { relative = 0.03 }',
  '',
  '[budget]',
  'maxAttempts = 20',
  '```',
].join('\n')

const REASON = 'a trigram index did not beat the btree on this corpus'

test('a declined attempt settles on the node and completes unmerged', async (makeHarness) => {
  let h!: E2eHarness
  const node = async () => (await h.store.listBuilds()).find((r) => r.ticket?.id === 'OPT')!
  // Stands in for the proposer (AUT-1228): the attempt's ticket is filed
  // from a recorded proposal before its implementer runs.
  let proposed = false
  const propose = async () => {
    if (proposed) return
    proposed = true
    await h.store.append((await node()).slug, {
      actor: DISPATCHER,
      type: 'optimization.attempts-proposed',
      payload: {
        request: 'r1',
        proposals: [
          {
            id: 'p1',
            ticket: { source: 'fake', id: 'TRY' },
            title: 'Trigram index',
            strategy: 'index the search column with trigrams',
          },
        ],
      },
    })
  }
  h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG_TOML.replace(
      'readyState = "Ready"',
      'readyState = "Ready"\nrejectedState = "Rejected"',
    ),
    handlers: {
      ...happyHandlers(),
      implement: async (cli) => {
        await propose()
        const [context] = await cli.run(['context'])
        expect(context).toContain('implement')
        const manifest = JSON.parse(await Bun.file(`${cli.ws}/.ab/implement/context.json`).text())
        expect(manifest.attempt).toMatchObject({ proposal: 'p1', harness: ['bench/**'] })
        await writeFileIn(cli.ws, 'scratch.ts', 'abandoned\n')
        const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', 'baseline 52, 52\n')
        await cli.run(['done', '--no-improvement', REASON, '--notes', notes])
      },
    },
    tickets: [
      {
        ...readyTicket('OPT', { title: 'Faster search', body: `${CONFORMING_BODY}\n${OBJECTIVE}` }),
        kind: 'node',
      },
      { ...readyTicket('TRY', { title: 'Trigram index' }), target: 'OPT' },
    ],
  })
  try {
    await h.dispatcher.tick()
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'TRY')!
    // The node launches too, for its starting measurement (AUT-1225); only
    // the attempt's launches matter here.
    const attemptLaunches = () => h.launched.filter((entry) => entry.slug === child.slug)
    expect(attemptLaunches()).toHaveLength(1)
    await h.runLaunched(child.slug)
    // The runner stopped at wait/declined; the janitor settles the attempt.
    expect(reduceBuild(await h.events(child.slug)).declined?.reason).toBe(REASON)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(attemptLaunches()).toHaveLength(1)
    const events = await h.events(child.slug)
    const types = events.map((event) => event.type)
    expect(ofType(events, 'implement.declined')).toHaveLength(1)
    expect(ofType(events, 'implement.started')).toHaveLength(1)
    for (const type of types)
      expect(
        /^(code-review|verify|finalize|pr)\.|^attempt\.measurement-requested$/.test(type),
      ).toBe(false)
    expect(ofType(events, 'phase.failed')).toHaveLength(0)
    expect(ofType(events, 'build.completed').map((event) => event.payload)).toEqual([
      { outcome: 'closed-unmerged' },
    ])
    expect(reduceBuild(events).status).toBe('done')

    const nodeSlug = (await node()).slug
    const settled = ofType(await h.events(nodeSlug), 'attempt.settled')
    expect(settled.map((event) => event.payload)).toEqual([
      {
        attempt: { proposal: 'p1', ticket: { source: 'fake', id: 'TRY' }, build: child.slug },
        outcome: 'declined',
        note: REASON,
      },
    ])
    const digest = reduceBuild(await h.events(nodeSlug)).optimization!
    expect(digest.plateau).toBe(1)
    expect(digest.inFlight).toEqual([])
    const ledger = (await readOptimizationLedger(h.store, nodeSlug)).value
    expect(ledger.entries).toMatchObject([{ proposal: 'p1', outcome: 'declined', note: REASON }])

    // Settled exactly once: a further tick appends nothing to the child and
    // no second settlement to the node (node polling bookkeeping may land).
    const before = (await h.events(child.slug)).length
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(await h.events(child.slug)).toHaveLength(before)
    expect(ofType(await h.events(nodeSlug), 'attempt.settled')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 60_000)
