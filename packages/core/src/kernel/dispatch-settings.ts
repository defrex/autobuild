/**
 * Pure projection of repository-scoped dispatcher controls — the intake gate,
 * the repository-wide pause, and the claim-time auto-merge default. The journal
 * is authoritative; fresh repositories retain the historical process defaults.
 */
import type { RepositoryEvent } from '../events/repository'
import { defineReducer, type IncrementalReducer } from './incremental'

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

/** The carried accumulator: the settings plus the seq of the fact that set
 * each, which decides last-writer-wins independent of array order. */
export interface DispatchSettingsAcc extends DispatchSettings {
  intakeSeq: number
  pausedSeq: number
  autoMergeSeq: number
}

/** Bump when `DispatchSettingsAcc`'s shape or fold semantics change. */
export const DISPATCH_SETTINGS_REDUCER_VERSION = 1

function foldDispatchSettings(acc: DispatchSettingsAcc, events: readonly RepositoryEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'dispatcher.intake-set':
        if (event.seq > acc.intakeSeq) {
          acc.intake = event.payload.enabled
          acc.intakeSeq = event.seq
        }
        break
      case 'dispatcher.pause-set':
        if (event.seq > acc.pausedSeq) {
          acc.paused = event.payload.enabled
          acc.pausedSeq = event.seq
        }
        break
      case 'dispatcher.auto-merge-default-set':
        if (event.seq > acc.autoMergeSeq) {
          acc.defaultAutoMerge = event.payload.enabled
          acc.autoMergeSeq = event.seq
        }
        break
      default:
        // Harvest facts share this journal and have no dispatcher-setting
        // meaning. Each setting is reduced independently.
        break
    }
  }
}

export const dispatchSettingsReducer: IncrementalReducer<
  DispatchSettingsAcc,
  RepositoryEvent,
  DispatchSettings
> = defineReducer({
  version: DISPATCH_SETTINGS_REDUCER_VERSION,
  initial: () => ({
    intake: DEFAULT_DISPATCH_INTAKE,
    paused: DEFAULT_DISPATCH_PAUSED,
    defaultAutoMerge: DEFAULT_DISPATCH_AUTO_MERGE,
    intakeSeq: 0,
    pausedSeq: 0,
    autoMergeSeq: 0,
  }),
  fold: foldDispatchSettings,
  finish: ({ intake, paused, defaultAutoMerge }) => ({ intake, paused, defaultAutoMerge }),
})

export function reduceDispatchSettings(events: RepositoryEvent[]): DispatchSettings {
  return dispatchSettingsReducer.reduce(events)
}
