/** Rollup serialization primitives, free of the reducer catalog so stores can
 * construct their locks without initializing it. `./rollups` re-exports them. */

/** A promise chain per key: serializes same-key work inside one store
 * instance. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(body)
    this.tails.set(key, next)
    try {
      return await next
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}

/** A store-wide rollup lease (the SQLite adapter's per-key serialization). */
export const ROLLUP_LEASE_MS = 120_000
/** How long a reader waits on another holder's lease before giving up. */
export const ROLLUP_LEASE_WAIT_MS = 600_000

/** A reader waited `ROLLUP_LEASE_WAIT_MS` on another holder's lease. */
export class RollupLeaseTimeoutError extends Error {
  override readonly name = 'RollupLeaseTimeoutError'
  constructor(readonly key: string) {
    super(`timed out waiting for the rollup lease on ${key}`)
  }
}

/** An advance's lease expired and another holder took it over; the advance
 * commits nothing. */
export class RollupLeaseLostError extends Error {
  override readonly name = 'RollupLeaseLostError'
  constructor(readonly key: string) {
    super(`lost the rollup lease on ${key}`)
  }
}
