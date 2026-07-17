/**
 * Reducer seam tests (SPEC §15.5), fixture-driven off the walkthroughs in
 * §15.6. Envelopes are constructed directly — seq by index, ts from a
 * steppingClock — and every fixture write passes `validateEventWrite`, so a
 * fixture that drifts from the vocabulary fails loudly.
 */
import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
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
import type { Finding } from '../ontology'
import { steppingClock } from '../testing/fixed'
import { reduceBuild, type BuildState } from './reducer'

const BUILD = 'auth-rate-limit'

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

/** Reduce the prefix ending at (and including) the nth event of `type`. */
function stateAfter(log: AbEvent[], type: EventType, nth = 1): BuildState {
  let seen = 0
  for (const event of log) {
    if (event.type === type) {
      seen += 1
      if (seen === nth) return reduceBuild(log.slice(0, event.seq))
    }
  }
  throw new Error(`fixture has no occurrence ${nth} of ${type}`)
}

function finding(id: string, persists: string[] = []): Finding {
  return { id, severity: 'blocking', summary: `finding ${id}`, persists }
}

// ── Fixture segments ─────────────────────────────────────────────────────────

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

function planApproved(): EventWrite[] {
  return [
    ev('plan.started', { round: 1 }),
    ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
    ev('plan-review.started', { round: 1 }),
    ev('plan-review.verdict', {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    }),
  ]
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
  verdict: 'approve' | 'revise',
  findings: Finding[] = [],
): EventWrite[] {
  return [
    ev('code-review.started', { round }),
    ev('code-review.verdict', {
      round,
      verdict,
      findings,
      artifact: { kind: 'code-review', rev: round - 1 },
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('reduceBuild: empty log', () => {
  test('reduces to queued with zeroed projections', () => {
    const state = reduceBuild([])
    expect(state.status).toBe('queued')
    expect(state.phase).toBeUndefined()
    expect(state.round).toBe(0)
    expect(state.currentPhase).toBeUndefined()
    expect(state.lastCompletedPhase).toBeUndefined()
    expect(state.lastSeq).toBe(0)
    expect(state.lastEvent).toBeUndefined()
    expect(state.specRev).toBeUndefined()
    expect(state.pr).toBeUndefined()
    expect(state.prState).toBeUndefined()
    expect(state.plan).toEqual({ round: 0, approved: false })
    expect(state.implement).toEqual({ round: 0 })
    expect(state.codeReviewApproved).toBe(false)
    expect(state.reviewFindings).toEqual({ planReview: [], codeReview: [] })
    expect(state.verify).toEqual({ attempt: 0, results: [], cycleSince: 0 })
    expect(state.restartSince).toBe(0)
    expect(state.finalizeCompletedSeq).toBe(0)
    expect(state.finalizeSteps).toEqual([])
    expect(state.codeReviewApproval).toBeUndefined()
    expect(state.reconcileAttempts).toBe(0)
    expect(state.openEscalations).toEqual([])
    expect(state.answeredEscalations).toEqual([])
    expect(state.observations).toEqual([])
    expect(state.pendingCommands).toEqual([])
    expect(state.sessions.open).toEqual([])
    expect(state.failures).toEqual({})
  })
})

describe('reduceBuild: §15.6 happy path', () => {
  const log = toLog([
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
    ...implementRound(1, 'sha-r1').slice(1), // 13 (completed only; started was 11)
    ...codeReview(1, 'approve'), // 14-15
    ...verifyRun('types', 1, true), // 16-17
    ...verifyRun('unit', 1, true), // 18-19
    ...verifyRun('e2e', 1, true), // 20-21
    ev('finalize.started', {}), // 22
    ev('finalize.completed', {
      pr: { number: 7, url: 'https://github.com/defrex/app/pull/7', headSha: 'sha-r1' },
    }), // 23
    ev('finalize.step-completed', { step: 'release-notes', ok: true }), // 24
    ev('pr.merged', { sha: 'sha-squash' }), // 25
    ev('workspace.released', {}), // 26
    ev('build.completed', { outcome: 'merged' }), // 27
  ])

  test('queued until runner.attached, running after (§15.5)', () => {
    const beforeAttach = stateAfter(log, 'spec.imported')
    expect(beforeAttach.status).toBe('queued')
    expect(beforeAttach.specRev).toBe(0)
    const afterAttach = stateAfter(log, 'runner.attached')
    expect(afterAttach.status).toBe('running')
    expect(afterAttach.phase).toBeUndefined()
    expect(afterAttach.round).toBe(0)
  })

  test('session brackets project into sessions.open', () => {
    const during = stateAfter(log, 'plan.started')
    expect(during.sessions.open).toEqual([
      {
        session: 's_plan_1',
        role: 'plan',
        runner: 'claude',
        model: undefined,
        phase: 'plan',
        round: 1,
        seq: 5,
      },
    ])
    const after = stateAfter(log, 'session.ended')
    expect(after.sessions.open).toEqual([])
  })

  test('plan loop: started sets currentPhase, terminal moves it to lastCompleted', () => {
    const started = stateAfter(log, 'plan.started')
    expect(started.currentPhase).toEqual({ phase: 'plan', round: 1, seq: 6 })
    expect(started.phase).toBe('plan')
    expect(started.round).toBe(1)

    const completed = stateAfter(log, 'plan.completed')
    expect(completed.currentPhase).toBeUndefined()
    expect(completed.lastCompletedPhase).toEqual({ phase: 'plan', round: 1, seq: 7 })
    expect(completed.phase).toBe('plan') // falls back to lastCompletedPhase
    expect(completed.plan).toEqual({ round: 1, approved: false, artifactRev: 0 })

    const reviewed = stateAfter(log, 'plan-review.verdict')
    expect(reviewed.plan.approved).toBe(true)
    expect(reviewed.reviewFindings.planReview).toEqual([[]])
    expect(reviewed.lastCompletedPhase?.phase).toBe('plan-review')
  })

  test('implement records commits and notes; observation is captured', () => {
    const done = stateAfter(log, 'implement.completed')
    expect(done.implement).toEqual({
      round: 1,
      commits: { base: 'sha-base', head: 'sha-r1' },
      artifactRev: 0,
    })
    expect(done.observations).toEqual([
      { id: 'o_1', kind: 'refactor', summary: 'extract limiter config', files: ['src/auth.ts'] },
    ])
    const reviewed = stateAfter(log, 'code-review.verdict')
    expect(reviewed.codeReviewApproved).toBe(true)
  })

  test('verify steps run in order within attempt 1', () => {
    const duringUnit = stateAfter(log, 'verify.started', 2)
    expect(duringUnit.currentPhase).toEqual({ phase: 'verify:unit', attempt: 1, seq: 18 })
    expect(duringUnit.phase).toBe('verify:unit')
    expect(duringUnit.round).toBe(1) // verify does not reset the loop round
    expect(duringUnit.verify.currentStep).toBe('unit')
    expect(duringUnit.verify.results).toEqual([
      { step: 'types', attempt: 1, pass: true, report: undefined, seq: 17 },
    ])

    const allDone = stateAfter(log, 'verify.completed', 3)
    expect(allDone.verify.attempt).toBe(1)
    expect(allDone.verify.currentStep).toBeUndefined()
    expect(allDone.verify.results.map((r) => [r.step, r.pass])).toEqual([
      ['types', true],
      ['unit', true],
      ['e2e', true],
    ])
  })

  test('finalize opens the PR; janitor merges it; build completes done{merged}', () => {
    const finalized = stateAfter(log, 'finalize.completed')
    expect(finalized.pr).toEqual({
      number: 7,
      url: 'https://github.com/defrex/app/pull/7',
      headSha: 'sha-r1',
    })
    expect(finalized.prState).toBe('open')
    expect(finalized.lastCompletedPhase?.phase).toBe('finalize')
    expect(finalized.status).toBe('running')

    const merged = stateAfter(log, 'pr.merged')
    expect(merged.prState).toBe('merged')
    expect(merged.status).toBe('running') // done only after build.completed

    const final = reduceBuild(log)
    expect(final.status).toBe('done')
    expect(final.outcome).toBe('merged')
    expect(final.prState).toBe('merged')
    expect(final.lastSeq).toBe(27)
    expect(final.lastEvent?.type).toBe('build.completed')
    expect(final.openEscalations).toEqual([])
    expect(final.pendingCommands).toEqual([])
  })
})

describe('reduceBuild: walkthrough A — verify failure routes back (§15.6-A)', () => {
  const report = { kind: 'verify-report:e2e', rev: 0 }
  const log = toLog([
    ...prelude(),
    ...planApproved(),
    ...implementRound(1, 'sha-r1'),
    ...codeReview(1, 'approve'),
    ...verifyRun('types', 1, true),
    ...verifyRun('e2e', 1, false, report),
    ev('implement.started', { round: 2, feedback: { verify: { step: 'e2e', report } } }),
    ev('implement.completed', {
      round: 2,
      commits: { base: 'sha-base', head: 'sha-r2' },
      artifact: { kind: 'implement-notes', rev: 1 },
    }),
    ...codeReview(2, 'approve'),
    ...verifyRun('types', 2, true),
    ...verifyRun('e2e', 2, true),
  ])

  test('the failed step records its report and closes the verify phase', () => {
    const failed = stateAfter(log, 'verify.completed', 2)
    expect(failed.verify.results).toEqual([
      { step: 'types', attempt: 1, pass: true, report: undefined, seq: 14 },
      { step: 'e2e', attempt: 1, pass: false, report, seq: 16 },
    ])
    expect(failed.verify.currentStep).toBeUndefined()
    expect(failed.currentPhase).toBeUndefined()
    expect(failed.lastCompletedPhase).toEqual({ phase: 'verify:e2e', attempt: 1, seq: 16 })
    expect(failed.status).toBe('running') // a fail verdict is a fact, not a block
  })

  test('failure re-enters the code loop as implement round 2', () => {
    const reentered = stateAfter(log, 'implement.started', 2)
    expect(reentered.currentPhase).toEqual({ phase: 'implement', round: 2, seq: 17 })
    expect(reentered.round).toBe(2)
    expect(reentered.implement.round).toBe(2)
    // commits still point at round 1's pushed head until round 2 completes (D3)
    expect(reentered.implement.commits).toEqual({ base: 'sha-base', head: 'sha-r1' })
  })

  test('verify re-runs from the FIRST step with attempt 2', () => {
    const rerun = stateAfter(log, 'verify.started', 3)
    expect(rerun.verify.attempt).toBe(2)
    expect(rerun.verify.currentStep).toBe('types')
    expect(rerun.currentPhase?.phase).toBe('verify:types')
    expect(rerun.currentPhase?.attempt).toBe(2)

    const final = reduceBuild(log)
    expect(final.verify.attempt).toBe(2)
    // The current cycle is seq-based, not attempt-based (§15.6-A): the round-2
    // code-review approve moved `cycleSince` past attempt 1's results.
    const currentCycle = final.verify.results.filter((r) => r.seq > final.verify.cycleSince)
    expect(currentCycle.map((r) => [r.step, r.pass])).toEqual([
      ['types', true],
      ['e2e', true],
    ])
    expect(final.verify.results).toHaveLength(4) // history keeps attempt 1
  })
})

describe('reduceBuild: walkthrough B — review stall escalates (§15.6-B)', () => {
  const log = toLog([
    ...prelude(),
    ...planApproved(),
    ...implementRound(1, 'sha-r1'),
    ...codeReview(1, 'revise', [finding('f_1')]),
    ...implementRound(2, 'sha-r2', { findings: ['f_1'] }),
    ...codeReview(2, 'revise', [finding('f_2', ['f_1'])]),
    ...implementRound(3, 'sha-r3', { findings: ['f_2'] }),
    ...codeReview(3, 'revise', [finding('f_3', ['f_2'])]),
    ev(
      'escalation.raised',
      {
        id: 'e_1',
        phase: 'code-review',
        round: 3,
        source: 'stall',
        question: 'Finding f_1 has persisted for 3 rounds — who is right?',
        refs: ['f_1', 'f_2', 'f_3'],
      },
      KERNEL, // stall escalations come from the kernel, not the reviewer (§15.4)
    ),
    ev('escalation.answered', {
      id: 'e_1',
      answer: 'The reviewer is right: validate at the boundary.',
      resolution: 'guidance',
    }),
  ])

  test('three revise rounds accumulate findings with persists chains', () => {
    const stalled = stateAfter(log, 'code-review.verdict', 3)
    expect(stalled.reviewFindings.codeReview).toHaveLength(3)
    expect(stalled.reviewFindings.codeReview[0]?.[0]?.id).toBe('f_1')
    expect(stalled.reviewFindings.codeReview[1]?.[0]?.persists).toEqual(['f_1'])
    expect(stalled.reviewFindings.codeReview[2]?.[0]?.persists).toEqual(['f_2'])
    expect(stalled.codeReviewApproved).toBe(false)
    expect(stalled.status).toBe('running')
  })

  test('escalation.raised{source: stall} blocks the build', () => {
    const blocked = stateAfter(log, 'escalation.raised')
    expect(blocked.status).toBe('blocked')
    expect(blocked.openEscalations).toEqual([
      {
        id: 'e_1',
        phase: 'code-review',
        round: 3,
        source: 'stall',
        question: 'Finding f_1 has persisted for 3 rounds — who is right?',
        refs: ['f_1', 'f_2', 'f_3'],
        seq: 21,
      },
    ])
  })

  test('escalation.answered{guidance} unblocks with the resolution recorded', () => {
    const answered = reduceBuild(log)
    expect(answered.status).toBe('running')
    expect(answered.openEscalations).toEqual([])
    expect(answered.answeredEscalations).toHaveLength(1)
    expect(answered.answeredEscalations[0]).toMatchObject({
      id: 'e_1',
      resolution: 'guidance',
      answer: 'The reviewer is right: validate at the boundary.',
      phase: 'code-review',
      round: 3,
      seq: 21,
      answeredSeq: 22,
    })
  })
})

describe('reduceBuild: walkthrough C — sandbox death and resume (§15.6-C)', () => {
  const deadEnd: EventWrite[] = [
    ...prelude(),
    ...planApproved(),
    ...implementRound(1, 'sha-r1'),
    ...codeReview(1, 'revise', [finding('f_1')]),
    ev('session.started', {
      session: 's_impl_2',
      role: 'implement',
      runner: 'claude',
      phase: 'implement',
      round: 2,
    }),
    ev('implement.started', { round: 2, feedback: { findings: ['f_1'] } }),
    // …sandbox dies here: no terminal event, no session.ended
  ]
  const deadLog = toLog(deadEnd)
  const deadSeq = deadLog.length

  test('log ending at implement.started r2 exposes the phase to re-run', () => {
    const state = reduceBuild(deadLog)
    expect(state.status).toBe('running') // liveness is lease columns, not events (§15.2.6)
    expect(state.currentPhase).toEqual({ phase: 'implement', round: 2, seq: deadSeq })
    expect(state.phase).toBe('implement')
    expect(state.round).toBe(2)
    // The dead session is visibly still open — its session.ended never came.
    expect(state.sessions.open.map((s) => s.session)).toEqual(['s_impl_2'])
    // Resume anchor (D3): round 1's pushed head is where the fresh sandbox fetches.
    expect(state.implement.commits).toEqual({ base: 'sha-base', head: 'sha-r1' })
    expect(state.lastSeq).toBe(deadSeq)
  })

  test('a fresh sandbox re-attaches and re-runs the phase from its start', () => {
    const resumed = toLog([
      ...deadEnd,
      ev('workspace.provisioned', {
        provider: 'sandbox',
        ref: 'sb-2',
        branch: 'ab/auth-rate-limit',
      }),
      ev('runner.attached', {
        instance: 'runner-2',
        host: 'sandbox-2',
        resumedFromSeq: deadSeq,
      }),
      ev('session.started', {
        session: 's_impl_3',
        role: 'implement',
        runner: 'claude',
        phase: 'implement',
        round: 2,
      }),
      ev('implement.completed', {
        round: 2,
        commits: { base: 'sha-base', head: 'sha-r2' },
        artifact: { kind: 'implement-notes', rev: 1 },
      }),
    ])
    const state = reduceBuild(resumed)
    expect(state.status).toBe('running')
    expect(state.currentPhase).toBeUndefined()
    expect(state.lastCompletedPhase?.phase).toBe('implement')
    expect(state.lastCompletedPhase?.round).toBe(2)
    expect(state.implement.commits).toEqual({ base: 'sha-base', head: 'sha-r2' })
    expect(state.implement.artifactRev).toBe(1)
    // The orphaned session stays listed alongside the fresh one — honest history.
    expect(state.sessions.open.map((s) => s.session)).toEqual(['s_impl_2', 's_impl_3'])
  })
})

describe('reduceBuild: pause/resume and the paused+blocked overlap (§15.5)', () => {
  const log = toLog([
    ...prelude(),
    ev('escalation.raised', {
      id: 'e_1',
      phase: 'plan',
      round: 1,
      source: 'agent',
      question: 'Is backwards compatibility in scope?',
    }),
    ev('build.pause-requested', { reason: 'investigating' }),
    ev('build.paused', {}),
    ev('build.resume-requested', {}),
    ev('build.resumed', {}),
    ev('escalation.answered', { id: 'e_1', answer: 'No.', resolution: 'guidance' }),
    ev('build.pause-requested', {}),
    ev('build.paused', {}),
    ev('build.resumed', {}),
  ])

  test('pause request is pending until the kernel acknowledges', () => {
    const requested = stateAfter(log, 'build.pause-requested')
    expect(requested.status).toBe('blocked') // request alone changes nothing
    expect(requested.pendingCommands).toEqual([
      { command: 'pause', seq: 6, reason: 'investigating', actor: humanActor('aron') },
    ])
    const paused = stateAfter(log, 'build.paused')
    expect(paused.pendingCommands).toEqual([])
  })

  test('paused wins over blocked while both hold; unpausing re-reports blocked', () => {
    const blocked = stateAfter(log, 'escalation.raised')
    expect(blocked.status).toBe('blocked')

    // Overlap: escalation still open AND build.paused — paused takes precedence,
    // and the escalation is not lost.
    const paused = stateAfter(log, 'build.paused')
    expect(paused.status).toBe('paused')
    expect(paused.openEscalations).toHaveLength(1)

    const resumed = stateAfter(log, 'build.resumed')
    expect(resumed.status).toBe('blocked') // still blocked: escalation unanswered

    const answered = stateAfter(log, 'escalation.answered')
    expect(answered.status).toBe('running')
  })

  test('a plain pause/resume cycle with no escalation returns to running', () => {
    const paused = stateAfter(log, 'build.paused', 2)
    expect(paused.status).toBe('paused')
    const resumed = stateAfter(log, 'build.resumed', 2)
    expect(resumed.status).toBe('running')
    expect(resumed.pendingCommands).toEqual([])
  })

  test('an opposing request expires earlier pending requests (last command wins, §15.2.7)', () => {
    // Regression: a resume-request retained from before a pause used to
    // survive as pending and later be acknowledged AGAINST the pause — the
    // stale command resurrecting. A request now supersedes every earlier
    // pending request of the opposing kind.
    const staleResume = toLog([
      ...prelude(),
      ev('build.resume-requested', {}), // while running — retained…
      ev('build.pause-requested', {}), // …until the opposing request expires it
    ])
    const state = reduceBuild(staleResume)
    expect(state.pendingCommands.map((c) => c.command)).toEqual(['pause'])

    const stalePause = toLog([
      ...prelude(),
      ev('build.pause-requested', {}),
      ev('build.paused', {}),
      ev('build.pause-requested', {}), // duplicate while paused — never acked…
      ev('build.resume-requested', {}), // …expired by the opposing request
    ])
    expect(reduceBuild(stalePause).pendingCommands.map((c) => c.command)).toEqual(['resume'])
  })
})

describe('reduceBuild: native auto-merge intent and application facts', () => {
  const log = toLog([
    ...prelude(),
    ev('build.auto-merge-requested', {}), // seq 5
    ev('pr.auto-merge-enabled', { commandSeq: 5 }), // seq 6
    ev('build.auto-merge-cancelled', {}), // seq 7
    // A late acknowledgement of the superseded enable must not rewrite the
    // latest human intent. It remains visibly stale until disable lands.
    ev('pr.auto-merge-enabled', { commandSeq: 5 }), // seq 8
    ev('pr.auto-merge-disabled', { commandSeq: 7 }), // seq 9
    ev('build.auto-merge-requested', {}), // seq 10 — latest command wins
  ])

  test('request and cancellation retain desired state and their command seq', () => {
    expect(stateAfter(log, 'build.auto-merge-requested').autoMerge).toEqual({
      requested: true,
      commandSeq: 5,
    })
    expect(stateAfter(log, 'build.auto-merge-cancelled').autoMerge).toEqual({
      requested: false,
      commandSeq: 7,
      applied: { enabled: true, commandSeq: 5 },
    })
  })

  test('matching enable/disable facts acknowledge exactly one command', () => {
    expect(stateAfter(log, 'pr.auto-merge-enabled').autoMerge).toEqual({
      requested: true,
      commandSeq: 5,
      applied: { enabled: true, commandSeq: 5 },
    })
    expect(stateAfter(log, 'pr.auto-merge-disabled').autoMerge).toEqual({
      requested: false,
      commandSeq: 7,
      applied: { enabled: false, commandSeq: 7 },
    })
  })

  test('a stale application fact never erases a newer command', () => {
    const stale = stateAfter(log, 'pr.auto-merge-enabled', 2).autoMerge
    expect(stale.requested).toBe(false)
    expect(stale.commandSeq).toBe(7)
    expect(stale.applied).toEqual({ enabled: true, commandSeq: 5 })
  })

  test('latest human command wins without fabricating a forge acknowledgement', () => {
    expect(reduceBuild(log).autoMerge).toEqual({
      requested: true,
      commandSeq: 10,
      applied: { enabled: false, commandSeq: 7 },
    })
  })

  test('commands are human-only and application commandSeq is positive', () => {
    expect(() =>
      validateEventWrite({ actor: KERNEL, type: 'build.auto-merge-requested', payload: {} }),
    ).toThrow(/actor kind "kernel" may not emit/)
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'pr.auto-merge-enabled',
        payload: { commandSeq: 0 },
      }),
    ).toThrow(/invalid payload/)
  })
})

describe('reduceBuild: abort — requested vs acknowledged (D2)', () => {
  const log = toLog([
    ...prelude(),
    ev('build.abort-requested', { reason: 'wrong ticket' }),
    ev('build.aborted', {}),
  ])

  test('abort-requested is pending, not aborted', () => {
    const requested = stateAfter(log, 'build.abort-requested')
    expect(requested.status).toBe('running')
    expect(requested.pendingCommands).toEqual([
      { command: 'abort', seq: 5, reason: 'wrong ticket', actor: humanActor('aron') },
    ])
  })

  test('build.aborted acknowledges: status aborted, pending cleared', () => {
    const aborted = reduceBuild(log)
    expect(aborted.status).toBe('aborted')
    expect(aborted.pendingCommands).toEqual([])
  })

  test('terminal statuses: latest wins in either order (§15.5)', () => {
    const abortedLast = reduceBuild(
      toLog([...prelude(), ev('build.completed', { outcome: 'merged' }), ev('build.aborted', {})]),
    )
    expect(abortedLast.status).toBe('aborted')

    const doneLast = reduceBuild(
      toLog([...prelude(), ev('build.aborted', {}), ev('build.completed', { outcome: 'abandoned' })]),
    )
    expect(doneLast.status).toBe('done')
    expect(doneLast.outcome).toBe('abandoned')
  })

  test('terminal wins over paused and blocked', () => {
    const state = reduceBuild(
      toLog([
        ...prelude(),
        ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'q?' }),
        ev('build.paused', {}),
        ev('build.aborted', {}),
      ]),
    )
    expect(state.status).toBe('aborted')
  })
})

