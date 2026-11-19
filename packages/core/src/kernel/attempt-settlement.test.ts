import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { RouteRefusalError } from '../operator/requests'
import { settleUnmeasuredAttempt, showObjective } from '../operator/optimization'
import { attemptBranchPublished, markUnmeasuredMerge, settleAttempt } from './attempt-settlement'
import { commandObjective, OPTIMIZATION_SHA } from './generators/optimization-log'

const ticket = { source: 'file', id: 'T-a' }
const measurement = { revision: 1, baseline: 50, candidate: 50, delta: 0 }

async function node() {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'opt-node', repo: 'repo', branch: 'ab-node/opt' })
  await store.append('opt-node', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: 'repo',
      ticket: { source: 'file', id: 'node' },
      baseBranch: 'main',
      kind: 'node',
    },
  })
  await store.append('opt-node', {
    actor: DISPATCHER,
    type: 'optimization.objective-accepted',
    payload: {
      objective: commandObjective(),
      revision: 1,
      harnessPin: OPTIMIZATION_SHA('a'),
      specRev: 0,
    },
  })
  await store.append('opt-node', {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: {
      request: 'r',
      proposals: [{ id: 'a', ticket, title: 'Attempt a', strategy: 'strategy a' }],
    },
  })
  return store
}

const settled = async (store: MemoryBuildStore) =>
  (await store.getEvents('opt-node')).filter((event) => event.type === 'attempt.settled')

describe('settleAttempt', () => {
  test('settles an in-flight attempt exactly once', async () => {
    const store = await node()
    const attempt = { proposal: 'a', ticket, build: 'attempt-a' }
    expect(
      await settleAttempt(store, 'opt-node', attempt, 'no-improvement', {
        measurement,
      }),
    ).toBe(true)
    // A retry, and a different terminal path racing it, write nothing.
    expect(
      await settleAttempt(store, 'opt-node', attempt, 'no-improvement', {
        measurement,
      }),
    ).toBe(false)
    expect(await settleAttempt(store, 'opt-node', attempt, 'aborted')).toBe(false)
    expect(await settled(store)).toHaveLength(1)
    const state = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(state.inFlight).toEqual([])
    expect(state.rejections).toEqual([
      { proposal: 'a', ticket, build: 'attempt-a', outcome: 'no-improvement' },
    ])
  })

  test('a concurrent append on the node log is re-read, not overwritten', async () => {
    const store = await node()
    const appendIfCurrent = store.appendIfCurrent.bind(store)
    let raced = false
    store.appendIfCurrent = (async (slug: string, expected: number, event: never) => {
      if (!raced) {
        raced = true
        await store.append('opt-node', {
          actor: DISPATCHER,
          type: 'node.poll-checked',
          payload: {
            activityKey: 'k',
            unchangedSince: '2026-11-17T00:00:00.000Z',
            nodeIdleAfterSeconds: 60,
            nodeIdlePollSeconds: 60,
          },
        })
      }
      return appendIfCurrent(slug, expected, event)
    }) as typeof store.appendIfCurrent
    expect(
      await settleAttempt(store, 'opt-node', { proposal: 'a', ticket }, 'accepted', {
        measurement: { ...measurement, candidate: 40, delta: 10 },
        head: MERGED,
      }),
    ).toBe(true)
    expect(await settled(store)).toHaveLength(1)
    expect((await settled(store))[0]!.payload).toMatchObject({ outcome: 'accepted', head: MERGED })
  })

  test('an unknown proposal never settles', async () => {
    const store = await node()
    expect(await settleAttempt(store, 'opt-node', { proposal: 'z', ticket }, 'aborted')).toBe(false)
    expect(await settled(store)).toEqual([])
  })
})

const MERGED = OPTIMIZATION_SHA('d')

