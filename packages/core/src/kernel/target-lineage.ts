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
  const receipts: TargetLineage['receipts'] = []
  let head = from
  for (let hop = 0; hop < MAX_TARGET_LINEAGE_HOPS; hop++) {
    const receipt = await store.getNodeRewrite(node, head)
    if (!receipt) break
    gitOid.parse(receipt.previous)
    gitOid.parse(receipt.head)
    if (receipt.previous !== head || receipt.head === head) break
    receipts.push(receipt)
    head = receipt.head
    if (head === sha || (await forge.isCommitAncestor(head, sha))) return { node, from, receipts }
  }
  // Latest-publication bridge: the child may have observed an ancestor of the
  // frozen source (e.g. another child landed before this node was restacked).
  // Prove both immutable sides; ownership alone is never sufficient.
  if (receipts.length === MAX_TARGET_LINEAGE_HOPS) return undefined
  const latest = await store.getNodeRewrite(node)
  if (latest) {
    gitOid.parse(latest.previous)
    gitOid.parse(latest.head)
  }
  if (
    latest &&
    latest.previous !== latest.head &&
    (from === latest.previous || (await forge.isCommitAncestor(from, latest.previous))) &&
    (sha === latest.head || (await forge.isCommitAncestor(latest.head, sha)))
  )
    return { node, from, receipts: [latest] }
  return undefined
}