describe('reduceBuild: spec revision (§6.3)', () => {
  const log = toLog([
    ...prelude(), // spec.imported rev 0
    ev('plan.started', { round: 1 }),
    ev('escalation.raised', {
      id: 'e_1',
      phase: 'plan',
      round: 1,
      source: 'agent',
      question: 'The spec assumes an endpoint that does not exist.',
    }),
    ev('escalation.answered', {
      id: 'e_1',
      answer: 'Right — spec updated to use the sessions endpoint.',
      resolution: 'revise-spec',
    }),
    ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 6 }),
    ev('plan.started', { round: 2 }), // build restarts from plan
  ])

  test('spec.revised bumps specRev and the resolution routes revise-spec', () => {
    expect(stateAfter(log, 'spec.imported').specRev).toBe(0)
    const revised = stateAfter(log, 'spec.revised')
    expect(revised.specRev).toBe(1)
    expect(revised.answeredEscalations[0]?.resolution).toBe('revise-spec')
    const restarted = reduceBuild(log)
    expect(restarted.currentPhase).toEqual({ phase: 'plan', round: 2, seq: 9 })
    expect(restarted.status).toBe('running')
  })
})

describe('reduceBuild: multiple escalations, out-of-order answers', () => {
  const log = toLog([
    ...prelude(),
    ev('escalation.raised', { id: 'e_1', phase: 'plan', source: 'agent', question: 'first?' }),
    ev('escalation.raised', { id: 'e_2', phase: 'plan', source: 'policy', question: 'second?' }),
    ev('escalation.answered', { id: 'e_9', answer: 'stray', resolution: 'guidance' }), // no match: ignored
    ev('escalation.answered', { id: 'e_2', answer: 'B', resolution: 'dismiss-finding' }),
    ev('escalation.answered', { id: 'e_1', answer: 'A', resolution: 'guidance' }),
  ])

  test('blocked while ANY escalation is open; answers match by id', () => {
    const bothOpen = stateAfter(log, 'escalation.raised', 2)
    expect(bothOpen.status).toBe('blocked')
    expect(bothOpen.openEscalations.map((e) => e.id)).toEqual(['e_1', 'e_2'])

    const strayAnswered = stateAfter(log, 'escalation.answered', 1)
    expect(strayAnswered.openEscalations).toHaveLength(2) // unknown id ignored, still total
    expect(strayAnswered.answeredEscalations).toHaveLength(0)

    const secondAnswered = stateAfter(log, 'escalation.answered', 2)
    expect(secondAnswered.status).toBe('blocked') // e_1 still open
    expect(secondAnswered.openEscalations.map((e) => e.id)).toEqual(['e_1'])
    expect(secondAnswered.answeredEscalations.map((e) => e.id)).toEqual(['e_2'])

    const allAnswered = reduceBuild(log)
    expect(allAnswered.status).toBe('running')
    expect(allAnswered.openEscalations).toEqual([])
    expect(allAnswered.answeredEscalations.map((e) => [e.id, e.resolution])).toEqual([
      ['e_2', 'dismiss-finding'],
      ['e_1', 'guidance'],
    ])
  })
})

