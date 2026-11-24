/** Optimization node objectives at dispatch, opening and spec revision
 * (SPEC §13.1.1), over real git. */
import { afterEach, expect, test as bunTest } from 'bun:test'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
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

const OBJECTIVE = [
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
  'maxAttempts = 20',
].join('\n')

const block = (toml = OBJECTIVE) => ['```autobuild-objective', toml, '```'].join('\n')
const withBlock = (...parts: string[]) => [CONFORMING_BODY, '', ...parts].join('\n')

test('a heading, a toml block and prose open as plain nodes', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [
      {
        ...readyTicket('HEADING', {
          title: 'Heading node',
          body: withBlock('## Objective', '', 'Minimize p95 latency within 20 attempts.'),
        }),
        kind: 'node',
      },
      {
        ...readyTicket('TOML', {
          title: 'Toml node',
          body: withBlock(['```toml', OBJECTIVE, '```'].join('\n')),
        }),
        kind: 'node',
      },
      {
        ...readyTicket('NESTED', {
          title: 'Nested node',
          body: withBlock(['````markdown', block(), '````'].join('\n')),
        }),
        kind: 'node',
      },
    ],
  })
  try {
    await h.dispatcher.tick()
    const builds = await h.store.listBuilds()
    expect(builds.map((r) => r.ticket?.id).sort()).toEqual(['HEADING', 'NESTED', 'TOML'])
    for (const record of builds) {
      const events = await h.events(record.slug)
      expect(ofType(events, 'node.opened')).toHaveLength(1)
      expect(ofType(events, 'optimization.objective-accepted')).toHaveLength(0)
      expect(reduceBuild(events).optimization).toBeUndefined()
    }
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('refused objectives bounce to triage naming the reason and create no build', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [
      {
        ...readyTicket('TWO', { title: 'Two blocks', body: withBlock(block(), '', block()) }),
        kind: 'node',
      },
      {
        ...readyTicket('BAD', {
          title: 'Bad field',
          body: withBlock(block(OBJECTIVE.replace('samples = 5', 'samples = 0'))),
        }),
        kind: 'node',
      },
      {
        ...readyTicket('NOBUDGET', {
          title: 'No budget',
          body: withBlock(block(OBJECTIVE.replace('[budget]\nmaxAttempts = 20', ''))),
        }),
        kind: 'node',
      },
      readyTicket('WORK', { title: 'Work with block', body: withBlock(block()) }),
    ],
  })
  try {
    await h.dispatcher.tick()
    expect(await h.store.listBuilds()).toEqual([])
    const comment = (id: string) => h.tickets.comments.find((c) => c.id === id)?.body ?? ''
    for (const id of ['TWO', 'BAD', 'NOBUDGET', 'WORK']) {
      expect((await h.tickets.get(id))?.state).toBe('Triage')
      expect(comment(id)).toContain('cannot open as dispatched')
    }
    expect(comment('TWO')).toContain('exactly one autobuild-objective block (found 2)')
    expect(comment('BAD')).toContain('metric.samples')
    expect(comment('NOBUDGET')).toContain('budget.maxAttempts or budget.maxHours')
    expect(comment('WORK')).toContain('no autobuild-objective block in a work ticket')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an objective node without a rejected role is refused naming the setting', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      {
        ...readyTicket('OPT', { title: 'No rejected role', body: withBlock(block()) }),
        kind: 'node',
      },
    ],
  })
  try {
    await h.dispatcher.tick()
    expect(await h.store.listBuilds()).toEqual([])
    expect((await h.tickets.get('OPT'))?.state).toBe('Triage')
    expect(h.tickets.comments.find((c) => c.id === 'OPT')?.body).toContain(
      '[tickets].rejectedState',
    )
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a valid objective is accepted before the node opens; revisions may change it but never add or remove the block', async (makeHarness) => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: WITH_REJECTED,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('OPT', { title: 'Optimization', body: withBlock(block()) }), kind: 'node' },
      { ...readyTicket('PLAIN', { title: 'Plain node' }), kind: 'node' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const records = await h.store.listBuilds()
    const node = records.find((r) => r.ticket?.id === 'OPT')!
    const plain = records.find((r) => r.ticket?.id === 'PLAIN')!
    // Accepted once, before the node opens, pinned to its opening commit.
    const opening = await h.events(node.slug)
    const opened = ofType(opening, 'node.opened')
    const initial = ofType(opening, 'optimization.objective-accepted')
    expect(initial).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(initial[0]!.seq).toBeLessThan(opened[0]!.seq)
    expect(initial[0]!.payload).toMatchObject({
      revision: 1,
      specRev: 0,
      harnessPin: opened[0]!.payload.sha,
      objective: {
        metric: { kind: 'command', harness: ['bench/**'] },
        stop: { mode: 'abort' },
        proposer: { concurrency: 1 },
      },
    })
    expect(reduceBuild(opening).status).toBe('collecting')
    expect(reduceBuild(opening).optimization?.revision).toBe(1)
    // Ticks after opening never accept twice.
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(ofType(await h.events(node.slug), 'optimization.objective-accepted')).toHaveLength(1)

    const revise = (slug: string, body: string) =>
      controlBuild({
        store: h.store,
        repo: h.origin,
        slug,
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: { kind: 'supplied', origin: 'replacement.md', read: async () => body },
          },
        },
      })
    const before = (await h.events(node.slug)).length
    await expect(revise(node.slug, CONFORMING_BODY)).rejects.toThrow(
      'cannot remove the `autobuild-objective` block',
    )
    await expect(
      revise(node.slug, withBlock(block(OBJECTIVE.replace('samples = 5', 'samples = 0')))),
    ).rejects.toThrow('metric.samples')
    await expect(revise(plain.slug, withBlock(block()))).rejects.toThrow(
      'cannot add an `autobuild-objective` block',
    )
    expect(await h.events(node.slug)).toHaveLength(before)

    await revise(node.slug, withBlock(block(OBJECTIVE.replace('threshold = 40', 'threshold = 30'))))
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const events = await h.events(node.slug)
    const accepted = ofType(events, 'optimization.objective-accepted')
    expect(accepted).toHaveLength(2)
    expect(accepted[1]!.payload).toMatchObject({
      revision: 2,
      specRev: 1,
      harnessPin: accepted[0]!.payload.harnessPin,
      objective: { target: { threshold: 30 } },
    })
    expect(reduceBuild(events).optimization?.rulerRevision).toBe(1)

    // Changing the metric starts a new ruler, pinned again at the node head.
    await revise(node.slug, withBlock(block(OBJECTIVE.replace('"bench/**"', '"bench/v2/**"'))))
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const repinned = reduceBuild(await h.events(node.slug)).optimization!
    expect(repinned.revision).toBe(3)
    expect(repinned.rulerRevision).toBe(3)
    expect(repinned.accepted.harnessPin).toMatch(/^[0-9a-f]{40}$/)
  } finally {
    await h.cleanup()
  }
}, 30_000)
