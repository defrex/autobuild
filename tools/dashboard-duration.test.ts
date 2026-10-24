import { expect, test } from 'bun:test'
import { formatDuration } from '../packages/core/src/cli/dashboard/render'
import { durationText, stepNote } from '../packages/hosted-store-service/app/dashboard/frame'

test('terminal and web durations agree at every unit and hour-digit boundary', () => {
  const cases = [
    [38_000, '38s'],
    [252_000, '4m12s'],
    [3_599_000, '59m59s'],
    [3_600_000, '1h00m00s'],
    [3_847_999, '1h04m07s'],
    [35_999_000, '9h59m59s'],
    [36_000_000, '10h00m00s'],
    [43_389_000, '12h03m09s'],
  ] as const
  for (const [ms, expected] of cases) {
    expect(formatDuration(ms)).toBe(expected)
    expect(durationText(ms)).toBe(expected)
  }
})

test('web compact and detail notes tick long cumulative steps and freeze closed intervals', () => {
  const step = {
    label: 'implement',
    state: 'current' as const,
    count: 3,
    qualifier: 'waiting' as const,
    timing: { accumulatedMs: 3_840_000, runningSince: 1_000_000 },
  }
  for (const [now, duration] of [
    [1_009_000, '1h04m09s'],
    [1_010_000, '1h04m10s'],
  ] as const) {
    expect(stepNote(step, now, 'row')).toBe(`(waiting, ${duration}/3)`)
    expect(stepNote(step, now, 'detail')).toBe(`(waiting, round 3, ${duration})`)
  }
  for (const state of ['current', 'done'] as const) {
    const frozen = { ...step, state, label: 'verify:unit', timing: { accumulatedMs: 3_847_000 } }
    for (const now of [1, 9_000_000]) {
      expect(stepNote(frozen, now, 'row')).toBe('(waiting, 1h04m07s/3)')
      expect(stepNote(frozen, now, 'detail')).toBe('(waiting, attempt 3, 1h04m07s)')
    }
  }
})