describe('reduceBuild: reconcile cycle (§15.7)', () => {
  const log = toLog([
    ...prelude(),
    ...planApproved(),
    ...implementRound(1, 'sha-r1'),
    ...codeReview(1, 'approve'),
    ...verifyRun('types', 1, true),
    ev('finalize.started', {}),
    ev('finalize.completed', {
      pr: { number: 9, url: 'https://github.com/defrex/app/pull/9', headSha: 'sha-r1' },
    }),
    ev('pr.conflicted', { baseSha: 'sha-main-2' }),
    ev('reconcile.started', { attempt: 1, baseSha: 'sha-main-2' }),
    ev('reconcile.completed', {
      mergeCommit: 'sha-mc-1',
      artifact: { kind: 'reconcile-notes', rev: 0 },
    }),
    ...verifyRun('types', 2, true), // reconcile changed code: full verify re-run
    ev('pr.conflicted', { baseSha: 'sha-main-3' }),
    ev('reconcile.started', { attempt: 2, baseSha: 'sha-main-3' }),
    ev('reconcile.completed', {
      mergeCommit: 'sha-mc-2',
      artifact: { kind: 'reconcile-notes', rev: 1 },
    }),
    ...verifyRun('types', 3, true),
    ev('pr.merged', { sha: 'sha-squash' }),
    ev('build.completed', { outcome: 'merged' }),
  ])

  test('pr.conflicted holds until reconcile.completed returns the PR to open', () => {
    const conflicted = stateAfter(log, 'pr.conflicted')
    expect(conflicted.prState).toBe('conflicted')
    expect(conflicted.status).toBe('running') // a conflict is work, not a block

    const reconciling = stateAfter(log, 'reconcile.started')
    expect(reconciling.prState).toBe('conflicted')
    expect(reconciling.currentPhase).toEqual({ phase: 'reconcile', attempt: 1, seq: 18 })
    expect(reconciling.reconcileAttempts).toBe(1)

    const reconciled = stateAfter(log, 'reconcile.completed')
    expect(reconciled.prState).toBe('open')
    expect(reconciled.currentPhase).toBeUndefined()
    expect(reconciled.lastCompletedPhase?.phase).toBe('reconcile')
  })

  test('repeat conflicts count attempts; the cycle ends merged', () => {
    const second = stateAfter(log, 'reconcile.completed', 2)
    expect(second.reconcileAttempts).toBe(2)
    expect(second.prState).toBe('open')

    const final = reduceBuild(log)
    expect(final.prState).toBe('merged')
    expect(final.status).toBe('done')
    expect(final.outcome).toBe('merged')
    expect(final.verify.attempt).toBe(3)
  })
})

