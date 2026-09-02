/**
 * Pure projection of repository-scoped dispatcher controls — the intake gate,
 * the repository-wide pause, and the claim-time auto-merge default. The journal
 * is authoritative; fresh repositories retain the historical process defaults.
 */
import type { RepositoryEvent } from '../events/repository'

export const DEFAULT_DISPATCH_INTAKE = true
export const DEFAULT_DISPATCH_PAUSED = false
export const DEFAULT_DISPATCH_AUTO_MERGE = false

export interface DispatchSettings {
  intake: boolean
  /**
   * Repository-wide quiescence: while true, no queued build may be given a
   * runner. Distinct from the per-build pause (a build-log fact with its own
   * reducer precedence) and from `HarvestState.paused` (the observation
   * workflow's own gate, which this does not govern).
   */
  paused: boolean
  defaultAutoMerge: boolean
}

export function reduceDispatchSettings(events: RepositoryEvent[]): DispatchSettings {
  let intake = DEFAULT_DISPATCH_INTAKE
  let paused = DEFAULT_DISPATCH_PAUSED
  let defaultAutoMerge = DEFAULT_DISPATCH_AUTO_MERGE
  let intakeSeq = 0
  let pausedSeq = 0
  let autoMergeSeq = 0

  for (const event of events) {
    switch (event.type) {
      case 'dispatcher.intake-set':
        if (event.seq > intakeSeq) {
          intake = event.payload.enabled
          intakeSeq = event.seq
        }
        break
      case 'dispatcher.pause-set':
        if (event.seq > pausedSeq) {
          paused = event.payload.enabled
          pausedSeq = event.seq
        }
        break
      case 'dispatcher.auto-merge-default-set':
        if (event.seq > autoMergeSeq) {
          defaultAutoMerge = event.payload.enabled
          autoMergeSeq = event.seq
        }
        break
      default:
        // Harvest facts share this journal and have no dispatcher-setting
        // meaning. Each setting is reduced independently.
        break
    }
  }

  return { intake, paused, defaultAutoMerge }
}
