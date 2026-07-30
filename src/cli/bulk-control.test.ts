import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import type { EventType } from '../events/payloads'
import { reduceBuild } from '../kernel/reducer'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import { controlBuild } from './build-control'
import { effectiveStatus } from './dashboard/model'
import {
  bulkControlRepository,
  bulkControlReport,
  bulkPausable,
  bulkResumable,
} from './bulk-control'

const REPO = '/repo'
const OTHER_REPO = '/other-repo'
const ENV = { USER: 'operator' }

/** The seed states the bulk walk has to tell apart. Each is expressed only in
 * events, so the reduced status is the store's answer rather than the test's. */
type Seed =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'blocked'
  | 'paused-and-blocked'
  | 'completed'

async function seedBuild(
  store: MemoryBuildStore,
  slug: string,
  seed: Seed,
  repo = REPO,
): Promise<void> {
  await store.createBuild({ slug, repo })
  if (seed === 'queued') return

  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: `runner-${slug}`, host: 'host-1', resumedFromSeq: 0 },
  })

  if (seed === 'blocked' || seed === 'paused-and-blocked') {
    await store.append(slug, {
      actor: agentActor('implement', `session-${slug}`),
      type: 'escalation.raised',
      payload: {
        id: `esc-${slug}`,
        phase: 'implement',
        round: 1,
        source: 'agent',
        question: 'Which way?',
      },
    })
  }

  if (seed === 'pausing') {
    await store.append(slug, {
      actor: { kind: 'human', user: 'someone-else' },
      type: 'build.pause-requested',
      payload: {},
    })
  }

  if (seed === 'paused' || seed === 'resuming' || seed === 'paused-and-blocked') {
    await store.append(slug, {
      actor: { kind: 'human', user: 'someone-else' },
      type: 'build.pause-requested',
      payload: {},
    })
    await store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
  }

  if (seed === 'resuming') {
    await store.append(slug, {
      actor: { kind: 'human', user: 'someone-else' },
      type: 'build.resume-requested',
      payload: {},
    })
  }

  if (seed === 'completed') {
    await store.append(slug, {
      actor: { kind: 'dispatcher' },
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
}

async function makeStore(seeds: Record<string, Seed>, other: Record<string, Seed> = {}) {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  for (const [slug, seed] of Object.entries(seeds)) await seedBuild(store, slug, seed)
  for (const [slug, seed] of Object.entries(other)) {
    await seedBuild(store, slug, seed, OTHER_REPO)
  }
  return store
}

async function snapshot(store: BuildStore): Promise<Record<string, AbEvent[]>> {
  const shot: Record<string, AbEvent[]> = {}
  for (const record of await store.listBuilds()) {
    shot[record.slug] = await store.getEvents(record.slug)
  }
  return shot
}

function typesOf(events: AbEvent[]): string[] {
  return events.map((event) => event.type)
}

function countOf(events: AbEvent[], type: EventType): number {
  return events.filter((event) => event.type === type).length
}

async function intakeOf(store: BuildStore, repo = REPO): Promise<boolean> {
  return reduceDispatchSettings(await store.getRepoEvents(repo)).intake
}

/**
 * A store decorator that lands ONE competing append through the inner store on
 * the first `appendIfCurrent` for a slug, before delegating. The injected event
 * advances the tail, so the CAS misses and the loop must re-read — which is
 * exactly the interleaving a live runner, a second dashboard, or a sessionless
 * `ab pause` produces. Deterministic: no timing is involved.
 */
function withRacingAppend(
  store: MemoryBuildStore,
  slug: string,
  competitor: EventWrite<EventType>,
): BuildStore {
  let injected = false
  const proxy = Object.create(store) as MemoryBuildStore
  proxy.appendIfCurrent = async <T extends EventType>(
    target: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> => {
    if (target === slug && !injected) {
      injected = true
      await store.append(slug, competitor)
    }
    return store.appendIfCurrent(target, expectedSeq, event)
  }
  return proxy
}

describe('bulkControlRepository — pause', () => {
  test('requests a pause on exactly the running builds and leaves everything else byte-identical', async () => {
    const store = await makeStore(
      {
        'a-running': 'running',
        'b-pausing': 'pausing',
        'c-paused': 'paused',
        'd-blocked': 'blocked',
        'e-queued': 'queued',
        'f-completed': 'completed',
        'g-running': 'running',
      },
      { 'z-other-running': 'running' },
    )
    const before = await snapshot(store)

    const summary = await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })

    expect(summary).toEqual({
      direction: 'pause',
      slugs: ['a-running', 'g-running'],
      intake: false,
    })

    for (const slug of ['a-running', 'g-running']) {
      const added = (await store.getEvents(slug)).slice(before[slug]?.length ?? 0)
      expect(typesOf(added)).toEqual(['build.pause-requested'])
      expect(added[0]?.actor).toEqual({ kind: 'human', user: 'operator' })
    }

    // The pending-pause build keeps exactly one pause and gains no resume: the
    // bulk control never cancels a pause the way build-row `p` does.
    const pausing = await store.getEvents('b-pausing')
    expect(countOf(pausing, 'build.pause-requested')).toBe(1)
    expect(countOf(pausing, 'build.resume-requested')).toBe(0)

    for (const slug of [
      'b-pausing',
      'c-paused',
      'd-blocked',
      'e-queued',
      'f-completed',
      'z-other-running',
    ]) {
      expect(await store.getEvents(slug)).toEqual(before[slug] ?? [])
    }
    await store.close()
  })

  test('intake is an absolute setter, not a toggle', async () => {
    const store = await makeStore({ 'a-running': 'running' })

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(await intakeOf(store)).toBe(false)

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(await intakeOf(store)).toBe(false)

    const intakeEvents = (await store.getRepoEvents(REPO)).filter(
      (event) => event.type === 'dispatcher.intake-set',
    )
    expect(intakeEvents).toHaveLength(2)
    expect(intakeEvents.every((event) => event.payload.enabled === false)).toBe(true)
    await store.close()
  })

  test('no pausable builds still turns intake off without erroring', async () => {
    const empty = new MemoryBuildStore({ clock: steppingClock() })
    await empty.ensureRepo(REPO)
    const emptySummary = await bulkControlRepository({
      store: empty,
      repo: REPO,
      env: ENV,
      direction: 'pause',
    })
    expect(emptySummary.slugs).toEqual([])
    expect(await intakeOf(empty)).toBe(false)
    await empty.close()

    const parked = await makeStore({ 'a-queued': 'queued', 'b-paused': 'paused' })
    const summary = await bulkControlRepository({
      store: parked,
      repo: REPO,
      env: ENV,
      direction: 'pause',
    })
    expect(summary.slugs).toEqual([])
    expect(await intakeOf(parked)).toBe(false)
    await parked.close()
  })

  test('a repository row no tick has created yet is ensured, not an error', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, 'a-running', 'running')
    expect(await store.getRepo(REPO)).toBeNull()

    const summary = await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(summary.slugs).toEqual(['a-running'])
    expect(await intakeOf(store)).toBe(false)
    await store.close()
  })
})

