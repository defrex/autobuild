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
  /** Seq of the chain's latest classified read failure. */
  lastFailureSeq: number
  /** A later own-build read succeeded after `lastFailureSeq`. */
  recovered: boolean
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
 * facts alone never advance a phase or reset any failure allowance. A native
 * continuation inherits its predecessor's pending item, so a chain parks once.
 * Recovery is only the durable `session.build-read-recovered` fact newer than
 * the chain's latest failure; it retires a finalize post-step, which has no
 * terminal, once the kernel records that session's step outcome. */
export function foldReadDeferrals(acc: ReadDeferralsAcc, events: readonly AbEvent[]): void {
  for (const event of events) {
    if (event.type === 'session.started') {
      const predecessor = event.payload.continuation?.predecessor
      if (predecessor !== undefined) {
        for (const item of acc.pending)
          if (
            item.session === predecessor &&
            !item.ended &&
            item.phase === event.payload.phase &&
            item.round === (event.payload.round ?? 1)
          )
            item.session = event.payload.session
        if (!acc.pending.some((item) => item.session === predecessor))
          delete acc.sessions[predecessor]
      }
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
      const existing = acc.pending.find((item) => item.session === p.session)
      if (
        session &&
        !session.terminal &&
        !session.ended &&
        session.phase === p.phase &&
        session.round === p.round
      ) {
        if (!existing)
          acc.pending.push({
            session: p.session,
            phase: p.phase,
            round: p.round,
            evidenceSeq: event.seq,
            diagnostic: p.diagnostic,
            ended: false,
            settled: false,
            lastFailureSeq: event.seq,
            recovered: false,
          })
        else if (
          !existing.ended &&
          !existing.settled &&
          existing.phase === p.phase &&
          existing.round === p.round
        ) {
          // A later failure invalidates earlier recovery; the chain keeps one item.
          existing.lastFailureSeq = event.seq
          existing.recovered = false
          existing.diagnostic = p.diagnostic
        }
      }
    }
    if (event.type === 'session.build-read-recovered') {
      const p = event.payload
      for (const item of acc.pending)
        if (
          item.session === p.session &&
          item.phase === p.phase &&
          item.round === p.round &&
          item.evidenceSeq === p.evidenceSeq &&
          item.lastFailureSeq === p.failureSeq &&
          !item.ended &&
          !item.settled
        )
          item.recovered = true
    }
    if (
      (event.type === 'finalize.step-completed' || event.type === 'publication.requested') &&
      acc.pending.some((item) => item.phase === 'finalize' && item.recovered && !item.settled) &&
      event.actor.kind === 'agent'
    ) {
      // The kernel's step outcome for a recovered post-step session, even after its end.
      const id = event.actor.session
      const retired = (item: ReadDeferral) =>
        item.session === id && item.phase === 'finalize' && item.recovered && !item.settled
      if (acc.pending.some(retired)) {
        acc.pending = acc.pending.filter((item) => !retired(item))
        delete acc.sessions[id]
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
