/**
 * Durable operator-sandbox state (AUT-340): the repository-journal projection
 * the sandbox service, the dispatcher's idle-settlement stage, and the
 * repository status projection read instead of process memory. The lifecycle
 * facts (`orchestrator.sandbox.provisioning`/`provisioned`/`resumed`/
 * `provision-failed`/`activity`/`refreshed`/`stopped`/`closed`/`released`/
 * `reset`) bracket one environment per operator × repository. A
 * `provisioning` fact opens a background attempt (state `provisioning`, its
 * kind kept as `pendingKind`) that `provisioned`/`resumed` settles to `live`
 * or `provision-failed` settles to `failed`; `closed` maps to `stopped`.
 * Every helper here is a pure function over the journal, mirroring the
 * harvest execution settlement, so any dispatcher invocation can settle an
 * orphaned environment.
 */
import type { RepositoryEvent } from '../events/repository'
import { defineReducer, type IncrementalReducer } from '../kernel/incremental'

export type SandboxEnvironmentState = 'provisioning' | 'live' | 'stopped' | 'failed' | 'released'

export type SandboxFailureStage = 'checkout' | 'setup' | 'environment' | 'resume' | 'provision'

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
   * reference point, read by the publish operation. A `refreshed` fact
   * moves it. Absent on snapshots provisioned before this field existed. */
  baseSha?: string
  /** The latest background attempt's failure, while `failed`. */
  failure?: { stage: SandboxFailureStage; message: string }
  /** The in-flight attempt's kind, while `provisioning`: which fact
   * (`provisioned` or `resumed`) settles it. */
  pendingKind?: 'provision' | 'resume'
}

type MutableSnapshot = {
  operator: string
  environmentId: string
  provider: string
  state: SandboxEnvironmentState
  lastEvidenceTs: string
  sessionId?: string
  baseSha?: string
  failure?: { stage: SandboxFailureStage; message: string }
  pendingKind?: 'provision' | 'resume'
}

/** Per-environment sandbox state, keyed deterministically by
 * `environmentId` (one environment per operator × repository, and the id is
 * derived from both). Latest fact wins; `released` environments stay in the
 * result with their closing evidence so callers can distinguish them. */
export function sandboxStates(events: readonly RepositoryEvent[]): SandboxEnvironmentSnapshot[] {
  return sandboxStatesReducer.reduce(events)
}

/** The carried accumulator: environments in `Map` insertion order (a re-set
 * of an existing id keeps its position). */
export type SandboxStatesAcc = MutableSnapshot[]

function foldSandboxStates(acc: SandboxStatesAcc, events: readonly RepositoryEvent[]): void {
  const byEnvironment = new Map<string, MutableSnapshot>(acc.map((s) => [s.environmentId, s]))
  for (const event of events) {
    const ts = event.ts
    if (event.type === 'orchestrator.sandbox.provisioning') {
      const previous = byEnvironment.get(event.payload.environmentId)
      byEnvironment.set(event.payload.environmentId, {
        operator: event.payload.operator,
        environmentId: event.payload.environmentId,
        provider: event.payload.provider,
        state: 'provisioning',
        lastEvidenceTs: ts,
        ...(previous?.sessionId !== undefined ? { sessionId: previous.sessionId } : {}),
        ...(previous?.baseSha !== undefined ? { baseSha: previous.baseSha } : {}),
        pendingKind: event.payload.kind,
      })
    } else if (event.type === 'orchestrator.sandbox.provision-failed') {
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined) {
        current.state = 'failed'
        current.failure = { stage: event.payload.stage, message: event.payload.message }
        delete current.pendingKind
        if (current.lastEvidenceTs <= ts) current.lastEvidenceTs = ts
      }
    } else if (event.type === 'orchestrator.sandbox.closed') {
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined && current.lastEvidenceTs <= ts) {
        current.state = 'stopped'
        current.lastEvidenceTs = ts
        delete current.pendingKind
      }
    } else if (event.type === 'orchestrator.sandbox.refreshed') {
      const current = byEnvironment.get(event.payload.environmentId)
      if (current !== undefined) {
        current.baseSha = event.payload.baseSha
        if (current.lastEvidenceTs <= ts) current.lastEvidenceTs = ts
      }
    } else if (event.type === 'orchestrator.sandbox.provisioned') {
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
        delete current.pendingKind
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
  acc.length = 0
  acc.push(...byEnvironment.values())
}

export const sandboxStatesReducer: IncrementalReducer<
  SandboxStatesAcc,
  RepositoryEvent,
  SandboxEnvironmentSnapshot[]
> = defineReducer({
  identity: 'sandboxStates',
  initial: (): SandboxStatesAcc => [],
  fold: foldSandboxStates,
  finish: (acc) => acc.map((s) => ({ ...s })),
})