describe('bulkControlRepository — resume', () => {
  test('requests a resume on exactly the cleanly paused builds', async () => {
    const store = await makeStore(
      {
        'a-paused': 'paused',
        'b-resuming': 'resuming',
        'c-paused-blocked': 'paused-and-blocked',
        'd-blocked': 'blocked',
        'e-running': 'running',
      },
      { 'z-other-paused': 'paused' },
    )
    const before = await snapshot(store)

    const summary = await bulkControlRepository({
      store,
      repo: REPO,
      env: ENV,
      direction: 'resume',
    })

    expect(summary).toEqual({ direction: 'resume', slugs: ['a-paused'], intake: true })
    const added = (await store.getEvents('a-paused')).slice(before['a-paused']?.length ?? 0)
    expect(typesOf(added)).toEqual(['build.resume-requested'])
    expect(added[0]?.actor).toEqual({ kind: 'human', user: 'operator' })

    for (const slug of [
      'b-resuming',
      'c-paused-blocked',
      'd-blocked',
      'e-running',
      'z-other-paused',
    ]) {
      expect(await store.getEvents(slug)).toEqual(before[slug] ?? [])
    }

    const intakeEvents = (await store.getRepoEvents(REPO)).filter(
      (event) => event.type === 'dispatcher.intake-set',
    )
    expect(intakeEvents).toHaveLength(1)
    expect(await intakeOf(store)).toBe(true)
    await store.close()
  })

  test('resumes a build paused by hand, not only ones a bulk pause paused', async () => {
    const store = await makeStore({ 'a-paused': 'paused' })
    // `a-paused` was paused by "someone-else" and never touched by a bulk
    // pause; resume-all takes it anyway, which the spec explicitly accepts.
    const summary = await bulkControlRepository({
      store,
      repo: REPO,
      env: ENV,
      direction: 'resume',
    })
    expect(summary.slugs).toEqual(['a-paused'])
    await store.close()
  })
})