/** A child of the node that merged as `sha`, optionally measured first. */
async function mergedChild(
  store: MemoryBuildStore,
  options: { slug?: string; sha?: string; measuredCandidate?: string; node?: string } = {},
) {
  const slug = options.slug ?? 'attempt-a'
  await store.createBuild({ slug, repo: 'repo', branch: `ab/${slug}`, ticket })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: 'repo',
      ticket,
      baseBranch: 'ab-node/opt',
      target: { build: options.node ?? 'opt-node', ticket: { source: 'file', id: 'node' } },
    },
  })
  if (options.measuredCandidate !== undefined) {
    const pair = {
      candidate: options.measuredCandidate,
      baseline: OPTIMIZATION_SHA('b'),
      harnessPin: OPTIMIZATION_SHA('a'),
      revision: 1,
    }
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'attempt.measurement-requested',
      payload: { id: 'm1', node: 'opt-node', ...pair },
    })
    await store.append(slug, {
      actor: KERNEL,
      type: 'attempt.measured',
      payload: {
        request: 'm1',
        ...pair,
        samples: 7,
        medians: { candidate: 40, baseline: 50 },
        delta: 10,
        decision: 'improved',
      },
    })
  }
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'pr.opened',
    payload: { pr: { number: 7, url: 'https://forge/pr/7', headSha: MERGED } },
  })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'pr.merged',
    payload: { sha: options.sha ?? MERGED },
  })
}

const settle = (store: MemoryBuildStore, attempt = 'a', policy = 'release-unmeasured') =>
  settleUnmeasuredAttempt({ store, repo: 'repo', slug: 'opt-node', attempt, policy, user: 'ada' })

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(RouteRefusalError)
  return (error as RouteRefusalError).refusal
}

describe('settlement options', () => {
  test('a branch obligation and an actor thread into the payload', async () => {
    const store = await node()
    expect(
      await settleAttempt(
        store,
        'opt-node',
        { proposal: 'a', ticket, build: 'attempt-a', branch: 'ab/attempt-a' },
        'declined',
        { note: 'no gain' },
      ),
    ).toBe(true)
    const [event] = await settled(store)
    expect(event!.payload).toMatchObject({
      attempt: { branch: 'ab/attempt-a' },
      outcome: 'declined',
      note: 'no gain',
    })
    const state = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(state.rejections[0]!.branch).toBe('ab/attempt-a')
  })

  test('only a build that completed an implement round or opened a PR published', () => {
    expect(attemptBranchPublished({ implement: { round: 1 } })).toBe(false)
    expect(
      attemptBranchPublished({
        implement: { round: 1, commits: { base: 'a', head: 'b' } as never },
      }),
    ).toBe(true)
    expect(
      attemptBranchPublished({
        implement: { round: 0 },
        pr: { number: 1, url: 'u', headSha: 'h' } as never,
      }),
    ).toBe(true)
  })
})

describe('markUnmeasuredMerge', () => {
  test('marks an in-flight attempt once; repeats and settled attempts are no-ops', async () => {
    const store = await node()
    const merge = { build: 'attempt-a', sha: MERGED, reason: 'absent' as const }
    expect(await markUnmeasuredMerge(store, 'opt-node', { proposal: 'a', ticket }, merge)).toBe(
      true,
    )
    expect(await markUnmeasuredMerge(store, 'opt-node', { proposal: 'a', ticket }, merge)).toBe(
      false,
    )
    expect(await markUnmeasuredMerge(store, 'opt-node', { proposal: 'z', ticket }, merge)).toBe(
      false,
    )
    const events = await store.getEvents('opt-node')
    expect(events.filter((event) => event.type === 'attempt.merged-unmeasured')).toHaveLength(1)
    const state = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(state.inFlight[0]!.unmeasuredMerge).toMatchObject({ build: 'attempt-a', sha: MERGED })
    expect(await settleAttempt(store, 'opt-node', { proposal: 'a', ticket }, 'stopped')).toBe(true)
    expect(await markUnmeasuredMerge(store, 'opt-node', { proposal: 'a', ticket }, merge)).toBe(
      false,
    )
  })
})

