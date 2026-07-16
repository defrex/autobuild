/**
 * `AB_STORE` reference resolution (SPEC §7.2, §8.1): a local filesystem path
 * opens the SQLite+blob-dir store; an http(s) URL is the remote HTTP adapter.
 *
 * The remote adapter is wired by `bin/ab.ts` via `remoteFactory` — this module
 * stays decoupled from it (the adapter is built in parallel), so an entry
 * point that never wires it gets a clear error instead of a broken import.
 */
import { openLocalStore } from '../store/local/store'
import type { BuildStore } from '../store/types'

export interface ResolveStoreOpts {
  /** Constructs the remote HTTP store (§7.2.2); wired by `bin/ab.ts`. */
  remoteFactory?: (url: string, token?: string) => BuildStore
  /** Scoped token (D8, `AB_TOKEN`) — passed through to the remote factory. */
  token?: string
}

export function resolveStore(ref: string, opts: ResolveStoreOpts = {}): BuildStore {
  if (/^https?:\/\//i.test(ref)) {
    if (opts.remoteFactory === undefined) {
      throw new Error(
        `remote store support not wired: cannot open "${ref}" from this entry ` +
          "point — the remote HTTP adapter (SPEC §7.2.2) is wired by bin/ab.ts " +
          "as resolveStore's remoteFactory",
      )
    }
    return opts.remoteFactory(ref, opts.token)
  }
  return openLocalStore(ref)
}
