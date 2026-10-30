import { createHash } from 'node:crypto'
import type { PresenceInputs } from './change-presence'
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

/** Canonical semantic evidence only: polling facts and journal positions do not
 * invalidate an assessment, but unchanged-head landing proofs do. */
export function restackAvailabilityFingerprint(
  state: BuildState,
  branch: string,
  parentBranch: string,
  head: string,
  parent: string,
  evidence: PresenceInputs,
  landingKey = restackLandingKey(evidence.landings),
): string {
  const requests = Object.values(state.nodeRestack?.requests ?? {})
    .map((r) => [
      r.id,
      r.reason,
      r.branch,
      r.parent,
      r.dependent?.source,
      r.dependent?.id,
      [...new Set(r.identities ?? [])].sort(),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const ancestry = [...evidence.states]
    .map(([slug, s]) => [
      slug,
      s.target?.build,
      s.baseBranch,
      Object.entries(s.nodeRestack?.foreignAliases ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        branch,
        parentBranch,
        head,
        parent,
        state.nodeRestack?.contributionBase,
        requests,
        ancestry,
        landingKey,
      ]),
    )
    .digest('hex')
}

export function actionableRestackDemand(state: BuildState, fingerprint: string): boolean {
  const observation = state.nodeRestack?.availability
  if (observation?.version !== 1 || observation.fingerprint !== fingerprint)
    return nodeRestackDemand(state)
  return nodeRestackDemand({
    ...state,
    nodeRestack: {
      ...state.nodeRestack!,
      requests: Object.fromEntries(
        Object.entries(state.nodeRestack?.requests ?? {}).filter(
          ([id, request]) => request.reason === 'operator' || observation.available.includes(id),
        ),
      ),
    },
  })
}

/** Hash shared landing evidence once, not once per considered node. */
export function restackLandingKey(landings: PresenceInputs['landings']): string {
  const canonical = landings
    .map((l) => [l.slug, l.sha, [...new Set(l.contribution ?? [])].sort()])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
