/** Optimization measurement lines and the noise check's default attention. */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { BUILD_ATTENTION_EVENTS, summarizeEvent } from './watch'

const sha = 'abcdef0123456789abcdef0123456789abcdef01'
const event = (build: string, type: string, payload: unknown) =>
  ({ build, seq: 3, ts: '2026-11-18T00:00:00.000Z', actor: KERNEL, type, payload }) as AbEvent

test('the noise check is default attention; measurements are not', () => {
  expect(BUILD_ATTENTION_EVENTS).toContain('optimization.noise-exceeded')
  expect(BUILD_ATTENTION_EVENTS as readonly string[]).not.toContain(
    'optimization.baseline-measured',
  )
  expect(BUILD_ATTENTION_EVENTS as readonly string[]).not.toContain('attempt.measured')
})

test('the noise line names both numbers and the remedy', () => {
  const noise = {
    revision: 1,
    head: sha,
    harnessPin: sha,
    median: 50,
    spread: 2,
    epsilon: { relative: 0.03 },
    effectiveEpsilon: 1.5,
  }
  expect(summarizeEvent(event('search', 'optimization.noise-exceeded', noise), null)).toBe(
    'Noise exceeds ε on search: starting spread 2 > ε 1.5 (relative 0.03 of median 50); the node continues — raise target.epsilon or metric.samples',
  )
  expect(
    summarizeEvent(
      event('search', 'optimization.noise-exceeded', {
        ...noise,
        epsilon: { absolute: 1 },
        effectiveEpsilon: 1,
      }),
      null,
    ),
  ).toContain('starting spread 2 > ε 1 (absolute)')
})

test('a starting measurement reports its value and noise', () => {
  expect(
    summarizeEvent(
      event('search', 'optimization.baseline-measured', {
        revision: 1,
        head: sha,
        harnessPin: sha,
        samples: 5,
        median: 50,
        spread: 0.4,
      }),
      null,
    ),
  ).toBe('starting value 50, noise spread 0.4 (5 samples per side, harness abcdef0)')
})

test('every attempt delta carries the noise spread beside it', () => {
  const measured = {
    request: 'm1',
    candidate: sha,
    baseline: sha,
    harnessPin: sha,
    revision: 1,
    samples: 5,
    medians: { candidate: 44, baseline: 50 },
    delta: 6,
    decision: 'improved',
    spread: 0.4,
  }
  expect(summarizeEvent(event('attempt', 'attempt.measured', measured), null)).toBe(
    'candidate 44 vs baseline 50: delta 6 (noise ±0.4) → improved',
  )
  const { spread: _spread, ...older } = measured
  expect(summarizeEvent(event('attempt', 'attempt.measured', older), null)).toBe(
    'candidate 44 vs baseline 50: delta 6 → improved',
  )
})
