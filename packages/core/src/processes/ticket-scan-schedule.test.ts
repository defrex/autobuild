import { describe, expect, test } from 'bun:test'
import type { ScanCadence } from '../store/scan-cadence'
import {
  ticketScanDeferredByJournal,
  ticketScanSchedule,
  type ScanMeasurement,
  type ScanScheduleInput,
} from './ticket-scan-schedule'

const T0 = Date.parse('2026-11-07T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const previous: ScanMeasurement = {
  startedAt: iso(T0),
  mode: 'admission',
  readinessFingerprint: 'r',
  criteriaFingerprint: 'c',
}

function input(overrides: Partial<ScanScheduleInput> = {}): ScanScheduleInput {
  return {
    previous,
    previousSeq: 7,
    mode: 'admission',
    readinessFingerprint: 'r',
    criteriaFingerprint: 'c',
    startedAt: iso(T0),
    intervalMs: 60_000,
    ...overrides,
  }
}

describe('ticketScanDeferredByJournal', () => {
  test('defers inside the interval since the recorded measurement', () => {
    expect(ticketScanDeferredByJournal(input())).toBe(true)
    expect(ticketScanDeferredByJournal(input({ startedAt: iso(T0 + 59_999) }))).toBe(true)
  })

  test('does not defer at the interval or before the measurement', () => {
    expect(ticketScanDeferredByJournal(input({ startedAt: iso(T0 + 60_000) }))).toBe(false)
    expect(ticketScanDeferredByJournal(input({ startedAt: iso(T0 - 1) }))).toBe(false)
  })

  test('does not defer without a recorded fact or after a forced change', () => {
    expect(ticketScanDeferredByJournal(input({ previous: undefined }))).toBe(false)
    expect(ticketScanDeferredByJournal(input({ readinessFingerprint: 'r2' }))).toBe(false)
    expect(ticketScanDeferredByJournal(input({ criteriaFingerprint: 'c2' }))).toBe(false)
  })

  test('admission after an observation measurement is never deferred', () => {
    const observed = { ...previous, mode: 'observation' as const }
    expect(ticketScanDeferredByJournal(input({ previous: observed }))).toBe(false)
    expect(ticketScanDeferredByJournal(input({ previous: observed, mode: 'observation' }))).toBe(
      true,
    )
    expect(ticketScanDeferredByJournal(input({ mode: 'observation' }))).toBe(true)
  })

  test('an unparsable measurement is not deferred', () => {
    expect(
      ticketScanDeferredByJournal(input({ previous: { ...previous, startedAt: 'nope' } })),
    ).toBe(false)
  })
})

describe('journal deferral agrees with the full schedule', () => {
  const intervals = [1_000, 60_000, 120_000]
  const offsets = [0, 1, 500, 999, 1_000, 30_000, 59_999, 60_000, 119_999, 120_000, 300_000]
  const modes = ['admission', 'observation'] as const
  const cadences = (prev: ScanMeasurement, now: number): (ScanCadence | null)[] => {
    const anchor = Date.parse(prev.startedAt)
    const rows: (ScanCadence | null)[] = [null]
    for (const at of [anchor, anchor + Math.floor((now - anchor) / 2), now]) {
      if (at < anchor || at > now) continue
      const valid: ScanCadence = {
        scanSeq: 7,
        startedAt: iso(at),
        mode: prev.mode,
        readinessFingerprint: prev.readinessFingerprint,
        criteriaFingerprint: prev.criteriaFingerprint,
      }
      rows.push(
        valid,
        { ...valid, scanSeq: 8 },
        { ...valid, mode: prev.mode === 'admission' ? 'observation' : 'admission' },
        { ...valid, readinessFingerprint: 'other' },
        { ...valid, criteriaFingerprint: 'other' },
        { ...valid, startedAt: 'invalid' },
      )
    }
    return rows
  }

  test('deferral implies not due for every missing, invalid or anchored row', () => {
    let deferred = 0
    for (const intervalMs of intervals)
      for (const offset of offsets)
        for (const prevMode of modes)
          for (const mode of modes)
            for (const readinessFingerprint of ['r', 'r2'])
              for (const criteriaFingerprint of ['c', 'c2']) {
                const prev = { ...previous, mode: prevMode }
                const now = T0 + offset
                const scan = input({
                  previous: prev,
                  mode,
                  readinessFingerprint,
                  criteriaFingerprint,
                  startedAt: iso(now),
                  intervalMs,
                })
                const journal = ticketScanDeferredByJournal(scan)
                if (journal) deferred++
                for (const cached of cadences(prev, now)) {
                  const schedule = ticketScanSchedule(scan, cached)
                  if (journal) expect(schedule).toEqual({ due: false, allowClockRollback: false })
                }
                // Without a row the full schedule is the journal-only decision.
                expect(ticketScanSchedule(scan, null).due).toBe(!journal)
              }
    expect(deferred).toBeGreaterThan(0)
  })

  test('clock regression: a future-dated row is consulted only after the journal window', () => {
    // The clock rolled back below a row written earlier, but stays at or after the anchor.
    const future: ScanCadence = {
      scanSeq: 7,
      ...previous,
      startedAt: iso(T0 + 50_000),
    }
    const rolledBack = input({ startedAt: iso(T0 + 10_000) })
    expect(ticketScanDeferredByJournal(rolledBack)).toBe(true)
    expect(ticketScanSchedule(rolledBack, future)).toEqual({ due: true, allowClockRollback: true })

    // The deferral ends one interval after the recorded measurement.
    const windowEnd = input({ startedAt: iso(T0 + 60_000) })
    expect(ticketScanDeferredByJournal(windowEnd)).toBe(false)
    expect(ticketScanSchedule(windowEnd, { ...future, startedAt: iso(T0 + 90_000) })).toEqual({
      due: true,
      allowClockRollback: true,
    })
  })
})
