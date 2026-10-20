import type { AbEvent } from '../events/catalog'
import type { Phase } from '../ontology'
import { phaseSpecFor } from './phases'

export interface ReadDeferral {
  session: string
  phase: Phase
  round: number
  evidenceSeq: number
  diagnostic: string
  ended: boolean
  settled: boolean
}
export interface ReadDeferralsAcc {
  sessions: Record<string, { phase: Phase; round: number; ended: boolean; terminal: boolean }>
  pending: ReadDeferral[]
  raises: Record<string, number>
}
export function initialReadDeferrals(): ReadDeferralsAcc {
  return { sessions: {}, pending: [], raises: {} }
}
/** Session identity and the launched phase/round are all required. Diagnostic
 * facts alone never advance a phase or reset any failure allowance. */
export function foldReadDeferrals(acc: ReadDeferralsAcc, events: readonly AbEvent[]): void {
  for (const event of events) {
    if (event.type === 'session.started') {
      acc.sessions[event.payload.session] = {
        phase: event.payload.phase,
        round: event.payload.round ?? 1,
        ended: false,
        terminal: false,
      }
    }
    for (const [id, session] of Object.entries(acc.sessions)) {
      if (session.ended) continue
      const actorMatches =
        event.actor.kind === 'kernel' ||
        (event.actor.kind === 'agent' && event.actor.session === id)
      const completion =
        event.type === phaseSpecFor(session.phase).terminalEvent &&
        (event.type !== 'verify.completed' || session.phase === `verify:${event.payload.step}`) &&
        (!('round' in event.payload) || event.payload.round === session.round) &&
        (!('attempt' in event.payload) || event.payload.attempt === session.round)
      const agentBoundary =
        event.actor.kind === 'agent' &&
        event.actor.session === id &&
        (event.type === 'escalation.raised' || event.type === 'publication.requested')
      if (actorMatches && (completion || agentBoundary)) {
        session.terminal = true
        acc.pending = acc.pending.filter((item) => item.session !== id)
      }
    }
    if (event.type === 'session.build-read-failed') {
      const p = event.payload
      const session = acc.sessions[p.session]
      if (
        session &&
        !session.terminal &&
        !session.ended &&
        session.phase === p.phase &&
        session.round === p.round &&
        !acc.pending.some((item) => item.session === p.session)
      ) {
        acc.pending.push({
          session: p.session,
          phase: p.phase,
          round: p.round,
          evidenceSeq: event.seq,
          diagnostic: p.diagnostic,
          ended: false,
          settled: false,
        })
      }
    }
    if (event.type === 'session.ended') {
      const session = acc.sessions[event.payload.session]
      if (session) session.ended = true
      if (!acc.pending.some((item) => item.session === event.payload.session))
        delete acc.sessions[event.payload.session]
      for (const item of acc.pending) if (item.session === event.payload.session) item.ended = true
    }
    if (event.type === 'phase.deferred') {
      const p = event.payload
      for (const item of acc.pending)
        if (item.session === p.session && item.phase === p.phase && item.round === p.round)
          item.settled = true
    }
    if (event.type === 'phase.deferral-escalated') {
      const p = event.payload
      if (
        acc.pending.some(
          (item) =>
            item.evidenceSeq === p.evidenceSeq &&
            item.session === p.session &&
            item.phase === p.phase &&
            item.round === p.round,
        )
      )
        acc.raises[p.id] = p.evidenceSeq
    }
    if (event.type === 'escalation.answered') {
      const seq = acc.raises[event.payload.id]
      if (seq !== undefined) {
        for (const item of acc.pending)
          if (item.evidenceSeq === seq) delete acc.sessions[item.session]
        acc.pending = acc.pending.filter((item) => item.evidenceSeq !== seq)
        delete acc.raises[event.payload.id]
      }
    }
  }
}
