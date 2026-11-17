/**
 * Configured hook delivery over MemoryBuildStore: the change gate, feed and
 * worker are driven deterministically through injected gate, backoff, clock
 * and invoke seams — no subprocess, no real sleeps.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { MemoryBuildStore } from '../store/memory'
import { manualClock, steppingClock } from '../testing/fixed'
import type { BuildStore } from '../store/types'
import type { HookConfig } from '../config/schema'
import { abWatch, decodeCursor } from '../cli/watch'
import { creationBuildSlug } from '../kernel/build-creation'
import { CursorTooOldError } from '../store/event-reads'
import { hookProgressKind } from '../store/retention'
import {
  HOOK_CHECKPOINT_INTERVAL_MS,
  HOOK_FAILING_ATTENTION_MS,
  HOOK_QUEUE_LIMIT,
  HookSupervisor,
  readHookProgress,
  type HookInvokeResult,
} from './hooks'

const REPO = '/main/repo'
const STORE_REF = '/main/store'
const NOTIFY: HookConfig = { command: 'true', timeoutSeconds: 30 }

const flush = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function newStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo(REPO)
  return store
}

async function escalate(store: BuildStore, slug: string, id = 'esc_1'): Promise<void> {
  await store.append(slug, {
    actor: agentActor('implement', 's_1'),
    type: 'escalation.raised',
    payload: { id, phase: 'implement', round: 1, source: 'agent', question: `Question ${id}?` },
  })
}

async function attach(store: BuildStore, slug: string): Promise<void> {
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
}

/** Abort and clean up: a settled terminal build. */
async function abort(store: BuildStore, slug: string): Promise<void> {
  await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'abandoned' },
  })
}

const ticketOf = (attempt: string) => ({ source: 'file', id: `T-${attempt}` })

async function selectCreation(
  store: BuildStore,
  attempt: string,
  slug: string,
  creationKey?: string,
): Promise<void> {
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: { attempt, ticket: ticketOf(attempt), readyState: 'ready', claimedState: 'claimed' },
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.creation-selected',
    payload: {
      attempt,
      ticket: ticketOf(attempt),
      slug,
      ...(creationKey ? { creationKey } : {}),
    },
  })
}

async function resolveOwned(store: BuildStore, attempt: string): Promise<void> {
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.resolved',
    payload: { attempt, ticket: ticketOf(attempt), outcome: 'owned' },
  })
}

/** Create a build the way ticket preparation does: announced in the journal. */
async function announceBuild(
  store: BuildStore,
  slug: string,
  attempt: string,
  between?: () => Promise<void>,
): Promise<void> {
  await selectCreation(store, attempt, slug)
  await store.createBuild({ slug, repo: REPO })
  await attach(store, slug)
  await between?.()
  await resolveOwned(store, attempt)
}

async function handBack(store: BuildStore, attempt: string): Promise<void> {
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket.handed-back',
    payload: {
      ticket: ticketOf(attempt),
      attempt,
      cause: 'preparation-failed',
      state: 'Backlog',
      role: 'triage',
    },
  })
}

/** A build that reaches merge consent readiness at `landing.decided`. */
async function seedConsentCandidate(store: BuildStore, slug: string): Promise<void> {
  await store.createBuild({ slug, repo: REPO, branch: `preview/${slug}` })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner', host: 'host' },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'local',
      ref: 'local',
      branch: `preview/${slug}`,
      base: { source: 'local', sha: 'base', remoteError: 'offline' },
    },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: 'head' } },
  })
}

async function decideConsent(store: BuildStore, slug: string): Promise<void> {
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'landing.decided',
    payload: {
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
      candidate: { head: 'head', parent: 'base', cycle: '3' },
    },
  })
}

type Outcome = (line: string) => HookInvokeResult | Promise<HookInvokeResult>

interface Harness {
  supervisor: HookSupervisor
  /** Completed attempts (success or failure), in order. */
  attempts: { hook: string; line: string; ok: boolean }[]
  backoffs: number[]
  warnings: string[]
  outcomes: Map<string, Outcome>
  maxInFlight: () => number
  /** One gate interval: read the change position, wake feeds, settle. */
  pulse: () => Promise<void>
}

