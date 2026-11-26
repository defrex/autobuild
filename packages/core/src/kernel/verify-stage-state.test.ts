import { describe, expect, test } from 'bun:test'
import type { OpenEscalation } from './reducer'
import {
  escalationCarried,
  initialVerifyStageState,
  launchInFlight,
  verifyMemberKey,
  type EscalationCarryInput,
  type VerifyStageState,
} from './verify-stage-state'

/** A three-member stage started at seqs 11..13 in the cycle opened at 10,
 * whose `types` member is owned by session `s_types`. */
function stage(finished: Record<string, 'done' | 'cancelled'> = {}): VerifyStageState {
  const state = initialVerifyStageState()
  state.cycle = 10
  ;['types', 'unit', 'docs'].forEach((step, index) => {
    const key = verifyMemberKey(step, 1)
    state.members[key] = { step, attempt: 1, seq: 11 + index }
    state.owners[`s_${step}`] = key
    if (finished[step] === 'done') state.outcomes[key] = 20 + index
    if (finished[step] === 'cancelled')
      state.cancellations[key] = {
        step,
        attempt: 1,
        cause: { step: 'types' },
        seq: 20 + index,
      }
  })
  return state
}

const memberRaise: OpenEscalation = {
  id: 'esc',
  phase: 'verify:types',
  round: 1,
  source: 'agent',
  session: 's_types',
  question: 'which fixture?',
  seq: 15,
}

/** No execution, launch or record: (A) alone decides. */
function input(overrides: Partial<EscalationCarryInput> = {}): EscalationCarryInput {
  return {
    openEscalations: [memberRaise],
    verifyStage: stage(),
    verifyCycle: 10,
    maxAttemptSeen: 1,
    executions: [{ seq: 5 }],
    slotAdmittedSeq: 1,
    failureSeq: 0,
    ...overrides,
  }
}

describe('escalationCarried (SPEC §12 "What holds a slot")', () => {
  test('(A) a member question carries while another member of its stage runs', () => {
    expect(escalationCarried(input())).toBe(true)
    // A sibling finished or cancelled no longer runs.
    expect(escalationCarried(input({ verifyStage: stage({ unit: 'done' }) }))).toBe(true)
    expect(
      escalationCarried(input({ verifyStage: stage({ unit: 'done', docs: 'cancelled' }) })),
    ).toBe(false)
    // Two held members and no third running.
    const both = { ...memberRaise, id: 'esc2', session: 's_unit', seq: 16 }
    expect(
      escalationCarried(
        input({
          openEscalations: [memberRaise, both],
          verifyStage: stage({ docs: 'done' }),
        }),
      ),
    ).toBe(false)
  })

  test('(A) is the engine exemption only: waits, other sources, older attempts or cycles stop', () => {
    const variants: OpenEscalation[] = [
      { ...memberRaise, wait: { id: 'w' } },
      { ...memberRaise, source: 'policy' },
      { ...memberRaise, session: 's_unknown' },
      {
        id: 'jan',
        phase: 'setup',
        source: 'policy',
        janitor: true,
        question: 'q',
        seq: 16,
      },
    ]
    for (const escalation of variants)
      expect(escalationCarried(input({ openEscalations: [memberRaise, escalation] }))).toBe(false)
    expect(escalationCarried(input({ maxAttemptSeen: 2 }))).toBe(false)
    expect(escalationCarried(input({ verifyCycle: 12 }))).toBe(false)
  })

  test('(E) an execution launched with the slot carries until it ends, whatever is open', () => {
    const janitor: OpenEscalation = {
      id: 'jan',
      phase: 'setup',
      source: 'policy',
      janitor: true,
      question: 'q',
      seq: 20,
    }
    const replacement = {
      openEscalations: [janitor],
      executions: [{ seq: 5 }, { seq: 26 }],
      slotAdmittedSeq: 25,
    }
    expect(escalationCarried(input({ ...replacement, liveExecution: { seq: 26 } }))).toBe(true)
    // Ended, it carries nothing.
    expect(escalationCarried(input(replacement))).toBe(false)
    // An acknowledgement: no record since the previous start.
    expect(
      escalationCarried(
        input({
          ...replacement,
          slotAdmittedSeq: 3,
          liveExecution: { seq: 26 },
        }),
      ),
    ).toBe(false)
  })

  test('(B) an execution older than the earliest open raise carries', () => {
    const legacy = { slotAdmittedSeq: undefined, executions: [{ seq: 5 }] }
    expect(
      escalationCarried(
        input({
          ...legacy,
          openEscalations: [{ ...memberRaise, source: 'policy' }],
          liveExecution: { seq: 5 },
        }),
      ),
    ).toBe(true)
    expect(
      escalationCarried(
        input({
          ...legacy,
          openEscalations: [{ ...memberRaise, source: 'policy', seq: 4 }],
          liveExecution: { seq: 5 },
        }),
      ),
    ).toBe(false)
  })

  test('(L) a launch in flight carries until it starts or a failure lands', () => {
    const provisioning = {
      openEscalations: [
        {
          id: 'jan',
          phase: 'setup',
          source: 'policy',
          janitor: true,
          question: 'q',
          seq: 31,
        },
      ] satisfies OpenEscalation[],
      slotAdmittedSeq: 30,
    }
    expect(launchInFlight(input(provisioning))).toBe(true)
    expect(escalationCarried(input(provisioning))).toBe(true)
    // Its start hands over to (E); a failure fact ends it.
    expect(launchInFlight(input({ ...provisioning, executions: [{ seq: 5 }, { seq: 32 }] }))).toBe(
      false,
    )
    expect(escalationCarried(input({ ...provisioning, failureSeq: 32 }))).toBe(false)
    // A claim's `build.created` is its first launch record.
    expect(launchInFlight(input({ executions: [], slotAdmittedSeq: 1 }))).toBe(true)
  })
})
