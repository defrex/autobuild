/**
 * Engine transition-table tests (SPEC §5, §8, §10, §15.6, §15.7), fixture-
 * driven off the walkthroughs in §15.6 in the reducer-test style: envelopes
 * built directly, seq by index, ts from a steppingClock, and every fixture
 * write validated through `validateEventWrite` so a fixture that drifts from
 * the vocabulary fails loudly. Decision assertions are deep equalities on
 * whole Decision objects.
 */
import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { parseConfig } from '../config/load'
import {
  KERNEL,
  humanActor,
  type Actor,
} from '../events/envelope'
import {
  validateEventWrite,
  allowedActorKinds,
  type AbEvent,
  type EventWrite,
} from '../events/catalog'
import { eventPayloadSchemas, type EventType } from '../events/payloads'
import type { CorePhase, Feedback, Finding } from '../ontology'
import { steppingClock } from '../testing/fixed'
import { decideNext, type Decision, type WaitReason } from './engine'

const BUILD = 'auth-rate-limit'

// Policy defaults apply: stallRounds 3, maxVerifyAttempts 3,
// maxReconcileAttempts 3, maxReviewRounds 5 (§16.1).
const config = parseConfig(`
[dispatcher]
readyState = "ready"

[commands]
typecheck = "bun tsc --noEmit"
test = "bun test"

[server]
start = "bun dev"
url = "http://localhost:3000"

[verify]
steps = ["types", "unit", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true

[finalize]
steps = ["release-notes"]
`)

// ── Fixture plumbing (reducer-test style) ────────────────────────────────────

type PayloadInput<T extends EventType> = z.input<(typeof eventPayloadSchemas)[T]>

function defaultActor(type: EventType): Actor {
  const kind = allowedActorKinds[type][0]
  switch (kind) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return { kind: 'dispatcher' }
    case 'human':
      return humanActor('aron')
    case 'agent':
      return { kind: 'agent', role: 'test-role', session: 's_test' }
    default:
      return { kind: 'ingester', source: 'test' }
  }
}

function ev<T extends EventType>(
  type: T,
  payload: PayloadInput<T>,
  actor: Actor = defaultActor(type),
): EventWrite {
  return validateEventWrite({ actor, type, payload })
}