function harness(
  store: BuildStore,
  clock: ReturnType<typeof manualClock> = manualClock(),
  opts: { advanceOnBackoff?: boolean } = {},
): Harness {
  const attempts: Harness['attempts'] = []
  const backoffs: number[] = []
  const warnings: string[] = []
  const outcomes = new Map<string, Outcome>()
  let inFlight = 0
  let maxInFlight = 0
  const supervisor = new HookSupervisor({
    store,
    repo: REPO,
    storeRef: STORE_REF,
    checkout: REPO,
    clock,
    invoke: async (hook, line, signal) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        const outcome = outcomes.get(hook.name)
        const result = outcome
          ? await Promise.race([
              Promise.resolve(outcome(line)),
              new Promise<HookInvokeResult>((resolve) =>
                signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' }), {
                  once: true,
                }),
              ),
            ])
          : { ok: true as const }
        if (!signal.aborted) attempts.push({ hook: hook.name, line, ok: result.ok })
        return result
      } finally {
        inFlight -= 1
      }
    },
    warn: (line) => warnings.push(line),
    appendRepo: (event: RepositoryEventWrite) => store.appendRepo(REPO, event),
    intervalMs: 1000,
    // The gate never fires on its own; tests pulse it explicitly.
    interval: (signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    backoff: async (ms) => {
      backoffs.push(ms)
      if (opts.advanceOnBackoff !== false) clock.advance(ms)
    },
  })
  return {
    supervisor,
    attempts,
    backoffs,
    warnings,
    outcomes,
    maxInFlight: () => maxInFlight,
    pulse: async () => {
      await flush()
      await supervisor.pulse()
      await flush()
    },
  }
}

const delivered = (h: Harness, hook: string) =>
  h.attempts.filter((a) => a.hook === hook && a.ok).map((a) => JSON.parse(a.line))
const ids = (h: Harness, hook: string): string[] => delivered(h, hook).map((r) => r.id)
const withoutCursor = ({ cursor: _cursor, ...rest }: Record<string, unknown>) => rest

async function progressOf(store: BuildStore, hook = 'notify') {
  const progress = await readHookProgress(store, REPO, hook)
  if (progress === undefined) throw new Error(`no progress for ${hook}`)
  return progress
}

function positionStreams(position: string): Record<string, number> {
  return decodeCursor(position, { store: STORE_REF, repo: REPO }).streams
}

async function repoEvents(store: BuildStore, type: string) {
  return (await store.getRepoEvents(REPO)).filter((event) => event.type === type)
}

/** The records `ab watch --json` prints from `since` with the same filter. */
async function watchRecords(
  store: BuildStore,
  since: string,
  events?: readonly string[],
): Promise<Record<string, unknown>[]> {
  const out: string[] = []
  const clock = manualClock()
  await abWatch({
    targetRepo: REPO,
    env: {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    stdout: (line) => out.push(line),
    stderr: () => {},
    openStore: () => store,
    storeRef: STORE_REF,
    since,
    ...(events ? { events } : {}),
    json: true,
    timeout: '1',
    now: clock,
    delay: async () => clock.advance(1000),
  })
  return out.map((line) => JSON.parse(line)).filter((record) => record.id !== undefined)
}

/** Counts store calls and optionally runs a mutation once, right after a call. */
function countingStore(
  store: BuildStore,
  inject?: { after: string; once: () => Promise<void> },
): { store: BuildStore; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  let pending = inject
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const name = String(property)
        calls[name] = (calls[name] ?? 0) + 1
        const result = await (value as (...a: unknown[]) => unknown).apply(target, args)
        const key =
          name === 'getReducerValue' ? `${name}:${(args[1] as { reducer: string }).reducer}` : name
        if (pending !== undefined && pending.after === key) {
          const run = pending.once
          pending = undefined
          await run()
        }
        return result
      }
    },
  }) as BuildStore
  return { store: wrapped, calls }
}

