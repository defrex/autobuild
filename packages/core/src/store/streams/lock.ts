/**
 * Per-stream, in-process async mutex (AUT-348): a promise-chain per key that
 * serializes a store's close against its appends inside one process, so an
 * append issued while a close is in flight either lands before the close's
 * prepare snapshot or blocks until the close commits and then fails the
 * closed re-check with an explicit error — never a silently omitted chunk.
 *
 * This is coordination *within one process only*. Cross-process and
 * cross-connection writers are invisible to it; serializing those remains the
 * store adapter's transaction discipline (BEGIN IMMEDIATE re-verification in
 * SQLite, the `FOR UPDATE` row lock in Postgres).
 */
export class StreamLocks {
  /** Queue tail per key: settles only when the current holder finishes. */
  private readonly tails = new Map<string, Promise<unknown>>()

  /** Run `fn` while holding the lock for `key`. Holders run in FIFO launch
   * order; a holder that throws releases the key and propagates its error to
   * its own caller without rejecting (poisoning) later holders. */
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve()
    // A failed holder must release the key, so the wait chain never rejects.
    const turn = tail.then(
      () => undefined,
      () => undefined,
    )
    const run = turn.then(fn)
    // Keep the chain alive regardless of this holder's fate, and drop the
    // entry once this holder is the last one (the tail) so idle keys do not
    // accumulate. A caller that already chained onto `tail` re-sets the entry
    // with its own, which makes the equality check a no-op for it.
    const released = run.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, released)
    released.then(() => {
      if (this.tails.get(key) === released) this.tails.delete(key)
    })
    return run
  }
}