describe('reduceBuild: review approval tracks the latest verdict', () => {
  test('plan: revise then approve on the revised rev', () => {
    const log = toLog([
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'revise',
        findings: [finding('f_1')],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('plan.started', { round: 2 }),
      ev('plan.completed', { round: 2, artifact: { kind: 'plan', rev: 1 } }),
      ev('plan-review.started', { round: 2 }),
      ev('plan-review.verdict', {
        round: 2,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 1 },
      }),
    ])
    const afterRevise = stateAfter(log, 'plan-review.verdict', 1)
    expect(afterRevise.plan.approved).toBe(false)
    expect(afterRevise.reviewFindings.planReview).toEqual([[finding('f_1')]])

    const afterApprove = reduceBuild(log)
    expect(afterApprove.plan).toEqual({
      round: 2,
      approved: true,
      artifactRev: 1,
      approval: { seq: 12, round: 2 },
    })
    expect(afterApprove.reviewFindings.planReview).toEqual([[finding('f_1')], []])
  })

  test('a verdict of escalate is not approval', () => {
    const log = toLog([
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'escalate',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
        reason: 'spec conflict',
      }),
    ])
    expect(reduceBuild(log).plan.approved).toBe(false)
  })
})

describe('reduceBuild: phase.failed tally (§8.4 retry policy input)', () => {
  const log = toLog([
    ...prelude(),
    ev('plan.started', { round: 1 }),
    ev('phase.failed', {
      phase: 'plan',
      round: 1,
      attempt: 1,
      error: 'no-terminal',
      willRetry: true,
    }),
    ev('phase.failed', {
      phase: 'plan',
      round: 1,
      attempt: 2,
      error: 'no-terminal',
      willRetry: false,
    }),
    ev('phase.failed', {
      phase: 'verify:e2e',
      attempt: 1,
      error: 'store unreachable',
      willRetry: true,
    }),
  ])

  test('failures tally per phase, including verify steps', () => {
    const state = reduceBuild(log)
    expect(state.failures).toEqual({ plan: 2, 'verify:e2e': 1 })
  })

  test('a failed phase stays started-not-completed — it is what re-runs', () => {
    const state = stateAfter(log, 'phase.failed', 2)
    expect(state.currentPhase).toEqual({ phase: 'plan', round: 1, seq: 5 })
    expect(state.status).toBe('running')
  })
})