describe('bulk eligibility predicates', () => {
  test('agree with what the operator sees on the dashboard', async () => {
    const seeds: Seed[] = [
      'queued',
      'running',
      'pausing',
      'paused',
      'resuming',
      'blocked',
      'paused-and-blocked',
    ]
    const store = await makeStore(Object.fromEntries(seeds.map((seed) => [seed, seed])))

    for (const seed of seeds) {
      const state = reduceBuild(await store.getEvents(seed))
      const shown = effectiveStatus(state)
      expect(bulkPausable(state)).toBe(shown === 'running')
      expect(bulkResumable(state)).toBe(shown === 'paused')
    }
    await store.close()
  })
})

describe('bulk event shape', () => {
  test('matches what the per-build control writes for the same command', async () => {
    const bulkStore = await makeStore({ 'a-running': 'running', 'b-paused': 'paused' })
    const perBuildStore = await makeStore({ 'a-running': 'running', 'b-paused': 'paused' })

    await bulkControlRepository({ store: bulkStore, repo: REPO, env: ENV, direction: 'pause' })
    await controlBuild({
      store: perBuildStore,
      repo: REPO,
      slug: 'a-running',
      env: ENV,
      action: { kind: 'pause' },
    })

    await bulkControlRepository({ store: bulkStore, repo: REPO, env: ENV, direction: 'resume' })
    await controlBuild({
      store: perBuildStore,
      repo: REPO,
      slug: 'b-paused',
      env: ENV,
      action: { kind: 'resume' },
    })

    for (const slug of ['a-running', 'b-paused']) {
      const bulk = (await bulkStore.getEvents(slug)).at(-1)
      const perBuild = (await perBuildStore.getEvents(slug)).at(-1)
      expect(bulk?.type).toBe(perBuild?.type)
      expect(bulk?.payload).toEqual(perBuild?.payload)
      expect(bulk?.actor).toEqual(perBuild?.actor)
    }
    await bulkStore.close()
    await perBuildStore.close()
  })
})

