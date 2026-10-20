import type { CompatibilityState } from '../events/compatibility'
import type { BuildState } from './reducer'
import type { BuildStore } from '../store/types'
import type { Actor } from '../events/envelope'
import { readBuildFacts } from '../store/reduced-reads'

export function compatibilityDiagnostic(facts: CompatibilityState): string | undefined {
  if (facts.decisiveFacts === 0) return undefined
  const versions = facts.writerVersions.length
    ? `written by version ${facts.writerVersions.join(', ')}`
    : ''
  const legacy = facts.legacyVersionUnavailable ? 'writer version unavailable for legacy facts' : ''
  return `Kernel decisions deferred: restart with a build that understands ${facts.types.join(', ')} (${[versions, legacy].filter(Boolean).join('; ')}).`
}
export function mixedVersionDeferred(state: Pick<BuildState, 'compatibility'>): boolean {
  return (state.compatibility?.decisiveFacts ?? 0) > 0
}
/** Compare-and-append deduplicates concurrent dispatchers/runners at the same
 * decisive boundary; upgrading clears the guard through local replay. */
export async function deferMixedVersion(
  store: BuildStore,
  slug: string,
  actor: Actor = { kind: 'dispatcher' },
): Promise<boolean> {
  for (;;) {
    const { state } = (await readBuildFacts(store, slug)).value
    const diagnostic = compatibilityDiagnostic(state.compatibility)
    if (!diagnostic) return false
    const facts = state.compatibility
    if (state.compatibilityDeferredBoundary === facts.decisiveBoundary) return true
    const written = await store.appendIfCurrent(slug, state.lastSeq, {
      actor,
      type: 'build.compatibility-deferred',
      payload: {
        boundary: facts.decisiveBoundary,
        types: facts.types,
        writerVersions: facts.writerVersions,
        legacyVersionUnavailable: facts.legacyVersionUnavailable,
        diagnostic,
      },
    })
    if (written) return true
  }
}

export class MixedVersionDeferral extends Error {
  constructor(diagnostic = 'kernel decisions deferred for unsupported decisive facts') {
    super(diagnostic)
  }
}
