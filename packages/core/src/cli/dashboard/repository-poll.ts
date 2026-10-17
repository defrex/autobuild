/** Display-only repository snapshot gate. Sample before reads, publish only
 * after a complete admitted read, and serialize action/timer refreshes. */
export class RepositoryPollCache<T> {
  private tail: Promise<void> = Promise.resolve()
  private cached: { value: T; position: string; revision: number; at: number } | undefined

  refresh(options: {
    position: () => Promise<string>
    now: () => number
    revision: number
    enabled: boolean
    admitted: () => boolean
    valid?: (value: T) => boolean
    read: () => Promise<T | undefined>
  }): Promise<T | undefined> {
    const result = this.tail.then(async () => {
      if (!options.admitted()) return undefined
      const position = options.enabled ? await options.position() : ''
      if (!options.admitted()) return undefined
      const cached = this.cached
      if (
        options.enabled &&
        cached &&
        (options.valid?.(cached.value) ?? true) &&
        cached.position === position &&
        cached.revision === options.revision &&
        options.now() - cached.at < 10_000
      ) {
        return cached.value
      }
      const value = await options.read()
      if (value === undefined || !options.admitted()) return undefined
      this.cached = { value, position, revision: options.revision, at: options.now() }
      return value
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