// ── The dashboard's read model (step 1: the seven additive projections) ───────
//
// These fields exist so a display can ask "will the engine re-run this?" and
// get the same answer the engine gives. The full-log booleans beside them
// (`plan.approved`, `codeReviewApproved`, `prState`) stay exactly as they were
// — the engine and the janitor route on them.

describe('reduceBuild: restartSince', () => {
  test('0 with no spec.revised; the latest spec.revised seq otherwise', () => {
    expect(reduceBuild(toLog(prelude())).restartSince).toBe(0)

    const log = toLog([
      ...prelude(),
      ev('escalation.raised', {
        id: 'e_1',
        phase: 'code-review',
        source: 'policy',
        question: 'stuck',
      }),
      ev('escalation.answered', { id: 'e_1', answer: 'respec', resolution: 'revise-spec' }),
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 5 }),
    ])
    const state = reduceBuild(log)
    expect(state.restartSince).toBe(7)
    expect(state.specRev).toBe(1)
  })
})

describe('reduceBuild: standing approvals carry seq and round', () => {
  test('plan.approval and codeReviewApproval mirror their booleans in both directions', () => {
    const log = toLog([...prelude(), ...planApproved(), ...implementRound(1, 'sha-r1'), ...codeReview(1, 'approve')])

    const planned = stateAfter(log, 'plan-review.verdict')
    expect(planned.plan.approved).toBe(true)
    expect(planned.plan.approval).toEqual({ seq: 8, round: 1 })

    const reviewed = reduceBuild(log)
    expect(reviewed.codeReviewApproved).toBe(true)
    expect(reviewed.codeReviewApproval).toEqual({ seq: 12, round: 1 })
  })

  test('a revise verdict clears the standing approval — approval !== undefined ⇔ approved', () => {
    const log = toLog([
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ...implementRound(2, 'sha-r2'),
      ...codeReview(2, 'revise', [finding('f_1')]),
    ])
    const state = reduceBuild(log)
    expect(state.codeReviewApproved).toBe(false)
    expect(state.codeReviewApproval).toBeUndefined()
  })

  test('an escalate verdict clears the standing approval too', () => {
    const log = toLog([
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'escalate',
        findings: [],
        reason: 'spec is ambiguous',
        artifact: { kind: 'plan-review', rev: 0 },
      }),
    ])
    const state = reduceBuild(log)
    expect(state.plan.approved).toBe(false)
    expect(state.plan.approval).toBeUndefined()
  })
})

