/** Launcher-local supervision, anchored to the original durable takeover. */
export class DispatchCrashBudget {
  private failures = 0
  private readonly counted = new Set<string>()
  constructor(readonly takeoverAt: string) {}
  withinWindow(now: number): boolean {
    const elapsed = now - Date.parse(this.takeoverAt)
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 10 * 60_000
  }
  failed(run: string, now: number): 'restart' | 'rollback' | undefined {
    if (!this.withinWindow(now) || this.counted.has(run)) return undefined
    this.counted.add(run)
    return ++this.failures >= 3 ? 'rollback' : 'restart'
  }
}
