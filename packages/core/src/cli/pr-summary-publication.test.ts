import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import { FakeForge } from '../ports/forge/fake'
import { GitHubApiError } from '../ports/forge/github-transport'
import { manualClock } from '../testing/fixed'
import { textContent } from '../store/types'
import { BUILD, seedStore } from './testkit'
import { renderPrSummary } from './pr-summary'
import {
  boundedSummary,
  pendingSummaryRequests,
  publishSummary,
  refreshSummaryBoundary,
  settleSummaryRequests,
  summaryBoundary,
  SUMMARY_LIMIT,
} from './pr-summary-publication'

async function fixture(remote = false) {
  const store = await seedStore()
  const forge = new FakeForge()
  const pr = await forge.openPr({
    workspacePath: '/repo',
    head: 'ab/test',
    base: 'main',
    title: 'Test',
    body: '',
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'custom',
      remote,
      ref: 'workspace',
      branch: 'ab/test',
      base: { source: 'existing', sha: 'base' },
    },
  })
  await store.append(BUILD, { actor: KERNEL, type: 'finalize.completed', payload: { pr } })
  const deps = {
    store,
    forge,
    slug: BUILD,
    workspacePath: '/repo',
    storeRef: 'https://store.test',
    clock: manualClock(),
  }
  return { ...deps, deps }
}

async function start(h: Awaited<ReturnType<typeof fixture>>, step = 'screens') {
  return h.store.append(BUILD, {
    actor: KERNEL,
    type: 'verify.started',
    payload: { step, attempt: 1 },
  })
}
async function finish(
  h: Awaited<ReturnType<typeof fixture>>,
  step = 'screens',
  outcome: 'pass' | 'fail' | 'skipped' = 'pass',
) {
  await h.store.append(BUILD, {
    actor: KERNEL,
    type: 'verify.completed',
    payload:
      outcome === 'skipped'
        ? { step, attempt: 1, outcome, reason: 'unchanged' }
        : { step, attempt: 1, outcome },
  })
}
async function attach(h: Awaited<ReturnType<typeof fixture>>, n: number) {
  for (let i = 0; i < n; i++) {
    const meta = await h.store.putArtifact(BUILD, { kind: `image:${i}`, content: 'test' })
    await h.store.append(BUILD, {
      actor: agentActor('verify:screens', 's_test'),
      type: 'pr-attachment.designated',
      payload: {
        artifact: { kind: meta.kind, rev: meta.revision },
        filename: `image-${i}.png`,
        mediaType: 'image/png',
      },
    })
  }
}