describe('reduceBuild: finalize projections', () => {
  const finalize = (): EventWrite[] => [
    ev('finalize.started', {}),
    ev('finalize.completed', {
      pr: { number: 7, url: 'https://github.com/defrex/app/pull/7', headSha: 'sha-r1' },
    }),
  ]

  test('finalizeCompletedSeq is 0 without one, the event seq otherwise', () => {
    expect(reduceBuild(toLog(prelude())).finalizeCompletedSeq).toBe(0)
    const log = toLog([...prelude(), ...finalize()])
    const state = reduceBuild(log)
    expect(state.finalizeCompletedSeq).toBe(6)
  })

  test('prState is UNCHANGED by the addition — it stays the full-log PR fact', () => {
    // f_03d0f6d4's constraint: the janitor (dispatcher.ts:342,:367,:396) and
    // the restart-orthogonal epilogue (engine.ts:402) read prState, so the fix
    // had to be a new seq BESIDE it, never a re-scoping of it.
    const log = toLog([
      ...prelude(),
      ...finalize(),
      ev('escalation.raised', {
        id: 'e_1',
        phase: 'finalize',
        source: 'policy',
        question: 'stuck',
      }),
      ev('escalation.answered', { id: 'e_1', answer: 'respec', resolution: 'revise-spec' }),
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 7 }),
    ])
    const state = reduceBuild(log)
    expect(state.prState).toBe('open') // survives the restart, by design
    expect(state.pr?.number).toBe(7)
    // …while the restart-scoped fact correctly says finalize has NOT run for
    // the current spec.
    expect(state.finalizeCompletedSeq).toBeLessThan(state.restartSince)
  })

  test('finalize.step-completed projects with ok true and false; absent ⇒ []', () => {
    expect(reduceBuild(toLog(prelude())).finalizeSteps).toEqual([])
    const log = toLog([
      ...prelude(),
      ...finalize(),
      ev('finalize.step-completed', { step: 'changelog', ok: true }),
      ev('finalize.step-completed', { step: 'notify', ok: false, note: 'slack down' }),
    ])
    expect(reduceBuild(log).finalizeSteps).toEqual([
      { step: 'changelog', ok: true },
      { step: 'notify', ok: false },
    ])
  })

  test('a completion before spec.revised is excluded — a restart re-runs the post-steps', () => {
    const log = toLog([
      ...prelude(),
      ...finalize(),
      ev('finalize.step-completed', { step: 'changelog', ok: true }),
      ev('escalation.raised', {
        id: 'e_1',
        phase: 'finalize',
        source: 'policy',
        question: 'stuck',
      }),
      ev('escalation.answered', { id: 'e_1', answer: 'respec', resolution: 'revise-spec' }),
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 8 }),
    ])
    expect(reduceBuild(log).finalizeSteps).toEqual([])
  })
})