describe('settleUnmeasuredAttempt', () => {
  async function marked(options: Parameters<typeof mergedChild>[1] = {}) {
    const store = await node()
    await mergedChild(store, options)
    await markUnmeasuredMerge(
      store,
      'opt-node',
      { proposal: 'a', ticket },
      { build: 'attempt-a', sha: MERGED, reason: 'absent' },
    )
    return store
  }

  test('releases the slot once, with the measurement absent and no value moved', async () => {
    const store = await marked()
    const before = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    const view = await showObjective({ store, repo: 'repo', slug: 'opt-node' })
    expect(view.progress.unmeasuredMerges).toEqual([
      { proposal: 'a', ticket: 'T-a', build: 'attempt-a', sha: MERGED, reason: 'absent' },
    ])
    expect(await settle(store, 'attempt-a')).toEqual({
      slug: 'opt-node',
      proposal: 'a',
      build: 'attempt-a',
      outcome: 'merged-unmeasured',
      policy: 'release-unmeasured',
    })
    const [event] = await settled(store)
    expect(event!.actor).toMatchObject({ kind: 'human' })
    expect(event!.payload).toEqual({
      attempt: { proposal: 'a', ticket, build: 'attempt-a' },
      outcome: 'merged-unmeasured',
      policy: 'release-unmeasured',
      mergedSha: MERGED,
    })
    const after = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(after.inFlight).toEqual([])
    expect(after.rejections).toEqual([])
    expect(after.attempts).toEqual({ ...before.attempts, unmeasured: 1 })
    expect([after.current, after.best, after.plateau]).toEqual([
      before.current,
      before.best,
      before.plateau,
    ])
    // A repeat, by proposal or build, is refused and writes nothing.
    expect((await refusal(settle(store))).kind).toBe('conflict')
    expect((await refusal(settle(store, 'attempt-a'))).kind).toBe('conflict')
    expect(await settled(store)).toHaveLength(1)
  })

  test('requires a known policy', async () => {
    const store = await marked()
    expect((await refusal(settle(store, 'a', 'accept'))).kind).toBe('validation')
    expect(await settled(store)).toEqual([])
  })

  test('refuses an attempt that has not merged unmeasured', async () => {
    const store = await node()
    expect((await refusal(settle(store))).error).toContain('has not merged without')
    expect(await settled(store)).toEqual([])
  })

  test('refuses an unknown attempt, an unknown node and a plain node', async () => {
    const store = await marked()
    expect((await refusal(settle(store, 'nope'))).kind).toBe('conflict')
    const unknown = settleUnmeasuredAttempt({
      store,
      repo: 'repo',
      slug: 'missing',
      attempt: 'a',
      policy: 'release-unmeasured',
      user: 'ada',
    })
    expect((await refusal(unknown)).kind).toBe('not-found')
    const work = settleUnmeasuredAttempt({
      store,
      repo: 'repo',
      slug: 'attempt-a',
      attempt: 'a',
      policy: 'release-unmeasured',
      user: 'ada',
    })
    expect((await refusal(work)).kind).toBe('conflict')
    expect(await settled(store)).toEqual([])
  })

  test('refuses a merged head that a valid measurement covers', async () => {
    const store = await marked({ measuredCandidate: MERGED })
    expect((await refusal(settle(store))).error).toContain('valid landing measurement')
    expect(await settled(store)).toEqual([])
  })

  test('refuses when the build merged a different head than the marker names', async () => {
    const store = await marked({ sha: OPTIMIZATION_SHA('e') })
    expect((await refusal(settle(store))).kind).toBe('conflict')
  })

  test('a competing normal settlement wins once; the operator sees a conflict', async () => {
    const store = await marked()
    const appendIfCurrent = store.appendIfCurrent.bind(store)
    let raced = false
    store.appendIfCurrent = (async (slug: string, expected: number, event: never) => {
      if (!raced && (event as { type: string }).type === 'attempt.settled') {
        raced = true
        await settleAttempt(store, 'opt-node', { proposal: 'a', ticket }, 'stopped')
      }
      return appendIfCurrent(slug, expected, event)
    }) as typeof store.appendIfCurrent
    expect((await refusal(settle(store))).error).toContain('settled concurrently')
    const events = await settled(store)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload.outcome).toBe('stopped')
  })

  test('resumes after a crash that lost the reply: the settlement stands once', async () => {
    const store = await marked()
    await settle(store)
    // A retried request, as after a lost response, never duplicates it.
    await refusal(settle(store))
    expect(await settled(store)).toHaveLength(1)
    const state = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(state.attempts.unmeasured).toBe(1)
  })
})
