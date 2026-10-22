import { mixedVersionDeferred } from './mixed-version'
import { readBuildFacts } from '../store/reduced-reads'
import { KERNEL } from '../events/envelope'
import type { BuildStore } from '../store/types'
import { missingIntegrationFailures } from './integration-state'

/** CAS retries reload all durable evidence, including another writer's receipt. */
export async function reportIntegrationFailures(store: BuildStore, slug: string): Promise<void> {
  for (;;) {
    const { state } = (await readBuildFacts(store, slug)).value
    if (mixedVersionDeferred(state)) return
    const payload = missingIntegrationFailures(state, slug)[0]
    if (!payload) return
    await store.appendIfCurrent(slug, state.lastSeq, {
      actor: KERNEL,
      type: 'integration.verification-failed',
      payload,
    })
  }
}
