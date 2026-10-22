/** Small semantic projections used by stateless service requests. */
import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import type { ArtifactRef } from '../ontology'
import { defineReducer } from './incremental'

export const effectiveConfigReducer = defineReducer<
  { run?: string; reference?: ArtifactRef },
  RepositoryEvent,
  { run?: string; reference?: ArtifactRef }
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.run-started') {
        acc.run = event.payload.run
        acc.reference = event.payload.effectiveConfig
      } else if (
        event.type === 'dispatcher.config-reloaded' &&
        event.payload.run === acc.run &&
        event.payload.effectiveConfig !== undefined
      ) {
        acc.reference = event.payload.effectiveConfig
      }
    }
  },
  finish: (acc) => ({ ...acc }),
})

export function delegationFactKey(id: string): string {
  return `id:${id}`
}

export interface EndingFact {
  seq: number
  at: string
}
export interface SessionFacts {
  starts: number[]
  endings: EndingFact[]
}
export interface BuildDelegationFacts {
  lastSeq: number
  sessions: Record<string, SessionFacts>
  terminals: EndingFact[]
}
export interface HarvestDelegationFacts {
  lastSeq: number
  runs: Record<string, true>
  sessions: Record<string, Record<string, SessionFacts & { suspended?: true }>>
  authorizations: Record<string, Record<string, { seq: number; leaseHolder: string }>>
  releases: Record<string, string[]>
  endings: Record<string, EndingFact[]>
}
/** Only lifecycle facts are retained. Contiguous canonical logs make every seq
 * from 1 through lastSeq a valid anchor without one entry per dispatcher tick. */
export const buildDelegationReducer = defineReducer<
  BuildDelegationFacts,
  AbEvent,
  BuildDelegationFacts
>({
  version: 1,
  initial: () => ({ lastSeq: 0, sessions: {}, terminals: [] }),
  fold(acc, events) {
    for (const event of events) {
      acc.lastSeq = event.seq
      if (event.type === 'session.started' || event.type === 'session.ended') {
        const key = delegationFactKey(event.payload.session)
        acc.sessions[key] ??= { starts: [], endings: [] }
        const session = acc.sessions[key]!
        if (event.type === 'session.started') session.starts.push(event.seq)
        else session.endings.push({ seq: event.seq, at: event.ts })
      } else if (event.type === 'build.completed' || event.type === 'build.aborted')
        acc.terminals.push({ seq: event.seq, at: event.ts })
    }
  },
  finish: (acc) => structuredClone(acc),
})
export const harvestDelegationReducer = defineReducer<
  HarvestDelegationFacts,
  RepositoryEvent,
  HarvestDelegationFacts
>({
  version: 2,
  initial: () => ({
    lastSeq: 0,
    runs: {},
    sessions: {},
    authorizations: {},
    releases: {},
    endings: {},
  }),
  fold(acc, events) {
    for (const event of events) {
      acc.lastSeq = event.seq
      if (event.type === 'harvest.started') acc.runs[delegationFactKey(event.payload.run)] = true
      if (event.type === 'harvest.execution.authorized') {
        const key = delegationFactKey(event.payload.run)
        acc.authorizations[key] ??= {}
        const run = acc.authorizations[key]!
        run[delegationFactKey(event.payload.execution)] ??= {
          seq: event.seq,
          leaseHolder: event.payload.leaseHolder,
        }
      }
      if (
        event.type === 'harvest.session.started' ||
        event.type === 'harvest.session.ended' ||
        event.type === 'harvest.session.suspended'
      ) {
        const runKey = delegationFactKey(event.payload.run)
        acc.sessions[runKey] ??= {}
        const run = acc.sessions[runKey]!
        const sessionKey = delegationFactKey(event.payload.session)
        run[sessionKey] ??= { starts: [], endings: [] }
        const session = run[sessionKey]!
        if (event.type === 'harvest.session.started') session.starts.push(event.seq)
        else {
          session.endings.push({ seq: event.seq, at: event.ts })
          if (event.type === 'harvest.session.suspended') session.suspended = true
        }
      }
      if (event.type === 'harvest.execution.released' || event.type === 'harvest.execution.ended') {
        const key = delegationFactKey(event.payload.execution)
        acc.releases[key] ??= []
        acc.releases[key]!.push(event.ts)
      }
      if (
        event.type === 'harvest.completed' ||
        event.type === 'harvest.escalated' ||
        event.type === 'harvest.recovery-exhausted' ||
        (event.type === 'harvest.failed' && !event.payload.willRetry)
      ) {
        const key = delegationFactKey(event.payload.run)
        acc.endings[key] ??= []
        acc.endings[key]!.push({ seq: event.seq, at: event.ts })
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
