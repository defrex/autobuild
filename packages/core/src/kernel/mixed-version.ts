import type { RuntimeIdentity } from '../events/runtime'
import type { CompatibilityState } from '../events/compatibility'
import type { BuildState } from './reducer'
import type { BuildStore } from '../store/types'
import type { Actor } from '../events/envelope'
import { readBuildFacts } from '../store/reduced-reads'

const drainingExecutions = new WeakMap<BuildStore, { instance: string; runtime: RuntimeIdentity }>()
/** Carry the caller's own immutable execution identity through nested kernel
 * helpers without adding repository authority to a build-scoped store. */
export function withDrainingExecution<T extends BuildStore>(
  store: T,
  instance: string,
  runtime: RuntimeIdentity,
): T {
  const scoped = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  drainingExecutions.set(scoped, { instance, runtime })
  return scoped
}
async function authorizedDrainingExecution(store: BuildStore, slug: string): Promise<boolean> {
  const execution = drainingExecutions.get(store)
  if (!execution) return false
  const authorization = (await readBuildFacts(store, slug)).value.state.drainingExecutions?.[
    execution.instance
  ]?.authorization
  return (
    !!authorization &&
    authorization.runtime.version === execution.runtime.version &&
    authorization.runtime.commit === execution.runtime.commit &&
    authorization.runtime.source.kind === execution.runtime.source.kind &&
    authorization.runtime.source.location === execution.runtime.source.location
  )
}

export function compatibilityDiagnostic(facts: CompatibilityState): string | undefined {
  if (facts.decisiveFacts === 0) return undefined
  const versions = facts.decisiveWriterVersions.length
    ? `written by version ${facts.decisiveWriterVersions.join(', ')}`
    : ''
  const legacy = facts.decisiveLegacyVersionUnavailable
    ? 'writer version unavailable for legacy facts'
    : ''
  return `Kernel decisions deferred: restart with a build that understands ${facts.decisiveTypes.join(', ')} (${[versions, legacy].filter(Boolean).join('; ')}).`
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
    if (await authorizedDrainingExecution(store, slug)) return true
    const facts = state.compatibility
    if (state.compatibilityDeferredBoundary === facts.decisiveBoundary) return true
    const written = await store.appendIfCurrent(slug, state.lastSeq, {
      actor,
      type: 'build.compatibility-deferred',
      payload: {
        boundary: facts.decisiveBoundary,
        types: facts.decisiveTypes,
        writerVersions: facts.decisiveWriterVersions,
        legacyVersionUnavailable: facts.decisiveLegacyVersionUnavailable,
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
