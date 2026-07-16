import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { parseConfig } from '../config/load'
import {
  validateEventWrite,
  type AbEvent,
  type EventWrite,
} from '../events/catalog'
import type { eventPayloadSchemas, EventType } from '../events/payloads'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { Feedback, Finding, Verdict } from '../ontology'
import { steppingClock } from '../testing/fixed'
import { decideNext } from './engine'
import { converge } from './converge'

function finding(id: string, persists: string[] = []): Finding {
  return {
    id,
    severity: 'important',
    summary: `finding ${id}`,
    persists,
  }
}

interface Draft {
  draft: number
}

/** Scripted producer: returns one artifact per round, records every call. */
function scriptedProducer(artifacts: Draft[]) {
  const calls: { feedback: Feedback | null; round: number }[] = []
  return {
    calls,
    produce: async (feedback: Feedback | null, round: number): Promise<Draft> => {
      calls.push({ feedback, round })
      const artifact = artifacts[calls.length - 1]
      if (artifact === undefined) {
        throw new Error(`produce called ${calls.length} times, scripted for ${artifacts.length}`)
      }
      return artifact
    },
  }
}

/** Scripted reviewer: returns one verdict per round, records every call. */
function scriptedReviewer(verdicts: Verdict[]) {
  const calls: { artifact: Draft; round: number; priorRounds: Finding[][] }[] = []
  return {
    calls,
    review: async (
      artifact: Draft,
      round: number,
      priorRounds: Finding[][],
    ): Promise<Verdict> => {
      calls.push({ artifact, round, priorRounds })
      const verdict = verdicts[calls.length - 1]
      if (verdict === undefined) {
        throw new Error(`review called ${calls.length} times, scripted for ${verdicts.length}`)
      }
      return verdict
    },
  }
}

const noStall = { maxRounds: 10, stallRounds: 10 }