/** seq assigned by index (starting at 1), ts from the stepping clock. */
function toLog(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map(
    (write, index) =>
      ({
        build: BUILD,
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
}

function decide(writes: EventWrite[]): Decision {
  return decideNext(toLog(writes), config)
}

function finding(id: string, persists: string[] = []): Finding {
  return { id, severity: 'blocking', summary: `finding ${id}`, persists }
}

function wait(reason: WaitReason): Decision {
  return { kind: 'wait', reason }
}

function runPhase(phase: CorePhase, round: number, feedback?: Feedback): Decision {
  return feedback === undefined
    ? { kind: 'run-phase', phase, round }
    : { kind: 'run-phase', phase, round, feedback }
}

// ── Fixture segments (§15.6) ─────────────────────────────────────────────────

function prelude(): EventWrite[] {
  return [
    ev('build.created', {
      ticket: { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' },
      repo: 'defrex/app',
      baseBranch: 'main',
    }),
    ev('workspace.provisioned', {
      provider: 'worktree',
      ref: '/ws/auth-rate-limit',
      branch: 'ab/auth-rate-limit',
    }),
    ev('spec.imported', {
      artifact: { kind: 'spec', rev: 0 },
      ticket: { source: 'linear', id: 'ENG-42' },
    }),
    ev('runner.attached', { instance: 'runner-1', host: 'local' }),
  ]
}

function planRound(
  round: number,
  verdict: 'approve' | 'revise' | 'escalate',
  findings: Finding[] = [],
  reason?: string,
): EventWrite[] {
  return [
    ev('plan.started', { round }),
    ev('plan.completed', { round, artifact: { kind: 'plan', rev: round - 1 } }),
    ev('plan-review.started', { round }),
    ev('plan-review.verdict', {
      round,
      verdict,
      findings,
      artifact: { kind: 'plan-review', rev: round - 1 },
      reason,
    }),
  ]
}

function planApproved(): EventWrite[] {
  return planRound(1, 'approve')
}

function implementRound(
  round: number,
  head: string,
  feedback?: PayloadInput<'implement.started'>['feedback'],
): EventWrite[] {
  return [
    ev('implement.started', { round, feedback }),
    ev('implement.completed', {
      round,
      commits: { base: 'sha-base', head },
      artifact: { kind: 'implement-notes', rev: round - 1 },
    }),
  ]
}

function codeReview(
  round: number,
  verdict: 'approve' | 'revise' | 'escalate',
  findings: Finding[] = [],
  reason?: string,
): EventWrite[] {
  return [
    ev('code-review.started', { round }),
    ev('code-review.verdict', {
      round,
      verdict,
      findings,
      artifact: { kind: 'code-review', rev: round - 1 },
      reason,
    }),
  ]
}

function verifyRun(
  step: string,
  attempt: number,
  pass: boolean,
  report?: { kind: string; rev: number },
): EventWrite[] {
  return [
    ev('verify.started', { step, attempt }),
    ev('verify.completed', { step, attempt, pass, report }),
  ]
}

function verifyAllPass(attempt: number): EventWrite[] {
  return [
    ...verifyRun('types', attempt, true),
    ...verifyRun('unit', attempt, true),
    ...verifyRun('e2e', attempt, true),
  ]
}

const PR = { number: 7, url: 'https://github.com/defrex/app/pull/7', headSha: 'sha-r1' }

function finalized(): EventWrite[] {
  return [
    ev('finalize.started', {}),
    ev('finalize.completed', { pr: PR }),
    ev('finalize.step-completed', { step: 'release-notes', ok: true }),
  ]
}

// ── §15.6 happy path: the prefix-walk property ───────────────────────────────

describe('decideNext: §15.6 happy path — prefix walk', () => {
  const happyPath: EventWrite[] = [
    ...prelude(), // 1-4
    ev('session.started', {
      session: 's_plan_1',
      role: 'plan',
      runner: 'claude',
      phase: 'plan',
      round: 1,
    }), // 5
    ev('plan.started', { round: 1 }), // 6
    ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }), // 7
    ev('session.ended', {
      session: 's_plan_1',
      transcript: { kind: 'transcript', rev: 0 },
      usage: { inputTokens: 900, outputTokens: 400, turns: 6 },
    }), // 8
    ev('plan-review.started', { round: 1 }), // 9
    ev('plan-review.verdict', {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    }), // 10
    ev('implement.started', { round: 1 }), // 11
    ev('observation.recorded', {
      id: 'o_1',
      kind: 'refactor',
      summary: 'extract limiter config',
      files: ['src/auth.ts'],
    }), // 12
    ev('implement.completed', {
      round: 1,
      commits: { base: 'sha-base', head: 'sha-r1' },
      artifact: { kind: 'implement-notes', rev: 0 },
    }), // 13
    ev('code-review.started', { round: 1 }), // 14
    ev('code-review.verdict', {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    }), // 15
    ...verifyRun('types', 1, true), // 16-17
    ...verifyRun('unit', 1, true), // 18-19
    ...verifyRun('e2e', 1, true), // 20-21
    ev('finalize.started', {}), // 22
    ev('finalize.completed', { pr: PR }), // 23
    ev('finalize.step-completed', { step: 'release-notes', ok: true }), // 24
    ev('pr.merged', { sha: 'sha-squash' }), // 25
    ev('workspace.released', {}), // 26
    ev('build.completed', { outcome: 'merged' }), // 27
  ]

  const checkTypes: Decision = {
    kind: 'run-check',
    step: 'types',
    command: 'bun tsc --noEmit',
    attempt: 1,
  }
  const checkUnit: Decision = { kind: 'run-check', step: 'unit', command: 'bun test', attempt: 1 }
  const agentE2e: Decision = {
    kind: 'run-agent-verify',
    step: 'e2e',
    skill: 'ab-verify-e2e',
    needsServer: true,
    attempt: 1,
  }

  const expected: Decision[] = [
    wait('awaiting-spec'), // 1 build.created — dispatch owns the import (§6.3)
    wait('awaiting-spec'), // 2 workspace.provisioned
    runPhase('plan', 1), // 3 spec.imported
    runPhase('plan', 1), // 4 runner.attached
    runPhase('plan', 1), // 5 session.started
    runPhase('plan', 1), // 6 plan.started — started-not-completed re-runs (§15.6-C)
    runPhase('plan-review', 1), // 7 plan.completed
    runPhase('plan-review', 1), // 8 session.ended
    runPhase('plan-review', 1), // 9 plan-review.started
    runPhase('implement', 1), // 10 approve → code loop
    runPhase('implement', 1), // 11 implement.started
    runPhase('implement', 1), // 12 observation.recorded
    runPhase('code-review', 1), // 13 implement.completed
    runPhase('code-review', 1), // 14 code-review.started
    checkTypes, // 15 approve → verify, first step, cheap checks first
    checkTypes, // 16 verify.started types
    checkUnit, // 17 types passed
    checkUnit, // 18 verify.started unit
    agentE2e, // 19 unit passed
    agentE2e, // 20 verify.started e2e
    runPhase('finalize', 1), // 21 all steps passed
    runPhase('finalize', 1), // 22 finalize.started
    { kind: 'run-finalize-step', step: 'release-notes' }, // 23 finalize.completed
    wait('awaiting-pr'), // 24 post-step done → PR is the janitor's (§15.7)
    wait('awaiting-pr'), // 25 pr.merged — the janitor completes the build
    wait('awaiting-pr'), // 26 workspace.released
    wait('done'), // 27 build.completed
  ]

  test('empty log waits for the spec', () => {
    expect(decideNext([], config)).toEqual(wait('awaiting-spec'))
  })

  test('every prefix decides the §15.6 sequence', () => {
    const log = toLog(happyPath)
    const actual = log.map((_, index) => decideNext(log.slice(0, index + 1), config))
    expect(actual).toEqual(expected)
  })

  test('decideNext is pure: re-deciding any prefix agrees with itself', () => {
    const log = toLog(happyPath)
    for (let i = 0; i <= log.length; i += 1) {
      const prefix = log.slice(0, i)
      expect(decideNext(prefix, config)).toEqual(decideNext(prefix, config))
    }
  })
})

// ── Rule 1: terminal states ──────────────────────────────────────────────────

describe('decideNext: rule 1 — terminal states', () => {
  test('build.completed → wait/done', () => {
    expect(decide([...prelude(), ev('build.completed', { outcome: 'merged' })])).toEqual(
      wait('done'),
    )
  })

  test('build.aborted → wait/aborted', () => {
    expect(
      decide([...prelude(), ev('build.abort-requested', {}), ev('build.aborted', {})]),
    ).toEqual(wait('aborted'))
  })

  test('terminal is latest-wins in either order (§15.5)', () => {
    expect(
      decide([...prelude(), ev('build.aborted', {}), ev('build.completed', { outcome: 'abandoned' })]),
    ).toEqual(wait('done'))
    expect(
      decide([...prelude(), ev('build.completed', { outcome: 'merged' }), ev('build.aborted', {})]),
    ).toEqual(wait('aborted'))
  })

  test('terminal wins over pending commands and open escalations', () => {
    expect(
      decide([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'q?' }),
        ev('build.completed', { outcome: 'merged' }),
        ev('build.pause-requested', {}),
      ]),
    ).toEqual(wait('done'))
  })
})

// ── Rule 2: operator commands (D2) ───────────────────────────────────────────

