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
  ) {}

  get painting(): boolean {
    return !this.suspended
  }

  get isFocused(): boolean {
    return this.focused && !this.suspended
  }

  get admitted(): boolean {
    return this.active && !this.suspended && (this.focused || this.permit === this.generation)
  }

  activity(live: boolean): void {
    this.live = live
  }

  focus(focused: boolean): void {
    this.focused = focused
    this.generation += 1
    this.cancel()
    if (focused) void this.request()
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
    this.focus(true)
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
    if (!this.active || this.suspended || (!this.focused && !interaction)) return Promise.resolve()
    if (this.flight !== undefined) {
      // A focus round trip invalidates an outstanding read. Refresh again after
      // it settles, rather than losing the focus-in wakeup.
      if (this.permit !== this.generation) this.wake = true
      return this.flight
    }
    this.cancel()
    this.started = this.time.now()
    this.permit = this.generation
    const current = Promise.resolve()
      .then(() => readIntent.run(false, this.refresh))
      .catch(() => {})
      .finally(() => {
        if (this.flight !== current) return
        this.flight = undefined
        this.permit = undefined
        if (this.wake && this.active && !this.suspended && this.focused) {
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

  private schedule(): void {
    if (!this.active || this.suspended || !this.focused) return
    const interval = this.live || this.time.now() < this.deadline ? 500 : 5000
    // Slow/failing requests do not spin when their start deadline is overdue.
    const delay = Math.max(50, this.started + interval - this.time.now())
    this.timer = this.time.set(() => {
      this.timer = undefined
      void this.request()
    }, delay)
  }
}

/** Guard each asynchronous read stage, including reads inside shared caches.
 * Operator mutations keep their original store; only presentation readers use
 * this facade. A focus loss cannot recall I/O already dispatched. */
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
