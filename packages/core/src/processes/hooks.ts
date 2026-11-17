/**
 * Configured hooks (§16.1 `[hooks]`): observe-only consumers the
 * lease-holding local dispatcher feeds. Each hook runs its own in-process
 * `ab watch` feed (`cli/watch.ts`, `WatchFeed`) from a durable position, and
 * every record the feed emits — the exact `ab watch --json` line, `id`
 * included — is delivered to the hook's command, one at a time and in order.
 * Progress advances only after a success, so delivery is at-least-once.
 *
 * Nothing here is read by a decision path: a hook's exit status, output and
 * duration never reach build state, and each hook has its own async loop
 * outside the dispatch tick, so a slow or failing hook delays nothing else.
 *
 * Durable progress is the latest revision of the retention-managed
 * repository artifact `hook-progress.<name>`. Its `position` is a safe point:
 * a feed cursor such that every record emitted before it has been delivered.
 * It moves on each success, and — for progress the hook's filter does not
 * match — through checkpoints taken only when every record emitted before
 * them has succeeded.
 *
 * Read cost: one shared gate reads `getRepoChangePosition` once per interval
 * for every hook. An unchanged position runs only in-memory timer checks;
 * a changed one runs each feed's incremental pass. Build discovery depends on
 * ticket preparation journaling `creation-selected` and `resolved owned`
 * around every `createBuild` (see `WatchFeed`); a new `createBuild` call site
 * must journal the same way or hooks will not see its builds.
 */
import { z } from 'zod'
import type { HookConfig } from '../config/schema'
import type { RepositoryEventWrite } from '../events/repository'
import { DISPATCHER } from '../events/envelope'
import { CursorTooOldError, RetiredSeedGenerationError } from '../store/event-reads'
import { hookProgressKind } from '../store/retention'
import type { BuildStore } from '../store/types'
import { abWatch, decodeCursor, type WatchJsonRecord } from '../cli/watch'
import { defaultDelay } from '../cli/remote-poll'

/** Continuous failure after which `hook.failing` is recorded, once per episode. */
export const HOOK_FAILING_ATTENTION_MS = 5 * 60_000
/** Longest a safe checkpoint of filtered-out progress waits while the position moves. */
export const HOOK_CHECKPOINT_INTERVAL_MS = 30_000
/** Queued records at which a feed stops reading further events this pass. */
export const HOOK_QUEUE_LIMIT = 500
const BACKOFF_MAX_MS = 60_000
const SKIPPED_RANGES_MAX = 1_000

export const hookProgressSchema = z.strictObject({
  v: z.literal(1),
  hook: z.string().min(1),
  /** The durable safe point: every record emitted before it was delivered. */
  position: z.string().min(1),
  delivered: z.number().int().min(0),
  lastSuccessAt: z.iso.datetime().optional(),
  lastDeliveredId: z.string().min(1).optional(),
  /** Records queued, including one in flight, when this revision was written. */
  pending: z.number().int().min(0),
  failing: z
    .strictObject({
      since: z.iso.datetime(),
      attempts: z.number().int().min(1),
      error: z.string(),
      reported: z.boolean(),
    })
    .optional(),
  /** A reported failure episode whose `hook.recovered` is not yet recorded. */
  recovery: z
    .strictObject({
      since: z.iso.datetime(),
      attempts: z.number().int().min(1),
    })
    .optional(),
  updatedAt: z.iso.datetime(),
})
export type HookProgress = z.infer<typeof hookProgressSchema>

/** The latest valid progress of one hook; an invalid artifact counts as absent. */
export async function readHookProgress(
  store: Pick<BuildStore, 'getRepoArtifact'>,
  repo: string,
  name: string,
  warn?: (message: string) => void,
): Promise<HookProgress | undefined> {
  const artifact = await store.getRepoArtifact(repo, hookProgressKind(name))
  if (artifact === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(artifact.content))
  } catch {
    value = undefined
  }
  const parsed = hookProgressSchema.safeParse(value)
  if (parsed.success) return parsed.data
  warn?.(`hook ${name}: ignoring invalid progress; starting from the current position`)
  return undefined
}

