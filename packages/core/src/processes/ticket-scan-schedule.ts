import type { RepositoryEvent } from '../events/repository'
import type { ScanCadence } from '../store/scan-cadence'

type ScanPayload = Extract<RepositoryEvent, { type: 'dispatcher.ticket-scan-completed' }>['payload']

export type ScanMeasurement = Pick<
  ScanPayload,
  'startedAt' | 'mode' | 'readinessFingerprint' | 'criteriaFingerprint'
>

export interface ScanScheduleInput {
  /** The recorded `dispatcher.ticket-scan-completed` fact, when the journal has one. */
  previous?: ScanMeasurement
  /** The journal sequence of `previous`. */
  previousSeq?: number
  mode: 'admission' | 'observation'
  readinessFingerprint: string
  criteriaFingerprint: string
  startedAt: string
  intervalMs: number
}

/**
 * Whether the journal measurement alone proves the scan is not due, so the
 * cadence row need not be read.
 *
 * Every cadence write without clock rollback is anchored: it acknowledges the
 * recorded measurement or a later one, never an earlier one. While less than
 * one interval has elapsed since the recorded measurement, with unchanged
 * fingerprints and no admission following an observation measurement, a
 * missing or invalid row falls back to the recorded fact, and a valid anchored
 * row is no older than it. Either way `ticketScanSchedule` would answer not
 * due, so this answer is exact.
 *
 * Clock regression is the one bounded exception, and it is decided design: a
 * row dated later than a rolled-back clock is consulted only once this window
 * ends, at most one interval after the recorded measurement. The clock
 * rollback rule then applies and the dispatcher rescans.
 */
export function ticketScanDeferredByJournal(input: ScanScheduleInput): boolean {
  const { previous } = input
  if (previous === undefined) return false
  if (previous.readinessFingerprint !== input.readinessFingerprint) return false
  if (previous.criteriaFingerprint !== input.criteriaFingerprint) return false
  if (input.mode === 'admission' && previous.mode === 'observation') return false
  const elapsed = Date.parse(input.startedAt) - Date.parse(previous.startedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < input.intervalMs
}

/** The full schedule decision, consulting the disposable cadence row. */
export function ticketScanSchedule(
  input: ScanScheduleInput,
  cached: ScanCadence | null,
): { due: boolean; allowClockRollback: boolean } {
  const { previous, startedAt, mode } = input
  // Outcomes always come from the reduction. This row only acknowledges their cadence.
  const valid =
    previous !== undefined &&
    cached !== null &&
    cached.scanSeq === input.previousSeq &&
    cached.mode === previous.mode &&
    cached.readinessFingerprint === previous.readinessFingerprint &&
    cached.criteriaFingerprint === previous.criteriaFingerprint &&
    Number.isFinite(Date.parse(cached.startedAt))
  const baseline = valid ? cached : previous
  const elapsed =
    baseline === undefined ? Infinity : Date.parse(startedAt) - Date.parse(baseline.startedAt)
  return {
    allowClockRollback: elapsed < 0,
    due:
      previous === undefined ||
      elapsed < 0 ||
      elapsed >= input.intervalMs ||
      previous.readinessFingerprint !== input.readinessFingerprint ||
      previous.criteriaFingerprint !== input.criteriaFingerprint ||
      (mode === 'admission' && previous.mode === 'observation'),
  }
}
