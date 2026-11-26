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
    case 'build.reopened':
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

/** What `escalationCarried` reads: reduced facts every `BuildState` carries,
 * or the reducer's in-loop values at an answer. */
export interface EscalationCarryInput {
  openEscalations: readonly Pick<
    OpenEscalation,
    'source' | 'session' | 'wait' | 'seq' | 'policyCause'
  >[]
  verifyStage: VerifyStageState
  /** The current verify cycle's boundary (`verify.cycleSince`). */
  verifyCycle: number
  maxAttemptSeen: number
  /** Every `execution.started`, in log order. */
  executions: readonly { seq: number }[]
  /** The latest execution, while no `execution.ended` closed it. */
  liveExecution?: { seq: number } | undefined
  /** The latest admission: `build.created` or `slot.admitted`. */
  slotAdmittedSeq?: number | undefined
  /** The latest `dispatch.failed`, `infrastructure.failed` or
   * `runner.setup-failed` seq, or 0. */
  failureSeq: number
}

/** The latest launch record, or undefined: the admission (`build.created` or
 * `slot.admitted`) that precedes every launch of a build holding its slot.
 * The dispatcher appends `slot.admitted` before every holding launch except
 * one already in flight, and every claim's `build.created` is followed by its
 * dispatch, so an acknowledgement launch, which holds no slot, is the only
 * launch with no record of its own. */
export function launchRecordSeq(input: Pick<EscalationCarryInput, 'slotAdmittedSeq'>) {
  return input.slotAdmittedSeq
}

/** (L) A launch in flight: its record is newer than the latest
 * `execution.started`, every recorded launch failure and any open
 * `execution-no-progress` escalation. Only the start (which hands over to the
 * execution), a failure fact or that refusal ends it. The dispatcher's
 * progress guard raises `execution-no-progress` in place of the launch, so
 * that raise is a launch failure; no other escalation ends a launch, since
 * none proves a provisioning or launching runner stopped. */
export function launchInFlight(
  input: Pick<
    EscalationCarryInput,
    'executions' | 'slotAdmittedSeq' | 'failureSeq' | 'openEscalations'
  >,
): boolean {
  const record = launchRecordSeq(input)
  return (
    record !== undefined &&
    record > (input.executions.at(-1)?.seq ?? 0) &&
    record > input.failureSeq &&
    !input.openEscalations.some(
      (escalation) => escalation.policyCause === 'execution-no-progress' && escalation.seq > record,
    )
  )
}

/** Whether work Autobuild started for a blocked build still runs, so its open
 * escalations do not stop it and it keeps its slot (SPEC §12 "What holds a
 * slot"). Pure reduced state: no lease, marker or clock enters. True when
 * any of these holds:
 *
 * - (A) stage carry: every open escalation is an agent escalation without a
 *   ticket wait whose session owns a current-cycle verify member at the
 *   highest attempt, and some other member still runs. This models the
 *   engine's stage exemption (`heldVerifier` and the open-escalation gate in
 *   `engine.ts`), which keeps the stage's other members running; the two
 *   change together.
 * - (E) held execution: the open execution was launched while the build held
 *   its slot (its launch record lies between the previous start and its own).
 * - (L) launch in flight (`launchInFlight`).
 * - (B) the open execution started before the earliest open raise.
 *
 * Only (A) looks at escalations, as part of its own definition, apart from
 * (L)'s progress-guard refusal, which is a launch failure: (E), (L) and (B)
 * rest on durable launch and execution facts, which no question contradicts. Stale evidence (a crashed runner's open execution, a launch
 * that died without a failure fact) over-holds a slot the build already
 * held; it never takes a new one. */
export function escalationCarried(input: EscalationCarryInput): boolean {
  return stageCarried(input) || executionCarried(input) || launchInFlight(input)
}

function stageCarried(input: EscalationCarryInput): boolean {
  const { openEscalations, verifyStage, verifyCycle, maxAttemptSeen } = input
  if (openEscalations.length === 0) return false
  const held = new Set<string>()
  for (const escalation of openEscalations) {
    if (
      escalation.source !== 'agent' ||
      escalation.wait !== undefined ||
      escalation.session === undefined
    )
      return false
    const key = verifyStage.owners[escalation.session]
    const member = key === undefined ? undefined : verifyStage.members[key]
    if (
      key === undefined ||
      member === undefined ||
      member.seq <= verifyCycle ||
      key !== verifyMemberKey(member.step, maxAttemptSeen)
    )
      return false
    held.add(key)
  }
  return runningVerifyMembers(verifyStage, verifyCycle).some(
    (member) => !held.has(verifyMemberKey(member.step, member.attempt)),
  )
}

function executionCarried(input: EscalationCarryInput): boolean {
  const live = input.liveExecution
  if (live === undefined) return false
  const record = launchRecordSeq(input)
  const previous = input.executions.findLast((execution) => execution.seq < live.seq)?.seq ?? 0
  if (record !== undefined && record > previous && record < live.seq) return true
  if (input.openEscalations.length === 0) return false
  return live.seq < Math.min(...input.openEscalations.map((escalation) => escalation.seq))
}