export type HookInvokeResult = { ok: true } | { ok: false; error: string }
/** Deliver one record (`line` ends with a newline). Never throws. */
export type HookInvoke = (
  hook: { name: string; config: HookConfig },
  line: string,
  signal: AbortSignal,
) => Promise<HookInvokeResult>

export interface HookSupervisorDeps {
  store: BuildStore
  repo: string
  storeRef: string
  checkout: string
  clock: () => Date
  invoke: HookInvoke
  warn: (message: string) => void
  appendRepo: (event: RepositoryEventWrite) => Promise<unknown>
  /** The change-gate cadence: 1 s for local stores, 5 s remote. */
  intervalMs: number
  /** Gate sleep between position reads; injectable for tests. */
  interval?: (signal: AbortSignal) => Promise<void>
  /** Retry backoff sleep; injectable for tests. */
  backoff?: (ms: number, signal: AbortSignal) => Promise<void>
}

interface Queued {
  id: string
  line: string
  cursor: string
}

/**
 * One gate for every hook: a single `getRepoChangePosition` read per interval,
 * however many hooks are configured, and none when no hook is.
 */
export class HookSupervisor {
  private readonly workers = new Map<string, HookWorker>()
  private gate: AbortController | undefined
  private gateTask: Promise<void> | undefined
  private waiters = new Set<() => void>()
  /** The last change position read; workers compare it to what they consumed. */
  position: string | undefined
  private gateReported = false

  constructor(readonly deps: HookSupervisorDeps) {}

  /** Start new hooks, stop removed ones, restart changed ones from durable progress. */
  async reconcile(hooks: Readonly<Record<string, HookConfig>>): Promise<void> {
    const stopping: Promise<void>[] = []
    for (const [name, worker] of this.workers) {
      const next = Object.hasOwn(hooks, name) ? hooks[name] : undefined
      if (next !== undefined && JSON.stringify(next) === JSON.stringify(worker.config)) continue
      this.workers.delete(name)
      stopping.push(worker.stop())
    }
    await Promise.all(stopping)
    for (const [name, config] of Object.entries(hooks)) {
      if (this.workers.has(name)) continue
      const worker = new HookWorker(this, name, config, 'watch')
      this.workers.set(name, worker)
      worker.start()
    }
    if (this.workers.size > 0) this.startGate()
    else await this.stopGate()
  }

  /** Stop every worker (in-flight commands are terminated and redelivered later). */
  async stop(): Promise<void> {
    const workers = [...this.workers.values()]
    this.workers.clear()
    await Promise.all(workers.map((worker) => worker.stop()))
    await this.stopGate()
  }

  /**
   * `ab dispatch --once`: each hook resumes, makes one full pass, delivers its
   * queue until empty or its first failure, and stops at a safe checkpoint.
   * The next invocation is the retry.
   */
  async drainOnce(hooks: Readonly<Record<string, HookConfig>>): Promise<void> {
    await Promise.all(
      Object.entries(hooks).map(async ([name, config]) => {
        const worker = new HookWorker(this, name, config, 'once')
        worker.start()
        await worker.settled
      }),
    )
  }

  /** Hook names with a running worker. */
  get names(): string[] {
    return [...this.workers.keys()]
  }

  /** One gate read, then wake every waiting feed. */
  async pulse(): Promise<void> {
    try {
      this.position = await this.deps.store.getRepoChangePosition(this.deps.repo)
      this.gateReported = false
    } catch (error) {
      if (!this.gateReported)
        this.deps.warn(
          `hooks: change position read failed (${error instanceof Error ? error.message : String(error)}); retrying`,
        )
      this.gateReported = true
    }
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }

  /** Resolves at the next gate pulse, or when `signal` aborts. */
  nextWake(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const wake = (): void => {
        signal.removeEventListener('abort', wake)
        this.waiters.delete(wake)
        resolve()
      }
      this.waiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }

