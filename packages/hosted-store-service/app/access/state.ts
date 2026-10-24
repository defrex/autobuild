/** A latest-request gate also invalidates requests on unmount. */
export function latestRequest() {
  let revision = 0
  return {
    start: () => ++revision,
    current: (id: number) => id === revision,
    invalidate: () => {
      revision++
    },
  }
}
/** Immediate exclusion, independent of React's next render. */
export function mutationGate() {
  let busy = false
  return async (
    write: () => Promise<unknown>,
    refresh: () => Promise<void>,
    report: (message: string) => void,
  ): Promise<boolean> => {
    if (busy) return false
    busy = true
    try {
      await write()
      try {
        await refresh()
      } catch (error) {
        report(
          `Change saved, but refresh failed: ${error instanceof Error ? error.message : 'service unavailable'}. Refresh to see current state.`,
        )
        return false
      }
      return true
    } catch (error) {
      report(error instanceof Error ? error.message : 'Access service unavailable. Try again.')
      return false
    } finally {
      busy = false
    }
  }
}

export interface Confirmation {
  context: string
  target: string
}
/** A destructive confirmation belongs to the exact acknowledged grant context. */
export function confirmedTarget(
  confirmation: Confirmation | undefined,
  context: string | undefined,
): string | undefined {
  return confirmation?.context === context ? confirmation?.target : undefined
}
