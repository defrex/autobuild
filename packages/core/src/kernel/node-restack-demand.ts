import type { BuildState } from './reducer'
import { integrationComplete, integrationFailed } from './integration-state'

/** Existing reservations are recovery work, regardless of fresh demand. */
export function nodeRestackDemand(state: BuildState): boolean {
  if (state.targetRewrite && !state.nodeRestack?.active) return false
  return !!(
    state.nodeRestack?.active ||
    state.nodeRestack?.parentChange ||
    Object.keys(state.nodeRestack?.requests ?? {}).length ||
    (integrationComplete(state) && !integrationFailed(state))
  )
}

/** Target first, nearest ancestors next. Each identity stops at its first
 * proven source; a missing proof never authorizes speculative cascade. */
export function presenceRestackPath(
  path: readonly { slug?: string; identities: readonly string[] }[],
  required: readonly string[],
): string[] {
  const requested = new Set<string>()
  for (const identity of required) {
    const source = path.findIndex((entry) => entry.identities.includes(identity))
    if (source <= 0) continue
    for (const entry of path.slice(0, source)) if (entry.slug) requested.add(entry.slug)
  }
  return path
    .flatMap((entry) => (entry.slug && requested.has(entry.slug) ? [entry.slug] : []))
    .reverse()
}
