/** Display-only repository snapshot gate. Sample before reads, publish only
 * after a complete admitted read, and serialize action/timer refreshes. */
export class RepositoryPollCache<T> {
  private tail: Promise<void> = Promise.resolve()
  private cached: { value: T; position: string; revision: number; enrichedAt: number } | undefined

  refresh(options: {
    position: () => Promise<string>
    now: () => number
    revision: number
    enabled: boolean
    admitted: () => boolean
    valid?: (value: T) => boolean
    /** The scheduler's current cadence, for refreshing before the next poll
     * would overshoot the enrichment deadline. This does not change cadence. */
    nextPollMs?: number
    read: (options: { fullEnrichment: boolean }) => Promise<T | undefined>
  }): Promise<T | undefined> {
    const result = this.tail.then(async () => {
      if (!options.admitted()) return undefined
      const startedAt = options.now()
      const position = options.enabled ? await options.position() : ''
      if (!options.admitted()) return undefined
      const cached = this.cached
      const deadline = (cached?.enrichedAt ?? startedAt) + 10_000
      const fullEnrichment =
        options.enabled &&
        cached !== undefined &&
        (startedAt >= deadline || startedAt + (options.nextPollMs ?? 0) > deadline)
      if (
        options.enabled &&
        cached &&
        (options.valid?.(cached.value) ?? true) &&
        cached.position === position &&
        cached.revision === options.revision &&
        !fullEnrichment
      ) {
        return cached.value
      }
      const value = await options.read({ fullEnrichment })
      if (value === undefined || !options.admitted()) return undefined
      this.cached = {
        value,
        position,
        revision: options.revision,
        // Position-driven reads must not postpone independent enrichment.
        enrichedAt: cached === undefined || fullEnrichment ? startedAt : cached.enrichedAt,
      }
      return value
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