describe('decideNext: rule 2 — operator commands (D2)', () => {
  test('unacknowledged pause-request → acknowledge pause', () => {
    expect(decide([...prelude(), ev('build.pause-requested', { reason: 'hold' })])).toEqual({
      kind: 'acknowledge',
      command: 'pause',
    })
  })

  test('paused parks phase decisions (plan is due but waits)', () => {
    expect(
      decide([...prelude(), ev('build.pause-requested', {}), ev('build.paused', {})]),
    ).toEqual(wait('paused'))
  })

  test('paused + unacknowledged resume-request → acknowledge resume', () => {
    expect(
      decide([
        ...prelude(),
        ev('build.pause-requested', {}),
        ev('build.paused', {}),
        ev('build.resume-requested', {}),
      ]),
    ).toEqual({ kind: 'acknowledge', command: 'resume' })
  })

  test('after build.resumed the phase decision returns', () => {
    expect(
      decide([
        ...prelude(),
        ev('build.pause-requested', {}),
        ev('build.paused', {}),
        ev('build.resume-requested', {}),
        ev('build.resumed', {}),
      ]),
    ).toEqual(runPhase('plan', 1))
  })

  test('abort-request wins over pause requests and open escalations', () => {
    expect(
      decide([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'q?' }),
        ev('build.pause-requested', {}),
        ev('build.abort-requested', { reason: 'wrong ticket' }),
      ]),
    ).toEqual({ kind: 'acknowledge', command: 'abort' })
  })

  test('abort-request wins while paused', () => {
    expect(
      decide([...prelude(), ev('build.paused', {}), ev('build.abort-requested', {})]),
    ).toEqual({ kind: 'acknowledge', command: 'abort' })
  })

  test('a resume-request while not paused is ignored', () => {
    expect(decide([...prelude(), ev('build.resume-requested', {})])).toEqual(runPhase('plan', 1))
  })

  test('a stale resume-request cannot un-pause a LATER pause (commands are ordered, §15.2.7)', () => {
    // Regression: the ignored-while-running resume used to be retained
    // forever, then acknowledged the moment a later pause landed — silently
    // undoing the operator's newest command. The pause-request supersedes it.
    expect(
      decide([
        ...prelude(),
        ev('build.resume-requested', {}), // ignored: not paused — and now countermanded below
        ev('build.pause-requested', {}),
        ev('build.paused', {}),
      ]),
    ).toEqual(wait('paused'))
  })

  test('a stale pause-request cannot re-pause after a LATER resume (mirror case)', () => {
    // Regression: a duplicate pause-request issued while already paused was
    // never acknowledged and survived the resume, re-pausing the build right
    // after the operator resumed it. The resume-request supersedes it.
    expect(
      decide([
        ...prelude(),
        ev('build.pause-requested', {}),
        ev('build.paused', {}), // clears the first pause request
        ev('build.pause-requested', {}), // duplicate while paused — countermanded below
        ev('build.resume-requested', {}),
        ev('build.resumed', {}),
      ]),
    ).toEqual(runPhase('plan', 1))
  })

  test('a pause-request on a blocked build still acknowledges (rule 2 before 3)', () => {
    expect(
      decide([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'q?' }),
        ev('build.pause-requested', {}),
      ]),
    ).toEqual({ kind: 'acknowledge', command: 'pause' })
  })

  test('paused wins over blocked; the escalation is not lost (§15.5)', () => {
    const writes = [
      ...prelude(),
      ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'q?' }),
      ev('build.pause-requested', {}),
      ev('build.paused', {}),
    ]
    expect(decide(writes)).toEqual(wait('paused'))
    expect(decide([...writes, ev('build.resumed', {})])).toEqual(wait('blocked'))
  })
})

// ── Rule 3: escalation gating ────────────────────────────────────────────────

describe('decideNext: rule 3 — escalation gating', () => {
  test('any open escalation → wait/blocked', () => {
    expect(
      decide([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', round: 1, source: 'agent', question: 'q?' }),
      ]),
    ).toEqual(wait('blocked'))
  })

  test('blocked while ANY escalation stays open', () => {
    expect(
      decide([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'one?' }),
        ev('escalation.raised', { id: 'e_2', phase: 'plan', source: 'policy', question: 'two?' }),
        ev('escalation.answered', { id: 'e_2', answer: 'B', resolution: 'guidance' }),
      ]),
    ).toEqual(wait('blocked'))
  })

  test('answered abort-resolution without build.aborted → acknowledge abort, even with other escalations open', () => {
    const writes = [
      ...prelude(),
      ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'one?' }),
      ev('escalation.raised', { id: 'e_2', phase: 'plan', source: 'agent', question: 'two?' }),
      ev('escalation.answered', { id: 'e_1', answer: 'Kill it.', resolution: 'abort' }),
    ]
    expect(decide(writes)).toEqual({ kind: 'acknowledge', command: 'abort' })
    expect(decide([...writes, ev('build.aborted', {})])).toEqual(wait('aborted'))
  })

  test('answered revise-spec → wait/awaiting-spec until spec.revised lands', () => {
    const writes = [
      ...prelude(),
      ev('escalation.raised', { id: 'e_1', phase: 'plan', round: 1, source: 'agent', question: 'spec wrong?' }),
      ev('escalation.answered', { id: 'e_1', answer: 'Spec updated.', resolution: 'revise-spec' }),
    ]
    expect(decide(writes)).toEqual(wait('awaiting-spec'))
    expect(
      decide([...writes, ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 5 })]),
    ).toEqual(runPhase('plan', 1))
  })
})

// ── Rule 4: the spec gate ────────────────────────────────────────────────────

describe('decideNext: rule 4 — spec gate (§6.3)', () => {
  test('no spec ever → wait/awaiting-spec (dispatch owns the import)', () => {
    expect(
      decide([
        ev('build.created', {
          ticket: { source: 'linear', id: 'ENG-42' },
          repo: 'defrex/app',
          baseBranch: 'main',
        }),
      ]),
    ).toEqual(wait('awaiting-spec'))
  })

  test('spec.authored satisfies the gate like spec.imported', () => {
    expect(
      decide([
        ev('build.created', {
          ticket: { source: 'linear', id: 'ENG-42' },
          repo: 'defrex/app',
          baseBranch: 'main',
        }),
        ev('spec.authored', { artifact: { kind: 'spec', rev: 0 }, session: 's_spec' }),
      ]),
    ).toEqual(runPhase('plan', 1))
  })
})

// ── Rule 5: the plan loop ────────────────────────────────────────────────────

