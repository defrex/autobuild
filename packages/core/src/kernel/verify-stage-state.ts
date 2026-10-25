import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { normalizeVerifyCompletion } from '../events/payloads'
import type { OpenEscalation, AnsweredEscalation } from './reducer'

export interface VerifyMember extends EventPayload<'verify.started'> {
  seq: number
}
export interface VerifyCancellation extends EventPayload<'verify.cancelled'> {
  seq: number
}
export interface VerifyStageFailure extends EventPayload<'verify.stage-failed'> {
  seq: number
}
export interface VerifyStageState {
  cycle: number
  concurrent: boolean
  executionSeq: number
  cleanupExecutionSeq?: number
  members: Record<string, VerifyMember>
  owners: Record<string, string>
  outcomes: Record<string, number>
  cancellations: Record<string, VerifyCancellation>
  failures: VerifyStageFailure[]
  implementations: Record<string, number>
  superseded: Array<{
    escalation: OpenEscalation | AnsweredEscalation
    cancellation: VerifyCancellation
  }>
}
export function verifyMemberKey(step: string, attempt: number): string {
  return JSON.stringify([step, attempt])
}
export function initialVerifyStageState(): VerifyStageState {
  return {
    cycle: 0,
    concurrent: false,
    executionSeq: 0,
    members: {},
    owners: {},
    outcomes: {},
    cancellations: {},
    failures: [],
    implementations: {},
    superseded: [],
  }
}
export function advanceVerifyStage(state: VerifyStageState, event: AbEvent): void {
  switch (event.type) {
    case 'verify.config-captured':
    case 'verify.config-superseded':
    case 'spec.revised':
    case 'reconcile.completed':
    case 'integration.prepared':
      state.cycle = event.seq
      break
    case 'code-review.verdict':
      if (event.payload.verdict === 'approve') state.cycle = event.seq
      break
    case 'execution.started':
      state.executionSeq = event.seq
      break
    case 'verify.started': {
      const key = verifyMemberKey(event.payload.step, event.payload.attempt)
      if (
        Object.entries(state.members).some(
          ([other, member]) =>
            other !== key &&
            member.seq > state.cycle &&
            !state.outcomes[other] &&
            !state.cancellations[other],
        )
      )
        state.concurrent = true
      state.members[key] = { ...event.payload, seq: event.seq }
      break
    }
    case 'session.started': {
      const { phase, round, session } = event.payload
      if (phase?.startsWith('verify:') && round !== undefined) {
        const key = verifyMemberKey(phase.slice(7), round)
        if (state.members[key]) state.owners[session] = key
      }
      break
    }
    case 'verify.completed': {
      const result = normalizeVerifyCompletion(event.payload)
      const key = verifyMemberKey(result.step, result.attempt)
      if (!state.cancellations[key]) state.outcomes[key] = event.seq
      break
    }
    case 'verify.cancelled': {
      const key = verifyMemberKey(event.payload.step, event.payload.attempt)
      if (!state.outcomes[key] && !state.cancellations[key]) {
        state.cancellations[key] = { ...event.payload, seq: event.seq }
        state.cleanupExecutionSeq = state.executionSeq
      }
      break
    }
    case 'verify.stage-failed':
      state.failures.push({ ...event.payload, seq: event.seq })
      break
    case 'implement.started':
      if (
        event.payload.verifyStageFailure !== undefined &&
        state.failures.some(
          (f) =>
            f.seq === event.payload.verifyStageFailure &&
            f.seq < event.seq &&
            f.cycle === state.cycle,
        )
      )
        state.implementations[String(event.payload.round)] = event.payload.verifyStageFailure
      break
  }
}
export function runningVerifyMembers(state: VerifyStageState, cycle: number): VerifyMember[] {
  return Object.entries(state.members)
    .filter(
      ([key, member]) => member.seq > cycle && !state.outcomes[key] && !state.cancellations[key],
    )
    .map(([, member]) => member)
}
