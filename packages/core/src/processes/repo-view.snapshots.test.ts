/**
 * Cold-start snapshots (store/snapshots.ts): a view that restores reducer state
 * and reads only events newer than the stored cursor answers exactly what a
 * full replay does, reads zero rows when nothing happened, and exactly the new
 * rows when something did.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { AbEvent, EventWrite } from '../events/catalog'
import type { RepositoryEventWrite } from '../events/repository'
import { randomBuildLog } from '../kernel/generators/build-log'
import { seededRandom } from '../kernel/incremental-contract'
import { buildReducer } from '../kernel/reducer'
import { MemoryBuildStore } from '../store/memory'
import type { ReducerSnapshot, SnapshotScope } from '../store/snapshots'
import { RepoViewStore } from './repo-view'

const REPO = 'acme/widgets'
const KERNEL = { kind: 'kernel' } as const

class CountingStore extends MemoryBuildStore {
  rows = { events: 0, repoEvents: 0, repoState: 0 }
  /** When false, every snapshot read misses — the "all snapshots deleted" arm. */
  snapshotsOn = true
  /** Rewrites every snapshot read, to model a stale, corrupt or foreign row. */
  tamper?: (scope: SnapshotScope, reducer: string, found: ReducerSnapshot) => ReducerSnapshot | null

  override async getEvents(...args: Parameters<MemoryBuildStore['getEvents']>) {
    const events = await super.getEvents(...args)
    this.rows.events += events.length
    return events
  }
  override async getRepoEvents(...args: Parameters<MemoryBuildStore['getRepoEvents']>) {
    const events = await super.getRepoEvents(...args)
    this.rows.repoEvents += events.length
    return events
  }
  override async getRepoStateEvents(...args: Parameters<MemoryBuildStore['getRepoStateEvents']>) {
    const events = await super.getRepoStateEvents(...args)
    this.rows.repoState += events.length
    return events
  }
  override async getReducerSnapshot(scope: SnapshotScope, reducer: string, version: number) {
    if (!this.snapshotsOn) return null
    const found = await super.getReducerSnapshot(scope, reducer, version)
    if (found === null || this.tamper === undefined) return found
    return this.tamper(scope, reducer, found)
  }
  totalRows(): number {
    return this.rows.events + this.rows.repoEvents + this.rows.repoState
  }
  reset(): void {
    this.rows = { events: 0, repoEvents: 0, repoState: 0 }
  }
}

/** `BuildFacts` with its publication view (closures) reduced to its answers. */
async function plainFacts(view: RepoViewStore, slug: string) {
  const { publication, ...rest } = await view.buildFacts(slug)
  return {
    ...rest,
    publication: {
      pending: publication.pending(),
      abandoned: publication.abandonedPending(),
      latest: publication.latestUncompletedRequest(),
    },
  }
}

const fresh = (store: MemoryBuildStore) => new RepoViewStore(store, { repo: REPO })

const asWrite = (event: AbEvent): EventWrite =>
  ({ actor: event.actor, type: event.type, payload: event.payload }) as EventWrite

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

const pause = (store: MemoryBuildStore, slug: string) =>
  store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} } as never)

const intake = (enabled: boolean): RepositoryEventWrite => ({
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
  payload: { run, pid: 1, effectiveConfig: { kind: 'effective-config', rev: 0 }, roleWarnings: [] },
})

async function seededRepo(store: MemoryBuildStore): Promise<void> {
  await store.ensureRepo(REPO)
  await store.appendRepo(REPO, intake(false))
  await store.appendRepo(REPO, runStarted('r1'))
  await store.appendRepo(REPO, tickStarted('r1'))
  await newBuild(store, 'a')
  await newBuild(store, 'b')
  await pause(store, 'b')
}

async function snapshotsOf(store: MemoryBuildStore, view: RepoViewStore): Promise<void> {
  void store
  await view.refresh()
  await view.persistSnapshots({ force: true })
}

