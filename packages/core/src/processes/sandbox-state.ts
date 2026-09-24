/**
 * Durable operator-sandbox state (AUT-340): the repository-journal projection
 * the sandbox service, the dispatcher's idle-settlement stage, and the
 * repository status projection read instead of process memory. The lifecycle
 * facts (`orchestrator.sandbox.provisioned`/`resumed`/`activity`/`stopped`/
 * `released`/`reset`) bracket one environment per operator × repository.
 * Every helper here is a pure function over the journal, mirroring the
 * harvest execution settlement, so any dispatcher invocation can settle an
 * orphaned environment.
 */
import type { RepositoryEvent } from '../events/repository'

export type SandboxEnvironmentState = 'live' | 'stopped' | 'released'

export interface SandboxEnvironmentSnapshot {
  operator: string
  environmentId: string
  provider: string
  state: SandboxEnvironmentState
  /** Journal timestamp of the latest lifecycle/activity fact for this
   * environment — the evidence the idle settlement compares against
   * `[orchestrator].sandbox.idleMinutes`. */
  lastEvidenceTs: string
  sessionId?: string
  /** The base branch head the fresh provision selected; carried forward
   * through later lifecycle facts (the base head cannot change without a
   * fresh provision, which overwrites it) — the publication precondition's
   * reference point, read by the publish operation. Absent on snapshots
   * provisioned before this field existed. */
  baseSha?: string
}

type MutableSnapshot = {
  operator: string
  environmentId: string
  provider: string
  state: SandboxEnvironmentState
  lastEvidenceTs: string
  sessionId?: string
  baseSha?: string
}

/** Per-environment sandbox state, keyed deterministically by
 * `environmentId` (one environment per operator × repository, and the id is
 * derived from both). Latest fact wins; `released` environments stay in the
 * result with their closing evidence so callers can distinguish them. */
export function sandboxStates(events: readonly RepositoryEvent[]): SandboxEnvironmentSnapshot[] {
  const byEnvironment = new Map<string, MutableSnapshot>()
  for (const event of events) {
    const ts = event.ts
    if (event.type === 'orchestrator.sandbox.provisioned') {
      byEnvironment.set(event.payload.environmentId, {
        operator: event.payload.operator,
        environmentId: event.payload.environmentId,
        provider: event.payload.provider,
        state: 'live',
        lastEvidenceTs: ts,
        ...(event.payload.sessionId !== undefined ? { sessionId: event.payload.sessionId } : {}),
        ...(event.payload.baseSha !== undefined ? { baseSha: event.payload.baseSha } : {}),
      })
    } else if (event.type === 'orchestrator.sandbox.resumed') {
      const previous = byEnvironment.get(event.payload.environmentId)
      byEnvironment.set(event.payload.environmentId, {
        operator: event.payload.operator,
        environmentId: event.payload.environmentId,
        provider: event.payload.provider,
        state: 'live',
        lastEvidenceTs: ts,
        ...(event.payload.sessionId !== undefined
          ? { sessionId: event.payload.sessionId }
          : previous?.sessionId !== undefined
            ? { sessionId: previous.sessionId }
            : {}),
        ...(previous?.baseSha !== undefined ? { baseSha: previous.baseSha } : {}),
      })
    } else if (event.type === 'orchestrator.sandbox.activity') {
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined && current.lastEvidenceTs <= ts) {
        current.lastEvidenceTs = ts
      }
    } else if (event.type === 'orchestrator.sandbox.stopped') {
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined && current.lastEvidenceTs <= ts) {
        current.state = 'stopped'
        current.lastEvidenceTs = ts
      }
    } else if (event.type === 'orchestrator.sandbox.reset') {
      // Destructive marker only: the following released/provisioned facts
      // carry the evidence. Refresh the evidence timestamp so a reset alone
      // counts as recent activity for the environment it names.
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined && current.lastEvidenceTs <= ts) {
        current.lastEvidenceTs = ts
      }
    } else if (event.type === 'orchestrator.sandbox.released') {
      // The released payload carries no provider; keep the one the
      // environment's earlier facts recorded, when one exists.
      const existing = byEnvironment.get(event.payload.environmentId)
      byEnvironment.set(event.payload.environmentId, {
        operator: event.payload.operator,
        environmentId: event.payload.environmentId,
        provider: existing?.provider ?? '',
        state: 'released',
        lastEvidenceTs: ts,
        ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
        ...(existing?.baseSha !== undefined ? { baseSha: existing.baseSha } : {}),
      })
    }
  }
  return [...byEnvironment.values()]
}
