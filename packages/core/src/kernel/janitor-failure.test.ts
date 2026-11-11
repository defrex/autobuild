import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import { ForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { ForgeCooldown } from './guarded-forge'
import {
  janitorDeferral,
  janitorDue,
  janitorEscalationId,
  recordJanitorFailure,
} from './janitor-failure'
import { KernelGitUnavailable } from './kernel-git'
import { MixedVersionDeferral } from './mixed-version'

describe('janitorDeferral', () => {
  const resetAt = '2026-07-15T12:15:00.000Z'

  test('repository scheduling signals defer the janitor', () => {
    expect(janitorDeferral(new ForgeCooldown(`Forge cooldown until ${resetAt}`))).toBe(true)
    expect(janitorDeferral(new ForgeRequestDeferred('deferred'))).toBe(true)
    expect(janitorDeferral(new KernelGitUnavailable('git', 'missing'))).toBe(true)
  })

  test('a classified rate limit defers in class and wire form', () => {
    expect(janitorDeferral(new ForgeFailure('limit', { kind: 'rate-limited', resetAt }))).toBe(true)
    expect(
      janitorDeferral({
        forgeFailure: 'autobuild.forge-failure.v1',
        message: 'limit',
        details: { kind: 'rate-limited', resetAt },
      }),
    ).toBe(true)
  })

  test('genuine failures and unrelated deferrals are not forge deferrals', () => {
    expect(
      janitorDeferral(new ForgeFailure('flaky', { kind: 'transient', retry: 'retryable' })),
    ).toBe(false)
    expect(janitorDeferral(new Error('provider unavailable'))).toBe(false)
    expect(janitorDeferral('rate-limited')).toBe(false)
    expect(janitorDeferral(new MixedVersionDeferral())).toBe(false)
  })
})

test('durable janitor episode doubles retries, caps them and emits attention once before recovery', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'failing', repo: 'r' })
  const policy = {
    janitorBackoffMaxSeconds: 300,
    janitorFailureAttentionSeconds: 600,
    janitorFailureEscalationSeconds: 3600,
  }
  for (const delay of [30, 60, 120, 240, 300, 300, 300]) {
    const previous = (await readBuildFacts(store, 'failing')).value.state.janitor
    const at = clock()
    await recordJanitorFailure(store, 'failing', previous, `error ${delay}`, at, policy, 'PR check')
    const current = (await readBuildFacts(store, 'failing')).value.state.janitor!
    expect(Date.parse(current.nextAttemptAt) - at.getTime()).toBe(delay * 1000)
    expect(current.firstFailureAt).toBe('2026-07-15T12:00:00.000Z')
    clock.advance(delay * 1000)
  }
  expect(
    (await store.getEvents('failing')).filter((e) => e.type === 'build.janitor-failing'),
  ).toHaveLength(1)
  expect((await readBuildFacts(store, 'failing')).value.state.janitor?.attention).toBe(true)
  await store.append('failing', { actor: DISPATCHER, type: 'build.janitor-recovered', payload: {} })
  expect((await readBuildFacts(store, 'failing')).value.state.janitor).toBeUndefined()
  await recordJanitorFailure(
    store,
    'failing',
    undefined,
    'new episode',
    clock(),
    {
      ...policy,
      janitorBackoffMaxSeconds: 7,
    },
    'PR check',
  )
  const next = (await readBuildFacts(store, 'failing')).value.state.janitor!
  expect(next.attempt).toBe(1)
  expect(Date.parse(next.nextAttemptAt) - clock().getTime()).toBe(7000)
  expect(next.attention).toBeUndefined()
})

