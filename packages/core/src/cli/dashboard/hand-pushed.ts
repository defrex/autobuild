import { originalForeign } from '../../kernel/change-presence'
import type { NodeRestackState } from '../../kernel/node-restack-state'

export const handPushedLabel = 'Hand-pushed changes'
export interface HandPushedChange {
  sha: string
  originalSha: string
}
export function projectHandPushed(
  node: NodeRestackState | undefined,
): HandPushedChange[] | undefined {
  if (!node?.inventory) return undefined
  const aliases = new Map(Object.entries(node.foreignAliases ?? {}))
  return node.inventory.foreign.map((sha) => ({ sha, originalSha: originalForeign(sha, aliases) }))
}
export function handPushedText(changes: HandPushedChange[] | undefined): string {
  return (
    changes
      ?.map(({ sha, originalSha }) =>
        sha === originalSha ? sha : `${sha} (original ${originalSha})`,
      )
      .join(', ') || (changes ? 'none' : 'unknown')
  )
}