describe('decideNext: rule 5 — plan loop', () => {
  test('revise verdict → next plan round with findings feedback', () => {
    expect(decide([...prelude(), ...planRound(1, 'revise', [finding('f_p1')])])).toEqual(
      runPhase('plan', 2, { findings: ['f_p1'] }),
    )
  })

  test('crashed plan round re-runs from its start (§15.6-C)', () => {
    expect(decide([...prelude(), ev('plan.started', { round: 1 })])).toEqual(runPhase('plan', 1))
  })

  test('crashed plan round 2 re-runs with recomputed findings feedback', () => {
    expect(
      decide([
        ...prelude(),
        ...planRound(1, 'revise', [finding('f_p1')]),
        ev('plan.started', { round: 2 }),
      ]),
    ).toEqual(runPhase('plan', 2, { findings: ['f_p1'] }))
  })

  test('plan completed without a verdict → the reviewer is due (crash included)', () => {
    const writes = [
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
    ]
    expect(decide(writes)).toEqual(runPhase('plan-review', 1))
    expect(decide([...writes, ev('plan-review.started', { round: 1 })])).toEqual(
      runPhase('plan-review', 1),
    )
  })

  test('escalate verdict without escalation.raised → repair the CLI crash gap', () => {
    expect(
      decide([...prelude(), ...planRound(1, 'escalate', [], 'spec assumes a missing endpoint')]),
    ).toEqual({
      kind: 'raise-escalation',
      source: 'agent',
      phase: 'plan-review',
      round: 1,
      question: 'spec assumes a missing endpoint',
    })
  })

  test('escalate verdict without a reason gets the default question', () => {
    expect(decide([...prelude(), ...planRound(1, 'escalate')])).toEqual({
      kind: 'raise-escalation',
      source: 'agent',
      phase: 'plan-review',
      round: 1,
      question: 'reviewer escalated',
    })
  })

  test('answered guidance on an escalate verdict feeds plan round R+1', () => {
    expect(
      decide([
        ...prelude(),
        ...planRound(1, 'escalate', [], 'unsure about scope'),
        ev(
          'escalation.raised',
          { id: 'e_1', phase: 'plan-review', round: 1, source: 'agent', question: 'unsure about scope' },
        ),
        ev('escalation.answered', { id: 'e_1', answer: 'Only the API surface.', resolution: 'guidance' }),
      ]),
    ).toEqual(runPhase('plan', 2, { guidance: { escalation: 'e_1', answer: 'Only the API surface.' } }))
  })

  test('guidance from a plan-phase escalation feeds the crashed round re-run', () => {
    expect(
      decide([
        ...prelude(),
        ev('plan.started', { round: 1 }),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', round: 1, source: 'agent', question: 'Which auth flow?' }),
        ev('escalation.answered', { id: 'e_1', answer: 'OAuth only.', resolution: 'guidance' }),
      ]),
    ).toEqual(runPhase('plan', 1, { guidance: { escalation: 'e_1', answer: 'OAuth only.' } }))
  })

  test('plan-loop guidance is consumed once plan.started CARRIES it (§15.6-B delivery)', () => {
    const writes = [
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('escalation.raised', { id: 'e_1', phase: 'plan', round: 1, source: 'agent', question: 'Which auth flow?' }),
      ev('escalation.answered', { id: 'e_1', answer: 'OAuth only.', resolution: 'guidance' }),
      // The guidance-fed re-run starts, citing the answer in its payload —
      // symmetric with implement.started (§15.3); this is what consumes it.
      ev('plan.started', {
        round: 1,
        feedback: { guidance: { escalation: 'e_1', answer: 'OAuth only.' } },
      }),
    ]
    // consumed at the citing start: the crash re-run recomputes without it
    expect(decide(writes)).toEqual(runPhase('plan', 1))
    expect(
      decide([
        ...writes,
        ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
        ev('plan-review.started', { round: 1 }),
        ev('plan-review.verdict', {
          round: 1,
          verdict: 'revise',
          findings: [finding('f_p1')],
          artifact: { kind: 'plan-review', rev: 0 },
        }),
      ]),
    ).toEqual(runPhase('plan', 2, { findings: ['f_p1'] })) // not the stale guidance
  })

  test('a plan.started that fails to carry the answer does NOT consume it (crash gap)', () => {
    // Regression: the engine used to treat ANY plan.started after the answer
    // as consumption, so an answer arriving while the runner was parked was
    // marked consumed the moment the (blind) next round started and the
    // human's authoritative feedback silently vanished (§15.6-B, §2.2).
    expect(
      decide([
        ...prelude(),
        ev('plan.started', { round: 1 }),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', round: 1, source: 'agent', question: 'Which auth flow?' }),
        ev('escalation.answered', { id: 'e_1', answer: 'OAuth only.', resolution: 'guidance' }),
        ev('plan.started', { round: 1 }), // crashed before `ab context` — no feedback carried
      ]),
    ).toEqual(runPhase('plan', 1, { guidance: { escalation: 'e_1', answer: 'OAuth only.' } }))
  })

  test('a persistence chain surviving stallRounds → stall escalation with chain refs', () => {
    expect(
      decide([
        ...prelude(),
        ...planRound(1, 'revise', [finding('f_p1')]),
        ...planRound(2, 'revise', [finding('f_p2', ['f_p1'])]),
        ...planRound(3, 'revise', [finding('f_p3', ['f_p2'])]),
      ]),
    ).toEqual({
      kind: 'raise-escalation',
      source: 'stall',
      phase: 'plan-review',
      round: 3,
      question: 'finding chain persisted 3 rounds: f_p1 -> f_p2 -> f_p3',
      refs: ['f_p1', 'f_p2', 'f_p3'],
    })
  })

  test('maxReviewRounds exhausted (fresh findings each round) → policy escalation', () => {
    expect(
      decide([
        ...prelude(),
        ...planRound(1, 'revise', [finding('f_a')]),
        ...planRound(2, 'revise', [finding('f_b')]),
        ...planRound(3, 'revise', [finding('f_c')]),
        ...planRound(4, 'revise', [finding('f_d')]),
        ...planRound(5, 'revise', [finding('f_e')]),
      ]),
    ).toEqual({
      kind: 'raise-escalation',
      source: 'policy',
      phase: 'plan-review',
      round: 5,
      question: 'maxReviewRounds (5) exhausted without approval',
    })
  })

  test('policy escalation dedupes after raising; answered guidance burns another round', () => {
    const writes = [
      ...prelude(),
      ...planRound(1, 'revise', [finding('f_a')]),
      ...planRound(2, 'revise', [finding('f_b')]),
      ...planRound(3, 'revise', [finding('f_c')]),
      ...planRound(4, 'revise', [finding('f_d')]),
      ...planRound(5, 'revise', [finding('f_e')]),
      ev(
        'escalation.raised',
        {
          id: 'e_1',
          phase: 'plan-review',
          round: 5,
          source: 'policy',
          question: 'maxReviewRounds (5) exhausted without approval',
        },
        KERNEL,
      ),
    ]
    expect(decide(writes)).toEqual(wait('blocked'))
    expect(
      decide([
        ...writes,
        ev('escalation.answered', { id: 'e_1', answer: 'One more round: drop scope X.', resolution: 'guidance' }),
      ]),
    ).toEqual(
      runPhase('plan', 6, { guidance: { escalation: 'e_1', answer: 'One more round: drop scope X.' } }),
    )
  })
})

// ── Rule 6: the code loop (walkthroughs B and C) ─────────────────────────────