describe('janitor escalation', () => {
  const policy = {
    janitorBackoffMaxSeconds: 300,
    janitorFailureAttentionSeconds: 600,
    janitorFailureEscalationSeconds: 3600,
  }
  const escalated = async (store: MemoryBuildStore, slug: string) =>
    (await store.getEvents(slug)).filter((e) => e.type === 'build.janitor-escalated')

  /** Fail on ticks `late` seconds after each attempt falls due, until escalated. */
  async function failUntilEscalated(late: number) {
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.createBuild({ slug: 'failing', repo: 'r' })
    const start = clock().getTime()
    for (let n = 0; n < 40; n++) {
      const previous = (await readBuildFacts(store, 'failing')).value.state.janitor
      await recordJanitorFailure(
        store,
        'failing',
        previous,
        'restore failed:\n  missing ref',
        clock(),
        policy,
        'PR check',
      )
      if ((await escalated(store, 'failing')).length)
        return { store, clock, attempt: n + 1, age: clock().getTime() - start }
      const next = Date.parse(
        (await readBuildFacts(store, 'failing')).value.state.janitor!.nextAttemptAt,
      )
      clock.set(new Date(next + late * 1000).toISOString())
    }
    throw new Error('never escalated')
  }

  test('raises on the first failed attempt at or after the limit and names the failure', async () => {
    // Due ticks: 0, 30, 90, 210, 450, then every 300 s; 3450 is short, 3750 crosses.
    const capped = await failUntilEscalated(0)
    expect(capped).toMatchObject({ attempt: 16, age: 3_750_000 })
    // Ticks 60 s late: 0, 90, 210, 390, 690, then every 360 s; 3570 is short, 3930 crosses.
    const late = await failUntilEscalated(60)
    expect(late).toMatchObject({ attempt: 14, age: 3_930_000 })
    const [event] = await escalated(capped.store, 'failing')
    const firstFailureAt = '2026-07-15T12:00:00.000Z'
    expect(event!.payload).toMatchObject({
      id: janitorEscalationId(firstFailureAt),
      operation: 'PR check',
      attempt: 16,
      firstFailureAt,
      message: 'restore failed:\n  missing ref',
    })
    const question = (event!.payload as { question: string }).question
    for (const part of [
      'PR check',
      'failed 16 consecutive',
      firstFailureAt,
      'restore failed: missing ref',
    ])
      expect(question).toContain(part)
    expect(question).not.toContain('\n')
    const state = (await readBuildFacts(capped.store, 'failing')).value.state
    expect(state.status).toBe('blocked')
    expect(state.openEscalations).toMatchObject([
      { id: janitorEscalationId(firstFailureAt), source: 'policy', phase: 'setup', janitor: true },
    ])
    expect(state.janitor?.escalation).toBe(janitorEscalationId(firstFailureAt))
  })

  test('raises once per episode, even after an answer, and again for a new episode', async () => {
    const { store, clock } = await failUntilEscalated(0)
    const fail = async () => {
      clock.advance(300_000)
      const previous = (await readBuildFacts(store, 'failing')).value.state.janitor
      await recordJanitorFailure(
        store,
        'failing',
        previous,
        'still failing',
        clock(),
        policy,
        'PR check',
      )
    }
    await fail()
    const id = (await escalated(store, 'failing'))[0]!.payload as { id: string }
    await store.append('failing', {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: id.id, answer: 'retry', resolution: 'retry' },
    })
    let janitor = (await readBuildFacts(store, 'failing')).value.state.janitor!
    expect(janitor.retryRequested).toBe(true)
    expect(janitorDue(janitor, clock())).toBe(true)
    await fail()
    janitor = (await readBuildFacts(store, 'failing')).value.state.janitor!
    expect(janitor.retryRequested).toBeUndefined()
    expect(janitor.escalation).toBe(id.id)
    expect(await escalated(store, 'failing')).toHaveLength(1)

    await store.append('failing', {
      actor: DISPATCHER,
      type: 'build.janitor-recovered',
      payload: {},
    })
    let state = (await readBuildFacts(store, 'failing')).value.state
    expect(state.janitor).toBeUndefined()
    expect(state.openEscalations).toEqual([])
    clock.advance(60_000)
    const second = clock().toISOString()
    await recordJanitorFailure(store, 'failing', undefined, 'again', clock(), policy, 'PR check')
    clock.advance(3_600_000)
    await fail()
    const events = await escalated(store, 'failing')
    expect(events).toHaveLength(2)
    expect((events[1]!.payload as { id: string }).id).toBe(janitorEscalationId(second))
    state = (await readBuildFacts(store, 'failing')).value.state
    expect(state.openEscalations.map((e) => e.id)).toEqual([janitorEscalationId(second)])
  })

  test('janitorDue honors backoff and an answered retry', () => {
    const now = new Date('2026-07-15T12:00:00.000Z')
    const episode = {
      firstFailureAt: '2026-07-15T11:00:00.000Z',
      attempt: 3,
      message: 'x',
      nextAttemptAt: '2026-07-15T12:05:00.000Z',
    }
    expect(janitorDue(undefined, now)).toBe(true)
    expect(janitorDue(episode, now)).toBe(false)
    expect(janitorDue({ ...episode, retryRequested: true }, now)).toBe(true)
    expect(janitorDue(episode, new Date('2026-07-15T12:05:00.000Z'))).toBe(true)
  })
})
