import { expect, test } from 'bun:test'
import type { UpgradeRun } from '../kernel/dispatch-upgrade'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { upgradeGenerationRun, upgradeGenerationWrites } from '../testing/upgrade-generations'
import {
  YIELD_OBSERVATION_INTERVAL_MS,
  classifyYieldObservation,
  observeYield,
  watchForYieldRequest,
  type YieldObservation,
} from './dispatch-yield-observer'

const fact = (payload: Record<string, unknown>) => ({ payload }) as never
const run = (facts: Partial<Record<keyof UpgradeRun, unknown>>): UpgradeRun =>
  ({ outstanding: {}, drained: 0, suspended: 0, ...facts }) as UpgradeRun
const prepared = fact({ correlation: 'c1', lineage: 'L' })

test('classifies durable upgrade state for one armed preparation', () => {
  const cases: Array<[string, UpgradeRun | undefined, YieldObservation]> = [
    ['no run', undefined, 'settled'],
    ['prepared, no request', run({ prepared }), 'waiting'],
    [
      'matching request',
      run({ prepared, request: fact({ correlation: 'c1', lineage: 'L' }) }),
      'requested',
    ],
    [
      'other lineage',
      run({ prepared, request: fact({ correlation: 'c1', lineage: 'X' }) }),
      'settled',
    ],
    [
      'other correlation',
      run({ prepared, request: fact({ correlation: 'c2', lineage: 'L' }) }),
      'settled',
    ],
    ['failure', run({ prepared, failure: fact({ correlation: 'c1' }) }), 'settled'],
    ['committed handoff', run({ prepared, handoff: fact({ correlation: 'c1' }) }), 'requested'],
    ['superseded preparation', run({ prepared: fact({ correlation: 'c2' }) }), 'settled'],
    ['completed', run({ prepared, completed: fact({ correlation: 'c1' }) }), 'settled'],
  ]
  for (const [name, state, expected] of cases)
    expect({ name, got: classifyYieldObservation(state, 'c1', 'L') }).toEqual({
      name,
      got: expected,
    })
})

test('observes the real reduced upgrade value with one read', async () => {
  const store = new MemoryBuildStore({ clock: manualClock() })
  const repo = '/yield-observer'
  await store.ensureRepo(repo)
  const writes = upgradeGenerationWrites(0)
  const owner = upgradeGenerationRun(0)
  const observe = () => observeYield(store, repo, owner, `c-${owner}`, 'launcher')
  for (const write of writes.slice(0, 4)) await store.appendRepo(repo, write)
  expect(await observe()).toBe('waiting')
  await store.appendRepo(repo, writes[4]!)
  expect(await observe()).toBe('requested')
  await store.close()
})

function harness(steps: Array<YieldObservation | Error>, onSleep?: () => void) {
  const sleeps: number[] = []
  let reads = 0
  let accepts = 0
  return {
    sleeps,
    reads: () => reads,
    accepts: () => accepts,
    opts: {
      observe: async () => {
        const step = steps[reads++] ?? 'waiting'
        if (step instanceof Error) throw step
        return step
      },
      accept: async () => {
        accepts++
      },
      sleep: async (ms: number) => {
        sleeps.push(ms)
        onSleep?.()
      },
    },
  }
}

test('accepts once after waiting and retries failed reads at the cadence', async () => {
  const h = harness(['waiting', new Error('read'), 'waiting', 'requested', 'requested'])
  const result = await watchForYieldRequest({ ...h.opts, signal: new AbortController().signal })
  expect(result).toBe('accepted')
  expect(h.accepts()).toBe(1)
  expect(h.reads()).toBe(4)
  expect(h.sleeps).toEqual(Array(4).fill(YIELD_OBSERVATION_INTERVAL_MS))
})

test('a failed acceptance is left to the ordinary tick', async () => {
  const h = harness(['requested'])
  let accepts = 0
  const result = await watchForYieldRequest({
    ...h.opts,
    accept: async () => {
      accepts++
      throw new Error('lease lapsed')
    },
    signal: new AbortController().signal,
  })
  expect({ result, accepts, reads: h.reads() }).toEqual({
    result: 'accepted',
    accepts: 1,
    reads: 1,
  })
})

test('settles, exhausts and stops without accepting', async () => {
  const settled = harness(['waiting', 'settled'])
  expect(
    await watchForYieldRequest({ ...settled.opts, signal: new AbortController().signal }),
  ).toBe('settled')
  expect(settled.accepts()).toBe(0)

  const exhausted = harness([])
  expect(
    await watchForYieldRequest({
      ...exhausted.opts,
      signal: new AbortController().signal,
      limit: 7,
    }),
  ).toBe('exhausted')
  expect(exhausted.reads()).toBe(7)

  const aborted = new AbortController()
  aborted.abort()
  const stopped = harness(['requested'])
  expect(await watchForYieldRequest({ ...stopped.opts, signal: aborted.signal })).toBe('stopped')
  expect(stopped.reads()).toBe(0)
})

test('cancellation during a sleep reads nothing more', async () => {
  const stop = new AbortController()
  let sleeps = 0
  const h = harness(['waiting', 'waiting', 'requested'], () => {
    if (++sleeps === 2) stop.abort()
  })
  expect(await watchForYieldRequest({ ...h.opts, signal: stop.signal })).toBe('stopped')
  expect({ reads: h.reads(), accepts: h.accepts() }).toEqual({ reads: 1, accepts: 0 })
})