describe('converge', () => {
  test('approve on round 1: produce once with null feedback, review sees no prior rounds', async () => {
    const draft = { draft: 1 }
    const producer = scriptedProducer([draft])
    const reviewer = scriptedReviewer([{ verdict: 'approve' }])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: noStall,
    })

    expect(outcome).toEqual({ outcome: 'approved', artifact: draft, rounds: 1 })
    if (outcome.outcome === 'approved') expect(outcome.artifact).toBe(draft)
    expect(producer.calls).toEqual([{ feedback: null, round: 1 }])
    expect(reviewer.calls).toHaveLength(1)
    expect(reviewer.calls[0]!.artifact).toBe(draft)
    expect(reviewer.calls[0]!.round).toBe(1)
    expect(reviewer.calls[0]!.priorRounds).toEqual([])
  })

  test('revise then approve: round-2 produce receives exactly the round-1 finding ids', async () => {
    const drafts = [{ draft: 1 }, { draft: 2 }]
    const round1 = [finding('f_1'), finding('f_2')]
    const producer = scriptedProducer(drafts)
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: round1 },
      { verdict: 'approve' },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: noStall,
    })

    expect(outcome).toEqual({ outcome: 'approved', artifact: drafts[1]!, rounds: 2 })
    if (outcome.outcome === 'approved') expect(outcome.artifact).toBe(drafts[1]!)
    expect(producer.calls).toEqual([
      { feedback: null, round: 1 },
      { feedback: { findings: ['f_1', 'f_2'] }, round: 2 },
    ])
    expect(reviewer.calls).toHaveLength(2)
    expect(reviewer.calls[1]!.artifact).toBe(drafts[1]!)
    expect(reviewer.calls[1]!.priorRounds).toEqual([round1])
    expect(reviewer.calls[1]!.priorRounds[0]).toBe(round1)
    expect(reviewer.calls[1]!.priorRounds[0]![0]).toBe(round1[0]!)
  })

  test('reviewer escalate verdict → escalated with source agent and the reason', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'escalate', reason: 'plan contradicts the spec' },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: noStall,
    })

    expect(outcome).toEqual({
      outcome: 'escalated',
      source: 'agent',
      reason: 'plan contradicts the spec',
      rounds: 2,
    })
    expect(producer.calls).toHaveLength(2)
    expect(reviewer.calls).toHaveLength(2)
  })

  test('stall at exactly policy.stallRounds: produce is NOT called again after the stall round', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }, { draft: 3 }])
    const round1 = [finding('f_1')]
    const round2 = [finding('f_2', ['f_1'])]
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: round1 },
      { verdict: 'revise', findings: round2 },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 10, stallRounds: 2 },
    })

    expect(outcome).toEqual({
      outcome: 'escalated',
      source: 'stall',
      reason: 'finding chain persisted 2 rounds: f_1 -> f_2',
      rounds: 2,
      chain: { ids: ['f_1', 'f_2'], rounds: 2 },
    })
    expect(producer.calls).toHaveLength(2)
    expect(reviewer.calls).toHaveLength(2)
  })

  test('walkthrough §15.6-B: revise → persists → persists stalls at round 3', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }, { draft: 3 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'revise', findings: [finding('f_2', ['f_1'])] },
      { verdict: 'revise', findings: [finding('f_3', ['f_2'])] },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 10, stallRounds: 3 },
    })

    expect(outcome).toMatchObject({
      outcome: 'escalated',
      source: 'stall',
      rounds: 3,
      chain: { ids: ['f_1', 'f_2', 'f_3'], rounds: 3 },
    })
    expect(producer.calls).toHaveLength(3)
  })

  test('maxRounds exhaustion → policy escalation, no extra produce round', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'revise', findings: [finding('f_2')] },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 2, stallRounds: 10 },
    })

    expect(outcome).toEqual({
      outcome: 'escalated',
      source: 'policy',
      reason: 'maxRounds (2) exhausted without approval',
      rounds: 2,
    })
    expect(producer.calls).toHaveLength(2)
    expect(reviewer.calls).toHaveLength(2)
  })

  test('stall is checked before the policy bound when both trip on the same round', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'revise', findings: [finding('f_2', ['f_1'])] },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 2, stallRounds: 2 },
    })

    expect(outcome).toMatchObject({ outcome: 'escalated', source: 'stall', rounds: 2 })
  })

  test('review receives ALL prior rounds each round, as the exact finding arrays', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }, { draft: 3 }])
    const round1 = [finding('f_1'), finding('f_2')]
    const round2 = [finding('f_3')]
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: round1 },
      { verdict: 'revise', findings: round2 },
      { verdict: 'approve' },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: noStall,
    })

    expect(outcome).toMatchObject({ outcome: 'approved', rounds: 3 })
    expect(reviewer.calls[0]!.priorRounds).toEqual([])
    expect(reviewer.calls[1]!.priorRounds).toEqual([round1])
    expect(reviewer.calls[2]!.priorRounds).toEqual([round1, round2])
    expect(reviewer.calls[2]!.priorRounds[0]).toBe(round1)
    expect(reviewer.calls[2]!.priorRounds[1]).toBe(round2)
    // Fresh outer array per round — one round's reviewer cannot see arrays
    // grow under a later round.
    expect(reviewer.calls[1]!.priorRounds).not.toBe(reviewer.calls[2]!.priorRounds)
    expect(reviewer.calls[1]!.priorRounds).toHaveLength(1)
  })

  test('findings are opaque: ids pass through verbatim and objects are never mutated', async () => {
    const round1 = [finding('f_9a', []), finding('f_9b')]
    const round2 = [finding('f_9c', ['f_9a'])]
    const snapshot = structuredClone([round1, round2])
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: round1 },
      { verdict: 'revise', findings: round2 },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 10, stallRounds: 2 },
    })

    expect([round1, round2]).toEqual(snapshot)
    expect(producer.calls[1]!.feedback).toEqual({ findings: ['f_9a', 'f_9b'] })
    expect(outcome).toMatchObject({
      outcome: 'escalated',
      source: 'stall',
      chain: { ids: ['f_9a', 'f_9c'], rounds: 2 },
    })
  })

  test('dismissedIds suppress a would-be stall and the loop continues (§15.6-B)', async () => {
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }, { draft: 3 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'revise', findings: [finding('f_2', ['f_1'])] },
      { verdict: 'approve' },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 10, stallRounds: 2 },
      dismissedIds: new Set(['f_2']),
    })

    expect(outcome).toMatchObject({ outcome: 'approved', rounds: 3 })
    expect(producer.calls).toHaveLength(3)
    expect(producer.calls[2]!.feedback).toEqual({ findings: ['f_2'] })
  })

  test('deepest stalled chain is reported; ties go to the earliest root', async () => {
    // Chain f_a is suppressed at round 2 by dismissing its tip, then
    // resurrected at round 3 — by then it is deeper than chain f_y.
    const producer = scriptedProducer([{ draft: 1 }, { draft: 2 }, { draft: 3 }])
    const reviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_a')] },
      { verdict: 'revise', findings: [finding('f_b', ['f_a']), finding('f_y')] },
      { verdict: 'revise', findings: [finding('f_c', ['f_b']), finding('f_z', ['f_y'])] },
    ])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 10, stallRounds: 2 },
      dismissedIds: new Set(['f_b']),
    })

    expect(outcome).toMatchObject({
      outcome: 'escalated',
      source: 'stall',
      rounds: 3,
      chain: { ids: ['f_a', 'f_b', 'f_c'], rounds: 3 },
    })

    const tieProducer = scriptedProducer([{ draft: 1 }, { draft: 2 }])
    const tieReviewer = scriptedReviewer([
      { verdict: 'revise', findings: [finding('f_a'), finding('f_x')] },
      { verdict: 'revise', findings: [finding('f_b', ['f_a']), finding('f_y', ['f_x'])] },
    ])
    const tie = await converge({
      produce: tieProducer.produce,
      review: tieReviewer.review,
      policy: { maxRounds: 10, stallRounds: 2 },
    })
    expect(tie).toMatchObject({ chain: { ids: ['f_a', 'f_b'], rounds: 2 } })
  })

  test('degenerate maxRounds 0 escalates on policy before any produce', async () => {
    const producer = scriptedProducer([])
    const reviewer = scriptedReviewer([])

    const outcome = await converge({
      produce: producer.produce,
      review: reviewer.review,
      policy: { maxRounds: 0, stallRounds: 10 },
    })

    expect(outcome).toEqual({
      outcome: 'escalated',
      source: 'policy',
      reason: 'maxRounds (0) exhausted without approval',
      rounds: 0,
    })
    expect(producer.calls).toHaveLength(0)
    expect(reviewer.calls).toHaveLength(0)
  })
})

