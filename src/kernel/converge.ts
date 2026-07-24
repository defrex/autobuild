/**
 * The generic review-loop primitive (SPEC §10): one tested state machine for
 * both the plan loop and the code loop. It owns rounds, feedback threading,
 * verdict routing, and the stall/policy thresholds — and nothing else: the
 * callbacks own all I/O (sessions, store deposits, plumbing), so this module
 * never touches a port or the store.
 *
 * Memory model (§10): the producer continues its session across rounds — its
 * feedback is only the latest verdict's finding ids, assembled
 * deterministically. The reviewer is a fresh skeptic each round and receives
 * ALL prior rounds' findings so it can mark `persists` (§15.4).
 *
 * Findings are opaque here: ids are stamped at deposit (D6) before a verdict
 * ever reaches this function, and converge never copies or mutates them —
 * the same objects flow into `stalledChains` and back out in the outcome.
 *
 * Relationship to the engine: the MAINLINE loop is `decideLoop` inside
 * `decideNext` (src/kernel/engine.ts) — the event-sourced re-statement of
 * this primitive, because the kernel's resume path must re-decide from the
 * log (§2.2) rather than hold a loop on the stack. converge remains the §10
 * reference semantics for in-process callers, and the two implementations
 * are pinned together by the differential suite in converge.test.ts
 * ('converge ⇄ decideNext differential'): the same verdict scripts must
 * produce the same rounds, feedback, and outcome in both. Edit loop
 * semantics (thresholds, stall ordering, feedback assembly) in BOTH places
 * or the differential fails.
 */
import type { Feedback, Finding, Verdict } from '../ontology'
import { stalledChains, type FindingChain } from './stall'

export interface ConvergePolicy {
  /** Producer/review round pairs allowed before escalating (source: policy). */
  maxRounds: number
  /** Persistence-chain streak that auto-escalates (source: stall — §15.4). */
  stallRounds: number
}

export type ConvergeOutcome<A> =
  | { outcome: 'approved'; artifact: A; rounds: number }
  | {
      outcome: 'escalated'
      source: 'agent' | 'stall' | 'policy'
      reason: string
      rounds: number
      chain?: FindingChain
    }

export async function converge<A>(opts: {
  produce: (feedback: Feedback | null, round: number) => Promise<A>
  review: (artifact: A, round: number, priorRounds: Finding[][]) => Promise<Verdict>
  policy: ConvergePolicy
  /** Chains a human already resolved via dismiss-finding (§15.6-B). */
  dismissedIds?: ReadonlySet<string>
  /** Durable callers may resume after prior revise rounds. Defaults preserve
   * the ordinary in-memory loop (round 1, no history). */
  startRound?: number
  priorRounds?: Finding[][]
  initialFeedback?: Feedback | null
}): Promise<ConvergeOutcome<A>> {
  const { produce, review, policy, dismissedIds } = opts
  const roundFindings: Finding[][] = (opts.priorRounds ?? []).map((round) => [...round])
  let feedback: Feedback | null = opts.initialFeedback ?? null

  for (let round = opts.startRound ?? 1; ; round += 1) {
    if (round > policy.maxRounds) {
      return {
        outcome: 'escalated',
        source: 'policy',
        reason: `maxRounds (${policy.maxRounds}) exhausted without approval`,
        rounds: round - 1,
      }
    }

    const artifact = await produce(feedback, round)
    const verdict = await review(artifact, round, roundFindings.slice())

    if (verdict.verdict === 'approve') {
      return { outcome: 'approved', artifact, rounds: round }
    }
    if (verdict.verdict === 'escalate') {
      return {
        outcome: 'escalated',
        source: 'agent',
        reason: verdict.reason,
        rounds: round,
      }
    }

    roundFindings.push(verdict.findings)

    // The kernel applies the stall threshold after every revise, BEFORE
    // burning another produce round (§15.4). Deepest chain reported; first
    // in root order on ties.
    const stalled = stalledChains(roundFindings, policy.stallRounds, dismissedIds)
    if (stalled.length > 0) {
      const chain = stalled.reduce((deepest, candidate) =>
        candidate.rounds > deepest.rounds ? candidate : deepest,
      )
      return {
        outcome: 'escalated',
        source: 'stall',
        reason: `finding chain persisted ${chain.rounds} rounds: ${chain.ids.join(' -> ')}`,
        rounds: round,
        chain,
      }
    }

    // Round N+1's producer prompt is assembled deterministically from finding
    // ids (§10) — payloads carry refs, never blobs (§15.2.3).
    feedback = { findings: verdict.findings.map((finding) => finding.id) }
  }
}
