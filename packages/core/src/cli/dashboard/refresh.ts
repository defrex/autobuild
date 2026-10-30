import { AsyncLocalStorage } from 'node:async_hooks'

const readIntent = new AsyncLocalStorage<boolean>()

/** Reads needed by an explicitly requested action may finish while unfocused. */
export function interactionRead<T>(operation: () => T): T {
  return readIntent.run(true, operation)
}

/** Presentation-only read scheduling. Kernel timers never use this controller. */
export interface RefreshScheduler {
  now(): number
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
const scheduler: RefreshScheduler = {
  now: Date.now,
  set: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return timer
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class DashboardRefresh {
  private focused = true
  private active = true
  private suspended = false
  private live = true // Unknown startup activity retries quickly.
  private deadline = -Infinity
  private started = -Infinity
  private timer: unknown
  private flight: Promise<void> | undefined
  private generation = 0
  private permit: number | undefined
  private wake = false

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly time: RefreshScheduler = scheduler,
    private readonly networkReads = false,
    private readonly cadenceMs?: number,
  ) {}

  get painting(): boolean {
    return !this.suspended
  }

  get isFocused(): boolean {
    return this.focused && !this.suspended
  }

  get admitted(): boolean {
    return this.active && !this.suspended
  }

  activity(live: boolean): void {
    this.live = live
  }

  focus(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (focused) void this.request()
    else if (this.networkReads) {
      this.cancel()
      if (this.flight === undefined) this.schedule()
    }
  }

  interaction(): void {
    this.deadline = this.time.now() + 30_000
    void this.request(true)
  }

  suspend(): void {
    this.suspended = true
    this.generation += 1
    this.cancel()
  }

  resume(): void {
    this.suspended = false
    this.focused = true
    void this.request()
  }

  stop(): void {
    this.active = false
    this.generation += 1
    this.cancel()
  }

  async join(): Promise<void> {
    await this.flight
  }

  /** One final focused snapshot, after input and scheduled polling are closed. */
  async finalRefresh(): Promise<void> {
    await this.join()
    if (!this.focused || this.suspended) return
    this.active = true
    try {
      await this.request()
    } finally {
      this.stop()
    }
  }

  request(interaction = false): Promise<void> {
    if (!this.active || this.suspended) return Promise.resolve()
    if (this.flight !== undefined) {
      // Retain an explicit wakeup that arrives during outstanding I/O.
      if (interaction || this.permit !== this.generation) this.wake = true
      return this.flight
    }
    this.cancel()
    this.wake = false
    this.started = this.time.now()
    this.permit = this.generation
    const current = Promise.resolve()
      .then(() => readIntent.run(false, this.refresh))
      .catch(() => {})
      .finally(() => {
        if (this.flight !== current) return
        this.flight = undefined
        this.permit = undefined
        if (this.wake && this.active && !this.suspended) {
          this.wake = false
          void this.request()
        } else this.schedule()
      })
    this.flight = current
    return current
  }

  private cancel(): void {
    if (this.timer !== undefined) this.time.clear(this.timer)
    this.timer = undefined
  }

  /** Current admission cadence, also used to bound presentation staleness. */
  get intervalMs(): number {
    if (this.cadenceMs !== undefined) return this.cadenceMs
    if (this.networkReads && !this.focused) return 5000
    return this.live || this.time.now() < this.deadline ? 500 : 5000
  }

  private schedule(): void {
    if (!this.active || this.suspended) return
    const interval = this.intervalMs
    // Slow/failing requests do not spin when their start deadline is overdue.
    const remaining = Number.isFinite(this.started)
      ? this.started + interval - this.time.now()
      : interval
    const delay = remaining > 0 ? remaining : this.networkReads && !this.focused ? interval : 50
    this.timer = this.time.set(() => {
      this.timer = undefined
      void this.request()
    }, delay)
  }
}

/** Guard each asynchronous read stage, including reads inside shared caches.
 * Operator mutations keep their original store; only presentation readers use
 * this facade. Suspension and stop fence subsequent read stages. */
export function presentationReader<T extends object>(store: T, admitted: () => boolean): T {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (
          /^(get|list|read|load)/u.test(String(key)) &&
          !admitted() &&
          readIntent.getStore() !== true
        ) {
          return Promise.reject(new Error('dashboard presentation read paused'))
        }
        return Reflect.apply(value, target, args)
      }
    },
  })
}