// ── Differential: converge ⇄ decideNext over the same verdict scripts ────────
//
// §10 says ONE generic primitive drives both loops, but the mainline is
// decideLoop inside decideNext — the event-sourced re-statement (see
// converge.ts's module doc). Nothing structural forces the two to agree, so
// this suite drives BOTH over identical verdict scripts and asserts the same
// rounds, per-round producer feedback, outcome, source, and stall chain. A
// threshold or ordering edit applied to one implementation but not the other
// fails here instead of shipping silently.

/** Normalized loop trace, comparable across both implementations. */
interface LoopTrace {
  outcome: 'approved' | 'escalated'
  /** Producer rounds actually run. */
  rounds: number
  source?: 'agent' | 'stall' | 'policy'
  /** Stall chain member ids (stall escalations only). */
  chainIds?: string[]
  /** Per producer round: findings-feedback ids, or null (round 1 / guidance-free). */
  feedbacks: (string[] | null)[]
}

// decideNext's policy knobs come from config defaults: stallRounds 3,
// maxReviewRounds 5 (§16.1). converge gets the same numbers below.
const diffConfig = parseConfig('')
const DIFF_POLICY = {
  maxRounds: diffConfig.policy.maxReviewRounds,
  stallRounds: diffConfig.policy.stallRounds,
}

