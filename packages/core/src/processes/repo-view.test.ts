import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { reduceBuild } from '../kernel/reducer'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { projectRepositoryStateEvents } from '../store/repo-state-events'
import { isWorkDigest, RepoViewStore } from './repo-view'

const REPO = 'acme/widgets'
const KERNEL = { kind: 'kernel' } as const

/** A memory store counting the event rows each read method returns. */
class CountingStore extends MemoryBuildStore {
  rows = { events: 0, repoEvents: 0, repoState: 0 }
  calls = { listBuilds: 0, digests: 0 }
  /** Drop the first `n` rows of the next delta read, to simulate a hole. */
  dropNextDeltaHead = 0

  override async getEvents(...args: Parameters<MemoryBuildStore['getEvents']>) {
    const events = await super.getEvents(...args)
    this.rows.events += events.length
    return events
  }
  override async getRepoEvents(...args: Parameters<MemoryBuildStore['getRepoEvents']>) {
    let events = await super.getRepoEvents(...args)
    if (this.dropNextDeltaHead > 0 && events.length > 0) {
      events = events.slice(this.dropNextDeltaHead)
      this.dropNextDeltaHead = 0
    }
    this.rows.repoEvents += events.length
    return events
  }
  override async getRepoStateEvents(...args: Parameters<MemoryBuildStore['getRepoStateEvents']>) {
    const events = await super.getRepoStateEvents(...args)
    this.rows.repoState += events.length
    return events
  }
  override async listBuilds() {
    this.calls.listBuilds += 1
    return super.listBuilds()
  }
  override async getRepoBuildDigests(repo: string) {
    this.calls.digests += 1
    return super.getRepoBuildDigests(repo)
  }
  totalRows(): number {
    return this.rows.events + this.rows.repoEvents + this.rows.repoState
  }
  reset(): void {
    this.rows = { events: 0, repoEvents: 0, repoState: 0 }
    this.calls = { listBuilds: 0, digests: 0 }
  }
}

const setting = (enabled: boolean): RepositoryEventWrite => ({
  actor: humanActor('op'),
  type: 'dispatcher.intake-set',
  payload: { enabled },
})
const tickStarted = (run: string): RepositoryEventWrite => ({
  actor: DISPATCHER,
  type: 'dispatcher.tick-started',
  payload: { run },
})
const runStarted = (run: string): RepositoryEventWrite => ({
  actor: DISPATCHER,
  type: 'dispatcher.run-started',
  payload: {
    run,
    pid: 1,
    effectiveConfig: { kind: 'effective-config', rev: 0 },
    roleWarnings: [],
  },
})

async function newBuild(store: MemoryBuildStore, slug: string): Promise<void> {
  await store.createBuild({ slug, repo: REPO, branch: `ab/${slug}` })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'fake', id: `T-${slug}`, title: slug },
      repo: REPO,
      baseBranch: 'main',
    },
  })
}

const touch = (store: BuildStore, slug: string) =>
  store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} } as never)

const complete = (store: BuildStore, slug: string) =>
  store.append(slug, {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'abandoned' },
  })

function setup() {
  const store = new CountingStore()
  const view = new RepoViewStore(store, { repo: REPO })
  return { store, view }
}