describe('RepoViewStore cold start from reducer snapshots', () => {
  test('a second cold view over an unchanged log reads zero event rows', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    store.reset()
    const view = fresh(store)
    await view.refresh()
    expect(store.totalRows()).toBe(0)
    expect(view.recordedJournal().map((event) => event.type)).toEqual([
      'dispatcher.intake-set',
      'dispatcher.run-started',
      'dispatcher.tick-started',
    ])
    const facts = await view.buildFacts('b')
    expect(facts.state.status).toBe('paused')
    expect(store.totalRows()).toBe(0)
  })

  test('M events appended between runs cost exactly M rows', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    await store.appendRepo(REPO, tickStarted('r1'))
    await store.appendRepo(REPO, tickStarted('r1'))
    await pause(store, 'a')
    await store.append('a', { actor: KERNEL, type: 'build.resumed', payload: {} } as never)
    await store.append('b', { actor: KERNEL, type: 'build.resumed', payload: {} } as never)
    store.reset()
    const view = fresh(store)
    await view.refresh()
    expect(store.totalRows()).toBe(5)
    expect(store.rows.repoEvents).toBe(2)
    expect(store.rows.events).toBe(3)
  })

  test('the run that writes the snapshots persists its own appends too', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    const view = fresh(store)
    await view.refresh()
    await view.appendRepo(REPO, tickStarted('r1'))
    await view.append('a', { actor: KERNEL, type: 'build.paused', payload: {} } as never)
    await view.persistSnapshots({ force: true })
    store.reset()
    const next = fresh(store)
    await next.refresh()
    expect(store.totalRows()).toBe(0)
    expect((await next.buildFacts('a')).state.status).toBe('paused')
  })

  test('every miss replays in full with identical facts', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    await pause(store, 'a')
    const reference = fresh(store)
    store.snapshotsOn = false
    await reference.refresh()
    const expected = {
      a: await plainFacts(reference, 'a'),
      b: await plainFacts(reference, 'b'),
      journal: reference.recordedJournal(),
    }
    expect(store.rows.events).toBeGreaterThan(0)

    const tampers: Record<
      string,
      (scope: SnapshotScope, reducer: string, found: ReducerSnapshot) => ReducerSnapshot | null
    > = {
      'no snapshot': () => null,
      'malformed build state': (_scope, reducer, found) =>
        reducer === 'build' ? { ...found, state: 'garbage' } : found,
      'malformed journal state': (_scope, reducer, found) =>
        reducer === 'journalView' ? { ...found, state: { retained: 'x' } } : found,
      'incomplete digest accumulator': (_scope, reducer, found) =>
        reducer === 'buildDigest' ? { ...found, state: {} } : found,
      'incomplete publication ledger': (_scope, reducer, found) =>
        reducer === 'publicationState' ? { ...found, state: {} } : found,
      'incomplete log index': (_scope, reducer, found) =>
        reducer === 'logIndex'
          ? { ...found, state: { candidates: [], maxRoundEver: {}, guidanceDeliveries: [] } }
          : found,
      'prefixes that disagree': (_scope, reducer, found) =>
        reducer === 'logIndex' ? { ...found, cursor: found.cursor - 1 } : found,
    }
    for (const [name, tamper] of Object.entries(tampers)) {
      store.snapshotsOn = true
      store.tamper = tamper
      const view = fresh(store)
      await view.refresh()
      expect({ name, a: await plainFacts(view, 'a') }).toEqual({ name, a: expected.a })
      expect({ name, b: await plainFacts(view, 'b') }).toEqual({ name, b: expected.b })
      expect({ name, journal: view.recordedJournal() }).toEqual({ name, journal: expected.journal })
    }
  })

  test('a snapshot of another reducer version or ahead of the log is ignored', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    // Version mismatch: the adapter answers null for any other version, and a
    // write at a higher cursor-equal version replaces it.
    expect(await store.getReducerSnapshot({ kind: 'build', slug: 'a' }, 'build', 999)).toBeNull()
    // Ahead of the log: refused at write, hidden at read.
    expect(
      await store.putReducerSnapshot({ kind: 'build', slug: 'a' }, 'logIndex', {
        version: 1,
        cursor: 99,
        state: {},
      }),
    ).toBe(false)
    store.reset()
    const view = fresh(store)
    await view.refresh()
    expect(store.totalRows()).toBe(0)
  })

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`generated logs, random chunking between runs, seed ${seed}`, async () => {
      const store = new CountingStore()
      const rand = seededRandom(seed)
      await store.ensureRepo(REPO)
      const journal: RepositoryEventWrite[] = Array.from({ length: 40 }, (_, index) => {
        const pick = Math.floor(rand() * 4)
        if (pick === 0) return intake(rand() < 0.5)
        if (pick === 1) return runStarted(`r${index}`)
        return tickStarted(`r${index}`)
      })
      const logs = ['a', 'b', 'c'].map((slug, index) => ({
        slug,
        events: randomBuildLog(seed * 10 + index, 25).filter(
          (event) => event.type !== 'build.completed' && event.type !== 'build.created',
        ),
      }))
      for (const { slug } of logs) await newBuild(store, slug)
      let journalAt = 0
      const cursors = new Map(logs.map((log) => [log.slug, 0]))
      for (let round = 0; round < 5; round++) {
        // Append a random slice of each source, then run a cold view that may
        // restore from what earlier rounds persisted.
        const take = Math.floor(rand() * 8)
        for (const event of journal.slice(journalAt, journalAt + take)) {
          await store.appendRepo(REPO, event)
        }
        journalAt += take
        for (const log of logs) {
          const from = cursors.get(log.slug) ?? 0
          const count = Math.floor(rand() * 7)
          for (const event of log.events.slice(from, from + count)) {
            await store.append(log.slug, asWrite(event))
          }
          cursors.set(log.slug, from + count)
        }
        store.snapshotsOn = true
        const withSnapshots = fresh(store)
        await withSnapshots.refresh()
        store.snapshotsOn = false
        const replayed = fresh(store)
        await replayed.refresh()
        store.snapshotsOn = true
        expect(withSnapshots.recordedJournal()).toEqual(replayed.recordedJournal())
        for (const { slug } of logs) {
          expect(await plainFacts(withSnapshots, slug)).toEqual(await plainFacts(replayed, slug))
          expect(await withSnapshots.buildState(slug)).toEqual(await replayed.buildState(slug))
        }
        expect(await withSnapshots.getRepoBuildDigests(REPO)).toEqual(
          await replayed.getRepoBuildDigests(REPO),
        )
        await withSnapshots.persistSnapshots({ force: true })
      }
    })
  }

  test('raw events remain available behind a snapshot-backed log', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    const view = fresh(store)
    await view.refresh()
    store.reset()
    expect(await view.getEvents('b')).toEqual(await store.getEvents('b'))
    // The full read happened once and is retained.
    store.reset()
    await view.getEvents('b')
    expect(store.rows.events).toBe(0)
    // And the accumulators still agree with the retained history.
    const facts = await view.buildFacts('b')
    expect(facts.state).toEqual(buildReducer.reduce(await store.getEvents('b')))
  })
})

describe('a malformed journal snapshot at a quiet tail', () => {
  test.each([
    ['a null entry', { retained: [null] }],
    ['an entry without a type', { retained: [{ repo: REPO, seq: 1, ts: 't', actor: {} }] }],
    ['a non-numeric anchor', { retained: [] as unknown[], anchor: 'x' }],
  ])('%s replays, and the next own append still folds', async (_name, state) => {
    const store = new CountingStore()
    await store.ensureRepo(REPO)
    await store.appendRepo(REPO, intake(false))
    expect(
      await store.putReducerSnapshot({ kind: 'repo', repo: REPO }, 'journalView', {
        version: 1,
        cursor: 1,
        state,
      }),
    ).toBe(true)
    const view = fresh(store)
    await view.startJournal()
    const appended = await view.appendRepo(REPO, runStarted('r1'))
    expect(appended.seq).toBe(2)
    expect(view.recordedJournal().map((event) => event.type)).toEqual([
      'dispatcher.intake-set',
      'dispatcher.run-started',
    ])
  })
})
