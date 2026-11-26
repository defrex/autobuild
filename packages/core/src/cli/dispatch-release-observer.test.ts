import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { upgradeGenerationRun, upgradeGenerationWrites } from '../testing/upgrade-generations'
import {
  RELEASE_OBSERVATION_FAST_LIMIT,
  RELEASE_OBSERVATION_FAST_MS,
  RELEASE_OBSERVATION_IDLE_MS,
  observeSuccessorRelease,
  releaseObservationCadence,
} from './dispatch-release-observer'

// The schedule itself and the per-step read cost are proven by the
// release-observation read budget in testing/dispatch-read-budget.ts.

test('a pause never undercuts the last observation, inside or after the fast window', () => {
  const cadence = releaseObservationCadence()
  expect(cadence(3_000)).toBe(3_000)
  for (let i = 1; i < RELEASE_OBSERVATION_FAST_LIMIT; i++) cadence(0)
  expect(cadence(3_000)).toBe(3_000)
  expect(cadence(Number.NaN)).toBe(100)
  expect(cadence(-5)).toBe(200)
  expect(cadence(Number.POSITIVE_INFINITY)).toBe(400)
  for (let i = 0; i < 1_000; i++) expect(cadence(0)).toBe(RELEASE_OBSERVATION_IDLE_MS)
  expect(cadence(3_000)).toBe(3_000)
  expect(RELEASE_OBSERVATION_FAST_MS).toBeLessThanOrEqual(50)
})

test('one observation reports the request, release and stop facts of the predecessor', async () => {
  const store = new MemoryBuildStore()
  const repo = '/release-observer'
  await store.ensureRepo(repo)
  const run = upgradeGenerationRun(0)
  const writes = upgradeGenerationWrites(0)
  for (const write of writes.slice(0, 5)) await store.appendRepo(repo, write)
  let reads = 0
  const counted = {
    getReducerValue: ((scope, request) => {
      reads++
      return store.getReducerValue(scope, request)
    }) as typeof store.getReducerValue,
  }
  const waiting = await observeSuccessorRelease(counted, repo, run)
  expect(reads).toBe(2)
  expect(waiting.current?.request?.payload.correlation).toBe(`c-${run}`)
  expect(waiting.current?.released).toBeUndefined()
  expect(waiting.facts.stop).toBeUndefined()
  for (const write of writes.slice(5, 7)) await store.appendRepo(repo, write)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run, outcome: 'normal' },
  })
  const released = await observeSuccessorRelease(store, repo, run)
  expect(released.current?.released?.payload.correlation).toBe(`c-${run}`)
  expect(released.facts.stop?.type).toBe('dispatcher.run-stopped')
})
