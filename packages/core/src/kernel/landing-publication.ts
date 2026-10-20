import { deferMixedVersion, MixedVersionDeferral } from './mixed-version'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { Forge } from '../ports/types'
import { KERNEL } from '../events/envelope'

/** Confirm cancellation at the trusted publication boundary. Consent remains
 * durable; this receipt suspends only its candidate-specific native effect.
 * Poll reconciliation also repairs an enable that completes after this call. */
export async function suspendNativeLanding(
  deps: {
    store: BuildStore
    forge: Forge
    slug: string
    workspacePath: string
  },
  operation: string,
): Promise<void> {
  if (await deferMixedVersion(deps.store, deps.slug, { kind: 'kernel' }))
    throw new MixedVersionDeferral()
  const state = (await readBuildFacts(deps.store, deps.slug)).value.state
  if (!state.pr) return
  const observed = await deps.forge.getPrState(deps.workspacePath, state.pr.number)
  if (observed.state !== 'open')
    throw new Error(`PR is ${observed.state}; settle it before publishing another head`)
  const result = await deps.forge.setAutoMerge(deps.workspacePath, state.pr.number, false)
  if (result.kind !== 'applied')
    throw new Error('Native auto-merge cancellation unconfirmed; publication suspended')
  await deps.store.append(deps.slug, {
    actor: KERNEL,
    type: 'landing.native-applied',
    payload: {
      enabled: false,
      operation,
      ...(state.landing?.decision
        ? { candidate: state.landing.decision.candidate, decisionSeq: state.landing.decision.seq }
        : {}),
      ...(state.landing?.command ? { commandSeq: state.landing.command.seq } : {}),
    },
  })
  const after = await deps.forge.getPrState(deps.workspacePath, state.pr.number)
  if (after.state !== 'open')
    throw new Error(`PR is ${after.state}; settle it before publishing another head`)
}
