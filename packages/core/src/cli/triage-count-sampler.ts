import { triageStateCount } from '../ports/tickets/states'
import type { TicketSource } from '../ports/types'

/** Minimum gap between display-only triage count reads, measured from the
 * start of one read to the start of the next. Shared by the dispatcher's
 * dashboard sampler and the viewer frontend. */
export const TRIAGE_COUNT_REFRESH_MS = 60_000

/** Background, single-flight sampler for the display-only triage count.
 * Callers poke it between dispatcher ticks; it never runs inside one. A read
 * that throws or answers `undefined` keeps the last good value, so the header
 * shows `–` until the first success rather than an invented zero. */
export class TriageCountSampler {
  private current: number | undefined
  private lastStartedAt = -Infinity
  private inFlight: Promise<void> | undefined

  constructor(
    private readonly read: () => Promise<number | undefined>,
    private readonly clock: () => Date,
    private readonly intervalMs = TRIAGE_COUNT_REFRESH_MS,
  ) {}

  get value(): number | undefined {
    return this.current
  }

  /** Start a background read when none is in flight and the interval has
   * passed since the last read started. Never awaits the read. */
  poke(): void {
    const now = this.clock().getTime()
    if (this.inFlight !== undefined || now - this.lastStartedAt < this.intervalMs) return
    this.lastStartedAt = now
    this.inFlight = (async () => {
      try {
        const count = await this.read()
        if (count !== undefined) this.current = count
      } catch {
        // Display only: keep the last good count and retry after the interval.
      } finally {
        this.inFlight = undefined
      }
    })()
  }

  /** Resolves once the in-flight read, if any, finishes. For tests. */
  async settled(): Promise<void> {
    await this.inFlight
  }
}

/** One bounded triage count read: `countStates([triage])` when the source has
 * it, else `listStates()`; a source with neither has no count. The triage name
 * is resolved per read so a config reload takes effect. */
export function triageReader(
  source: Pick<TicketSource, 'countStates' | 'listStates'>,
  triageName: () => string,
): () => Promise<number | undefined> {
  return async () => {
    const name = triageName()
    if (source.countStates) return triageStateCount(await source.countStates([name]), name)
    if (source.listStates) return triageStateCount(await source.listStates(), name)
    return undefined
  }
}
