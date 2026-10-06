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
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { buildReducer } from '../kernel/reducer'
import { MemoryBuildStore } from '../store/memory'
import type { ReducerSnapshot, SnapshotScope } from '../store/snapshots'
import { RepoViewStore, WORK_BUNDLE_VERSION } from './repo-view'

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

    /** Rewrite one part of the stored work bundle; the journal stays intact. */
    const inBundle =
      (rewrite: (bundle: { build: unknown; extra: Record<string, unknown> }) => void) =>
      (_scope: SnapshotScope, reducer: string, found: ReducerSnapshot): ReducerSnapshot => {
        if (reducer !== 'work') return found
        const state = structuredClone(found.state) as {
          build: unknown
          extra: Record<string, unknown>
        }
        rewrite(state)
        return { ...found, state }
      }
    const tampers: Record<
      string,
      (scope: SnapshotScope, reducer: string, found: ReducerSnapshot) => ReducerSnapshot | null
    > = {
      'no snapshot': () => null,
      'malformed bundle state': (_scope, reducer, found) =>
        reducer === 'work' ? { ...found, state: 'garbage' } : found,
      'bundle without its extras': inBundle((bundle) => {
        bundle.extra = undefined as never
      }),
      'malformed build state': inBundle((bundle) => {
        bundle.build = 'garbage'
      }),
      'malformed journal state': (_scope, reducer, found) =>
        reducer === 'journalView' ? { ...found, state: { retained: 'x' } } : found,
      'incomplete digest accumulator': inBundle((bundle) => {
        bundle.extra.buildDigest = {}
      }),
      'incomplete publication ledger': inBundle((bundle) => {
        bundle.extra.publicationState = {}
      }),
      'incomplete log index': inBundle((bundle) => {
        bundle.extra.logIndex = { candidates: [], maxRoundEver: {}, guidanceDeliveries: [] }
      }),
      'openExecution without its open field': inBundle((bundle) => {
        bundle.extra.openExecution = {}
      }),
      'workspace with a malformed open field': inBundle((bundle) => {
        bundle.extra.openBuildWorkspace = { open: 3 }
      }),
      'last execution without its state': inBundle((bundle) => {
        bundle.extra.lastExecutionOutcome = {}
      }),
      'dashboard facts without their sessions': inBundle((bundle) => {
        bundle.extra.dashboardFacts = {}
      }),
      'deferral ledger without its entries': inBundle((bundle) => {
        bundle.extra.currentDeferralObservation = {}
      }),
      'a bundle that predates the dashboard extras': inBundle((bundle) => {
        delete bundle.extra.dashboardFacts
        delete bundle.extra.currentDeferralObservation
      }),
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
    expect(await store.getReducerSnapshot({ kind: 'build', slug: 'a' }, 'work', 999)).toBeNull()
    // Ahead of the log: refused at write, hidden at read.
    expect(
      await store.putReducerSnapshot({ kind: 'build', slug: 'a' }, 'work', {
        version: WORK_BUNDLE_VERSION,
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

describe('a journal snapshot whose retained payload is invalid', () => {
  test.each([
    ['missing', undefined],
    ['of the wrong shape', { enabled: 'yes' }],
  ])('a payload %s replays, and the settings reduction still runs', async (_name, payload) => {
    const store = new CountingStore()
    await store.ensureRepo(REPO)
    const written = await store.appendRepo(REPO, intake(false))
    const { payload: _dropped, ...rest } = written
    expect(
      await store.putReducerSnapshot({ kind: 'repo', repo: REPO }, 'journalView', {
        version: 1,
        cursor: 1,
        state: { retained: [{ ...rest, ...(payload === undefined ? {} : { payload }) }] },
      }),
    ).toBe(true)
    const view = fresh(store)
    await view.startJournal()
    expect(reduceDispatchSettings(view.recordedJournal()).intake).toBe(false)
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

describe('a restored openExecution accumulator', () => {
  test('missing its open field replays, and a later execution.ended folds', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    store.tamper = (_scope, reducer, found) =>
      reducer === 'work'
        ? {
            ...found,
            state: {
              ...(found.state as object),
              extra: { ...(found.state as { extra: object }).extra, openExecution: {} },
            },
          }
        : found
    const view = fresh(store)
    await view.refresh()
    expect((await view.buildFacts('a')).open).toBeNull()
    const started = {
      provider: 'p',
      workspaceRef: 'w',
      instance: 'i1',
      environmentId: 'w',
      sessionId: 's',
      commandId: 'c',
    }
    await view.append('a', { actor: DISPATCHER, type: 'execution.started', payload: started })
    expect((await view.buildFacts('a')).open?.instance).toBe('i1')
    await view.append('a', {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: { instance: 'i1', workspaceRef: 'w', outcome: 'lost' },
    })
    expect((await view.buildFacts('a')).open).toBeNull()
  })
})

describe('the work bundle is one atomic row', () => {
  const scopeOf = (slug: string): SnapshotScope => ({ kind: 'build', slug })

  test('a work build persists one `work` row and no per-reducer rows', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    const bundle = await store.getReducerSnapshot(scopeOf('a'), 'work', WORK_BUNDLE_VERSION)
    expect(bundle).not.toBeNull()
    expect(Object.keys((bundle!.state as { extra: object }).extra).sort()).toEqual(
      [
        'buildDigest',
        'currentDeferralObservation',
        'dashboardFacts',
        'lastExecutionOutcome',
        'logIndex',
        'openBuildWorkspace',
        'openExecution',
        'publicationState',
      ].sort(),
    )
    for (const name of ['build', 'logIndex', 'buildDigest', 'dashboardFacts']) {
      expect(await store.getReducerSnapshot(scopeOf('a'), name, 1)).toBeNull()
    }
  })

  test('the bundle version moves with the component reducer versions', () => {
    // Bump WORK_BUNDLE_LAYOUT (or a component reducer's version) and this pin
    // together: a stale bundle must miss instead of mixing shapes.
    expect(WORK_BUNDLE_VERSION).toBe(pinnedBundleVersion())
  })

  test('a reader racing a publisher sees the old or the new bundle, never history', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await snapshotsOf(store, fresh(store))
    for (let i = 0; i < 50; i++) await pause(store, 'a')
    // Publisher A reads the new tail and parks before its put lands.
    let release!: () => void
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached!: () => void
    const inPut = new Promise<void>((resolve) => {
      reached = resolve
    })
    const publisher = new Proxy(store, {
      get(target, prop) {
        if (prop === 'putReducerSnapshot') {
          return async (...args: Parameters<MemoryBuildStore['putReducerSnapshot']>) => {
            reached()
            await parked
            return target.putReducerSnapshot(...args)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as MemoryBuildStore
    const writer = new RepoViewStore(publisher, { repo: REPO })
    // The cold refresh reads the delta, then publishes it at its end.
    const persisting = writer.refresh()
    await inPut
    // B restores while A's write is in flight: the old coherent bundle plus
    // its delta, never a mixed or full replay of A's log.
    store.reset()
    const during = fresh(store)
    await during.refresh()
    const during_ = await plainFacts(during, 'a')
    const rowsDuring = store.rows.events
    expect(rowsDuring).toBeLessThanOrEqual(50)
    release()
    await persisting
    store.reset()
    const after = fresh(store)
    await after.refresh()
    expect(store.rows.events).toBe(0)
    expect(await plainFacts(after, 'a')).toEqual(during_)
  })

  test('a settled build read for one request restores from, and then leaves, a bundle', async () => {
    const store = new CountingStore()
    await seededRepo(store)
    await store.append('a', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    // No snapshot exists for the settled build: the first read replays it.
    const first = fresh(store)
    await first.refresh()
    store.reset()
    await first.buildFacts('a')
    expect(store.rows.events).toBeGreaterThan(0)
    await first.persistSnapshots({ force: true, held: true })
    // The next process restores it with zero rows.
    const second = fresh(store)
    await second.refresh()
    store.reset()
    const facts = await second.buildFacts('a')
    expect(store.rows.events).toBe(0)
    expect(facts.state.status).toBe('done')
    expect(facts.state).toEqual(buildReducer.reduce(await store.getEvents('a')))
  })
})

import { buildReducer as pinBuild } from '../kernel/reducer'
import { currentDeferralObservationReducer as pinDeferral } from '../kernel/auto-merge'
import { dashboardFactsReducer as pinFacts } from '../cli/dashboard/facts'
import { logIndexReducer as pinLogIndex } from '../kernel/log-index'
import {
  openExecutionReducer as pinOpen,
  lastExecutionOutcomeReducer as pinLast,
} from './execution-settlement'
import { openBuildWorkspaceReducer as pinWorkspace } from './dispatcher-selectors'
import { publicationStateReducer as pinPublication } from './publication-state'
import { buildDigestReducer as pinDigest } from '../store/digest'

function pinnedBundleVersion(): number {
  const layout = 1
  return (
    layout +
    [
      pinBuild,
      pinDeferral,
      pinFacts,
      pinLogIndex,
      pinOpen,
      pinLast,
      pinWorkspace,
      pinPublication,
      pinDigest,
    ]
      .map((reducer) => reducer.version)
      .reduce((a, b) => a + b, 0)
  )
}
