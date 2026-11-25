import { describe, expect, test } from 'bun:test'
import { NO_DISPATCHER_RUN_LINE } from '../cli/dashboard/configuration'
import { dispatchWarningLines } from '../cli/dashboard/header'
import { buildDashboardFromProjected } from '../cli/dashboard/model'
import { DashboardBuildPollCache, repositoryDashboardHeader } from '../cli/dashboard/poll'
import { projectOverview } from '../cli/dashboard/row-text'
import { normalizeEffectiveConfigArtifact } from '../config/effective-artifact'
import { configSchema } from '../config/schema'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import type { BuildRosterValue } from '../kernel/build-roster'
import { BuildFeedUnsupportedError } from '../store/build-feed'
import { MemoryBuildStore } from '../store/memory'
import { readRepositoryFacts } from '../store/reduced-reads'
import { RemoteBuildStore } from '../store/remote/client'
import { ReducerValueIncompatibilityError } from '../store/remote/compatibility'
import { steppingClock } from '../testing/fixed'
import { OverviewFrameSource } from './overview-source'
import { WebReadFencedError } from './protocol'
import { readOnlyStore } from './read-only'
import { projectRepositoryFrame } from './repository-source'

const REPO = '/web-overview'
const NOW = new Date('2026-11-24T12:00:00.000Z')
const clock = () => NOW
const CONFIG = { capacity: 2, tickets: { source: 'file', readyState: 'ready' } }
/** Calls that scan history; the source must never make one. */
const FORBIDDEN = [
  'listBuilds',
  'listBuildsForRepo',
  'listBuildsPage',
  'getEvents',
  'getRepoEvents',
  'getRepoBuildDigests',
]

/** Record every store call as `name` plus the scope or build it names. */
function recording(store: MemoryBuildStore) {
  const calls: string[] = []
  const label = (name: string, args: unknown[]) => {
    const scope = args[0] as string | { kind?: string; slug?: string; build?: string } | undefined
    if (name === 'getReducerValue' && typeof scope === 'object')
      return `getReducerValue:${scope.kind}${scope.slug !== undefined ? `:${scope.slug}` : ''}`
    if (name === 'listStreams' && typeof scope === 'object') return `listStreams:${scope.build}`
    if (['getBuild', 'getArtifact'].includes(name)) return `${name}:${String(scope)}`
    return name
  }
  // Replacements the caller sees; the store's own internal calls are untouched.
  type Original = (...args: unknown[]) => Promise<unknown>
  // biome-ignore lint/suspicious/noExplicitAny: each override names its own store method's arguments
  const overrides = new Map<string, (original: Original, ...args: any[]) => unknown>()
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(label(String(key), args))
        const original: Original = (...a) => Reflect.apply(value, target, a)
        const override = overrides.get(String(key))
        return override ? override(original, ...args) : original(...args)
      }
    },
  })
  const take = () => calls.splice(0).sort()
  return { proxy, calls, take, overrides }
}

/** The four targeted reads one visible build costs. */
const buildReads = (slug: string) => [
  `getArtifact:${slug}`,
  `getBuild:${slug}`,
  `getReducerValue:build:${slug}`,
  `listStreams:${slug}`,
]

async function startRun(store: MemoryBuildStore, warnings: string[] = [], config = CONFIG) {
  const artifact = await store.putRepoArtifact(REPO, {
    kind: 'config',
    content: JSON.stringify(config),
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      roleWarnings: warnings,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
    },
  })
}

async function running(store: MemoryBuildStore, slug: string) {
  await store.createBuild({ slug, repo: REPO })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: `runner-${slug}`, host: 'test' },
  })
}

const complete = (store: MemoryBuildStore, slug: string) =>
  store.append(slug, {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'merged' },
  })

const abort = (store: MemoryBuildStore, slug: string) =>
  store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

async function configured() {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo(REPO)
  await startRun(store)
  return store
}

