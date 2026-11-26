import type { CurrentBuildFacts } from '../store/reduced-reads'
import type { BuildRecord } from '../store/types'
import type { CapacityBuild } from './dispatch-capacity'
import { landingRestackDue } from './engine'

/** One build's capacity facts from its saved `buildReadFacts` value: the one
 * constructor every status surface shares, so each reports slot state from
 * the facts it already read. */
export function capacityBuildFromFacts(
  record: BuildRecord,
  value: CurrentBuildFacts,
): Required<CapacityBuild> {
  return {
    record,
    state: value.state,
    workspace: value.workspace !== null,
    provisioning: value.provisionMarker !== undefined,
    restackDue: landingRestackDue(value.state, value.log),
  }
}
