/** Launcher-local supervision, anchored to the original durable takeover. */
export class DispatchCrashBudget {
  private failures = 0
  private readonly counted = new Set<string>()
  constructor(readonly takeoverAt: string) {}
  failed(run: string, now: number): 'restart' | 'rollback' | undefined {
    const elapsed = now - Date.parse(this.takeoverAt)
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10 * 60_000 || this.counted.has(run))
      return undefined
    this.counted.add(run)
    return ++this.failures >= 3 ? 'rollback' : 'restart'
  }
}