describe('the repository frame', () => {
  test('an empty repository shows the no-run notice and no overview', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    const { frame, live } = await new OverviewFrameSource(readOnlyStore(store), REPO).read()
    expect(frame.notice).toBe(NO_DISPATCHER_RUN_LINE)
    expect(frame.repository?.queued).toBe(0)
    expect(frame.overview).toBeUndefined()
    expect(live).toBe(false)
  })

  test('the header carries the dispatcher warnings, in the terminal dashboard terms', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await startRun(store, ['role implement has no model'])
    await store.appendRepo(REPO, {
      actor: humanActor('op'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
    const { frame, live } = await new OverviewFrameSource(readOnlyStore(store), REPO, {
      clock,
    }).read()
    const facts = (await readRepositoryFacts(store, REPO)).value
    expect(live).toBe(true)
    expect(frame.notice).toBeUndefined()
    expect(frame.repository).toEqual(projectRepositoryFrame(REPO, facts).frame.repository!)
    expect(frame.repository?.warningLines).toEqual(dispatchWarningLines(facts.status!))
    expect(frame.repository?.warningLines).toContain('role implement has no model')
    expect(frame.repository?.drained).toBe(true)
    expect(frame.overview?.dispatcher).toBeDefined()
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
  })

  test('without a recorded config there is no overview and no build read', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(REPO)
    await running(store, 'unconfigured')
    const { proxy, take } = recording(store)
    const source = new OverviewFrameSource(readOnlyStore(proxy), REPO)
    expect((await source.read()).frame.overview).toBeUndefined()
    await running(store, 'unconfigured-2')
    await source.read()
    expect(new Set(take())).toEqual(
      new Set(['getRepoChangePosition', 'getRepo', 'getReducerValue:repo']),
    )
  })
})