async function runConvergeLoop(
  verdicts: Verdict[],
  dismissed?: readonly string[],
): Promise<LoopTrace> {
  const feedbacks: (string[] | null)[] = []
  const outcome = await converge<Draft>({
    produce: async (feedback, round) => {
      feedbacks.push(feedback !== null && 'findings' in feedback ? feedback.findings : null)
      return { draft: round }
    },
    review: async (_artifact, round) => {
      const verdict = verdicts[round - 1]
      if (verdict === undefined) throw new Error(`no scripted verdict for round ${round}`)
      return verdict
    },
    policy: DIFF_POLICY,
    ...(dismissed !== undefined ? { dismissedIds: new Set(dismissed) } : {}),
  })
  return outcome.outcome === 'approved'
    ? { outcome: 'approved', rounds: outcome.rounds, feedbacks }
    : {
        outcome: 'escalated',
        rounds: outcome.rounds,
        source: outcome.source,
        ...(outcome.chain !== undefined ? { chainIds: outcome.chain.ids } : {}),
        feedbacks,
      }
}

type DiffPayloadInput<T extends EventType> = z.input<(typeof eventPayloadSchemas)[T]>

function diffEv<T extends EventType>(
  type: T,
  payload: DiffPayloadInput<T>,
  actor = KERNEL,
): EventWrite {
  return validateEventWrite({ actor, type, payload })
}

