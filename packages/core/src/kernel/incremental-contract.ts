/**
 * Test support for the incremental reducer contract. Imported only by tests.
 */
import { expect } from 'bun:test'
import type { IncrementalReducer } from './incremental'

export interface CheckOptions<State> {
  /** Equality for the oracle comparison. Defaults to `toEqual`, which treats
   * `undefined` and missing keys alike (the JSON round trip needs that). */
  compare?: (actual: State, expected: State) => void
  /** Also fold one event at a time. Default true. */
  stepwise?: boolean
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Assert that for every split point `k`, advancing the accumulator of
 * `log[0..k]` with `log[k..]` equals reducing the whole log — in memory and
 * through a JSON round trip — and that `advance` never mutates its input. */
export function checkIncremental<Acc, Event, State>(
  reducer: IncrementalReducer<Acc, Event, State>,
  log: readonly Event[],
  options: CheckOptions<State> = {},
): void {
  const compare = options.compare ?? ((a, b) => expect(a).toEqual(b))
  const oracle = reducer.reduce(log)
  for (let k = 0; k <= log.length; k++) {
    const prefix = reducer.advance(reducer.initial(), log.slice(0, k))
    const before = structuredClone(prefix)
    const earlier = reducer.finish(prefix)
    const earlierSnapshot = structuredClone(earlier)
    const suffix = log.slice(k)

    const advanced = reducer.advance(prefix, suffix)
    expect(prefix).toEqual(before)
    compare(reducer.finish(advanced), oracle)
    // Advancing later must not disturb a state derived earlier.
    expect(earlier).toEqual(earlierSnapshot)

    const revived = reducer.advance(roundTrip(prefix), suffix)
    compare(reducer.finish(revived), oracle)
    // A serialized finished accumulator must also revive to the same state.
    compare(reducer.finish(roundTrip(advanced)), oracle)
  }
  if (options.stepwise ?? true) {
    let acc = reducer.initial()
    for (const event of log) acc = reducer.advance(acc, [event])
    compare(reducer.finish(acc), oracle)
  }
}

/** A small seeded PRNG (mulberry32) so generated logs reproduce from a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T
}

export function shuffled<T>(rand: () => number, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}