describe('the overview', () => {
  test('matches the terminal projection for the same store', async () => {
    const store = await configured()
    await running(store, 'a-running')
    await store.append('a-running', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await running(store, 'b-blocked')
    await store.append('b-blocked', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: { id: 'esc_1', phase: 'plan', round: 1, source: 'agent', question: 'which?' },
    })
    await store.createBuild({ slug: 'c-queued', repo: REPO })
    await running(store, 'd-merged')
    await complete(store, 'd-merged')
    await running(store, 'e-cleaning')
    await abort(store, 'e-cleaning')

    const source = new OverviewFrameSource(readOnlyStore(store), REPO, { clock })
    const { frame } = await source.read()

    // The terminal's path over the same store.
    const facts = (await readRepositoryFacts(store, REPO)).value
    const status = facts.status!
    const artifact = (await store.getRepoArtifact(
      REPO,
      status.effectiveConfig!.kind,
      status.effectiveConfig!.rev,
    ))!
    const config = configSchema.parse(
      normalizeEffectiveConfigArtifact(JSON.parse(new TextDecoder().decode(artifact.content))),
    )
    const snapshot = await new DashboardBuildPollCache(store, REPO, config).refresh()
    const model = buildDashboardFromProjected(
      snapshot.builds,
      repositoryDashboardHeader({
        repo: REPO,
        status,
        config,
        repositoryFacts: facts,
        capacityBuilds: snapshot.capacityBuilds ?? [],
        states: snapshot.states.values(),
        now: NOW,
        ...(status.triage !== undefined ? { triage: status.triage } : {}),
      }),
      facts,
      facts.upgrades,
    )
    const roster = (
      await store.getReducerValue(
        { kind: 'rollup', repo: REPO },
        {
          reducer: 'buildRoster',
        },
      )
    ).value as unknown as BuildRosterValue
    const expected = projectOverview(model, {
      ...(status.health !== undefined ? { health: status.health } : {}),
      finished: roster.finished.filter((entry) => !snapshot.states.has(entry.slug)),
    })
    expect(frame.overview).toEqual(expected)
    const overview = frame.overview!
    expect(overview.dispatcher).toEqual(expected.dispatcher)
    expect(overview.active.map((row) => row.slug)).toContain('e-cleaning')
    expect(overview.queued.map((row) => row.slug)).toEqual(['c-queued'])
    expect(overview.finished.map((row) => row.slug)).toEqual(['d-merged'])
    expect(overview.attention.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
  })
})

describe('incremental reads', () => {
  async function started() {
    const store = await configured()
    await running(store, 'live-0')
    await running(store, 'live-1')
    const recorder = recording(store)
    const source = new OverviewFrameSource(readOnlyStore(recorder.proxy), REPO, { clock })
    const first = await source.read()
    const cold = recorder.take()
    return { store, source, first, cold, ...recorder }
  }

  test('a cold start reads the roster and the live builds, never history', async () => {
    const { store, source, first, cold, overrides, take } = await started()
    expect(cold).toEqual(
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'getRepoArtifact',
        'getReducerValue:rollup',
        ...buildReads('live-0'),
        ...buildReads('live-1'),
      ].sort(),
    )
    expect(first.frame.overview?.active.map((row) => row.slug)).toEqual(['live-0', 'live-1'])
    // Unchanged: the position only, and the same frame.
    expect(await source.read()).toBe(first)
    expect(take()).toEqual(['getRepoChangePosition'])

    // The first feed read starts from the roster's own position.
    const roster = (
      await store.getReducerValue(
        { kind: 'rollup', repo: REPO },
        {
          reducer: 'buildRoster',
        },
      )
    ).value as unknown as BuildRosterValue
    const since: string[] = []
    overrides.set('listBuildsChangedSince', (feed, repo: string, position: string) => {
      since.push(position)
      return feed(repo, position)
    })
    await running(store, 'live-2')
    await source.read()
    expect(since).toEqual([roster.position])
  })

  test('a change that leaves every row alone still makes a new frame, by its position', async () => {
    const { store, source, first, take } = await started()
    await store.append('live-0', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-live-0', host: 'test' },
    })
    const next = await source.read()
    const { position: before, ...rest } = first.frame
    const { position: after, ...unchanged } = next.frame
    expect(unchanged).toEqual(rest)
    expect(after).toBe(await store.getRepoChangePosition(REPO))
    expect(after).not.toBe(before)
    expect(take()).toEqual(
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'listBuildsChangedSince',
        ...buildReads('live-0'),
      ].sort(),
    )
  })

  test('a change to one live build reads that build only, without the roster', async () => {
    const { store, source, take } = await started()
    await store.append('live-0', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await source.read()
    expect(take()).toEqual(
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'listBuildsChangedSince',
        ...buildReads('live-0'),
      ].sort(),
    )
  })

  test('completion, creation and abort each read that build plus one roster', async () => {
    const { store, source, take } = await started()
    const moved = (reads: string[]) =>
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'listBuildsChangedSince',
        'getReducerValue:rollup',
        ...reads,
      ].sort()

    await complete(store, 'live-1')
    let overview = (await source.read()).frame.overview!
    expect(take()).toEqual(moved(['getBuild:live-1', 'getReducerValue:build:live-1']))
    expect(overview.active.map((row) => row.slug)).toEqual(['live-0'])
    expect(overview.finished[0]).toMatchObject({ slug: 'live-1', outcome: 'merged' })

    await running(store, 'new-0')
    overview = (await source.read()).frame.overview!
    expect(take()).toEqual(moved(buildReads('new-0')))
    expect(overview.active.map((row) => row.slug)).toEqual(['live-0', 'new-0'])

    await abort(store, 'new-0')
    overview = (await source.read()).frame.overview!
    expect(take()).toEqual(moved(buildReads('new-0')))
    // Cleaning: still active, not finished.
    expect(overview.active.map((row) => row.slug)).toContain('new-0')
    expect(overview.finished.map((row) => row.slug)).not.toContain('new-0')
  })

  for (const variant of ['completed', 'aborted then completed'] as const)
    test(`a build created and finished between two reads appears finished (${variant})`, async () => {
      const { store, source, take } = await started()
      await store.createBuild({ slug: 'blink-0', repo: REPO })
      if (variant !== 'completed') await abort(store, 'blink-0')
      await complete(store, 'blink-0')
      const overview = (await source.read()).frame.overview!
      expect(take()).toEqual(
        [
          'getRepoChangePosition',
          'getRepo',
          'getReducerValue:repo',
          'listBuildsChangedSince',
          'getReducerValue:rollup',
          'getBuild:blink-0',
          'getReducerValue:build:blink-0',
        ].sort(),
      )
      expect(overview.finished[0]).toMatchObject({ slug: 'blink-0', outcome: 'merged' })
      const shown = [...overview.active, ...overview.queued].map((row) => row.slug)
      expect(shown).not.toContain('blink-0')
      for (let idle = 0; idle < 2; idle++) {
        await source.read()
        expect(take()).toEqual(['getRepoChangePosition'])
      }
    })

  test('a config change re-projects rows with one artifact read and no build read', async () => {
    const { store, source, take } = await started()
    await startRun(store, [], { ...CONFIG, capacity: 3 })
    const { frame } = await source.read()
    expect(take()).toEqual(
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'getRepoArtifact',
        'listBuildsChangedSince',
      ].sort(),
    )
    expect(frame.overview?.active).toHaveLength(2)
  })

  test('a feed head below the watermark is a reset and cold-starts', async () => {
    const { store, source, overrides, take } = await started()
    overrides.set('listBuildsChangedSince', async (feed, repo: string, position: string) => ({
      ...((await feed(repo, position)) as object),
      position: '0',
    }))
    await store.append('live-0', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await source.read()
    expect(take()).toContain('getReducerValue:rollup')
  })

  test('a failed read retries at the old state', async () => {
    const { store, source, overrides, take } = await started()
    await store.append('live-0', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    let fail = true
    overrides.set('getReducerValue', (values, scope: { kind: string }, request) => {
      if (fail && scope.kind === 'build') return Promise.reject(new Error('store unavailable'))
      return values(scope, request)
    })
    await expect(source.read()).rejects.toThrow('store unavailable')
    take()
    fail = false
    const { frame } = await source.read()
    expect(take()).toEqual(
      [
        'getRepoChangePosition',
        'getRepo',
        'getReducerValue:repo',
        'listBuildsChangedSince',
        ...buildReads('live-0'),
      ].sort(),
    )
    expect(frame.overview?.active.map((row) => row.slug)).toEqual(['live-0', 'live-1'])
  })
})

