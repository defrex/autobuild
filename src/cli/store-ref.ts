/**
 * `AB_STORE` reference resolution (SPEC §7.2, §8.1): a local filesystem path
 * opens the SQLite+blob-dir store; an http(s) URL is the remote HTTP adapter.
 *
 * The production remote adapter is composed in `src/cli/store-opening.ts` via
 * `remoteFactory`. This low-level parser stays decoupled from that adapter, so
 * it remains independently testable and an unwired entry point fails clearly.
 */
import { openLocalStore } from '../store/local/store'
import type { BuildStore } from '../store/types'
import { isRemoteStoreRef } from './repo-state'

export interface ResolveStoreOpts {
  /** Constructs the remote HTTP store (§7.2.2); production wiring is external. */
  remoteFactory?: (url: string, token?: string) => BuildStore
  /** Scoped token (D8, `AB_TOKEN`) — passed through to the remote factory. */
  token?: string
}

export function resolveStore(ref: string, opts: ResolveStoreOpts = {}): BuildStore {
  if (isRemoteStoreRef(ref)) {
    if (opts.remoteFactory === undefined) {
      throw new Error(
        `remote store support not wired: cannot open "${ref}" from this entry ` +
          "point — supply the remote HTTP adapter (SPEC §7.2.2) as " +
          "resolveStore's remoteFactory; production composition lives in " +
          'src/cli/store-opening.ts',
      )
    }
    return opts.remoteFactory(ref, opts.token)
  }
  return openLocalStore(ref)
}
