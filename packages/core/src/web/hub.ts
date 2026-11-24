import { DashboardRefresh, type RefreshScheduler } from '../cli/dashboard/refresh'
import { type WebFrame, type WebFrameSource, WebReadFencedError } from './protocol'

export type WebFrameListener = (json: string) => void

export interface WebModelHubOptions {
  /** Pull mode: the hub reads frames itself while anyone is connected. Absent
   * is push mode: the hub reads nothing and serves what `publish` hands it. */
  source?: WebFrameSource
  /** The store reads over a network; the refresh cadence adapts as the viewer's does. */
  networkReads?: boolean
  scheduler?: RefreshScheduler
  /** Called once per failure streak; a later success resets it. */
  onError?: (error: unknown) => void
}

/**
 * One refresh loop shared by every connected browser. The loop exists only
 * while at least one subscriber is connected, so an idle server reads
 * nothing; each tick reads one frame, serializes it once, and fans the string
 * out only when it changed, so ten tabs cost the same reads as one.
 *
 * At most one source read is in flight across the hub's lifetime: a loop
 * started by a reconnecting tab joins a read its predecessor left running
 * instead of starting a second one, and a read whose subscribers all left
 * stops at its next store stage.
 *
 * Without a source the hub is in push mode: it owns no loop and reads
 * nothing, and its owner publishes frames from reads it already makes
 * (`ab dispatch --web`).
 */
export class WebModelHub {
  private readonly listeners = new Set<WebFrameListener>()
  private refresh: DashboardRefresh | undefined
  /** The hub-wide in-flight read, shared across refresh loop generations. */
  private reading: ReturnType<WebFrameSource['read']> | undefined
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
    if (this.listeners.has(entry) && this.refresh === undefined && this.opts.source !== undefined) {
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

  /** Push mode: serve `frame`, fanning it out only when it changed. */
  publish(frame: WebFrame): void {
    if (this.closed) return
    this.push(JSON.stringify(frame))
  }

  /** Push mode: replace the frame with the failure's notice. */
  fail(error: unknown): void {
    this.publish(noticeFrame(error))
  }

  /** Await the in-flight tick and source read, if any. */
  async join(): Promise<void> {
    await this.refresh?.join()
    await this.reading?.catch(() => {})
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
      const result = await this.read()
      if (result === undefined) return
      refresh?.activity(result.live)
      frame = result.frame
      this.failing = false
    } catch (error) {
      // Abandoned for lack of subscribers: nobody is waiting for a notice.
      if (error instanceof WebReadFencedError) return
      frame = noticeFrame(error)
      if (!this.failing) this.opts.onError?.(error)
      this.failing = true
    }
    if (this.refresh !== refresh || refresh === undefined) return
    this.push(JSON.stringify(frame))
  }

  private push(json: string): void {
    if (json === this.json) return
    this.json = json
    for (const listener of [...this.listeners]) this.deliver(listener, json)
  }

  /** Start the source read, or join the one already running. */
  private read(): ReturnType<WebFrameSource['read']> {
    if (this.reading === undefined) {
      const reading = this.opts.source!.read(() => !this.closed && this.listeners.size > 0)
      this.reading = reading
      const clear = () => {
        if (this.reading === reading) this.reading = undefined
      }
      reading.then(clear, clear)
    }
    return this.reading
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

function noticeFrame(error: unknown): WebFrame {
  return { notice: `Viewer unavailable: ${error instanceof Error ? error.message : String(error)}` }
}