describe('bulk per-build writes are compare-and-set', () => {
  test('a competing pause request wins and leaves exactly one pending pause', async () => {
    const inner = await makeStore({ 'a-running': 'running' })
    const store = withRacingAppend(inner, 'a-running', {
      actor: { kind: 'human', user: 'other-dashboard' },
      type: 'build.pause-requested',
      payload: {},
    })

    const summary = await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })

    expect(summary.slugs).toEqual([])
    const events = await inner.getEvents('a-running')
    expect(countOf(events, 'build.pause-requested')).toBe(1)
    expect(events.at(-1)?.actor).toEqual({ kind: 'human', user: 'other-dashboard' })
    await inner.close()
  })

  test('a competing kernel acknowledgement stops the pause from landing', async () => {
    const paused = await makeStore({ 'a-running': 'pausing' })
    const pausedStore = withRacingAppend(paused, 'a-running', {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
    // Drop the pre-existing pause first so the ONLY thing making the build
    // ineligible on retry is the competitor's acknowledgement.
    await paused.append('a-running', {
      actor: { kind: 'human', user: 'someone-else' },
      type: 'build.resume-requested',
      payload: {},
    })
    await paused.append('a-running', { actor: KERNEL, type: 'build.resumed', payload: {} })
    expect(reduceBuild(await paused.getEvents('a-running')).status).toBe('running')

    const pausedSummary = await bulkControlRepository({
      store: pausedStore,
      repo: REPO,
      env: ENV,
      direction: 'pause',
    })
    expect(pausedSummary.slugs).toEqual([])
    expect(countOf(await paused.getEvents('a-running'), 'build.pause-requested')).toBe(1)
    await paused.close()

    const done = await makeStore({ 'a-running': 'running' })
    const doneStore = withRacingAppend(done, 'a-running', {
      actor: { kind: 'dispatcher' },
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const doneSummary = await bulkControlRepository({
      store: doneStore,
      repo: REPO,
      env: ENV,
      direction: 'pause',
    })
    expect(doneSummary.slugs).toEqual([])
    expect(countOf(await done.getEvents('a-running'), 'build.pause-requested')).toBe(0)
    await done.close()
  })

  test('an unrelated competing append retries and then succeeds', async () => {
    const inner = await makeStore({ 'a-running': 'running' })
    const store = withRacingAppend(inner, 'a-running', {
      actor: agentActor('implement', 'session-race'),
      type: 'observation.recorded',
      payload: {
        id: 'obs-race',
        kind: 'followup',
        summary: 'An unrelated fact landed mid-walk',
      },
    })

    const summary = await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })

    expect(summary.slugs).toEqual(['a-running'])
    const types = typesOf(await inner.getEvents('a-running'))
    expect(types.filter((type) => type === 'build.pause-requested')).toHaveLength(1)
    expect(types.slice(-2)).toEqual(['observation.recorded', 'build.pause-requested'])
    await inner.close()
  })

  test('a competing resume request leaves exactly one pending resume', async () => {
    const inner = await makeStore({ 'a-paused': 'paused' })
    const store = withRacingAppend(inner, 'a-paused', {
      actor: { kind: 'human', user: 'other-dashboard' },
      type: 'build.resume-requested',
      payload: {},
    })

    const summary = await bulkControlRepository({
      store,
      repo: REPO,
      env: ENV,
      direction: 'resume',
    })

    expect(summary.slugs).toEqual([])
    const state = reduceBuild(await inner.getEvents('a-paused'))
    expect(state.pendingCommands.filter((command) => command.command === 'resume')).toHaveLength(1)
    await inner.close()
  })
})

describe('bulkControlReport', () => {
  test('names the direction, the count, and the durable intake value', () => {
    expect(bulkControlReport({ direction: 'pause', slugs: ['a', 'b'], intake: false })).toBe(
      'pause all: pause requested for 2 builds; intake OFF',
    )
    expect(bulkControlReport({ direction: 'pause', slugs: ['a'], intake: false })).toBe(
      'pause all: pause requested for 1 build; intake OFF',
    )
    expect(bulkControlReport({ direction: 'pause', slugs: [], intake: false })).toBe(
      'pause all: no pausable builds; intake OFF',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: ['a', 'b'], intake: true })).toBe(
      'resume all: resume requested for 2 builds; intake ON',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: ['a'], intake: true })).toBe(
      'resume all: resume requested for 1 build; intake ON',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: [], intake: true })).toBe(
      'resume all: no paused builds; intake ON',
    )
  })
})
