/**
 * Pure event-log projections the dispatcher and janitor read, extracted from
 * `dispatcher.ts` so each is an incremental reducer (see
 * `kernel/incremental.ts`). The dispatcher's private helpers delegate here.
 */
import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { defineReducer } from '../kernel/incremental'

export type OpenBuildWorkspace = EventPayload<'workspace.provisioned'>

export const OPEN_BUILD_WORKSPACE_REDUCER_VERSION = 1

/** Latest `workspace.provisioned` not followed by a `workspace.released` —
 * the reducer deliberately ignores workspace events (liveness is the
 * dispatcher's concern), so the janitor scans the raw log. */
export const openBuildWorkspaceReducer = defineReducer<
  { open: OpenBuildWorkspace | null },
  AbEvent,
  OpenBuildWorkspace | null
>({
  version: OPEN_BUILD_WORKSPACE_REDUCER_VERSION,
  initial: () => ({ open: null }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'workspace.provisioned') acc.open = event.payload
      else if (event.type === 'workspace.released') acc.open = null
    }
  },
  finish: (acc) => (acc.open === null ? null : { ...acc.open }),
})

export function openBuildWorkspace(events: readonly AbEvent[]): OpenBuildWorkspace | null {
  return openBuildWorkspaceReducer.reduce(events)
}

export const BASE_BRANCH_REDUCER_VERSION = 1

/** The base branch recorded on the FIRST `build.created` in array order, or
 * undefined for logs missing one (callers fall back to the repo config). */
export const baseBranchReducer = defineReducer<
  { baseBranch?: string },
  AbEvent,
  string | undefined
>({
  version: BASE_BRANCH_REDUCER_VERSION,
  initial: () => ({}),
  fold(acc, events) {
    if (acc.baseBranch !== undefined) return
    for (const event of events) {
      if (event.type === 'build.created') {
        acc.baseBranch = event.payload.baseBranch
        return
      }
    }
  },
  finish: (acc) => acc.baseBranch,
})

export interface ProvisionMarker {
  provider: string
  branch: string
  generation: number
  ts: string
  seq: number
}

export const PROVISION_MARKER_REDUCER_VERSION = 1

/** The latest `workspace.provision-started` not yet followed by a
 * provisioned/released fact — an open provisioning marker. */
export const provisionMarkerReducer = defineReducer<
  { marker: ProvisionMarker | null },
  AbEvent,
  ProvisionMarker | undefined
>({
  version: PROVISION_MARKER_REDUCER_VERSION,
  initial: () => ({ marker: null }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'workspace.provision-started') {
        acc.marker = { ...event.payload, ts: event.ts, seq: event.seq }
      } else if (
        acc.marker !== null &&
        (event.type === 'workspace.provisioned' || event.type === 'workspace.released')
      ) {
        acc.marker = null
      }
    }
  },
  finish: (acc) => (acc.marker === null ? undefined : { ...acc.marker }),
})

export const RECOVERY_CHECKPOINT_REDUCER_VERSION = 1

/** The commit a recovered workspace is re-cut from: the latest settled
 * publication head, else the first provisioned base. */
export const recoveryCheckpointReducer = defineReducer<
  { settled?: string; original?: string },
  AbEvent,
  string | undefined
>({
  version: RECOVERY_CHECKPOINT_REDUCER_VERSION,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'workspace.provisioned' && acc.original === undefined) {
        acc.original = event.payload.base.sha
      } else if (event.type === 'implement.completed') {
        acc.settled = event.payload.commits.head
      } else if (event.type === 'reconcile.completed') {
        acc.settled = event.payload.mergeCommit
      } else if (
        event.type === 'finalize.step-completed' &&
        event.payload.ok &&
        event.payload.headSha !== undefined
      ) {
        acc.settled = event.payload.headSha
      }
    }
  },
  finish: (acc) => acc.settled ?? acc.original,
})
