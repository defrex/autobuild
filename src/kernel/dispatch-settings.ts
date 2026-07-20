/**
 * Pure projection of repository-scoped dispatcher controls. The journal is
 * authoritative; fresh repositories retain the historical process defaults.
 */
import type { RepositoryEvent } from '../events/repository'

export const DEFAULT_DISPATCH_INTAKE = true
export const DEFAULT_DISPATCH_AUTO_MERGE = false

export interface DispatchSettings {
  intake: boolean
  defaultAutoMerge: boolean
}

export function reduceDispatchSettings(
  events: RepositoryEvent[],
): DispatchSettings {
  let intake = DEFAULT_DISPATCH_INTAKE
  let defaultAutoMerge = DEFAULT_DISPATCH_AUTO_MERGE
  let intakeSeq = 0
  let autoMergeSeq = 0

  for (const event of events) {
    switch (event.type) {
      case 'dispatcher.intake-set':
        if (event.seq > intakeSeq) {
          intake = event.payload.enabled
          intakeSeq = event.seq
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

  return { intake, defaultAutoMerge }
}
