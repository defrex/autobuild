import { gitOid } from '../events/payloads'
import type { EventPayload } from '../events/payloads'
import type { Forge } from '../ports/types'
import type { BuildStore } from '../store/types'

export const MAX_TARGET_LINEAGE_HOPS = 64
export type TargetLineage = NonNullable<EventPayload<'target.moved'>['lineage']>[number]

/** Repository-scoped dispatcher proof. Neither branch ownership nor inventory
 * is rewrite authority: every discontinuity needs a guarded publication receipt.
 * Point reads cost O(gap), capped independently of total history. */
export async function proveTargetLineage(input: {
  store: BuildStore
  forge: Forge
  node: string
  branch: string
  from: string
  sha: string
}): Promise<TargetLineage | undefined> {
  const { store, forge, node, branch, from, sha } = input
  gitOid.parse(from)
  gitOid.parse(sha)
  if (!store.getNodeRewrite || !forge.isCommitAncestor) return undefined
  const record = await store.getBuild(node)
  if (record?.branch !== branch) return undefined
  // Exact chains remain a cheap point-lookup path, including when a newer
  // publication raced this observation. Share the read cap with gap recovery.
  let reads = 0
  let forward = from
  const exact: TargetLineage['receipts'] = []
  while (reads < MAX_TARGET_LINEAGE_HOPS) {
    reads++
    const receipt = await store.getNodeRewrite(node, forward)
    if (!receipt || receipt.previous !== forward || receipt.head === forward) break
    gitOid.parse(receipt.previous)
    gitOid.parse(receipt.head)
    exact.push(receipt)
    forward = receipt.head
    if (forward === sha || (await forge.isCommitAncestor(forward, sha)))
      return { node, from, receipts: exact }
  }
  // Walk backwards from the latest guarded publication. Between receipts a
  // sibling may land forward commits; prove each such immutable gap rather than
  // requiring exact previous-head equality. Never infer a rewrite from ownership.
  const receipts: TargetLineage['receipts'] = []
  let head = sha
  let beforePrevious: string | undefined
  const seen = new Set<string>()
  while (reads < MAX_TARGET_LINEAGE_HOPS) {
    reads++
    const receipt = await store.getNodeRewrite(node, undefined, beforePrevious)
    if (!receipt || seen.has(receipt.id)) return undefined
    seen.add(receipt.id)
    gitOid.parse(receipt.previous)
    gitOid.parse(receipt.head)
    if (receipt.previous === receipt.head) return undefined
    if (head !== receipt.head && !(await forge.isCommitAncestor(receipt.head, head)))
      return undefined
    receipts.unshift(receipt)
    head = receipt.previous
    if (from === head || (await forge.isCommitAncestor(from, head))) return { node, from, receipts }
    beforePrevious = receipt.previous
  }
  return undefined
}
