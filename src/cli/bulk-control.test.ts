import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import type { EventType } from '../events/payloads'
import { reduceBuild } from '../kernel/reducer'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import { withFailingRepoAppend } from '../testing/store-failures'
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

async function pausedOf(store: BuildStore, repo = REPO): Promise<boolean> {
  return reduceDispatchSettings(await store.getRepoEvents(repo)).paused
}

/** The `dispatcher.*` types this action wrote, in journal order. */
async function settingTypesOf(store: BuildStore, repo = REPO): Promise<string[]> {
  return (await store.getRepoEvents(repo))
    .map((event) => event.type)
    .filter((type) => type.startsWith('dispatcher.'))
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
      paused: true,
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

  test('intake and the repository pause are absolute setters, not toggles', async () => {
    const store = await makeStore({ 'a-running': 'running' })

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(await intakeOf(store)).toBe(false)
    expect(await pausedOf(store)).toBe(true)

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(await intakeOf(store)).toBe(false)
    expect(await pausedOf(store)).toBe(true)

    const settings = await store.getRepoEvents(REPO)
    const intakeEvents = settings.filter((event) => event.type === 'dispatcher.intake-set')
    expect(intakeEvents).toHaveLength(2)
    expect(intakeEvents.every((event) => event.payload.enabled === false)).toBe(true)
    const pauseEvents = settings.filter((event) => event.type === 'dispatcher.pause-set')
    expect(pauseEvents).toHaveLength(2)
    expect(pauseEvents.every((event) => event.payload.enabled === true)).toBe(true)
    await store.close()
  })

  test('no pausable builds still writes the hold and turns intake off without erroring', async () => {
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
    expect(await pausedOf(empty)).toBe(true)
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
    // The queued build received no per-build request — it is held by the
    // repository fact instead, which is the only thing this action did for it.
    expect(await pausedOf(parked)).toBe(true)
    await parked.close()
  })

  test('a repository row no tick has created yet is ensured, not an error', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, 'a-running', 'running')
    expect(await store.getRepo(REPO)).toBeNull()

    const summary = await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(summary.slugs).toEqual(['a-running'])
    expect(await intakeOf(store)).toBe(false)
    expect(await pausedOf(store)).toBe(true)
    await store.close()
  })
})

describe('bulkControlRepository — repository write order', () => {
  test('the pause fact is written before intake, in both directions', async () => {
    const store = await makeStore({ 'a-running': 'running' })

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' })
    expect(await settingTypesOf(store)).toEqual(['dispatcher.pause-set', 'dispatcher.intake-set'])

    await bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'resume' })
    expect(await settingTypesOf(store)).toEqual([
      'dispatcher.pause-set',
      'dispatcher.intake-set',
      'dispatcher.pause-set',
      'dispatcher.intake-set',
    ])
    await store.close()
  })

  test('a failed intake write still leaves the repository durably held', async () => {
    const inner = await makeStore({ 'a-queued': 'queued', 'b-running': 'running' })
    const store = withFailingRepoAppend(inner, 'dispatcher.intake-set')

    await expect(
      bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' }),
    ).rejects.toThrow(/dispatcher.intake-set/)

    // The surviving prefix is the safe half: queued work is held even though
    // the operator's intake value never landed.
    expect(await pausedOf(inner)).toBe(true)
    expect(await intakeOf(inner)).toBe(true) // never written; still the default
    await inner.close()
  })

  test('a failed intake write on resume still releases the hold', async () => {
    const inner = await makeStore({ 'a-paused': 'paused' })
    await bulkControlRepository({ store: inner, repo: REPO, env: ENV, direction: 'pause' })
    const store = withFailingRepoAppend(inner, 'dispatcher.intake-set')

    await expect(
      bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'resume' }),
    ).rejects.toThrow(/dispatcher.intake-set/)

    // Held work is released as asked; intake stays OFF, the conservative half.
    expect(await pausedOf(inner)).toBe(false)
    expect(await intakeOf(inner)).toBe(false)
    await inner.close()
  })

  test('a failed first write claims nothing at all', async () => {
    const inner = await makeStore({ 'a-running': 'running' })
    const store = withFailingRepoAppend(inner, 'dispatcher.pause-set')

    await expect(
      bulkControlRepository({ store, repo: REPO, env: ENV, direction: 'pause' }),
    ).rejects.toThrow(/dispatcher.pause-set/)

    expect(await inner.getRepoEvents(REPO)).toEqual([])
    expect(typesOf(await inner.getEvents('a-running'))).not.toContain('build.pause-requested')
    await inner.close()
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

    expect(summary).toEqual({
      direction: 'resume',
      slugs: ['a-paused'],
      paused: false,
      intake: true,
    })
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

    expect(await settingTypesOf(store)).toEqual(['dispatcher.pause-set', 'dispatcher.intake-set'])
    expect(await intakeOf(store)).toBe(true)
    expect(await pausedOf(store)).toBe(false)

    // Another repository sharing the store is untouched by this one's controls.
    await store.ensureRepo(OTHER_REPO)
    expect(await store.getRepoEvents(OTHER_REPO)).toEqual([])
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
  test('names the direction, the count, the hold, and the durable intake value', () => {
    const paused = { paused: true, intake: false } as const
    const resumed = { paused: false, intake: true } as const
    expect(bulkControlReport({ direction: 'pause', slugs: ['a', 'b'], ...paused })).toBe(
      'pause all: pause requested for 2 builds; queued builds held; intake OFF',
    )
    expect(bulkControlReport({ direction: 'pause', slugs: ['a'], ...paused })).toBe(
      'pause all: pause requested for 1 build; queued builds held; intake OFF',
    )
    expect(bulkControlReport({ direction: 'pause', slugs: [], ...paused })).toBe(
      'pause all: no pausable builds; queued builds held; intake OFF',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: ['a', 'b'], ...resumed })).toBe(
      'resume all: resume requested for 2 builds; queued builds released; intake ON',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: ['a'], ...resumed })).toBe(
      'resume all: resume requested for 1 build; queued builds released; intake ON',
    )
    expect(bulkControlReport({ direction: 'resume', slugs: [], ...resumed })).toBe(
      'resume all: no paused builds; queued builds released; intake ON',
    )
  })
})
