import { DashboardRefresh, type RefreshScheduler } from '../cli/dashboard/refresh'
import type { WebFrame, WebFrameSource } from './protocol'

export type WebFrameListener = (json: string) => void

export interface WebModelHubOptions {
  source: WebFrameSource
  /** The store reads over a network; the refresh cadence adapts as the viewer's does. */
  networkReads: boolean
  scheduler?: RefreshScheduler
  /** Called once per failure streak; a later success resets it. */
  onError?: (error: unknown) => void
}

/**
 * One refresh loop shared by every connected browser. The loop exists only
 * while at least one subscriber is connected, so an idle server reads
 * nothing; each tick reads one frame, serializes it once, and fans the string
 * out only when it changed, so ten tabs cost the same reads as one.
 */
export class WebModelHub {
  private readonly listeners = new Set<WebFrameListener>()
  private refresh: DashboardRefresh | undefined
  private json: string | undefined
  private failing = false
  private closed = false

  constructor(private readonly opts: WebModelHubOptions) {}

  get subscribers(): number {
    return this.listeners.size
  }

  /** The last frame pushed, serialized; absent before the first read. */
  get current(): string | undefined {
    return this.json
  }

  subscribe(listener: WebFrameListener): () => void {
    if (this.closed) return () => {}
    // A distinct identity per subscription, so one function may subscribe twice.
    const entry: WebFrameListener = (json) => listener(json)
    this.listeners.add(entry)
    if (this.json !== undefined) this.deliver(entry, this.json)
    if (this.listeners.has(entry) && this.refresh === undefined) {
      // An absent scheduler takes DashboardRefresh's real-timer default.
      this.refresh = new DashboardRefresh(
        () => this.tick(),
        this.opts.scheduler,
        this.opts.networkReads,
      )
      void this.refresh.request()
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      this.remove(entry)
    }
  }

  /** Await the in-flight tick, if any. */
  async join(): Promise<void> {
    await this.refresh?.join()
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.stop()
  }

  private remove(entry: WebFrameListener): void {
    this.listeners.delete(entry)
    if (this.listeners.size === 0) this.stop()
  }

  private stop(): void {
    // DashboardRefresh.stop is terminal; the next subscriber starts a new loop.
    this.refresh?.stop()
    this.refresh = undefined
  }

  private async tick(): Promise<void> {
    const refresh = this.refresh
    let frame: WebFrame
    try {
      const result = await this.opts.source.read()
      if (result === undefined) return
      refresh?.activity(result.live)
      frame = result.frame
      this.failing = false
    } catch (error) {
      frame = {
        notice: `Viewer unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }
      if (!this.failing) this.opts.onError?.(error)
      this.failing = true
    }
    if (this.refresh !== refresh || refresh === undefined) return
    const json = JSON.stringify(frame)
    if (json === this.json) return
    this.json = json
    for (const listener of [...this.listeners]) this.deliver(listener, json)
  }

  private deliver(listener: WebFrameListener, json: string): void {
    try {
      listener(json)
    } catch {
      // A broken subscriber leaves; the others still receive the frame.
      this.remove(listener)
    }
  }
}