  private startGate(): void {
    if (this.gate !== undefined) return
    const gate = new AbortController()
    this.gate = gate
    const sleep =
      this.deps.interval ?? ((signal: AbortSignal) => defaultDelay(this.deps.intervalMs, signal))
    this.gateTask = (async () => {
      while (!gate.signal.aborted) {
        await sleep(gate.signal)
        if (gate.signal.aborted) break
        await this.pulse()
      }
    })()
  }

  private async stopGate(): Promise<void> {
    this.gate?.abort()
    await this.gateTask
    this.gate = undefined
    this.gateTask = undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class HookWorker {
  private readonly stopping = new AbortController()
  private task: Promise<void> | undefined
  /** Resolves when the worker has fully stopped. */
  settled: Promise<void> = Promise.resolve()

  // Per feed session; reset whenever the feed (re)starts.
  private queue: Queued[] = []
  private emitted = 0
  private succeeded = 0
  private candidate: { cursor: string; emitted: number } | undefined
  private consumed: string | undefined
  private queued: (() => void) | undefined
  private passes = 0
  private passDone: (() => void) | undefined

  /** The in-memory progress; `written` is the last revision persisted. */
  private state: HookProgress | undefined
  private written: HookProgress | undefined
  private lastWriteAt = 0
  private writes: Promise<void> = Promise.resolve()
  private recoveryFailures = 0

  constructor(
    private readonly supervisor: HookSupervisor,
    readonly name: string,
    readonly config: HookConfig,
    private readonly mode: 'watch' | 'once',
  ) {}

  private get deps(): HookSupervisorDeps {
    return this.supervisor.deps
  }

  start(): void {
    this.task = this.run().catch((error) => {
      this.deps.warn(`hook ${this.name}: stopped unexpectedly (${errorMessage(error)})`)
    })
    this.settled = this.task
  }

  async stop(): Promise<void> {
    this.stopping.abort()
    await this.task
  }

  private now(): Date {
    return this.deps.clock()
  }

  private sleepBackoff(attempts: number, signal: AbortSignal): Promise<void> {
    const ms = Math.min(1000 * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS)
    return (this.deps.backoff ?? defaultDelay)(ms, signal)
  }

  /** Persist the current in-memory progress; writes are serialized and each
   * writes the newest state, so a slower write never regresses the position.
   * Resolves whether the write succeeded; a failure is warned, never thrown. */
  private persist(): Promise<boolean> {
    const next = this.writes.then(async () => {
      if (this.state === undefined) return true
      const snapshot: HookProgress = { ...this.state, updatedAt: this.now().toISOString() }
      try {
        await this.deps.store.putRepoArtifact(this.deps.repo, {
          kind: hookProgressKind(this.name),
          content: JSON.stringify(snapshot),
        })
        this.written = snapshot
        this.lastWriteAt = this.now().getTime()
        return true
      } catch (error) {
        this.deps.warn(`hook ${this.name}: progress write failed (${errorMessage(error)})`)
        return false
      }
    })
    this.writes = next.then(() => {})
    return next
  }

  private async append(event: RepositoryEventWrite): Promise<boolean> {
    try {
      await this.deps.appendRepo(event)
      return true
    } catch (error) {
      this.deps.warn(`hook ${this.name}: could not record ${event.type} (${errorMessage(error)})`)
      return false
    }
  }

  private async run(): Promise<void> {
    const stopping = this.stopping.signal
    let rebaseline: { reason: string; old: string | undefined } | undefined
    let feedFailures = 0
    while (!stopping.aborted) {
      let progress: HookProgress | undefined
      try {
        progress = await readHookProgress(this.deps.store, this.deps.repo, this.name, (message) =>
          this.deps.warn(message),
        )
      } catch (error) {
        feedFailures += 1
        this.deps.warn(`hook ${this.name}: progress read failed (${errorMessage(error)}); retrying`)
        if (this.mode === 'once') return
        await this.sleepBackoff(feedFailures, stopping)
        continue
      }
      this.state = progress
      this.written = progress
      this.lastWriteAt = this.now().getTime()
      this.queue = []
      this.emitted = 0
      this.succeeded = 0
      this.candidate = undefined
      this.passes = 0
      this.consumed = this.supervisor.position

      // A position this store or repository cannot resume (a moved checkout,
      // a switched store) is history the hook can no longer read.
      if (rebaseline === undefined && progress !== undefined) {
        try {
          decodeCursor(progress.position, { store: this.deps.storeRef, repo: this.deps.repo })
        } catch (error) {
          rebaseline = { reason: errorMessage(error), old: undefined }
        }
      }
      const session = new AbortController()
      const signal = AbortSignal.any([stopping, session.signal])
      const since = rebaseline === undefined ? progress?.position : undefined
      const skip = rebaseline
      const delivery = this.deliver(signal, session)
      let failure: unknown
      try {
        await abWatch({
          targetRepo: this.deps.checkout,
          env: {},
          exec: async () => {
            throw new Error('hook feeds run no commands')
          },
          stdout: () => {},
          stderr: (line) => this.deps.warn(`hook ${this.name}: ${line}`),
          ...(since !== undefined ? { since } : {}),
          ...(this.config.events !== undefined ? { events: this.config.events } : {}),
          timeout: '0',
          json: true,
          now: () => this.now(),
          delay: (_ms, delaySignal) => this.feedDelay(delaySignal ?? signal),
          signal,
          feed: {
            context: {
              store: this.deps.store,
              repo: this.deps.repo,
              storeRef: this.deps.storeRef,
              checkout: this.deps.checkout,
            },
            record: (record) => this.enqueue(record),
            baseline: (cursor) => this.saveBaseline(cursor, progress, skip),
            position: (cursor) => this.onPosition(cursor),
            changed: async () => {
              if (this.mode === 'once') return true
              const position = this.supervisor.position
              if (position === this.consumed) return false
              this.consumed = position
              return true
            },
            saturated: () => this.queue.length >= HOOK_QUEUE_LIMIT,
            unresolved: async (reason) => {
              await this.deps.appendRepo({
                actor: DISPATCHER,
                type: 'hook.skipped',
                payload: { hook: this.name, reason, ranges: [] },
              })
            },
          },
        })
      } catch (error) {
        failure = error
      }
      session.abort()
      await delivery
      if (stopping.aborted || (this.mode === 'once' && failure === undefined)) {
        await this.checkpoint(true)
        await this.writes
        return
      }
      rebaseline = undefined
      if (failure instanceof CursorTooOldError || failure instanceof RetiredSeedGenerationError) {
        // History the hook still needed is gone: resume from the current
        // position and report the skipped range, never drop it silently.
        rebaseline = { reason: errorMessage(failure), old: this.state?.position }
        continue
      }
      feedFailures += 1
      this.deps.warn(`hook ${this.name}: feed failed (${errorMessage(failure)}); restarting`)
      if (this.mode === 'once') return
      await this.sleepBackoff(feedFailures, stopping)
    }
  }

  /** The pre-emission baseline of a new hook (or a rebaseline), persisted
   * before the feed emits anything. */
  private async saveBaseline(
    cursor: string,
    progress: HookProgress | undefined,
    skip: { reason: string; old: string | undefined } | undefined,
  ): Promise<void> {
    if (skip !== undefined) {
      await this.deps.appendRepo({
        actor: DISPATCHER,
        type: 'hook.skipped',
        payload: {
          hook: this.name,
          reason: skip.reason.slice(0, 1_000) || 'history unavailable',
          ranges: this.skippedRanges(skip.old, cursor),
        },
      })
    }
    const now = this.now().toISOString()
    const next: HookProgress = {
      v: 1,
      hook: this.name,
      position: cursor,
      delivered: progress?.delivered ?? 0,
      ...(progress?.lastSuccessAt !== undefined ? { lastSuccessAt: progress.lastSuccessAt } : {}),
      ...(progress?.lastDeliveredId !== undefined
        ? { lastDeliveredId: progress.lastDeliveredId }
        : {}),
      pending: 0,
      ...(progress?.failing !== undefined ? { failing: progress.failing } : {}),
      ...(progress?.recovery !== undefined ? { recovery: progress.recovery } : {}),
      updatedAt: now,
    }
    await this.deps.store.putRepoArtifact(this.deps.repo, {
      kind: hookProgressKind(this.name),
      content: JSON.stringify(next),
    })
    this.state = next
    this.written = next
    this.lastWriteAt = this.now().getTime()
  }

  private skippedRanges(
    old: string | undefined,
    cursor: string,
  ): { stream: string; after: number; through: number }[] {
    if (old === undefined) return []
    const expected = { store: this.deps.storeRef, repo: this.deps.repo }
    try {
      const before = decodeCursor(old, expected).streams
      const after = decodeCursor(cursor, expected).streams
      const ranges: { stream: string; after: number; through: number }[] = []
      for (const [stream, through] of Object.entries(after)) {
        const from = before[stream]
        if (from !== undefined && through > from) ranges.push({ stream, after: from, through })
      }
      return ranges.slice(0, SKIPPED_RANGES_MAX)
    } catch {
      return []
    }
  }

  private enqueue(record: WatchJsonRecord): void {
    this.emitted += 1
    this.queue.push({ id: record.id, line: JSON.stringify(record), cursor: record.cursor })
    this.queued?.()
  }

  private onPosition(cursor: string): void {
    this.candidate = { cursor, emitted: this.emitted }
    this.passes += 1
    void this.checkpoint(false)
    // `--once`: the resume pass and one full pass are the whole feed.
    if (this.mode === 'once' && this.passes >= 2) this.passDone?.()
  }

  private async feedDelay(signal: AbortSignal): Promise<void> {
    if (this.mode === 'watch') return this.supervisor.nextWake(signal)
    if (this.passes < 2) return
    // After its full pass a `--once` feed waits for delivery to finish.
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  /**
   * Persist the newest safe candidate: one taken after the last delivered
   * record, while nothing emitted before it is still undelivered. Only that
   * candidate is both safe and newer than the delivered position.
   */
  private async checkpoint(force: boolean): Promise<void> {
    const candidate = this.candidate
    if (this.state === undefined || candidate === undefined) return
    if (candidate.emitted !== this.succeeded || candidate.cursor === this.state.position) return
    if (!force && this.now().getTime() - this.lastWriteAt < HOOK_CHECKPOINT_INTERVAL_MS) return
    this.state = { ...this.state, position: candidate.cursor, pending: this.queue.length }
    await this.persist()
  }

  /** Waits for a queued record or the end of the session. */
  private waitForRecord(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || this.queue.length > 0) return resolve()
      const done = (): void => {
        this.queued = undefined
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.queued = done
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Waits for a queued record, or a backoff before retrying the recovery report. */
  private async waitForRecordOrRetry(signal: AbortSignal): Promise<void> {
    const woken = new AbortController()
    const both = AbortSignal.any([signal, woken.signal])
    await Promise.race([
      this.waitForRecord(both),
      this.sleepBackoff(Math.max(1, this.recoveryFailures), both),
    ])
    woken.abort()
  }

  /**
   * Record the outstanding `hook.recovered`, if any, and clear the durable
   * obligation. Resolves false while the append fails; the command is never
   * rerun to retry it.
   */
  private async reportRecovery(): Promise<boolean> {
    const recovery = this.state?.recovery
    if (recovery === undefined) return true
    const recorded = await this.append({
      actor: DISPATCHER,
      type: 'hook.recovered',
      payload: { hook: this.name, since: recovery.since, attempts: recovery.attempts },
    })
    if (!recorded) {
      this.recoveryFailures += 1
      return false
    }
    this.recoveryFailures = 0
    const { recovery: _reported, ...rest } = this.state!
    this.state = rest
    await this.persist()
    return true
  }

  private async deliver(signal: AbortSignal, session: AbortController): Promise<void> {
    const hook = { name: this.name, config: this.config }
    let passEnded = this.mode === 'watch'
    if (this.mode === 'once') {
      void new Promise<void>((resolve) => {
        this.passDone = resolve
      }).then(() => {
        passEnded = true
        this.queued?.()
      })
    }
    while (!signal.aborted) {
      await this.reportRecovery()
      const head = this.queue[0]
      if (head === undefined) {
        if (this.mode === 'once' && passEnded) {
          session.abort()
          return
        }
        if (this.mode === 'watch' && this.state?.recovery !== undefined)
          await this.waitForRecordOrRetry(signal)
        else await this.waitForRecord(signal)
        continue
      }
      if (this.state === undefined) {
        await this.waitForRecord(signal)
        continue
      }
      if (this.written?.pending === 0) {
        this.state = { ...this.state, pending: this.queue.length }
        await this.persist()
      }
      const result = await this.deps.invoke(hook, `${head.line}\n`, signal)
      // A stop terminates the in-flight attempt; it is neither a success nor
      // a failure, and the record is redelivered by the next session.
      if (signal.aborted) return
      if (result.ok) {
        // The next record waits until this success is durable, so a restart
        // redelivers at most the one record in flight.
        if (!(await this.succeed(head, signal))) {
          if (this.mode === 'once') session.abort()
          return
        }
      } else {
        await this.fail(head, result.error)
        if (this.mode === 'once') {
          session.abort()
          return
        }
        await this.sleepBackoff(this.state?.failing?.attempts ?? 1, signal)
      }
    }
  }

  /**
   * Record a success and persist it, retrying the progress write with backoff
   * (never the command). Resolves false when the session ends, or a `--once`
   * write fails, before the success is durable; the record is then redelivered.
   */
  private async succeed(record: Queued, signal: AbortSignal): Promise<boolean> {
    this.queue.shift()
    this.succeeded += 1
    const failing = this.state!.failing
    const candidate = this.candidate
    // A candidate snapshotted after this record (and nothing undelivered
    // before it) is newer and still safe: it carries filtered-out progress.
    const position =
      candidate !== undefined && candidate.emitted === this.succeeded
        ? candidate.cursor
        : record.cursor
    const { failing: _cleared, ...rest } = this.state!
    this.state = {
      ...rest,
      position,
      delivered: this.state!.delivered + 1,
      lastSuccessAt: this.now().toISOString(),
      lastDeliveredId: record.id,
      pending: this.queue.length,
      // The episode's recovery is an obligation persisted with the success
      // and reported by the delivery loop until `hook.recovered` lands.
      ...(failing?.reported === true
        ? { recovery: { since: failing.since, attempts: failing.attempts } }
        : {}),
    }
    let attempts = 0
    while (!(await this.persist())) {
      attempts += 1
      if (this.mode === 'once' || signal.aborted) return false
      await this.sleepBackoff(attempts, signal)
      if (signal.aborted) return false
    }
    return true
  }

  private async fail(record: Queued, error: string): Promise<void> {
    const now = this.now()
    const message = error.trim().length > 0 ? error.slice(0, 1_000) : 'failed'
    const previous = this.state!.failing
    const failing = previous
      ? { ...previous, attempts: previous.attempts + 1, error: message }
      : { since: now.toISOString(), attempts: 1, error: message, reported: false }
    this.state = { ...this.state!, failing, pending: this.queue.length }
    let write = previous === undefined
    if (previous === undefined)
      this.deps.warn(`hook ${this.name}: delivery of ${record.id} failed (${message}); retrying`)
    if (
      !failing.reported &&
      now.getTime() - Date.parse(failing.since) >= HOOK_FAILING_ATTENTION_MS &&
      // A new episode is reported only after the previous one's recovery.
      (await this.reportRecovery())
    ) {
      if (
        await this.append({
          actor: DISPATCHER,
          type: 'hook.failing',
          payload: {
            hook: this.name,
            since: failing.since,
            attempts: failing.attempts,
            error: message,
            record: record.id,
          },
        })
      ) {
        this.state = { ...this.state, failing: { ...failing, reported: true } }
        write = true
      }
    }
    if (write || this.mode === 'once') await this.persist()
  }
}