test('a read whose subscribers left stops before its next store call', async () => {
  const store = await configured()
  const { proxy, calls } = recording(store)
  let admitted = true
  const gated = new Proxy(proxy, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'getRepoChangePosition') return value
      return async (...args: unknown[]) => {
        const position = await Reflect.apply(value, target, args)
        admitted = false // the last tab leaves while the position read is out
        return position
      }
    },
  })
  const source = new OverviewFrameSource(readOnlyStore(gated), REPO)
  await expect(source.read(() => admitted)).rejects.toBeInstanceOf(WebReadFencedError)
  expect(calls).toEqual(['getRepoChangePosition'])
  calls.length = 0
  await expect(source.read(() => false)).rejects.toBeInstanceOf(WebReadFencedError)
  expect(calls).toEqual([])
})

describe('a remote store without the roster or the feed', () => {
  test('fails with the typed error and never scans history', async () => {
    const store = await configured()
    await running(store, 'live-0')
    const remote = new RemoteBuildStore({
      url: 'http://store.test',
      fetchFn: (async () =>
        Response.json(
          { error: 'not found', kind: 'error' },
          { status: 404 },
        )) as unknown as typeof fetch,
    })
    const { proxy, calls, overrides } = recording(store)
    overrides.set('getReducerValue', (values, scope, request) =>
      scope.kind === 'rollup' ? remote.getReducerValue(scope, request) : values(scope, request),
    )
    const source = new OverviewFrameSource(readOnlyStore(proxy), REPO)
    await expect(source.read()).rejects.toBeInstanceOf(ReducerValueIncompatibilityError)
    expect(calls.filter((call) => FORBIDDEN.includes(call) || call.startsWith('getBuild'))).toEqual(
      [],
    )
  })

  test('a missing feed fails with its typed error, then and on the next read', async () => {
    const store = await configured()
    await running(store, 'live-0')
    const { proxy, calls, overrides } = recording(store)
    const source = new OverviewFrameSource(readOnlyStore(proxy), REPO)
    await source.read()
    overrides.set('listBuildsChangedSince', () =>
      Promise.reject(new BuildFeedUnsupportedError('changedBuilds')),
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      await store.append('live-0', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
      await expect(source.read()).rejects.toBeInstanceOf(BuildFeedUnsupportedError)
    }
    expect(calls.filter((call) => FORBIDDEN.includes(call))).toEqual([])
  })
})