describe('RepoViewStore', () => {
  test('cold refresh answers the same bounded journal and builds as the store', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, setting(false))
    await store.appendRepo(REPO, runStarted('r1'))
    await store.appendRepo(REPO, tickStarted('r1'))
    await newBuild(store, 'a')
    await view.refresh()
    expect(await view.getRepoStateEvents(REPO)).toEqual(await store.getRepoStateEvents(REPO))
    expect((await view.listBuilds()).map((record) => record.slug)).toEqual(['a'])
    expect(await view.getEvents('a')).toEqual(await store.getEvents('a'))
    expect(await view.getRepoBuildDigests(REPO)).toEqual(await store.getRepoBuildDigests(REPO))
  })

  test.each([
    ['durable settings then run-scoped facts, no anchor', ['s', 'tick']],
    ['a non-empty journal whose bounded subset is empty', ['tick', 'tick']],
    ['an anchored journal', ['s', 'run', 'tick']],
  ] as const)('an idle warm refresh reads zero rows: %s', async (_name, shape) => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    for (const kind of shape) {
      if (kind === 's') await store.appendRepo(REPO, setting(true))
      if (kind === 'tick') await store.appendRepo(REPO, tickStarted('r0'))
      if (kind === 'run') await store.appendRepo(REPO, runStarted('r1'))
    }
    await newBuild(store, 'live')
    await view.refresh()
    store.reset()
    await view.refresh()
    await view.refresh()
    expect(store.totalRows()).toBe(0)
    // Only discovery was read.
    expect(store.calls.listBuilds).toBe(2)
    expect(store.calls.digests).toBe(2)
  })

  test.each([
    ['anchor-free', ['s', 'tick']],
    ['anchored', ['s', 'run', 'tick']],
  ] as const)(
    'a warm refresh after M new events reads exactly M rows (%s)',
    async (_name, shape) => {
      const { store, view } = setup()
      await store.ensureRepo(REPO)
      for (const kind of shape) {
        if (kind === 's') await store.appendRepo(REPO, setting(true))
        if (kind === 'tick') await store.appendRepo(REPO, tickStarted('r0'))
        if (kind === 'run') await store.appendRepo(REPO, runStarted('r1'))
      }
      await newBuild(store, 'live')
      await view.refresh()
      store.reset()
      await store.appendRepo(REPO, setting(false))
      await store.appendRepo(REPO, tickStarted('r0'))
      await touch(store, 'live')
      await view.refresh()
      expect(store.totalRows()).toBe(3)
      expect(await view.getRepoStateEvents(REPO)).toEqual(await store.getRepoStateEvents(REPO))
      expect(await view.getEvents('live')).toEqual(await store.getEvents('live'))
    },
  )

  test('a build held live that settles elsewhere reads its tail, matches a full read, then is evicted', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await newBuild(store, 'a')
    await view.refresh()
    await touch(store, 'a')
    await complete(store, 'a')
    store.reset()
    await view.refresh()
    expect(store.rows.events).toBe(2)
    const digests = await view.getRepoBuildDigests(REPO)
    expect(isWorkDigest(digests.get('a')!)).toBe(false)
    expect(reduceBuild(await view.getEvents('a')).status).toBe('done')
    store.reset()
    await view.refresh()
    await view.refresh()
    // Settled and evicted: no log read.
    expect(store.rows.events).toBe(0)
  })

  test('builds created by another handle appear at the next refresh; own creates immediately', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await view.refresh()
    await newBuild(store, 'foreign')
    expect((await view.listBuilds()).map((record) => record.slug)).toEqual([])
    await view.refresh()
    expect((await view.listBuilds()).map((record) => record.slug)).toEqual(['foreign'])
    expect(await view.getEvents('foreign')).toHaveLength(1)
    await view.createBuild({ slug: 'own', repo: REPO, branch: 'ab/own' })
    expect((await view.listBuilds()).map((record) => record.slug).sort()).toEqual([
      'foreign',
      'own',
    ])
    expect(isWorkDigest((await view.getRepoBuildDigests(REPO)).get('own')!)).toBe(true)
  })

  test('own appends are visible at once without a store read', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await newBuild(store, 'a')
    await view.refresh()
    store.reset()
    await view.append('a', { actor: KERNEL, type: 'build.paused', payload: {} } as never)
    await view.appendRepo(REPO, setting(false))
    expect((await view.getEvents('a')).at(-1)?.type).toBe('build.paused')
    expect((await view.getRepoStateEvents(REPO)).at(-1)?.type).toBe('dispatcher.intake-set')
    expect(store.totalRows()).toBe(0)
    // Folded exactly: a fresh full read agrees.
    expect(await view.getEvents('a')).toEqual(await store.getEvents('a'))
  })

  test('an interleaved foreign append leaves a gap that the next read fills without loss or duplicates', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await newBuild(store, 'a')
    await view.refresh()
    await touch(store, 'a')
    await view.append('a', { actor: KERNEL, type: 'build.paused', payload: {} } as never)
    const seen = await view.getEvents('a')
    expect(seen.map((event) => event.seq)).toEqual([1, 2, 3])
    await store.appendRepo(REPO, setting(false))
    await view.appendRepo(REPO, setting(true))
    const journal = await view.getRepoStateEvents(REPO)
    expect(journal.map((event) => event.seq)).toEqual([1, 2])
  })

  test('an own journal append across a gap is reconciled for the synchronous snapshot', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await view.refresh()
    await store.appendRepo(REPO, setting(false))
    await view.appendRepo(REPO, setting(true))
    expect(view.recordedJournal().map((event) => event.seq)).toEqual([1, 2])
  })

  test('a failed appendIfCurrent refreshes so the retry sees the winner', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await newBuild(store, 'a')
    await view.refresh()
    await touch(store, 'a')
    const lost = await view.appendIfCurrent('a', 1, {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    } as never)
    expect(lost).toBeNull()
    const events = await view.getEvents('a')
    expect(events.map((event) => event.seq)).toEqual([1, 2])
  })

  test('a non-contiguous delta triggers a full re-read instead of skipping events', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await view.refresh()
    await store.appendRepo(REPO, setting(false))
    await store.appendRepo(REPO, setting(true))
    store.dropNextDeltaHead = 1
    await view.refresh()
    expect((await view.getRepoStateEvents(REPO)).map((event) => event.seq)).toEqual([1, 2])
  })

  test('a repository nobody has recorded yet is re-probed each refresh', async () => {
    const { store, view } = setup()
    await view.refresh()
    expect(view.journalRecorded()).toBe(false)
    expect(view.recordedJournal()).toEqual([])
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, setting(false))
    await view.refresh()
    expect(view.journalRecorded()).toBe(true)
    expect(view.recordedJournal()).toHaveLength(1)
  })

  test('a settled build turning back into work is picked up from discovery', async () => {
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    await newBuild(store, 'a')
    await complete(store, 'a')
    await view.refresh()
    store.reset()
    await view.refresh()
    expect(store.rows.events).toBe(0)
    await store.append('a', {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'p',
        workspaceRef: 'w',
        instance: 'i1',
        environmentId: 'e',
        sessionId: 's',
        commandId: 'c',
      },
    } as never)
    await view.refresh()
    expect(isWorkDigest((await view.getRepoBuildDigests(REPO)).get('a')!)).toBe(true)
    expect(await view.getEvents('a')).toEqual(await store.getEvents('a'))
  })

  test('randomized interleavings from two handles converge on the full reads', async () => {
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const { store, view } = setup()
    await store.ensureRepo(REPO)
    const slugs = ['a', 'b', 'c']
    for (const slug of slugs) await newBuild(store, slug)
    await view.refresh()
    const completed = new Set<string>()
    for (let step = 0; step < 120; step += 1) {
      const slug = slugs[next(slugs.length)]!
      const viaView = next(2) === 0
      const target: BuildStore = viaView ? view : store
      switch (next(5)) {
        case 0:
          if (!completed.has(slug)) await touch(target, slug)
          break
        case 1:
          await target.appendRepo(REPO, next(2) === 0 ? setting(next(2) === 0) : tickStarted('r'))
          break
        case 2:
          if (next(8) === 0) await target.appendRepo(REPO, runStarted(`r${step}`))
          break
        case 3:
          if (next(10) === 0 && !completed.has(slug)) {
            completed.add(slug)
            await complete(target, slug)
          }
          break
        default:
          await view.refresh()
      }
      if (next(6) === 0) {
        expect(await view.getRepoStateEvents(REPO)).toEqual(
          projectRepositoryStateEvents(await store.getRepoEvents(REPO)),
        )
        for (const build of slugs) {
          expect(reduceBuild(await view.getEvents(build))).toEqual(
            reduceBuild(await store.getEvents(build)),
          )
        }
      }
    }
    await view.refresh()
    expect(await view.getRepoStateEvents(REPO)).toEqual(
      projectRepositoryStateEvents(await store.getRepoEvents(REPO)),
    )
    for (const build of slugs) {
      expect(await view.getEvents(build)).toEqual(await store.getEvents(build))
    }
  })
})

