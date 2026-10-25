import { expect, test } from 'bun:test'
import { seedStore, BUILD } from '../cli/testkit'
import { KERNEL, humanActor } from '../events/envelope'
import { ForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { manualClock } from '../testing/fixed'
import { readBuildFacts, readPhaseFailures } from '../store/reduced-reads'
import {
  publicationRetryGate,
  retryPublicationEffect,
  PUBLICATION_RETRY_SECONDS,
} from './publication-retry'

for (const operation of ['restack', 'reconcile'] as const) {
  test(`${operation}: durable six-retry budget, restart, exhaustion and answer isolation`, async () => {
    const store = await seedStore()
    const clock = manualClock()
    const deps = { store, slug: BUILD, clock, actor: KERNEL }
    let calls = 0
    const fail = () =>
      retryPublicationEffect(deps, operation, 'rewrite-1', 1, async () => {
        calls++
        throw new ForgeFailure('HTTP 503 Service Unavailable', {
          kind: 'transient',
          retry: 'retryable',
        })
      })
    for (const seconds of PUBLICATION_RETRY_SECONDS) {
      await expect(fail()).rejects.toBeInstanceOf(ForgeRequestDeferred)
      const events = await store.getEvents(BUILD)
      const scheduled = events.findLast((e) => e.type === 'publication.retry-scheduled')!
      expect(scheduled.payload).toMatchObject({
        failure: calls,
        retryAt: new Date(clock().getTime() + seconds * 1000).toISOString(),
      })
      const before = calls
      await expect(fail()).rejects.toBeInstanceOf(ForgeRequestDeferred)
      expect(calls).toBe(before)
      expect(await store.getEvents(BUILD)).toHaveLength(events.length)
      clock.advance(seconds * 1000 - 1)
      await expect(
        publicationRetryGate({ ...deps }, operation, 'rewrite-1'),
      ).rejects.toBeInstanceOf(ForgeRequestDeferred)
      clock.advance(1)
      await publicationRetryGate({ ...deps }, operation, 'rewrite-1')
    }
    await expect(fail()).rejects.toBeInstanceOf(ForgeRequestDeferred)
    expect(calls).toBe(7)
    await expect(fail()).rejects.toBeInstanceOf(ForgeRequestDeferred)
    const facts = (await readBuildFacts(store, BUILD)).value
    expect(facts.state.openEscalations).toHaveLength(1)
    const escalation = facts.state.openEscalations[0]!
    expect(escalation.question).toContain('6')
    expect(escalation.question).toContain('HTTP 503')
    expect((await readPhaseFailures(store, BUILD, 'reconcile', 1)).count).toBe(0)
    // Another rewrite has its own allowance.
    await publicationRetryGate(deps, operation, 'rewrite-2')
    await store.append(BUILD, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: escalation.id, answer: 'retry', resolution: 'retry' },
    })
    await expect(
      retryPublicationEffect({ ...deps }, operation, 'rewrite-1', 1, async () => 'published'),
    ).resolves.toBe('published')
    await expect(fail()).rejects.toBeInstanceOf(ForgeRequestDeferred)
    expect(
      (await readBuildFacts(store, BUILD)).value.publication.retry(operation, 'rewrite-1').latest
        ?.payload.failure,
    ).toBe(1)
  })
}

test('publication accounting excludes rate limits and unclassified failures', async () => {
  const store = await seedStore()
  const deps = { store, slug: BUILD, clock: manualClock(), actor: KERNEL }
  for (const error of [
    new Error('dirty worktree'),
    new ForgeFailure('cooldown', { kind: 'rate-limited', resetAt: '2026-07-16T00:00:00.000Z' }),
  ]) {
    await expect(
      retryPublicationEffect(deps, 'restack', 'r', 1, async () => {
        throw error
      }),
    ).rejects.toBeInstanceOf(error instanceof ForgeFailure ? ForgeRequestDeferred : Error)
  }
  expect(
    (await store.getEvents(BUILD)).filter((e) => e.type.startsWith('publication.retry-')),
  ).toHaveLength(0)
})

test('exhaustion repairs the escalation crash gap and folds incrementally', async () => {
  const { publicationStateReducer } = await import('../processes/publication-state')
  const store = await seedStore()
  const deps = { store, slug: BUILD, actor: KERNEL, clock: manualClock() }
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'phase.failed',
    payload: {
      phase: 'reconcile',
      round: 1,
      attempt: 1,
      error: 'prior agent failure',
      willRetry: true,
    },
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'publication.retry-exhausted',
    payload: {
      operation: 'restack',
      rewriteId: 'r',
      round: 1,
      anchor: 0,
      failure: 7,
      error: 'HTTP 503',
    },
  })
  await expect(publicationRetryGate(deps, 'restack', 'r')).rejects.toBeInstanceOf(
    ForgeRequestDeferred,
  )
  await expect(publicationRetryGate(deps, 'restack', 'r')).rejects.toBeInstanceOf(
    ForgeRequestDeferred,
  )
  const raises = (await store.getEvents(BUILD)).filter((e) => e.type === 'escalation.raised')
  expect(raises).toHaveLength(1)
  await store.append(BUILD, {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: raises[0]!.payload.id, answer: 'retry', resolution: 'retry' },
  })
  expect((await readPhaseFailures(store, BUILD, 'reconcile', 1)).count).toBe(1)
  const events = await store.getEvents(BUILD)
  let acc = publicationStateReducer.initial()
  for (const event of events) acc = publicationStateReducer.advance(acc, [event])
  expect(publicationStateReducer.finish(acc).retry('restack', 'r')).toEqual(
    publicationStateReducer.reduce(events).retry('restack', 'r'),
  )
  await publicationRetryGate(deps, 'restack', 'r')
})
