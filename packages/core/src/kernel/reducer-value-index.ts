/**
 * Selective reducer lookup for value reads. The reducers short-lived readers
 * request load only their own modules; every other name resolves through the
 * complete `REDUCERS` catalog, loaded on first need. Both paths build entries
 * with `valueReadEntry`, so identities, keys and validation are identical
 * (`reducer-value-index.test.ts` pins each selective registration to its
 * catalog entry). This module must never import the registry statically.
 */
import { valueReadEntry, type RegisteredReducer } from './reducer-value-entry'

type Loader = () => Promise<RegisteredReducer>

/** Names whose registration is built from the reducer module alone. `covers`
 * and representative arguments match `REGISTERED`. */
const SELECTIVE: Record<string, Loader> = {
  dispatchUpgrade: async () => {
    const { dispatchUpgradeReducer } = await import('./dispatch-upgrade')
    return registration('dispatchUpgrade', dispatchUpgradeReducer)
  },
  repositoryReadFacts: async () => {
    const { repositoryReadFactsReducer } = await import('./repository-read-facts')
    return registration('repositoryReadFacts', repositoryReadFactsReducer)
  },
  dispatcherRunFacts: async () => {
    const { dispatcherRunFactsReducer } = await import('./repository-read-facts')
    return registration('dispatcherRunFacts', dispatcherRunFactsReducer('run-a'), {
      create: ({ run }) => dispatcherRunFactsReducer(run),
    })
  },
}
export const SELECTIVE_VALUE_REGISTRATIONS: readonly string[] = Object.keys(SELECTIVE)

function registration(
  name: string,
  reducer: RegisteredReducer['reducer'],
  options?: Parameters<typeof valueReadEntry>[2],
): RegisteredReducer {
  return { reducer, covers: [], valueRead: valueReadEntry(name, reducer, options) }
}

const loaded = new Map<string, Promise<RegisteredReducer>>()

/** The registration `name` resolves to, or `undefined` for an unknown name. */
export async function loadValueRegistration(name: string): Promise<RegisteredReducer | undefined> {
  if (!Object.hasOwn(SELECTIVE, name)) {
    const { REDUCERS } = await import('./reducer-registry')
    return Object.hasOwn(REDUCERS, name) ? REDUCERS[name] : undefined
  }
  let pending = loaded.get(name)
  if (!pending) {
    pending = SELECTIVE[name]!().catch((error: unknown) => {
      loaded.delete(name)
      throw error
    })
    loaded.set(name, pending)
  }
  return pending
}
