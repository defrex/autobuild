import type { BuildStore, OperatorIdentity } from '../store/types'

/** A single budget covers cancellation, ordered withdrawal and handle closure. */
export class WatchLifetime {
  readonly writes = new AbortController()
  readonly deadline = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private withdrawal: Promise<void> | undefined
  private identity: OperatorIdentity | undefined
  private store: BuildStore | undefined
  private repo = ''
  private reported = false
  private withdrawn = false
  private readonly terminate = (): void => {
    this.timer ??= setTimeout(() => this.deadline.abort(), 2_000)
    this.writes.abort()
    if (this.identity) this.withdrawal ??= this.withdraw()
  }

  constructor(
    private readonly signal: AbortSignal | undefined,
    private readonly stderr: (line: string) => void,
  ) {
    signal?.addEventListener('abort', this.terminate, { once: true })
    if (signal?.aborted) this.terminate()
  }

  get terminated(): boolean {
    return this.signal?.aborted === true
  }

  register(store: BuildStore, repo: string, identity: OperatorIdentity): Promise<unknown> {
    this.store = store
    this.repo = repo
    this.identity = identity
    // Even an already-terminated invocation must not leave a registration behind.
    if (this.terminated) {
      this.withdrawal ??= this.withdraw()
      return Promise.resolve()
    }
    return this.renew()
  }

  renew(): Promise<unknown> {
    if (this.terminated) return Promise.resolve()
    this.pending = this.store!.upsertOperatorPresence(this.repo, this.identity!, this.writes.signal)
    return this.pending
  }

  private report(error: unknown): void {
    if (this.reported || !this.identity) return
    this.reported = true
    this.stderr(
      `ab watch: operator withdrawal failed (${String(error)}); falling back to TTL expiry`,
    )
  }

  private async withdraw(): Promise<void> {
    try {
      // Abort and drain the writer before DELETE: a late heartbeat must never
      // recreate the registration. Never race DELETE ahead of an unacknowledged write.
      await this.pending.catch(() => {})
      if (this.identity && !this.deadline.signal.aborted) {
        await this.store!.removeOperatorPresence(this.repo, this.identity.id, this.deadline.signal)
        this.withdrawn = true
      }
    } catch (error) {
      this.report(error)
    }
  }

  limitCallback<A, T>(run: (arg: A) => Promise<T>): (arg: A) => Promise<T | undefined> {
    return (arg) => this.limit(run(arg))
  }

  async limit<T>(task: Promise<T>): Promise<T | undefined> {
    return untilDeadline(task, this.deadline.signal)
  }

  async finish(): Promise<void> {
    if (!this.terminated) return
    await this.limit(this.withdrawal ?? Promise.resolve())
    if (this.deadline.signal.aborted && !this.withdrawn) this.report('shutdown deadline exceeded')
  }

  close(): void {
    this.signal?.removeEventListener('abort', this.terminate)
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}

export async function untilDeadline<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) {
    void task.catch(() => {})
    return undefined
  }
  let expired: () => void = () => {}
  const deadline = new Promise<undefined>((resolve) => {
    expired = () => resolve(undefined)
    signal.addEventListener('abort', expired, { once: true })
  })
  try {
    return await Promise.race([task, deadline])
  } finally {
    signal.removeEventListener('abort', expired)
  }
}
