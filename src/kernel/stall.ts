/**
 * Persistence-chain mechanics for stall detection (SPEC §15.4, D4).
 *
 * The split follows the constitution: deciding whether a new finding is *the
 * same disagreement* as an earlier one is fuzzy → judgment → the reviewer
 * (fresh each round) marks `persists`. Everything in this module is the
 * deterministic half: following the marked links and applying the threshold.
 *
 * Chain model:
 * - A chain is identified by its root — a finding whose `persists` resolves to
 *   no earlier-round finding. `persists` links are honored only when the
 *   target exists in a strictly earlier round; unknown ids and same/later
 *   round targets are not links (ids are deposit-stamped, so a reviewer can
 *   only ever reference rounds it was shown — §8.3).
 * - Branching persists (two findings continuing one ancestor) extend the same
 *   chain; a finding with multiple `persists` entries joins every chain its
 *   ancestors belong to.
 * - A chain's `rounds` is the longest run of *consecutive* rounds it occupies
 *   (SPEC §15.4: a chain "survives" N rounds). A round in which no reviewer
 *   continued the chain breaks the streak: that round's fresh skeptic saw all
 *   prior findings (§8.3) and judged the disagreement resolved, so a later
 *   re-raise starts surviving anew — though the chain's `ids` keep the full
 *   history.
 */
import type { Finding } from '../ontology'

export interface FindingChain {
  /** Member finding ids in round order, chain root first. */
  ids: string[]
  /** Count of distinct consecutive rounds the chain spans (longest streak). */
  rounds: number
}

interface ChainMembers {
  ids: string[]
  /** Parallel to `ids`: the 1-based round each member was found in. */
  memberRounds: number[]
}

/**
 * Follow `persists` links across rounds (`roundFindings[0]` is round 1) and
 * group findings into chains, one per root. Single fresh findings are chains
 * of `rounds: 1` — staying below any sane threshold is what "fresh" means.
 */
export function persistenceChains(roundFindings: Finding[][]): FindingChain[] {
  return buildChains(roundFindings).map((chain) => ({
    ids: chain.ids,
    rounds: longestConsecutiveRun(chain.memberRounds),
  }))
}

/**
 * Chains whose streak has reached `stallRounds` (SPEC §15.4) — minus chains a
 * human already resolved via `escalation.answered {dismiss-finding}`
 * (§15.6-B).
 *
 * Dismissal semantics: a chain is human-resolved when every finding in its
 * most recent round (its tip — the live continuations of the disagreement) is
 * dismissed. Earlier members are history and need no dismissal. If a later
 * round persists into a dismissed chain with a finding that is not itself
 * dismissed, the tip moves and the chain resurrects — with its full streak
 * intact, so a reviewer overriding a human dismissal re-escalates at the very
 * next revise rather than burning `stallRounds` more rounds.
 */
export function stalledChains(
  roundFindings: Finding[][],
  stallRounds: number,
  dismissedIds?: ReadonlySet<string>,
): FindingChain[] {
  const stalled: FindingChain[] = []
  for (const chain of buildChains(roundFindings)) {
    const rounds = longestConsecutiveRun(chain.memberRounds)
    if (rounds < stallRounds) continue
    if (dismissedIds !== undefined && tipDismissed(chain, dismissedIds)) continue
    stalled.push({ ids: chain.ids, rounds })
  }
  return stalled
}

function buildChains(roundFindings: Finding[][]): ChainMembers[] {
  const byId = new Map<string, { finding: Finding; round: number }>()
  const traversal: string[] = []
  roundFindings.forEach((findings, index) => {
    for (const finding of findings) {
      if (byId.has(finding.id)) continue
      byId.set(finding.id, { finding, round: index + 1 })
      traversal.push(finding.id)
    }
  })

  // Links point strictly to earlier rounds, so recursion terminates; memoized
  // so shared ancestors are resolved once.
  const rootsMemo = new Map<string, ReadonlySet<string>>()
  function rootsOf(id: string): ReadonlySet<string> {
    const memoized = rootsMemo.get(id)
    if (memoized !== undefined) return memoized
    const node = byId.get(id)
    if (node === undefined) return new Set()
    const parents = node.finding.persists.filter((parentId) => {
      const parent = byId.get(parentId)
      return parent !== undefined && parent.round < node.round
    })
    const roots = new Set<string>()
    if (parents.length === 0) {
      roots.add(id)
    } else {
      for (const parentId of parents) {
        for (const root of rootsOf(parentId)) roots.add(root)
      }
    }
    rootsMemo.set(id, roots)
    return roots
  }

  // Traversal is round-major, and a root is always its chain's earliest
  // member, so each chain lists its root first and members in round order.
  const chains = new Map<string, ChainMembers>()
  for (const id of traversal) {
    const node = byId.get(id)
    if (node === undefined) continue
    for (const root of rootsOf(id)) {
      let chain = chains.get(root)
      if (chain === undefined) {
        chain = { ids: [], memberRounds: [] }
        chains.set(root, chain)
      }
      chain.ids.push(id)
      chain.memberRounds.push(node.round)
    }
  }
  return [...chains.values()]
}

function longestConsecutiveRun(rounds: readonly number[]): number {
  const occupied = new Set(rounds)
  let longest = 0
  for (const round of occupied) {
    if (occupied.has(round - 1)) continue
    let length = 1
    while (occupied.has(round + length)) length += 1
    if (length > longest) longest = length
  }
  return longest
}

function tipDismissed(chain: ChainMembers, dismissedIds: ReadonlySet<string>): boolean {
  const tipRound = Math.max(...chain.memberRounds)
  for (let i = 0; i < chain.ids.length; i += 1) {
    const id = chain.ids[i]
    if (chain.memberRounds[i] === tipRound && id !== undefined && !dismissedIds.has(id)) {
      return false
    }
  }
  return true
}
