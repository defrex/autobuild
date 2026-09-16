/**
 * Unit tests for the shared polling subscribe's two cadences (AUT-334): the
 * unchanged interval loop when no `waitSeconds` is given, and long-poll mode
 * when it is — one held request at a time, request starts spaced at least
 * `pollMs` apart, delivery in order and exactly once per subscription.
 */
import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { agentActor } from '../events/envelope'
import { MemoryBuildStore } from './memory'
import { pollingSubscribe, type SubscribeRead } from './subscribe'

function makeStore(): MemoryBuildStore {
  return new MemoryBuildStore()
}

async function appendObservation(store: MemoryBuildStore, slug: string, summary: string) {
  return store.append(slug, {
    actor: agentActor('implement', 's_1'),
    type: 'observation.recorded',
    payload: { id: `o_${summary}`, kind: 'followup', summary },
  })
}

describe('pollingSubscribe interval mode (no waitSeconds)', () => {
  test('delivers appended events in order, each exactly once', async () => {
    const store = makeStore()
    await store.createBuild({ slug: 's', repo: 'r' })
    const received: number[] = []
    const unsubscribe = pollingSubscribe(
      (since) => store.getEvents('s', since),
      { pollMs: 10 },
      (event) => received.push(event.seq),
    )
    await appendObservation(store, 's', 'one')
    await Bun.sleep(50)
    await appendObservation(store, 's', 'two')
    await Bun.sleep(50)
    unsubscribe()
    expect(received).toEqual([1, 2])
  })
})

describe('pollingSubscribe bounded-wait mode', () => {
  test('delivers an event appended during the held read, without waiting the gap', async () => {
    const store = makeStore()
    await store.createBuild({ slug: 's', repo: 'r' })
    const reads: (number | undefined)[] = []
    const getEvents: SubscribeRead = async (since, opts) => {
      reads.push(since)
      if (reads.length === 1) {
        // The append "lands" while the request is held; a real server
        // answers as soon as it does.
        await appendObservation(store, 's', 'wake')
      }
      return store.getEvents('s', since, opts)
    }
    const received: number[] = []
    const unsubscribe = pollingSubscribe(
      getEvents,
      { pollMs: 60_000, waitSeconds: 5 },
      (event: AbEvent) => received.push(event.seq),
    )
    await Bun.sleep(100)
    unsubscribe()
    expect(received).toEqual([1])
  })

  test('request starts are spaced at least pollMs apart when the server answers early', async () => {
    const store = makeStore()
    await store.createBuild({ slug: 's', repo: 'r' })
    const starts: number[] = []
    const getEvents: SubscribeRead = async (since) => {
      // Monotonic clock: Date.now() is wall time and can slew mid-test,
      // measuring an honest gap as short.
      starts.push(performance.now())
      // An early-answering (wait-ignoring) server: no hold at all.
      return store.getEvents('s', since)
    }
    const unsubscribe = pollingSubscribe(getEvents, { pollMs: 100, waitSeconds: 1 }, () => {})
    await Bun.sleep(350)
    unsubscribe()
    expect(starts.length).toBeGreaterThanOrEqual(3)
    // Bun.sleep can wake a millisecond or two early under load (observed
    // 98–99 ms gaps on an honest pollMs cadence), so the pin allows a few
    // milliseconds of measurement slack around the pollMs spacing.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(95)
    }
  })

  test('unsubscribe aborts the in-flight held read immediately', async () => {
    const signals: AbortSignal[] = []
    let settledAt: number | undefined
    const getEvents: SubscribeRead = (_since, opts) => {
      const signal = opts?.signal
      if (signal === undefined) {
        // A bounded-wait read without a signal could never be torn down.
        throw new Error('bounded-wait reads must carry an abort signal')
      }
      signals.push(signal)
      // A held read that resolves only when cancelled — the abort IS the
      // answer. An un-aborted unsubscribe would hang until the test times
      // out; prompt settling is the assertion.
      return new Promise<never>((_, reject) => {
        const abort = (): void => {
          settledAt = Date.now()
          reject(signal.reason)
        }
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    const unsubscribe = pollingSubscribe(getEvents, { pollMs: 60_000, waitSeconds: 25 }, () => {})
    await Bun.sleep(50)
    expect(signals.length).toBe(1)
    expect(signals[0]!.aborted).toBe(false)
    const started = Date.now()
    unsubscribe()
    await Bun.sleep(50)
    expect(settledAt).toBeDefined()
    expect(settledAt! - started).toBeLessThan(1_000)
  })

  test('a failing read is retried after the gap and delivery stays exactly once', async () => {
    const store = makeStore()
    await store.createBuild({ slug: 's', repo: 'r' })
    let calls = 0
    const getEvents: SubscribeRead = async (since, opts) => {
      calls += 1
      if (calls === 1) throw new Error('unreachable')
      if (calls === 2) await appendObservation(store, 's', 'after-retry')
      return store.getEvents('s', since, opts)
    }
    const received: number[] = []
    const unsubscribe = pollingSubscribe(
      getEvents,
      { pollMs: 30, waitSeconds: 5 },
      (event: AbEvent) => received.push(event.seq),
    )
    await Bun.sleep(200)
    unsubscribe()
    expect(received).toEqual([1])
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