describe('decideNext: rule 6 — code loop (walkthroughs B & C)', () => {
  const threeReviseRounds: EventWrite[] = [
    ...prelude(), // 1-4
    ...planApproved(), // 5-8
    ...implementRound(1, 'sha-r1'), // 9-10
    ...codeReview(1, 'revise', [finding('f_1')]), // 11-12
    ...implementRound(2, 'sha-r2', { findings: ['f_1'] }), // 13-14
    ...codeReview(2, 'revise', [finding('f_2', ['f_1'])]), // 15-16
    ...implementRound(3, 'sha-r3', { findings: ['f_2'] }), // 17-18
    ...codeReview(3, 'revise', [finding('f_3', ['f_2'])]), // 19-20
  ]
  const stallRaised = ev(
    'escalation.raised',
    {
      id: 'e_1',
      phase: 'code-review',
      round: 3,
      source: 'stall',
      question: 'finding chain persisted 3 rounds: f_1 -> f_2 -> f_3',
      refs: ['f_1', 'f_2', 'f_3'],
    },
    KERNEL, // stall escalations come from the kernel (§15.4)
  )
  const GUIDANCE = 'The reviewer is right: validate at the boundary.'

  test('revise verdict → implement R+1 with findings feedback', () => {
    expect(
      decide([...prelude(), ...planApproved(), ...implementRound(1, 'sha-r1'), ...codeReview(1, 'revise', [finding('f_1')])]),
    ).toEqual(runPhase('implement', 2, { findings: ['f_1'] }))
  })

  test('implement completed without a verdict → code-review is due', () => {
    expect(
      decide([...prelude(), ...planApproved(), ...implementRound(1, 'sha-r1')]),
    ).toEqual(runPhase('code-review', 1))
  })

  test('walkthrough C: log ending at implement.started r2 re-runs implement r2', () => {
    expect(
      decide([
        ...prelude(),
        ...planApproved(),
        ...implementRound(1, 'sha-r1'),
        ...codeReview(1, 'revise', [finding('f_1')]),
        ev('implement.started', { round: 2, feedback: { findings: ['f_1'] } }),
      ]),
    ).toEqual(runPhase('implement', 2, { findings: ['f_1'] }))
  })

  test('three revise rounds with a persists chain → stall escalation, exactly the chain', () => {
    expect(decide(threeReviseRounds)).toEqual({
      kind: 'raise-escalation',
      source: 'stall',
      phase: 'code-review',
      round: 3,
      question: 'finding chain persisted 3 rounds: f_1 -> f_2 -> f_3',
      refs: ['f_1', 'f_2', 'f_3'],
    })
  })

  test('the stall decision is stable on re-decide (raised exactly once)', () => {
    expect(decide(threeReviseRounds)).toEqual(decide(threeReviseRounds))
    // once escalation.raised lands, the open escalation blocks (no re-raise)
    expect(decide([...threeReviseRounds, stallRaised])).toEqual(wait('blocked'))
  })

  test('answered guidance → implement R+1 with guidance feedback', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: GUIDANCE, resolution: 'guidance' }),
      ]),
    ).toEqual(runPhase('implement', 4, { guidance: { escalation: 'e_1', answer: GUIDANCE } }))
  })

  test('guidance is consumed once implement.started carries it (crash re-run falls back to findings)', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: GUIDANCE, resolution: 'guidance' }),
        ev('implement.started', { round: 4, feedback: { guidance: { escalation: 'e_1', answer: GUIDANCE } } }),
      ]),
    ).toEqual(runPhase('implement', 4, { findings: ['f_3'] }))
  })

  test('consumed guidance is not reused: the next revise round gets findings feedback', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: GUIDANCE, resolution: 'guidance' }),
        ...implementRound(4, 'sha-r4', { guidance: { escalation: 'e_1', answer: GUIDANCE } }),
        ...codeReview(4, 'revise', [finding('f_4')]), // fresh finding — chain not continued
      ]),
    ).toEqual(runPhase('implement', 5, { findings: ['f_4'] }))
  })

  test('a reviewer continuing the chain after guidance re-escalates at the next revise', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: GUIDANCE, resolution: 'guidance' }),
        ...implementRound(4, 'sha-r4', { guidance: { escalation: 'e_1', answer: GUIDANCE } }),
        ...codeReview(4, 'revise', [finding('f_4', ['f_3'])]), // chain lives on
      ]),
    ).toEqual({
      kind: 'raise-escalation',
      source: 'stall',
      phase: 'code-review',
      round: 4,
      question: 'finding chain persisted 4 rounds: f_1 -> f_2 -> f_3 -> f_4',
      refs: ['f_1', 'f_2', 'f_3', 'f_4'],
    })
  })

  test('answered dismiss-finding → the loop continues with the chain suppressed', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: 'Not a real issue.', resolution: 'dismiss-finding' }),
      ]),
    ).toEqual(runPhase('implement', 4, { findings: ['f_3'] }))
  })

  test('no re-stall on the dismissed chain: the next reviewer round proceeds', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: 'Not a real issue.', resolution: 'dismiss-finding' }),
        ...implementRound(4, 'sha-r4', { findings: ['f_3'] }),
        ...codeReview(4, 'revise', [finding('f_5')]), // fresh disagreement only
      ]),
    ).toEqual(runPhase('implement', 5, { findings: ['f_5'] }))
  })

  test('a reviewer overriding the dismissal resurrects the chain and re-escalates', () => {
    expect(
      decide([
        ...threeReviseRounds,
        stallRaised,
        ev('escalation.answered', { id: 'e_1', answer: 'Not a real issue.', resolution: 'dismiss-finding' }),
        ...implementRound(4, 'sha-r4', { findings: ['f_3'] }),
        ...codeReview(4, 'revise', [finding('f_5', ['f_3'])]), // continues the dismissed tip
      ]),
    ).toEqual({
      kind: 'raise-escalation',
      source: 'stall',
      phase: 'code-review',
      round: 4,
      question: 'finding chain persisted 4 rounds: f_1 -> f_2 -> f_3 -> f_5',
      refs: ['f_1', 'f_2', 'f_3', 'f_5'],
    })
  })

  test('code-review escalate crash gap repairs, then guidance feeds implement R+1', () => {
    const writes = [
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'escalate', [], 'risky migration'),
    ]
    expect(decide(writes)).toEqual({
      kind: 'raise-escalation',
      source: 'agent',
      phase: 'code-review',
      round: 1,
      question: 'risky migration',
    })
    expect(
      decide([
        ...writes,
        ev('escalation.raised', { id: 'e_1', phase: 'code-review', round: 1, source: 'agent', question: 'risky migration' }),
        ev('escalation.answered', { id: 'e_1', answer: 'Migration is fine, ship it.', resolution: 'guidance' }),
      ]),
    ).toEqual(
      runPhase('implement', 2, { guidance: { escalation: 'e_1', answer: 'Migration is fine, ship it.' } }),
    )
  })
})

