import { describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { ForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { ForgeCooldown } from './guarded-forge'
import { janitorDeferral, recordJanitorFailure } from './janitor-failure'
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
  const policy = { janitorBackoffMaxSeconds: 300, janitorFailureAttentionSeconds: 600 }
  for (const delay of [30, 60, 120, 240, 300, 300, 300]) {
    const previous = (await readBuildFacts(store, 'failing')).value.state.janitor
    const at = clock()
    await recordJanitorFailure(store, 'failing', previous, `error ${delay}`, at, policy)
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
  await recordJanitorFailure(store, 'failing', undefined, 'new episode', clock(), {
    ...policy,
    janitorBackoffMaxSeconds: 7,
  })
  const next = (await readBuildFacts(store, 'failing')).value.state.janitor!
  expect(next.attempt).toBe(1)
  expect(Date.parse(next.nextAttemptAt) - clock().getTime()).toBe(7000)
  expect(next.attention).toBeUndefined()
})