/** A store whose `method` throws `error()` once, then behaves normally. */
function failingOnce(store: BuildStore, method: string, error: () => Error): BuildStore {
  let fail = true
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        if (property === method && fail) {
          fail = false
          throw error()
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as BuildStore
}

describe('configured hooks', () => {
  test('a new hook baselines without history, then delivers matching records in order', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'old', repo: REPO })
    await escalate(store, 'old', 'esc_old')
    await announceBuild(store, 'done-before', 'a0')
    await escalate(store, 'done-before', 'esc_done')
    await abort(store, 'done-before')
    const h = harness(store)
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    expect(h.attempts).toEqual([])
    expect((await progressOf(store)).delivered).toBe(0)

    await escalate(store, 'old', 'esc_2')
    await announceBuild(store, 'fresh', 'a1')
    await escalate(store, 'fresh', 'esc_3')
    await h.pulse()
    await h.pulse()
    expect(ids(h, 'notify')).toEqual(['build:old:2', 'build:fresh:2'])
    expect(h.maxInFlight()).toBe(1)
    const progress = await progressOf(store)
    expect(progress).toMatchObject({ delivered: 2, lastDeliveredId: 'build:fresh:2', pending: 0 })
    expect(progress.failing).toBeUndefined()
    await h.supervisor.stop()
  })

  test('each record is the ab watch --json record for the same event, filter and position', async () => {
    const store = await newStore()
    await seedConsentCandidate(store, 'ready')
    const h = harness(store)
    const routine: HookConfig = { ...NOTIFY, events: ['runner.*', 'ticket.*'] }
    await h.supervisor.reconcile({ notify: NOTIFY, routine })
    await h.pulse()
    const since = {
      notify: (await progressOf(store, 'notify')).position,
      routine: (await progressOf(store, 'routine')).position,
    }
    await decideConsent(store, 'ready')
    await escalate(store, 'ready')
    await handBack(store, 'h1')
    await attach(store, 'ready')
    await h.pulse()
    await h.pulse()

    const notify = delivered(h, 'notify')
    expect(notify.map((r) => r.id)).toEqual([
      'build.consent-ready:["consent","ready",4]',
      'build:ready:5',
      `repo:${(await repoEvents(store, 'ticket.handed-back'))[0]!.seq}`,
    ])
    expect(notify[0].observation.type).toBe('build.consent-ready')
    expect(notify[1].event.type).toBe('escalation.raised')
    expect(notify[2].event.type).toBe('ticket.handed-back')
    expect(notify.map(withoutCursor)).toEqual(
      (await watchRecords(store, since.notify)).map(withoutCursor),
    )
    const routineRecords = delivered(h, 'routine')
    // Within a pass, build streams are read before the repository journal.
    expect(routineRecords.map((r) => r.event.type)).toEqual([
      'runner.attached',
      'ticket.handed-back',
    ])
    expect(routineRecords.map(withoutCursor)).toEqual(
      (await watchRecords(store, since.routine, routine.events)).map(withoutCursor),
    )
    // Every record's cursor is a valid resume position.
    for (const record of [...notify, ...routineRecords])
      expect(() => decodeCursor(record.cursor, { store: STORE_REF, repo: REPO })).not.toThrow()
    await h.supervisor.stop()
  })

  test('the default filter is the watch attention set and filtered events still advance', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const clock = manualClock()
    const h = harness(store, clock)
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    const before = await progressOf(store)
    for (let i = 0; i < 5; i++) await attach(store, 'b')
    await h.pulse()
    expect(h.attempts).toEqual([])
    // Nothing matched; the safe checkpoint waits for its interval.
    expect((await progressOf(store)).position).toBe(before.position)
    clock.advance(HOOK_CHECKPOINT_INTERVAL_MS)
    await attach(store, 'b')
    await h.pulse()
    expect(positionStreams((await progressOf(store)).position).b).toBe(6)
    await h.supervisor.stop()
  })

  test('a hook that never answers delays neither another hook nor the gate', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const h = harness(store)
    h.outcomes.set('stuck', () => new Promise<HookInvokeResult>(() => {}))
    await h.supervisor.reconcile({ stuck: NOTIFY, notify: NOTIFY })
    await h.pulse()
    await escalate(store, 'b', 'e1')
    await h.pulse()
    await escalate(store, 'b', 'e2')
    await h.pulse()
    expect(ids(h, 'notify')).toEqual(['build:b:1', 'build:b:2'])
    expect(ids(h, 'stuck')).toEqual([])
    expect((await progressOf(store, 'stuck')).pending).toBe(1)
    await h.supervisor.stop()
  })

  test('failures retry with increasing delay, redeliver the same id, and report once after five minutes', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const clock = manualClock()
    const h = harness(store, clock)
    let failures = 0
    let release: (() => void) | undefined
    h.outcomes.set('notify', async () => {
      // The eleventh failure lands 1+2+4+8+16+32+60+60+60+60 s > 5 min in.
      if (failures < 11) {
        failures += 1
        return { ok: false, error: 'exit status 1: boom' }
      }
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ok: true }
    })
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    await escalate(store, 'b')
    await h.pulse()
    expect(h.backoffs).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000,
    ])
    const attempts = h.attempts.filter((a) => a.hook === 'notify')
    expect(new Set(attempts.map((a) => JSON.parse(a.line).id))).toEqual(new Set(['build:b:1']))
    const failing = await repoEvents(store, 'hook.failing')
    expect(failing).toHaveLength(1)
    expect(failing[0]!.payload).toMatchObject({
      hook: 'notify',
      record: 'build:b:1',
      error: 'exit status 1: boom',
    })
    expect((await progressOf(store)).failing).toMatchObject({ reported: true })
    expect(h.warnings.filter((w) => w.includes('delivery of build:b:1 failed'))).toHaveLength(1)
    const before = (await progressOf(store)).position
    release?.()
    await h.pulse()
    const recovered = await repoEvents(store, 'hook.recovered')
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.payload).toMatchObject({ hook: 'notify', attempts: 11 })
    expect((await progressOf(store)).failing).toBeUndefined()
    // Both events reach a default-filter watch.
    const watched = await watchRecords(store, before)
    expect(watched.map((r) => (r.event as { type: string }).type)).toEqual([
      'escalation.raised',
      'hook.failing',
      'hook.recovered',
    ])
    await h.supervisor.stop()
  })

  test('a short failure records neither failing nor recovered', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const h = harness(store)
    let failed = false
    h.outcomes.set('notify', () => {
      if (failed) return { ok: true }
      failed = true
      return { ok: false, error: 'timed out after 30s' }
    })
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    await escalate(store, 'b')
    await h.pulse()
    expect(ids(h, 'notify')).toEqual(['build:b:1'])
    expect(await repoEvents(store, 'hook.failing')).toEqual([])
    expect(await repoEvents(store, 'hook.recovered')).toEqual([])
    await h.supervisor.stop()
  })

  test('a fresh supervisor resumes after the last success and redelivers only the in-flight record', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const first = harness(store)
    let calls = 0
    first.outcomes.set('notify', () => {
      calls += 1
      return calls === 1 ? { ok: true } : new Promise<HookInvokeResult>(() => {})
    })
    await first.supervisor.reconcile({ notify: NOTIFY })
    await first.pulse()
    await escalate(store, 'b', 'e1')
    await escalate(store, 'b', 'e2')
    await escalate(store, 'b', 'e3')
    await first.pulse()
    expect(ids(first, 'notify')).toEqual(['build:b:1'])
    // A crash: the first process is abandoned with build:b:2 in flight.
    const second = harness(store)
    await second.supervisor.reconcile({ notify: NOTIFY })
    await second.pulse()
    expect(ids(second, 'notify')).toEqual(['build:b:2', 'build:b:3'])
    await second.supervisor.stop()
  })

  test('a graceful stop and a successor (hot-upgrade handoff) neither skip nor repeat', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const first = harness(store)
    await first.supervisor.reconcile({ notify: NOTIFY })
    await first.pulse()
    await escalate(store, 'b', 'e1')
    await first.pulse()
    await first.supervisor.stop()
    await escalate(store, 'b', 'e2')
    await announceBuild(store, 'during', 'a1')
    await escalate(store, 'during', 'e3')
    const successor = harness(store)
    await successor.supervisor.reconcile({ notify: NOTIFY })
    await successor.pulse()
    expect([...ids(first, 'notify'), ...ids(successor, 'notify')]).toEqual([
      'build:b:1',
      'build:b:2',
      'build:during:2',
    ])
    await successor.supervisor.stop()
  })

  test('reload: an added hook starts at its baseline, a removed one stops, a changed one resumes', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const h = harness(store)
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    await escalate(store, 'b', 'e1')
    await h.pulse()
    await h.supervisor.reconcile({ notify: NOTIFY, added: NOTIFY })
    await h.pulse()
    expect(ids(h, 'added')).toEqual([])
    await escalate(store, 'b', 'e2')
    await h.pulse()
    expect(ids(h, 'added')).toEqual(['build:b:2'])
    await h.supervisor.reconcile({ notify: { ...NOTIFY, events: ['escalation.*', 'runner.*'] } })
    expect(h.supervisor.names).toEqual(['notify'])
    await escalate(store, 'b', 'e3')
    await attach(store, 'b')
    await h.pulse()
    await h.pulse()
    expect(ids(h, 'notify')).toEqual(['build:b:1', 'build:b:2', 'build:b:3', 'build:b:4'])
    expect(ids(h, 'added')).toEqual(['build:b:2'])
    await h.supervisor.stop()
  })

  describe('discovery', () => {
    test('a build created, escalated and finished between two passes is delivered, then retires', async () => {
      const store = await newStore()
      const h = harness(store)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await announceBuild(store, 'quick', 'a1', async () => {
        await escalate(store, 'quick')
        await abort(store, 'quick')
      })
      await h.pulse()
      await h.pulse()
      expect(ids(h, 'notify')).toEqual(['build:quick:2'])
      await h.supervisor.stop()
      expect(positionStreams((await progressOf(store)).position)).not.toHaveProperty('quick')
    })

    test('a build whose whole lifecycle happens while the dispatcher is stopped is delivered', async () => {
      const store = await newStore()
      const first = harness(store)
      await first.supervisor.reconcile({ notify: NOTIFY })
      await first.pulse()
      await first.supervisor.stop()
      await announceBuild(store, 'gap', 'a1', async () => {
        await escalate(store, 'gap')
        await abort(store, 'gap')
      })
      const counted = countingStore(store)
      const second = harness(counted.store)
      await second.supervisor.reconcile({ notify: NOTIFY })
      await second.pulse()
      expect(ids(second, 'notify')).toEqual(['build:gap:2'])
      expect(counted.calls.listBuilds ?? 0).toBe(0)
      expect(counted.calls.listBuildsForRepo ?? 0).toBe(0)
      expect(counted.calls.getRepoBuildDigests ?? 0).toBe(0)
      await second.supervisor.stop()
    })

    test('a selection before the durable position resolves through the persisted preparing map', async () => {
      const store = await newStore()
      const first = harness(store)
      await first.supervisor.reconcile({ notify: NOTIFY })
      await first.pulse()
      await selectCreation(store, 'a1', 'later')
      await first.pulse()
      await first.supervisor.stop()
      const position = (await progressOf(store)).position
      expect(decodeCursor(position, { store: STORE_REF, repo: REPO }).preparing).toEqual({
        a1: { slug: 'later' },
      })
      await store.createBuild({ slug: 'later', repo: REPO })
      await escalate(store, 'later')
      await resolveOwned(store, 'a1')
      const second = harness(store)
      await second.supervisor.reconcile({ notify: NOTIFY })
      await second.pulse()
      expect(ids(second, 'notify')).toEqual(['build:later:1'])
      await second.supervisor.stop()
    })

    test('a keyed store resolves the canonical slug through the creation key', async () => {
      const store = await newStore()
      const h = harness(store)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      const canonical = creationBuildSlug(REPO, 'keyed', 'a1')
      await selectCreation(store, 'a1', 'keyed', 'a1')
      await store.createBuild({ slug: canonical, repo: REPO })
      await escalate(store, canonical)
      await resolveOwned(store, 'a1')
      await h.pulse()
      expect(ids(h, 'notify')).toEqual([`build:${canonical}:1`])
      await h.supervisor.stop()
    })

    test('an announcement that resolves to no build is reported, never dropped silently', async () => {
      const store = await newStore()
      const h = harness(store)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await selectCreation(store, 'a1', 'missing')
      await resolveOwned(store, 'a1')
      await h.pulse()
      const skipped = await repoEvents(store, 'hook.skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]!.payload).toEqual({
        hook: 'notify',
        reason: 'build announced by attempt a1 could not be resolved to one build',
        ranges: [],
      })
      // The report itself is repository attention and is delivered.
      await h.pulse()
      expect(ids(h, 'notify')).toEqual([`repo:${skipped[0]!.seq}`])
      await h.supervisor.stop()
    })

    test('builds that existed before the baseline deliver nothing from before it', async () => {
      const store = await newStore()
      await announceBuild(store, 'finished', 'a0', async () => {
        await escalate(store, 'finished')
        await abort(store, 'finished')
      })
      await store.createBuild({ slug: 'active', repo: REPO })
      await escalate(store, 'active')
      const h = harness(store)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await h.pulse()
      expect(h.attempts).toEqual([])
      await h.supervisor.stop()
    })
  })

  test('unretrievable history rebaselines and reports the skipped range', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const first = harness(store)
    await first.supervisor.reconcile({ notify: NOTIFY })
    await first.pulse()
    await first.supervisor.stop()
    const old = (await progressOf(store)).position
    await handBack(store, 'h1')
    const wrapped = failingOnce(
      store,
      'getStreamSeed',
      () => new CursorTooOldError({ kind: 'repo', repo: REPO }, 1, 1_000_000),
    )
    const second = harness(wrapped)
    await second.supervisor.reconcile({ notify: NOTIFY })
    await second.pulse()
    const skipped = await repoEvents(store, 'hook.skipped')
    expect(skipped).toHaveLength(1)
    const handedBack = (await repoEvents(store, 'ticket.handed-back'))[0]!.seq
    expect(skipped[0]!.payload).toMatchObject({
      hook: 'notify',
      ranges: [{ stream: '#repo', after: positionStreams(old)['#repo'], through: handedBack }],
    })
    expect((skipped[0]!.payload as { reason: string }).reason.length).toBeGreaterThan(0)
    await second.pulse()
    expect(ids(second, 'notify')).toEqual([`repo:${skipped[0]!.seq}`])
    await second.supervisor.stop()
  })

  describe('safe checkpoints', () => {
    test('filtered-out progress persists within the interval and at stop, never while idle', async () => {
      const store = await newStore()
      await store.createBuild({ slug: 'b', repo: REPO })
      const clock = manualClock()
      const h = harness(store, clock)
      await h.supervisor.reconcile({ notify: { ...NOTIFY, events: ['pr.merged'] } })
      await h.pulse()
      const writes = async () =>
        (await store.listRepoArtifacts(REPO, hookProgressKind('notify'))).length
      const baselineWrites = await writes()
      for (let i = 0; i < 3; i++) await attach(store, 'b')
      await h.pulse()
      expect(await writes()).toBe(baselineWrites)
      clock.advance(HOOK_CHECKPOINT_INTERVAL_MS)
      await attach(store, 'b')
      await h.pulse()
      expect(await writes()).toBe(baselineWrites + 1)
      expect(positionStreams((await progressOf(store)).position).b).toBe(4)
      // Idle: no writes however long.
      clock.advance(10 * HOOK_CHECKPOINT_INTERVAL_MS)
      await h.pulse()
      await h.pulse()
      expect(await writes()).toBe(baselineWrites + 1)
      await attach(store, 'b')
      await h.pulse()
      await h.supervisor.stop()
      expect(positionStreams((await progressOf(store)).position).b).toBe(5)
    })

    test('no checkpoint passes an in-flight record; the success persists the newer safe candidate', async () => {
      const store = await newStore()
      await store.createBuild({ slug: 'b', repo: REPO })
      const clock = manualClock()
      const h = harness(store, clock)
      let release: ((result: HookInvokeResult) => void) | undefined
      h.outcomes.set(
        'notify',
        () =>
          new Promise<HookInvokeResult>((resolve) => {
            release = resolve
          }),
      )
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await escalate(store, 'b')
      await h.pulse()
      await attach(store, 'b')
      await attach(store, 'b')
      clock.advance(HOOK_CHECKPOINT_INTERVAL_MS)
      await h.pulse()
      expect(positionStreams((await progressOf(store)).position).b).toBe(0)
      release?.({ ok: true })
      await flush()
      expect(positionStreams((await progressOf(store)).position).b).toBe(3)
      await h.supervisor.stop()
    })

    test('a stop with a failed record in the queue does not advance past it', async () => {
      const store = await newStore()
      await store.createBuild({ slug: 'b', repo: REPO })
      const h = harness(store, manualClock(), { advanceOnBackoff: false })
      let calls = 0
      h.outcomes.set('notify', () => {
        calls += 1
        return calls === 1
          ? { ok: false, error: 'exit status 2' }
          : new Promise<HookInvokeResult>(() => {})
      })
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await escalate(store, 'b')
      await attach(store, 'b')
      await h.pulse()
      await h.supervisor.stop()
      expect(positionStreams((await progressOf(store)).position).b).toBe(0)
      const next = harness(store)
      await next.supervisor.reconcile({ notify: NOTIFY })
      await next.pulse()
      expect(ids(next, 'notify')).toEqual(['build:b:1'])
      await next.supervisor.stop()
    })
  })

  describe('first initialization', () => {
    test('preparations in flight across the baseline deliver from seq 0, in both orders', async () => {
      for (const createBeforeSample of [false, true]) {
        const store = await newStore()
        await selectCreation(store, 'a1', 'racing')
        if (createBeforeSample) await store.createBuild({ slug: 'racing', repo: REPO })
        const h = harness(store)
        await h.supervisor.reconcile({ notify: NOTIFY })
        await h.pulse()
        if (!createBeforeSample) await store.createBuild({ slug: 'racing', repo: REPO })
        await escalate(store, 'racing')
        await resolveOwned(store, 'a1')
        await h.pulse()
        expect(ids(h, 'notify')).toEqual(['build:racing:1'])
        expect(await repoEvents(store, 'hook.skipped')).toEqual([])
        await h.supervisor.stop()
      }
    })

    test.each(['P0', 'J0', 'D', 'A', 'G'] as const)(
      'a build announced and finished right after the %s read is delivered from seq 0 when its resolution follows the load boundary',
      async (point) => {
        const store = await newStore()
        await selectCreation(store, 'a1', 'interleaved')
        const counted = countingStore(store, {
          after: {
            P0: 'getReducerValue:repositoryReadFacts',
            J0: 'getRepoHighWater',
            D: 'getRepoBuildDigests',
            A: 'getReducerValue:repositoryAttention',
            G: 'getRepoEvents',
          }[point],
          once: async () => {
            await store.createBuild({ slug: 'interleaved', repo: REPO })
            await escalate(store, 'interleaved')
            await abort(store, 'interleaved')
            await resolveOwned(store, 'a1')
          },
        })
        const h = harness(counted.store)
        await h.supervisor.reconcile({ notify: NOTIFY })
        await h.pulse()
        await h.pulse()
        // Resolved before the high-water read (`J0`), the build settled
        // before the population sample: pre-load history.
        expect(ids(h, 'notify')).toEqual(point === 'P0' ? [] : ['build:interleaved:1'])
        expect(await repoEvents(store, 'hook.skipped')).toEqual([])
        await h.supervisor.stop()
        expect(positionStreams((await progressOf(store)).position)).not.toHaveProperty(
          'interleaved',
        )
      },
    )

    test('a block entirely before the baseline is history', async () => {
      const store = await newStore()
      await announceBuild(store, 'history', 'a1', async () => {
        await escalate(store, 'history')
        await abort(store, 'history')
      })
      const h = harness(store)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      await h.pulse()
      expect(h.attempts).toEqual([])
      await h.supervisor.stop()
    })

    test.each(['crash', 'failed-stop', 'partial'] as const)(
      'the pre-emission baseline survives a %s first delivery',
      async (variant) => {
        const store = await newStore()
        await selectCreation(store, 'a1', 'early')
        const counted = countingStore(store, {
          after: 'getRepoHighWater',
          once: async () => {
            await seedConsentCandidate(store, 'early')
            await decideConsent(store, 'early')
            await escalate(store, 'early', 'e1')
            await escalate(store, 'early', 'e2')
            await resolveOwned(store, 'a1')
          },
        })
        const first = harness(counted.store, manualClock(), { advanceOnBackoff: false })
        let calls = 0
        first.outcomes.set('notify', () => {
          calls += 1
          if (variant === 'failed-stop' && calls === 1) return { ok: false, error: 'exit status 1' }
          if (variant === 'partial' && calls === 1) return { ok: true }
          return new Promise<HookInvokeResult>(() => {})
        })
        await first.supervisor.reconcile({ notify: NOTIFY })
        await first.pulse()
        if (variant === 'failed-stop') await first.supervisor.stop()
        const saved = await progressOf(store)
        const cursor = decodeCursor(saved.position, { store: STORE_REF, repo: REPO })
        if (variant === 'partial') {
          expect(cursor.streams.early).toBe(4)
          expect(cursor.deliveredAttention).toEqual([JSON.stringify(['consent', 'early', 4])])
        } else {
          expect(cursor.streams.early).toBe(0)
          expect(cursor.deliveredAttention).toEqual([])
        }
        const second = harness(store)
        await second.supervisor.reconcile({ notify: NOTIFY })
        await second.pulse()
        const expected = [
          'build.consent-ready:["consent","early",4]',
          'build:early:5',
          'build:early:6',
        ]
        expect(ids(second, 'notify')).toEqual(variant === 'partial' ? expected.slice(1) : expected)
        if (variant === 'partial') expect(ids(first, 'notify')).toEqual(expected.slice(0, 1))
        expect(await repoEvents(store, 'hook.skipped')).toEqual([])
        await second.supervisor.stop()
      },
    )

    test('a failed baseline write emits nothing and is retried', async () => {
      const store = await newStore()
      await store.createBuild({ slug: 'b', repo: REPO })
      const wrapped = failingOnce(store, 'putRepoArtifact', () => new Error('store unavailable'))
      const h = harness(wrapped)
      await h.supervisor.reconcile({ notify: NOTIFY })
      await h.pulse()
      expect(h.warnings.some((w) => w.includes('store unavailable'))).toBe(true)
      expect(await readHookProgress(store, REPO, 'notify')).toBeDefined()
      await escalate(store, 'b')
      await h.pulse()
      expect(ids(h, 'notify')).toEqual(['build:b:1'])
      await h.supervisor.stop()
    })
  })

  test('backpressure bounds the queue and still delivers every record in order', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const h = harness(store)
    let gate: (() => void) | undefined
    let held = true
    h.outcomes.set('notify', async () => {
      if (held)
        await new Promise<void>((resolve) => {
          gate = resolve
        })
      return { ok: true }
    })
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    const total = HOOK_QUEUE_LIMIT + 120
    for (let i = 0; i < total; i++) await escalate(store, 'b', `e${i}`)
    await h.pulse()
    await h.pulse()
    expect((await progressOf(store)).pending).toBeLessThanOrEqual(HOOK_QUEUE_LIMIT)
    held = false
    gate?.()
    for (let i = 0; i < 5; i++) await h.pulse()
    expect(ids(h, 'notify')).toEqual(Array.from({ length: total }, (_, i) => `build:b:${i + 1}`))
    await h.supervisor.stop()
  })

  test('drainOnce delivers until the first failure and persists the failure', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'b', repo: REPO })
    const clock = manualClock()
    await harness(store, clock).supervisor.drainOnce({ notify: NOTIFY })
    await escalate(store, 'b', 'e1')
    await escalate(store, 'b', 'e2')
    const second = harness(store, clock)
    let calls = 0
    second.outcomes.set('notify', () => {
      calls += 1
      return calls === 1 ? { ok: true } : { ok: false, error: 'exit status 9' }
    })
    await second.supervisor.drainOnce({ notify: NOTIFY })
    expect(ids(second, 'notify')).toEqual(['build:b:1'])
    expect(second.backoffs).toEqual([])
    expect((await progressOf(store)).failing).toMatchObject({
      attempts: 1,
      error: 'exit status 9',
      reported: false,
    })
    clock.advance(HOOK_FAILING_ATTENTION_MS)
    const third = harness(store, clock)
    third.outcomes.set('notify', () => ({ ok: false, error: 'exit status 9' }))
    await third.supervisor.drainOnce({ notify: NOTIFY })
    expect(await repoEvents(store, 'hook.failing')).toHaveLength(1)
    const fourth = harness(store, clock)
    await fourth.supervisor.drainOnce({ notify: NOTIFY })
    const failingSeq = (await repoEvents(store, 'hook.failing'))[0]!.seq
    // The failing report is itself attention, delivered after the stuck record.
    expect(ids(fourth, 'notify').slice(0, 2)).toEqual(['build:b:2', `repo:${failingSeq}`])
    expect(await repoEvents(store, 'hook.recovered')).toHaveLength(1)
  })
})

test('hook delivery read cost does not grow with history, builds or deliveries', async () => {
  const { hookReadBudget } = await import('../testing/reduced-read-budget')
  await hookReadBudget()
}, 120_000)