// ── Rule 7: verify (walkthrough A) ───────────────────────────────────────────

describe('decideNext: rule 7 — verify (walkthrough A, §15.6-A)', () => {
  const report0 = { kind: 'verify-report:unit', rev: 0 }
  const report1 = { kind: 'verify-report:unit', rev: 1 }
  const report2 = { kind: 'verify-report:unit', rev: 2 }

  const failAtUnit: EventWrite[] = [
    ...prelude(), // 1-4
    ...planApproved(), // 5-8
    ...implementRound(1, 'sha-r1'), // 9-10
    ...codeReview(1, 'approve'), // 11-12
    ...verifyRun('types', 1, true), // 13-14
    ...verifyRun('unit', 1, false, report0), // 15-16
  ]

  test('a failed step routes back into the code loop with the report (§15.6-A)', () => {
    expect(decide(failAtUnit)).toEqual(
      runPhase('implement', 2, { verify: { step: 'unit', report: report0 } }),
    )
  })

  test('a crashed fail-routed implement round re-runs with the same verify feedback', () => {
    expect(
      decide([
        ...failAtUnit,
        ev('implement.started', { round: 2, feedback: { verify: { step: 'unit', report: report0 } } }),
      ]),
    ).toEqual(runPhase('implement', 2, { verify: { step: 'unit', report: report0 } }))
  })

  test('the fixed round goes to code-review, then verify re-runs from the FIRST step at attempt 2', () => {
    const fixed = [...failAtUnit, ...implementRound(2, 'sha-r2', { verify: { step: 'unit', report: report0 } })]
    expect(decide(fixed)).toEqual(runPhase('code-review', 2))
    expect(decide([...fixed, ...codeReview(2, 'approve')])).toEqual({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit',
      attempt: 2,
    })
  })

  test('a pending fail routes via the code loop — the step is never re-run directly', () => {
    // types passed, unit failed, nothing else: the next decision is implement,
    // not run-check unit.
    expect(decide(failAtUnit)).not.toEqual(
      expect.objectContaining({ kind: 'run-check', step: 'unit' }),
    )
  })

  const exhausted: EventWrite[] = [
    ...failAtUnit, // fail 1 (seq 16)
    ...implementRound(2, 'sha-r2', { verify: { step: 'unit', report: report0 } }), // 17-18
    ...codeReview(2, 'approve'), // 19-20
    ...verifyRun('types', 2, true), // 21-22
    ...verifyRun('unit', 2, false, report1), // 23-24 — fail 2
    ...implementRound(3, 'sha-r3', { verify: { step: 'unit', report: report1 } }), // 25-26
    ...codeReview(3, 'approve'), // 27-28
    ...verifyRun('types', 3, true), // 29-30
    ...verifyRun('unit', 3, false, report2), // 31-32 — fail 3 = maxVerifyAttempts
  ]

  test('the second fail routes with attempt counting up', () => {
    const secondFail = exhausted.slice(0, exhausted.length - 8)
    expect(decide(secondFail)).toEqual(
      runPhase('implement', 3, { verify: { step: 'unit', report: report1 } }),
    )
  })

  test('maxVerifyAttempts exhausted → policy escalation, exactly once', () => {
    const expected: Decision = {
      kind: 'raise-escalation',
      source: 'policy',
      phase: 'verify:unit',
      question: 'maxVerifyAttempts (3) exhausted: verify:unit is still failing',
    }
    expect(decide(exhausted)).toEqual(expected)
    expect(decide(exhausted)).toEqual(decide(exhausted)) // stable on re-decide
    expect(
      decide([
        ...exhausted,
        ev(
          'escalation.raised',
          { id: 'e_1', phase: 'verify:unit', source: 'policy', question: expected.kind === 'raise-escalation' ? expected.question : '' },
          KERNEL,
        ),
      ]),
    ).toEqual(wait('blocked'))
  })

  test('guidance after exhaustion outranks the verify report (feedback priority)', () => {
    expect(
      decide([
        ...exhausted,
        ev(
          'escalation.raised',
          { id: 'e_1', phase: 'verify:unit', source: 'policy', question: 'stuck' },
          KERNEL,
        ),
        ev('escalation.answered', { id: 'e_1', answer: 'Skip the flaky asserts.', resolution: 'guidance' }),
      ]),
    ).toEqual(
      runPhase('implement', 4, { guidance: { escalation: 'e_1', answer: 'Skip the flaky asserts.' } }),
    )
  })

  test('a fail without a report still routes to implement, without feedback', () => {
    expect(
      decide([
        ...prelude(),
        ...planApproved(),
        ...implementRound(1, 'sha-r1'),
        ...codeReview(1, 'approve'),
        ...verifyRun('types', 1, false),
      ]),
    ).toEqual(runPhase('implement', 2))
  })

  test('a verify step started but not completed re-runs (crash semantics)', () => {
    expect(
      decide([
        ...prelude(),
        ...planApproved(),
        ...implementRound(1, 'sha-r1'),
        ...codeReview(1, 'approve'),
        ...verifyRun('types', 1, true),
        ev('verify.started', { step: 'unit', attempt: 1 }),
      ]),
    ).toEqual({ kind: 'run-check', step: 'unit', command: 'bun test', attempt: 1 })
  })

  test('no verify steps configured → straight to finalize', () => {
    const bare = parseConfig('[dispatcher]\nreadyState = "ready"\n')
    expect(
      decideNext(
        toLog([...prelude(), ...planApproved(), ...implementRound(1, 'sha-r1'), ...codeReview(1, 'approve')]),
        bare,
      ),
    ).toEqual(runPhase('finalize', 1))
  })
})

// ── Rule 8: finalize ─────────────────────────────────────────────────────────