describe('reduceBuild: the verify cycle boundary (§15.6-A)', () => {
  test('verify.results carry the verify.completed seq', () => {
    const log = toLog([
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ...verifyRun('types', 1, true),
    ])
    const state = reduceBuild(log)
    expect(state.verify.results).toEqual([
      { step: 'types', attempt: 1, pass: true, report: undefined, seq: 14 },
    ])
  })

  test('cycleSince is 0 before any boundary, then moves to the code-review approve', () => {
    const base = [...prelude(), ...planApproved(), ...implementRound(1, 'sha-r1')]
    expect(reduceBuild(toLog(base)).verify.cycleSince).toBe(0)

    const log = toLog([...base, ...codeReview(1, 'approve'), ...verifyRun('types', 1, true)])
    const approved = stateAfter(log, 'code-review.verdict')
    expect(approved.verify.cycleSince).toBe(12)
    expect(approved.verify.results.filter((r) => r.seq > approved.verify.cycleSince)).toEqual([])

    // The result that lands after the boundary IS the current cycle.
    const verified = reduceBuild(log)
    expect(
      verified.verify.results.filter((r) => r.seq > verified.verify.cycleSince),
    ).toHaveLength(1)
  })

  test('cycleSince moves to a later reconcile.completed — reconciliation changed the code', () => {
    const log = toLog([
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ...verifyRun('types', 1, true),
      ev('finalize.started', {}),
      ev('finalize.completed', {
        pr: { number: 7, url: 'https://github.com/defrex/app/pull/7', headSha: 'sha-r1' },
      }),
      ev('pr.conflicted', { baseSha: 'sha-base-2' }),
      ev('reconcile.started', { attempt: 1, baseSha: 'sha-base-2' }),
      ev('reconcile.completed', {
        mergeCommit: 'sha-merge',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }),
    ])
    const state = reduceBuild(log)
    expect(state.verify.cycleSince).toBe(19)
    expect(state.verify.results.filter((r) => r.seq > state.verify.cycleSince)).toEqual([])
  })

  test('cycleSince moves to a spec.revised seq', () => {
    const log = toLog([
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ...verifyRun('types', 1, true),
      ev('escalation.raised', {
        id: 'e_1',
        phase: 'verify:types',
        source: 'policy',
        question: 'stuck',
      }),
      ev('escalation.answered', { id: 'e_1', answer: 'respec', resolution: 'revise-spec' }),
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 15 }),
    ])
    const state = reduceBuild(log)
    expect(state.verify.cycleSince).toBe(17)
    expect(state.restartSince).toBe(17)
    expect(state.verify.results.filter((r) => r.seq > state.verify.cycleSince)).toEqual([])
  })

  test('cycleSince does NOT retreat when a later code-review revise lands', () => {
    // The step 1(d) warning, pinned: `cycleSince` answers "when did the code
    // last become approved-and-verifiable" (never cleared — engine.ts:637),
    // NOT "does an approval currently stand" (`codeReviewApproval`, cleared).
    // Conflating them silently moves the boundary backwards.
    const log = toLog([
      ...prelude(),
      ...planApproved(),
      ...implementRound(1, 'sha-r1'),
      ...codeReview(1, 'approve'),
      ...verifyRun('types', 1, false, { kind: 'verify-report:types', rev: 0 }),
      ...implementRound(2, 'sha-r2'),
      ...codeReview(2, 'revise', [finding('f_1')]),
    ])
    const state = reduceBuild(log)
    expect(state.codeReviewApproval).toBeUndefined() // the approval is gone…
    expect(state.verify.cycleSince).toBe(12) // …but the boundary held
  })
})