describe('phase summary publication', () => {
  for (const count of [3, 300])
    test(`${count} designations produce one bounded final publication`, async () => {
      const h = await fixture()
      await start(h)
      await attach(h, count)
      expect(h.forge.comments).toHaveLength(0)
      await finish(h)
      await refreshSummaryBoundary(h.deps)
      await refreshSummaryBoundary(h.deps)
      const events = await h.store.getEvents(BUILD)
      expect(events.filter((e) => e.type === 'pr-summary.attempted')).toHaveLength(1)
      expect(h.forge.comments).toHaveLength(1)
      expect(h.forge.comments[0]!.body.length).toBeLessThanOrEqual(SUMMARY_LIMIT)
      const full =
        count === 300
          ? textContent((await h.store.getArtifact(BUILD, 'pr-summary', 0))!)
          : h.forge.comments[0]!.body
      expect(full).toContain(`image-${count - 1}.png`)
      expect(full).toContain('(attempt 1): pass')
      expect(events.filter((e) => e.type === 'pr-attachment.designated')).toHaveLength(count)
    })

  test('exact limit stays full; over limit stores a pinned complete projection with escaped commands', async () => {
    const h = await fixture()
    await start(h)
    await finish(h, 'screens', 'skipped')
    const events = await h.store.getEvents(BUILD)
    const completed = events.findLast((e) => e.type === 'verify.completed')!
    if (completed.type !== 'verify.completed') throw new Error('missing completion')
    const env = {
      build: BUILD,
      store: h.storeRef,
      phase: 'finalize' as const,
      round: 1,
      session: '',
    }
    const baseLength = renderPrSummary(env, events).length
    completed.payload = {
      step: 'screens',
      attempt: 1,
      outcome: 'skipped',
      reason: `unchanged${'x'.repeat(SUMMARY_LIMIT - baseLength)}`,
    }
    expect((await boundedSummary(h.deps, events)).length).toBe(SUMMARY_LIMIT)
    completed.payload.reason += '😀<&'
    const compact = await boundedSummary(h.deps, events)
    expect(compact.length).toBeLessThan(SUMMARY_LIMIT)
    expect(compact).toContain('pr-summary@0')
    expect(compact).toContain('--store &#39;https://store.test&#39; --output pr-summary.md')
    const stored = await h.store.getArtifact(BUILD, 'pr-summary', 0)
    expect(textContent(stored!)).toContain('😀&lt;&amp;')
  })

  test('concurrent triggers claim once and a missing result never buys a second attempt', async () => {
    const h = await fixture()
    await start(h)
    await finish(h)
    const append = h.store.append.bind(h.store)
    h.store.append = async (slug, event) => {
      if (event.type === 'pr-summary.result') throw new Error('result unavailable')
      return append(slug, event)
    }
    await Promise.all([refreshSummaryBoundary(h.deps), refreshSummaryBoundary(h.deps)])
    await refreshSummaryBoundary(h.deps)
    expect(
      (await h.store.getEvents(BUILD)).filter((e) => e.type === 'pr-summary.attempted'),
    ).toHaveLength(1)
    expect(h.forge.comments).toHaveLength(1)
  })

  test('claim and rendering/deposit failures are isolated and never send an oversized body', async () => {
    const h = await fixture()
    await start(h)
    await attach(h, 300)
    await finish(h)
    h.store.putArtifact = async () => {
      throw new Error('artifact unavailable')
    }
    await expect(refreshSummaryBoundary(h.deps)).resolves.toBe(false)
    expect(h.forge.comments).toHaveLength(0)
    expect(
      (await h.store.getEvents(BUILD)).findLast((e) => e.type === 'pr-summary.result')?.payload,
    ).toMatchObject({ outcome: 'failure' })
    await start(h, 'next')
    await finish(h, 'next')
    h.store.appendIfCurrent = async () => {
      throw new Error('claim unavailable')
    }
    await expect(refreshSummaryBoundary(h.deps)).resolves.toBe(false)
    expect(h.forge.comments).toHaveLength(0)
  })

  test('rate limit suppresses phase retries and short next phases; later completion catches up', async () => {
    const h = await fixture()
    await start(h)
    await finish(h)
    let calls = 0
    const original = h.forge.commentOnPr.bind(h.forge)
    h.forge.commentOnPr = async (...args) => {
      calls++
      if (calls === 1)
        throw new GitHubApiError(
          403,
          'Secondary content creation rate limit',
          {},
          { 'retry-after': '120' },
        )
      return original(...args)
    }
    await refreshSummaryBoundary(h.deps)
    await refreshSummaryBoundary(h.deps)
    await start(h, 'short')
    await attach(h, 3)
    await finish(h, 'short')
    await refreshSummaryBoundary(h.deps)
    expect(calls).toBe(1)
    h.clock.advance(121_000)
    await start(h, 'later')
    await finish(h, 'later')
    await refreshSummaryBoundary(h.deps)
    expect(calls).toBe(2)
    expect(h.forge.comments[0]!.body).toContain('image-2.png')
    expect(h.forge.comments[0]!.body).toContain('<code>later</code>')
  })

  for (const count of [3, 300])
    test(`remote ${count} artifacts yield without a guest attempt, settle once, and resume`, async () => {
      const h = await fixture(true)
      await start(h)
      await attach(h, count)
      await finish(h)
      const guest = {
        ...h.deps,
        forge: {
          ...h.forge,
          commentOnPr: async () => {
            throw new Error('guest must not publish')
          },
        } as unknown as FakeForge,
      }
      expect(await refreshSummaryBoundary(guest)).toBe(true)
      expect((await h.store.getEvents(BUILD)).some((e) => e.type === 'pr-summary.attempted')).toBe(
        false,
      )
      await settleSummaryRequests({ ...h.deps, holder: 'host' })
      await settleSummaryRequests({ ...h.deps, holder: 'restarted-host' })
      expect(pendingSummaryRequests(await h.store.getEvents(BUILD))).toHaveLength(0)
      expect(h.forge.comments).toHaveLength(1)
      expect(await refreshSummaryBoundary(guest)).toBe(false)
      expect((await h.store.getBuild(BUILD))!.lease).toBeUndefined()
      const full =
        count === 300
          ? textContent((await h.store.getArtifact(BUILD, 'pr-summary', 0))!)
          : h.forge.comments[0]!.body
      expect(full).toContain(`image-${count - 1}.png`)
      expect(full).toContain('(attempt 1): pass')
    })

  test('host repairs missing handoff, reuses launch reservation, and does not publish against a live execution', async () => {
    const h = await fixture(true)
    await start(h)
    await finish(h)
    await h.store.append(BUILD, {
      actor: { kind: 'dispatcher' },
      type: 'execution.started',
      payload: { instance: 'guest', provider: 'custom', workspaceRef: 'workspace' },
    })
    await settleSummaryRequests({ ...h.deps, holder: 'host' })
    expect(h.forge.comments).toHaveLength(0)
    await h.store.append(BUILD, {
      actor: { kind: 'dispatcher' },
      type: 'execution.ended',
      payload: { instance: 'guest', workspaceRef: 'workspace', outcome: 'completed' },
    })
    expect(await h.store.claimLease(BUILD, 'launch', 60_000)).toBe(true)
    await settleSummaryRequests({ ...h.deps, holder: 'host', reservation: 'launch' })
    expect(h.forge.comments).toHaveLength(1)
    expect((await h.store.getBuild(BUILD))!.lease?.holder).toBe('launch')
  })

  test('phase boundary waits for all sessions to end and selects latest completed occurrence', async () => {
    const h = await fixture()
    await start(h)
    await h.store.append(BUILD, {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 'live', role: 'verify', runner: 'test', phase: 'verify:screens' },
    })
    await finish(h)
    expect(summaryBoundary(await h.store.getEvents(BUILD))).toBeUndefined()
    await h.store.append(BUILD, {
      actor: KERNEL,
      type: 'session.ended',
      payload: {
        session: 'live',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 1 },
      },
    })
    const boundary = summaryBoundary(await h.store.getEvents(BUILD))!
    await publishSummary(h.deps, boundary)
    await start(h, 'next')
    await finish(h, 'next', 'fail')
    await refreshSummaryBoundary(h.deps)
    expect(h.forge.comments).toHaveLength(1)
    expect(h.forge.comments[0]!.body).toContain('<code>next</code> (attempt 1): fail')
    expect(
      (await h.store.getEvents(BUILD)).filter((e) => e.type === 'pr-summary.attempted'),
    ).toHaveLength(2)
  })
})

