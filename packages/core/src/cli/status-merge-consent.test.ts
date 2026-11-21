/** `ab build status` shows the head merge consent was given at beside the
 * current candidate head (SPEC §merge policy). */
import { expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { MemoryBuildStore } from '../store/memory'
import { detail, renderDetail, renderSummaries, summarize } from './status'

const decided = (head: string): EventWrite<'landing.decided'> => ({
  actor: DISPATCHER,
  type: 'landing.decided',
  payload: {
    candidate: { head, parent: 'base', cycle: '1' },
    from: 'leaf',
    into: { kind: 'root' },
    labels: [],
    mode: 'consent',
    rule: { default: true },
  },
})
const finalized = (headSha: string) =>
  ({
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha } },
  }) as const

async function render(build: (store: MemoryBuildStore, slug: string) => Promise<void>) {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'consent', repo: '/repo' })
  await build(store, record.slug)
  const now = new Date('2026-11-16T00:00:00Z')
  const shown = detail(record, await store.getEvents(record.slug), now)
  return { shown, lines: renderDetail(shown, now) }
}

test('a build without a merge candidate shows no merge line', async () => {
  const { lines } = await render(async () => {})
  expect(lines.some((line) => line.startsWith('  merge:'))).toBe(false)
})

test('a candidate awaiting consent shows the current head', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, decided('aaa'))
  })
  expect(lines).toContain('  merge:    no consent recorded · current head aaa')
})

test('consent given at an old head shows both heads in text and JSON', async () => {
  const { shown, lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    const decision = await store.append(slug, decided('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.land-requested',
      payload: { decisionSeq: decision.seq },
    })
    await store.append(slug, finalized('bbb'))
  })
  expect(lines).toContain('  merge:    consented at aaa · current head bbb')
  expect(shown.tree).toMatchObject({
    consentedHead: 'aaa',
    currentHead: 'bbb',
  })
})

test('a hold shows held', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, decided('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.hold-requested',
      payload: {},
    })
  })
  expect(lines).toContain('  merge:    held · current head aaa')
})

test('a hold with a reason shows it in detail, JSON and the build list until consent', async () => {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'consent', repo: '/repo' })
  await store.append(record.slug, finalized('aaa'))
  const decision = await store.append(record.slug, decided('aaa'))
  await store.append(record.slug, {
    actor: humanActor('operator'),
    type: 'build.hold-requested',
    payload: { reason: 'waiting on Q-1\u001b[2J' },
  })
  const now = new Date('2026-11-16T00:00:00Z')
  const events = await store.getEvents(record.slug)
  const shown = detail(record, events, now)
  expect(shown.tree?.holdReason).toBe('waiting on Q-1\u001b[2J')
  expect(renderDetail(shown, now)).toContain(
    '  merge:    held — waiting on Q-1\\u{1b}[2J · current head aaa',
  )
  const summary = summarize(record, events, now)
  expect(summary.holdReason).toBe('waiting on Q-1\u001b[2J')
  expect(renderSummaries([summary], now, '')).toContain('    merge held — waiting on Q-1\\u{1b}[2J')

  await store.append(record.slug, {
    actor: humanActor('operator'),
    type: 'build.land-requested',
    payload: { decisionSeq: decision.seq },
  })
  const released = await store.getEvents(record.slug)
  expect(detail(record, released, now).tree?.holdReason).toBeNull()
  expect(summarize(record, released, now).holdReason).toBeUndefined()
  expect(renderSummaries([summarize(record, released, now)], now, '').join('\n')).not.toContain(
    'held',
  )
})

test('legacy consent has no recorded head', async () => {
  const { lines } = await render(async (store, slug) => {
    await store.append(slug, finalized('aaa'))
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
  })
  expect(lines).toContain('  merge:    consented (head not recorded) · current head aaa')
})

test('a node whose integration candidate is deferred on unrecorded paths says so', async () => {
  const head = 'c'.repeat(40)
  const candidate = { head, parent: 'p'.repeat(40), cycle: 'cycle-1' }
  const { shown, lines } = await render(async (store, slug) => {
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: '/repo',
        ticket: { source: 'fake', id: 'N' },
        baseBranch: 'main',
        kind: 'node',
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.opened',
      payload: { pr: { number: 2, url: 'https://forge/2', headSha: head } },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.prepared',
      payload: {
        id: candidate.cycle,
        head,
        parent: candidate.parent,
        config: '{}',
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'landing.deferred',
      payload: {
        candidate,
        reason: 'paths-unrecorded',
        rule: { index: 1, snapshot: { within: ['docs/**'], mode: 'auto' } },
        policy: 'sha256:x',
      },
    })
  })
  expect(shown.landingDeferred).toContain('merge[1] matches on changed paths')
  expect(lines).toContain(
    `  landing:  undecided — deferred — [[merge]] rule merge[1] matches on changed paths, but the changed paths of head ${head.slice(0, 12)} are not recorded; the decision waits for a head this build records (heads pushed outside a build are never recorded)`,
  )
})

test('a reopened leaf shows who reopened it in summaries, detail and JSON until it resettles', async () => {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'consent', repo: '/repo' })
  const finalize = await store.append(record.slug, finalized('aaa'))
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'pipeline.settled',
    payload: { cycle: finalize.seq },
  })
  await store.append(record.slug, {
    actor: humanActor('ada'),
    type: 'build.reopened',
    payload: { feedback: 'rename the flag\u001b[2J' },
  })
  const now = new Date('2026-11-20T00:00:00Z')
  const events = await store.getEvents(record.slug)
  const summary = summarize(record, events, now)
  expect(summary.reopened).toMatchObject({
    user: 'ada',
    route: 'implement',
    feedback: 'rename the flag\u001b[2J',
  })
  expect(JSON.parse(JSON.stringify(summary)).reopened.route).toBe('implement')
  expect(renderSummaries([summary], now, '')).toContain(
    '    reopened by ada → implement: rename the flag\\u{1b}[2J',
  )
  expect(renderDetail(detail(record, events, now), now).join('\n')).toContain(
    '  reopened: by ada → implement: rename the flag\\u{1b}[2J',
  )
  await store.append(record.slug, finalized('bbb'))
  const last = (await store.getEvents(record.slug)).at(-1)!
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'pipeline.settled',
    payload: { cycle: last.seq },
  })
  expect(summarize(record, await store.getEvents(record.slug), now).reopened).toBeUndefined()
})