describe('RepoViewStore read windows', () => {
  async function settledWithHistory(resident: boolean) {
    const store = new CountingStore()
    const view = new RepoViewStore(store, { repo: REPO, resident })
    await store.ensureRepo(REPO)
    await newBuild(store, 'old')
    for (let i = 0; i < 4; i += 1) await touch(store, 'old')
    await complete(store, 'old')
    await view.refresh()
    return { store, view }
  }

  test('resident: a nonzero cursor reads the log once, then only deltas, and buildState needs no replay', async () => {
    const { store, view } = await settledWithHistory(true)
    store.reset()
    expect((await view.getEvents('old', 3)).map((event) => event.seq)).toEqual([4, 5, 6])
    expect(store.rows.events).toBe(6)
    store.reset()
    await view.refresh()
    expect(await view.getEvents('old', 3)).toHaveLength(3)
    expect(store.rows.events).toBe(0)
    await store.append('old', { actor: KERNEL, type: 'build.paused', payload: {} } as never)
    await view.refresh()
    expect((await view.getEvents('old', 6)).map((event) => event.seq)).toEqual([7])
    expect(store.rows.events).toBe(1)
    store.reset()
    const state = await view.buildState('old')
    expect(store.rows.events).toBe(0)
    expect(state).toEqual(reduceBuild(await store.getEvents('old')))
  })

  test('one-shot: the window reads from its cursor exactly as a direct read would', async () => {
    const { store, view } = await settledWithHistory(false)
    store.reset()
    expect((await view.getEvents('old', 3)).map((event) => event.seq)).toEqual([4, 5, 6])
    expect(store.rows.events).toBe(3)
    const state = await view.buildState('old')
    expect(state).toEqual(reduceBuild(await store.getEvents('old')))
  })

  test('a lower cursor widens the window; releaseWindowsBelow trims consumed history', async () => {
    const { store, view } = await settledWithHistory(true)
    await view.getEvents('old', 4)
    view.releaseWindowsBelow({ build: 'old' }, 5)
    expect((await view.getEvents('old', 5)).map((event) => event.seq)).toEqual([6])
    store.reset()
    // Below the trimmed floor: re-read from there.
    expect((await view.getEvents('old', 2)).map((event) => event.seq)).toEqual([3, 4, 5, 6])
    expect(store.rows.events).toBeGreaterThan(0)
    // Trimming never loses reduced state.
    view.releaseWindowsBelow({ build: 'old' }, 6)
    expect(await view.buildState('old')).toEqual(reduceBuild(await store.getEvents('old')))
  })

  test('an own append racing window creation or widening is not lost', async () => {
    class DeferredStore extends CountingStore {
      hold: (() => Promise<void>) | undefined
      override async getRepoEvents(...args: Parameters<MemoryBuildStore['getRepoEvents']>) {
        const events = await super.getRepoEvents(...args)
        const hold = this.hold
        this.hold = undefined
        await hold?.()
        return events
      }
    }
    const store = new DeferredStore()
    const view = new RepoViewStore(store, { repo: REPO, resident: true })
    await store.ensureRepo(REPO)
    await view.refresh()
    // Creation: the snapshot is empty, then an own append lands before it returns.
    store.hold = async () => {
      await view.appendRepo(REPO, setting(false))
    }
    await view.getRepoEvents(REPO, 0)
    await view.refresh()
    expect((await view.getRepoEvents(REPO, 0)).map((event) => event.seq)).toEqual([1])
    // Widening: a later cursor first, then a lower one that races an append.
    await view.appendRepo(REPO, setting(true))
    await view.getRepoEvents(REPO, 2)
    view.releaseWindowsBelow('journal', 2)
    store.hold = async () => {
      await view.appendRepo(REPO, setting(false))
    }
    await view.getRepoEvents(REPO, 0)
    await view.refresh()
    expect((await view.getRepoEvents(REPO, 0)).map((event) => event.seq)).toEqual([1, 2, 3])
  })

  test('the journal window serves every event type above its cursor and reads each row once', async () => {
    const store = new CountingStore()
    const view = new RepoViewStore(store, { repo: REPO, resident: true })
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, tickStarted('r'))
    await store.appendRepo(REPO, tickStarted('r'))
    await view.refresh()
    store.reset()
    expect((await view.getRepoEvents(REPO, 1)).map((event) => event.seq)).toEqual([2])
    expect(store.rows.repoEvents).toBe(1)
    store.reset()
    await view.refresh()
    expect(await view.getRepoEvents(REPO, 1)).toHaveLength(1)
    expect(store.totalRows()).toBe(0)
    await store.appendRepo(REPO, tickStarted('r'))
    await view.refresh()
    expect((await view.getRepoEvents(REPO, 2)).map((event) => event.seq)).toEqual([3])
    expect(store.rows.repoEvents).toBe(1)
    view.releaseWindowsBelow('journal', 2)
    expect((await view.getRepoEvents(REPO, 2)).map((event) => event.seq)).toEqual([3])
  })
})