describe('decideNext: rule 8 — finalize', () => {
  const greenBuild: EventWrite[] = [
    ...prelude(),
    ...planApproved(),
    ...implementRound(1, 'sha-r1'),
    ...codeReview(1, 'approve'),
    ...verifyAllPass(1),
  ]

  test('all verify steps passed and no finalize.completed → run finalize', () => {
    expect(decide(greenBuild)).toEqual(runPhase('finalize', 1))
  })

  test('finalize.started without completion re-runs (crash semantics)', () => {
    expect(decide([...greenBuild, ev('finalize.started', {})])).toEqual(runPhase('finalize', 1))
  })

  test('post-steps run in config order after finalize.completed', () => {
    const twoSteps = parseConfig(
      '[dispatcher]\nreadyState = "ready"\n[finalize]\nsteps = ["release-notes", "screenshots"]\n',
    )
    const done = [
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ev('finalize.started', {}),
      ev('finalize.completed', { pr: PR }),
    ]
    expect(decideNext(toLog(done), twoSteps)).toEqual({
      kind: 'run-finalize-step',
      step: 'release-notes',
    })
    // ok:false still counts — post-steps are failure-tolerant (§5): a failed
    // step files an observation, never re-runs, never kills a green build.
    const firstFailed = [...done, ev('finalize.step-completed', { step: 'release-notes', ok: false, note: 'no template' })]
    expect(decideNext(toLog(firstFailed), twoSteps)).toEqual({
      kind: 'run-finalize-step',
      step: 'screenshots',
    })
    expect(
      decideNext(toLog([...firstFailed, ev('finalize.step-completed', { step: 'screenshots', ok: true })]), twoSteps),
    ).toEqual(wait('awaiting-pr'))
  })

  test('no post-steps configured → straight to awaiting-pr', () => {
    const bare = parseConfig('[dispatcher]\nreadyState = "ready"\n')
    expect(
      decideNext(
        toLog([
          ...prelude(),
          ...planApproved(),
          ...implementRound(1, 'sha-r1'),
          ...codeReview(1, 'approve'),
          ev('finalize.started', {}),
          ev('finalize.completed', { pr: PR }),
        ]),
        bare,
      ),
    ).toEqual(wait('awaiting-pr'))
  })
})

// ── Rule 9: post-PR epilogue (§15.7) ─────────────────────────────────────────

describe('decideNext: rule 9 — post-PR epilogue (§15.7)', () => {
  const throughFinalize: EventWrite[] = [
    ...prelude(), // 1-4
    ...planApproved(), // 5-8
    ...implementRound(1, 'sha-r1'), // 9-10
    ...codeReview(1, 'approve'), // 11-12
    ...verifyAllPass(1), // 13-18
    ...finalized(), // 19-21
  ]

  function reconcileCycle(attempt: number, baseSha: string): EventWrite[] {
    return [
      ev('pr.conflicted', { baseSha }),
      ev('reconcile.started', { attempt, baseSha }),
      ev('reconcile.completed', {
        mergeCommit: `sha-mc-${attempt}`,
        artifact: { kind: 'reconcile-notes', rev: attempt - 1 },
      }),
      // Each full re-run is a NEW cycle at a fresh attempt number (§15.6-A):
      // the mainline ran attempt 1, reconcile N's re-run is attempt N+1.
      ...verifyAllPass(attempt + 1),
    ]
  }

  test('an open PR waits for the janitor', () => {
    expect(decide(throughFinalize)).toEqual(wait('awaiting-pr'))
  })

  test('merged and closed both wait — the janitor completes the build', () => {
    expect(decide([...throughFinalize, ev('pr.merged', { sha: 'sha-squash' })])).toEqual(
      wait('awaiting-pr'),
    )
    expect(decide([...throughFinalize, ev('pr.closed', {})])).toEqual(wait('awaiting-pr'))
  })

  test('pr.conflicted → reconcile attempt 1 with the conflict baseSha', () => {
    expect(decide([...throughFinalize, ev('pr.conflicted', { baseSha: 'sha-main-2' })])).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1, baseSha: 'sha-main-2' },
    })
  })

  test('a crashed reconcile re-runs the SAME attempt (§15.6-C)', () => {
    expect(
      decide([
        ...throughFinalize,
        ev('pr.conflicted', { baseSha: 'sha-main-2' }),
        ev('reconcile.started', { attempt: 1, baseSha: 'sha-main-2' }),
      ]),
    ).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1, baseSha: 'sha-main-2' },
    })
  })

  test('after reconcile.completed, verify re-runs in full from the first step at a FRESH attempt', () => {
    // Regression: the re-run used to reuse the mainline's attempt number, so
    // the reducer's current-cycle projection (attempt === verify.attempt)
    // mixed the pre-finalize cycle into the post-reconcile one and D5 failure
    // keys (verify:<step>, round = attempt) collided across the cycles.
    // Attempt numbers are monotonic over the full log, like loop rounds.
    expect(
      decide([
        ...throughFinalize, // mainline cycle ran at attempt 1
        ev('pr.conflicted', { baseSha: 'sha-main-2' }),
        ev('reconcile.started', { attempt: 1, baseSha: 'sha-main-2' }),
        ev('reconcile.completed', {
          mergeCommit: 'sha-mc-1',
          artifact: { kind: 'reconcile-notes', rev: 0 },
        }),
      ]),
    ).toEqual({ kind: 'run-check', step: 'types', command: 'bun tsc --noEmit', attempt: 2 })
  })

  test('a verify failure after reconcile re-enters the code loop as usual (§15.7)', () => {
    const report = { kind: 'verify-report:types', rev: 0 }
    expect(
      decide([
        ...throughFinalize,
        ev('pr.conflicted', { baseSha: 'sha-main-2' }),
        ev('reconcile.started', { attempt: 1, baseSha: 'sha-main-2' }),
        ev('reconcile.completed', {
          mergeCommit: 'sha-mc-1',
          artifact: { kind: 'reconcile-notes', rev: 0 },
        }),
        ...verifyRun('types', 2, false, report),
      ]),
    ).toEqual(runPhase('implement', 2, { verify: { step: 'types', report } }))
  })

  test('a green verify re-run returns to awaiting-pr without re-running post-steps', () => {
    expect(
      decide([...throughFinalize, ...reconcileCycle(1, 'sha-main-2')]),
    ).toEqual(wait('awaiting-pr'))
  })

  test('conflicts past maxReconcileAttempts → policy escalation, once per conflict', () => {
    const thrash = [
      ...throughFinalize,
      ...reconcileCycle(1, 'sha-main-2'),
      ...reconcileCycle(2, 'sha-main-3'),
      ...reconcileCycle(3, 'sha-main-4'),
      ev('pr.conflicted', { baseSha: 'sha-main-5' }),
    ]
    const expected: Decision = {
      kind: 'raise-escalation',
      source: 'policy',
      phase: 'reconcile',
      question: 'maxReconcileAttempts (3) exhausted',
    }
    expect(decide(thrash)).toEqual(expected)
    expect(
      decide([
        ...thrash,
        ev(
          'escalation.raised',
          { id: 'e_9', phase: 'reconcile', source: 'policy', question: 'maxReconcileAttempts (3) exhausted' },
          KERNEL,
        ),
      ]),
    ).toEqual(wait('blocked'))
  })

  test('an answered escalation lets reconcile proceed past the cap', () => {
    expect(
      decide([
        ...throughFinalize,
        ...reconcileCycle(1, 'sha-main-2'),
        ...reconcileCycle(2, 'sha-main-3'),
        ...reconcileCycle(3, 'sha-main-4'),
        ev('pr.conflicted', { baseSha: 'sha-main-5' }),
        ev(
          'escalation.raised',
          { id: 'e_9', phase: 'reconcile', source: 'policy', question: 'maxReconcileAttempts (3) exhausted' },
          KERNEL,
        ),
        ev('escalation.answered', { id: 'e_9', answer: 'Keep trying, base settled.', resolution: 'guidance' }),
      ]),
    ).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 4,
      reconcile: { attempt: 4, baseSha: 'sha-main-5' },
    })
  })
})