function diffLog(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map(
    (write, index) =>
      ({
        build: 'diff-build',
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
}

const DIFF_AGENT = { kind: 'agent', role: 'plan-review', session: 's_diff' } as const

/**
 * Drive decideNext the way the build-runner would (§8): append the round's
 * plan-loop events for every `run-phase plan` decision, feeding the scripted
 * verdict, until the loop approves (decision leaves the plan loop) or
 * escalates.
 */
function runEngineLoop(verdicts: Verdict[], dismissed?: readonly string[]): LoopTrace {
  const writes: EventWrite[] = [
    diffEv(
      'spec.imported',
      { artifact: { kind: 'spec', rev: 0 }, ticket: { source: 'linear', id: 'ENG-1' } },
      DISPATCHER,
    ),
  ]
  if (dismissed !== undefined) {
    // The engine's dismissedIds come from an answered dismiss-finding
    // escalation's refs (§15.6-B) — converge takes the set directly.
    writes.push(
      diffEv('escalation.raised', {
        id: 'e_dismiss',
        phase: 'plan-review',
        source: 'stall',
        question: 'pre-dismissed chain',
        refs: [...dismissed],
      }),
      diffEv(
        'escalation.answered',
        { id: 'e_dismiss', answer: 'Not an issue.', resolution: 'dismiss-finding' },
        humanActor('aron'),
      ),
    )
  }
  const feedbacks: (string[] | null)[] = []
  for (let round = 1; ; round += 1) {
    const decision = decideNext(diffLog(writes), diffConfig)
    if (decision.kind === 'run-phase' && decision.phase === 'plan') {
      if (decision.round !== round) {
        throw new Error(`engine ran plan round ${decision.round}, expected ${round}`)
      }
      feedbacks.push(
        decision.feedback !== undefined && 'findings' in decision.feedback
          ? decision.feedback.findings
          : null,
      )
      const verdict = verdicts[round - 1]
      if (verdict === undefined) throw new Error(`no scripted verdict for round ${round}`)
      writes.push(
        diffEv('plan.started', { round }),
        diffEv(
          'plan.completed',
          { round, artifact: { kind: 'plan', rev: round - 1 } },
          DIFF_AGENT,
        ),
        diffEv('plan-review.started', { round }),
        diffEv(
          'plan-review.verdict',
          {
            round,
            verdict: verdict.verdict,
            findings: verdict.verdict === 'revise' ? verdict.findings : [],
            artifact: { kind: 'plan-review', rev: round - 1 },
            ...(verdict.verdict === 'escalate' ? { reason: verdict.reason } : {}),
          },
          DIFF_AGENT,
        ),
      )
      continue
    }
    const rounds = round - 1
    if (decision.kind === 'run-phase' && decision.phase === 'implement') {
      return { outcome: 'approved', rounds, feedbacks }
    }
    if (decision.kind === 'raise-escalation') {
      return {
        outcome: 'escalated',
        rounds,
        source: decision.source,
        ...(decision.source === 'stall' && decision.refs !== undefined
          ? { chainIds: decision.refs }
          : {}),
        feedbacks,
      }
    }
    throw new Error(`unexpected decision: ${JSON.stringify(decision)}`)
  }
}

async function expectAgreement(
  verdicts: Verdict[],
  dismissed?: readonly string[],
): Promise<LoopTrace> {
  const fromConverge = await runConvergeLoop(verdicts, dismissed)
  const fromEngine = runEngineLoop(verdicts, dismissed)
  expect(fromEngine).toEqual(fromConverge)
  return fromEngine
}

describe('converge ⇄ decideNext differential (§10: one primitive, two implementations)', () => {
  test('approve on round 1', async () => {
    const trace = await expectAgreement([{ verdict: 'approve' }])
    expect(trace).toEqual({ outcome: 'approved', rounds: 1, feedbacks: [null] })
  })

  test('revise → approve threads the same findings feedback into round 2', async () => {
    const trace = await expectAgreement([
      { verdict: 'revise', findings: [finding('f_1'), finding('f_2')] },
      { verdict: 'approve' },
    ])
    expect(trace).toEqual({
      outcome: 'approved',
      rounds: 2,
      feedbacks: [null, ['f_1', 'f_2']],
    })
  })

  test('reviewer escalate agrees on source and round count', async () => {
    const trace = await expectAgreement([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'escalate', reason: 'plan contradicts the spec' },
    ])
    expect(trace).toMatchObject({ outcome: 'escalated', source: 'agent', rounds: 2 })
  })

  test('a persists chain stalls both implementations at stallRounds with the same chain', async () => {
    const trace = await expectAgreement([
      { verdict: 'revise', findings: [finding('f_1')] },
      { verdict: 'revise', findings: [finding('f_2', ['f_1'])] },
      { verdict: 'revise', findings: [finding('f_3', ['f_2'])] },
    ])
    expect(trace).toMatchObject({
      outcome: 'escalated',
      source: 'stall',
      rounds: 3,
      chainIds: ['f_1', 'f_2', 'f_3'],
    })
  })

  test('fresh findings exhaust the round cap in both at the same round', async () => {
    const trace = await expectAgreement([
      { verdict: 'revise', findings: [finding('f_a')] },
      { verdict: 'revise', findings: [finding('f_b')] },
      { verdict: 'revise', findings: [finding('f_c')] },
      { verdict: 'revise', findings: [finding('f_d')] },
      { verdict: 'revise', findings: [finding('f_e')] },
    ])
    expect(trace).toMatchObject({ outcome: 'escalated', source: 'policy', rounds: 5 })
  })

  test('a dismissed chain tip suppresses the stall in both and the loop converges', async () => {
    const trace = await expectAgreement(
      [
        { verdict: 'revise', findings: [finding('f_1')] },
        { verdict: 'revise', findings: [finding('f_2', ['f_1'])] },
        { verdict: 'revise', findings: [finding('f_3', ['f_2'])] },
        { verdict: 'approve' },
      ],
      ['f_3'],
    )
    expect(trace).toEqual({
      outcome: 'approved',
      rounds: 4,
      feedbacks: [null, ['f_1'], ['f_2'], ['f_3']],
    })
  })
})