test('workspace release settles a summary-only remote boundary without branch publication', async () => {
  const { settlePublicationBeforeRelease } = await import('../processes/publication-loss')
  const h = await fixture(true)
  await start(h)
  await finish(h, 'screens', 'skipped')
  const events = await settlePublicationBeforeRelease(
    {
      store: h.store,
      settlePublication: async () => settleSummaryRequests({ ...h.deps, holder: 'host' }),
    },
    BUILD,
    await h.store.getEvents(BUILD),
    'terminal',
  )
  expect(h.forge.comments).toHaveLength(1)
  expect(h.forge.comments[0]!.body).toContain('skipped')
  expect(events.some((event) => event.type === 'pr-summary.settled')).toBe(true)
  expect(events.some((event) => event.type === 'publication.requested')).toBe(false)
})

test('an oversized compact locator is never sent to the forge', async () => {
  const h = await fixture()
  await start(h)
  await finish(h)
  await refreshSummaryBoundary({ ...h.deps, storeRef: 'x'.repeat(SUMMARY_LIMIT) })
  expect(h.forge.comments).toHaveLength(0)
  expect(
    (await h.store.getEvents(BUILD)).findLast((e) => e.type === 'pr-summary.result')?.payload,
  ).toMatchObject({ outcome: 'failure' })
})

test('remote rate limit dispositions let the next phase resume while respecting cooldown', async () => {
  const h = await fixture(true)
  await start(h)
  await finish(h, 'screens', 'fail')
  let calls = 0
  h.forge.commentOnPr = async () => {
    calls++
    throw new GitHubApiError(429, 'limited')
  }
  expect(await refreshSummaryBoundary(h.deps)).toBe(true)
  await settleSummaryRequests({ ...h.deps, holder: 'host' })
  expect(await refreshSummaryBoundary(h.deps)).toBe(false)
  await start(h, 'next')
  await finish(h, 'next')
  expect(await refreshSummaryBoundary(h.deps)).toBe(true)
  await settleSummaryRequests({ ...h.deps, holder: 'host' })
  expect(await refreshSummaryBoundary(h.deps)).toBe(false)
  expect(calls).toBe(1)
  expect(
    (await h.store.getEvents(BUILD)).findLast((e) => e.type === 'pr-summary.settled')?.payload,
  ).toMatchObject({ disposition: 'deferred' })
})
