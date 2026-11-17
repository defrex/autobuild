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
import {
  HOOK_FAILING_ATTENTION_MS,
  HOOK_QUEUE_LIMIT,
  HookSupervisor,
  readHookProgress,
  type HookInvokeResult,
} from './hooks'

export const REPO = '/main/repo'
const STORE_REF = 'memory://hooks'

export const flush = async (rounds = 50): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function newStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.ensureRepo(REPO)
  return store
}

export async function escalate(store: BuildStore, slug: string, id = 'esc_1'): Promise<void> {
  await store.append(slug, {
    actor: agentActor('implement', 's_1'),
    type: 'escalation.raised',
    payload: { id, phase: 'implement', round: 1, source: 'agent', question: `Question ${id}?` },
  })
}

export async function attach(store: BuildStore, slug: string): Promise<void> {
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
}

/** Create a build the way ticket preparation does: announced in the journal. */
export async function announceBuild(
  store: BuildStore,
  slug: string,
  attempt: string,
  between?: () => Promise<void>,
): Promise<void> {
  const ticket = { source: 'file', id: `T-${attempt}`, title: `Ticket ${attempt}` }
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: { attempt, ticket, readyState: 'ready', claimedState: 'claimed' },
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.creation-selected',
    payload: { attempt, ticket, slug },
  })
  await store.createBuild({ slug, repo: REPO })
  await attach(store, slug)
  await between?.()
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'ticket-preparation.resolved',
    payload: { attempt, ticket, outcome: 'owned' },
  })
}

export async function complete(store: BuildStore, slug: string): Promise<void> {
  await store.append(slug, {
    actor: KERNEL,
    type: 'build.aborted',
    payload: {},
  })
}

export interface Harness {
  store: BuildStore
  clock: ReturnType<typeof manualClock>
  supervisor: HookSupervisor
  delivered: { hook: string; line: string }[]
  backoffs: number[]
  warnings: string[]
  /** One gate interval: read the change position, wake feeds, settle. */
  pulse: () => Promise<void>
  /** Script the next outcomes per hook; default success. */
  outcomes: Map<string, (line: string) => HookInvokeResult | Promise<HookInvokeResult>>
}

export function harness(store: BuildStore, opts: { clock?: ReturnType<typeof manualClock> } = {}) {
  const clock = opts.clock ?? manualClock()
  const delivered: { hook: string; line: string }[] = []
  const backoffs: number[] = []
  const warnings: string[] = []
  const outcomes = new Map<string, (line: string) => HookInvokeResult | Promise<HookInvokeResult>>()
  const supervisor = new HookSupervisor({
    store,
    repo: REPO,
    storeRef: STORE_REF,
    checkout: REPO,
    clock,
    invoke: async (hook, line, signal) => {
      const outcome = outcomes.get(hook.name)
      const result = outcome ? await outcome(line) : { ok: true as const }
      if (!signal.aborted) delivered.push({ hook: hook.name, line })
      return result
    },
    warn: (line) => warnings.push(line),
    appendRepo: (event: RepositoryEventWrite) => store.appendRepo(REPO, event),
    intervalMs: 1000,
    // The gate never fires on its own; tests pulse it explicitly.
    interval: (signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    backoff: async (ms) => {
      backoffs.push(ms)
      clock.advance(ms)
    },
  })
  const pulse = async (): Promise<void> => {
    await flush()
    await supervisor.pulse()
    await flush()
  }
  const h: Harness = { store, clock, supervisor, delivered, backoffs, warnings, pulse, outcomes }
  return h
}

export const lines = (h: Harness, hook: string) =>
  h.delivered.filter((d) => d.hook === hook).map((d) => JSON.parse(d.line))

const NOTIFY: HookConfig = { command: 'true', timeoutSeconds: 30 }

/** The JSON lines `ab watch --json` prints from `since` with the same filter. */
async function watchLines(
  store: BuildStore,
  since: string,
  events?: readonly string[],
): Promise<unknown[]> {
  const out: string[] = []
  let ticks = 0
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
    timeout: '0',
    delay: async (_ms, signal) => {
      ticks += 1
      if (ticks > 1) (signal as AbortSignal & { abortNow?: () => void }).abortNow?.()
    },
    count: 1_000,
  }).catch(() => {})
  return out.map((line) => JSON.parse(line))
}

describe('hook delivery', () => {
  test('a new hook baselines without history, then delivers matching records in order', async () => {
    const store = await newStore()
    await store.createBuild({ slug: 'old', repo: REPO })
    await escalate(store, 'old', 'esc_old')
    const h = harness(store)
    await h.supervisor.reconcile({ notify: NOTIFY })
    await h.pulse()
    expect(h.delivered).toEqual([])
    const baseline = await readHookProgress(store, REPO, 'notify')
    expect(baseline?.delivered).toBe(0)

    await escalate(store, 'old', 'esc_2')
    await announceBuild(store, 'fresh', 'a1')
    await escalate(store, 'fresh', 'esc_3')
    await h.pulse()
    await h.pulse()
    const records = lines(h, 'notify')
    expect(records.map((r) => r.id)).toEqual(['build:old:2', 'build:fresh:2'])
    expect(records.map((r) => r.event.payload.id)).toEqual(['esc_2', 'esc_3'])
    const progress = await readHookProgress(store, REPO, 'notify')
    expect(progress?.delivered).toBe(2)
    expect(progress?.lastDeliveredId).toBe('build:fresh:2')
    expect(progress?.pending).toBe(0)
    await h.supervisor.stop()
  })
})