// ── Spec revision: the restart boundary (§6.3) ───────────────────────────────

describe('decideNext: spec revision restart (§6.3)', () => {
  // Everything approved and verified against spec rev 0, then a mid-flight
  // escalation forces rev 1. Includes a pre-restart verify FAILURE so the
  // attempt reset is observable.
  const preRestart: EventWrite[] = [
    ...prelude(), // 1-4
    ...planApproved(), // 5-8
    ...implementRound(1, 'sha-r1'), // 9-10
    ...codeReview(1, 'approve'), // 11-12
    ...verifyRun('types', 1, false, { kind: 'verify-report:types', rev: 0 }), // 13-14
    ev('escalation.raised', {
      id: 'e_1',
      phase: 'implement',
      round: 2,
      source: 'agent',
      question: 'The spec assumes an endpoint that does not exist.',
    }), // 15
  ]
  const revised: EventWrite[] = [
    ...preRestart,
    ev('escalation.answered', {
      id: 'e_1',
      answer: 'Right — spec updated to use the sessions endpoint.',
      resolution: 'revise-spec',
    }), // 16
    ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 15 }), // 17
  ]

  test('revise-spec parks the build until spec.revised lands', () => {
    expect(decide(preRestart)).toEqual(wait('blocked'))
    expect(decide(revised.slice(0, revised.length - 1))).toEqual(wait('awaiting-spec'))
  })

  test('after spec.revised the build restarts from plan — stale approvals ignored', () => {
    // Plan was approved and code-review approved for rev 0; none of it carries.
    // Round numbers continue monotonically: next plan round is 2, not 1.
    expect(decide(revised)).toEqual(runPhase('plan', 2))
  })

  test('post-restart rounds continue monotonically in the code loop too', () => {
    expect(
      decide([...revised, ...planRound(2, 'approve')]),
    ).toEqual(runPhase('implement', 2))
  })

  test('pre-restart verify results are ignored for routing, but attempt numbers continue', () => {
    // The pre-restart failure neither counts toward exhaustion nor routes
    // (§6.3) — but its attempt NUMBER is taken: the post-restart cycle runs
    // at attempt 2, monotonic like loop rounds, so "attempt 1" still names
    // exactly one run and the reducer's current-cycle projection (attempt ===
    // verify.attempt) can never resurrect the stale pre-restart failure.
    expect(
      decide([
        ...revised,
        ...planRound(2, 'approve'),
        ...implementRound(2, 'sha-r2'),
        ...codeReview(2, 'approve'),
      ]),
    ).toEqual({ kind: 'run-check', step: 'types', command: 'bun tsc --noEmit', attempt: 2 })
  })

  test('attempts stay collision-free across a restart with MULTIPLE pre-restart cycles', () => {
    // Regression: attempt used to be 1 + post-restart failure count, so this
    // rebuilt cycle re-ran at attempt 1 — colliding with the pre-restart
    // attempt-1 events (and any phase.failed keyed round=1, D5) — and the
    // reducer's documented current-cycle filter returned the stale attempt-2
    // FAILURE on a green build.
    const twoFailCycles: EventWrite[] = [
      ...prelude(), // 1-4
      ...planApproved(), // 5-8
      ...implementRound(1, 'sha-r1'), // 9-10
      ...codeReview(1, 'approve'), // 11-12
      ...verifyRun('types', 1, false, { kind: 'verify-report:types', rev: 0 }), // 13-14
      ...implementRound(2, 'sha-r2', {
        verify: { step: 'types', report: { kind: 'verify-report:types', rev: 0 } },
      }), // 15-16
      ...codeReview(2, 'approve'), // 17-18
      ...verifyRun('types', 2, false, { kind: 'verify-report:types', rev: 1 }), // 19-20
      ev('escalation.raised', {
        id: 'e_2',
        phase: 'implement',
        round: 3,
        source: 'agent',
        question: 'The spec is unimplementable as written.',
      }), // 21
      ev('escalation.answered', { id: 'e_2', answer: 'Spec updated.', resolution: 'revise-spec' }), // 22
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 21 }), // 23
      // Rounds continue monotonically across the restart (§6.3): plan was at
      // round 1, implement at round 2.
      ...planRound(2, 'approve'),
      ...implementRound(3, 'sha-r3'),
      ...codeReview(3, 'approve'),
    ]
    expect(decide(twoFailCycles)).toEqual({
      kind: 'run-check',
      step: 'types',
      command: 'bun tsc --noEmit',
      attempt: 3, // max attempt ever (2) + 1 — never a reused number
    })
    // The crashed-step rule still holds at the continued number: a started-
    // but-not-completed step re-runs at the SAME attempt (§15.6-C).
    expect(
      decide([...twoFailCycles, ev('verify.started', { step: 'types', attempt: 3 })]),
    ).toEqual({ kind: 'run-check', step: 'types', command: 'bun tsc --noEmit', attempt: 3 })
  })

  test('a crashed plan round after the restart re-runs at the continued number', () => {
    expect(decide([...revised, ev('plan.started', { round: 2 })])).toEqual(runPhase('plan', 2))
  })
})
