/**
 * The shared remote long-poll task machinery behind `ab watch` and `ab wait`
 * (AUT-334, corrected for `ab wait` in AUT-368, extracted in AUT-403). One
 * long-poll task per tracked stream runs concurrently against an `http(s)`
 * store: a held `getEvents` request per stream is always in flight, gap-fill
 * spaces request starts at least one interval apart, and every stop — a
 * domain condition, an external abort, or an elapsed deadline — cancels the
 * in-flight holds and wakes the gap sleeps instead of waiting out a full
 * hold. A hold's own bound is capped at the remaining time budget.
 *
 * The two commands keep their different semantics through injected
 * callbacks (`shouldStop`, per-task `endCheck`, the discovery step) and two
 * explicit configuration points (`drain` mode, `deadlineMs`); everything
 * mechanical lives here, so a fix to streak or stop handling cannot land in
 * one command and silently miss the other.
 *
 * Timing is fully injected (`now`, `sleep`): the module never reads the wall
 * clock and never schedules a real timer, so tests drive every wait
 * deterministically.
 */
import { REMOTE_EVENT_WAIT_SECONDS } from '../store/remote/client'

/** The read options one held long-poll request carries. */
export interface RemotePollReadOpts {
  waitSeconds?: number
  signal?: AbortSignal
}

/**
 * The default abortable sleep: resolves after `ms`, or as soon as `signal`
 * aborts. Shared verbatim by `ab watch` and `ab wait` as the `delay` default.
 */
export function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A failed read is reported once per failure streak, advances nothing, and
 * is retried at the next interval (local) or next request (remote); a
 * success on the same source re-arms the report. Each read source — per
 * stream task, plus discovery — carries its own streak, so a persistent
 * failure on one stream interleaved with successes elsewhere is still
 * reported only once.
 */
export function makeFailureStreak(
  command: string,
  stderr: (line: string) => void,
): { onFailure: (error: unknown) => void; onSuccess: () => void } {
  let reported = false
  return {
    onFailure: (error: unknown): void => {
      if (reported) return
      reported = true
      const message = error instanceof Error ? error.message : String(error)
      stderr(`ab ${command}: a store read failed (${message}); retrying at the next interval`)
    },
    onSuccess: (): void => {
      reported = false
    },
  }
}

export interface RemotePollRunnerOpts {
  /** `'watch' | 'wait'` — the streak message's command prefix. */
  command: string
  stderr: (line: string) => void
  /** Injected clock; never the wall clock directly. */
  now: () => Date
  /** Injected delay; every wait the runner makes goes through this. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** The gap-fill floor between request starts. */
  intervalMs: number
  /** Epoch ms at which reads stop; `Number.POSITIVE_INFINITY` for an
   * unbounded `--timeout 0`. */
  deadlineMs: number
  /** The external signal only (SIGINT) — never widened to the domain stop
   * terms, so a failure observed as the deadline elapses is still reported. */
  aborted: () => boolean
  /** The loop-guard predicate: `aborted() || deadline elapsed || domain
   * stop`. Evaluated at the top of every task cycle. */
  shouldStop: () => boolean
  /** Invoked on every runner stop — a task's endCheck, the discovery task's
   * endCheck, or a caller-initiated `requestStop`. `ab watch` trips its
   * shared `stop` flag here: `pollBuild`/`pollRepository` gate their batch
   * loops on that flag (`if (stop) break`), so a sibling task whose held
   * read has already resolved must stop delivering its batch the moment any
   * task observes the terminal condition — exactly what the pre-extraction
   * command-scoped `requestStop` did (f_42263f38). May fire more than once
   * (every `requestStop` call fires it); the callback must be idempotent. */
  onStop?: () => void
  /** How `drain()` treats tasks launched while it is awaiting.
   * `'snapshot'`: await only the tasks present when `drain()` is called
   * (`ab watch`'s one-shot semantics). `'quiesce'`: keep awaiting until no
   * task remains (`ab wait`'s semantics — the exit decision must observe
   * every task settled). */
  drain: 'snapshot' | 'quiesce'
}

export interface RemotePollRunner {
  /** Whether a stop has been requested — by `requestStop` or a task's own
   * `endCheck`. */
  readonly stopped: boolean
  /** Abort every in-flight held read, wake the gap sleeps, mark stopped. */
  requestStop(): void
  /** Launch one per-stream long-poll task; idempotent per key. `endCheck`
   * runs after each successful poll; true ⇒ requestStop + return. */
  launch(
    key: string,
    poll: (readOpts: RemotePollReadOpts) => Promise<unknown>,
    endCheck?: () => boolean,
  ): void
  /** The interval-cadence discovery task, self-tracked for drain. `step`
   * (the discovery read) runs inside the try/catch; `launchPending` (the
   * launch-everything loop) runs UNCONDITIONALLY after the catch, so streams
   * registered before a mid-discovery throw are still launched; `endCheck`
   * (wait only) runs after `launchPending`, throw or not. */
  runDiscovery(opts: {
    step: () => Promise<void>
    launchPending: () => void
    endCheck?: () => boolean
  }): Promise<void>
  /** Await launched tasks per the configured strategy. */
  drain(): Promise<void>
}

/**
 * Build the per-command runner over the shared machinery. Every piece is
 * moved verbatim from the command-local copies this module replaces; the
 * commands' different stop and drain semantics enter only through `opts`.
 */
export function createRemotePollRunner(opts: RemotePollRunnerOpts): RemotePollRunner {
  // Held reads in flight right now, each with its own controller. When the
  // command stops for any reason, every in-flight read is cancelled —
  // otherwise a stop during a quiet window would wait out a full wait
  // window (up to the remote hold) before the command could exit.
  const inFlightReads = new Set<AbortController>()
  // Wakes stop-aware gap sleeps the moment the command stops.
  const stopController = new AbortController()
  let stopped = false
  const requestStop = (): void => {
    stopped = true
    opts.onStop?.()
    stopController.abort()
    for (const controller of inFlightReads) controller.abort()
  }

  /** The wait bound for one held read: the remote default, capped at the
   * command's remaining time budget. With an unbounded deadline the same
   * expression yields exactly the remote default, so one form covers both. */
  const readWaitSeconds = (atMs: number): number => {
    const remaining = Math.floor((opts.deadlineMs - atMs) / 1000)
    return Math.max(0, Math.min(REMOTE_EVENT_WAIT_SECONDS, remaining))
  }

  // One self-cleaning task set for both commands. Awaiting a snapshot that
  // omits already-settled tasks is equivalent to awaiting the plain array
  // the one-shot drain used before the extraction.
  const tasks = new Set<Promise<void>>()
  /** Track a task and keep the set accurate as tasks settle, so the quiesce
   * drain also waits for tasks launched while it is awaiting. */
  const track = (task: Promise<void>): void => {
    tasks.add(task)
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    )
  }

  const runStreamTask = async (
    poll: (readOpts: RemotePollReadOpts) => Promise<unknown>,
    endCheck?: () => boolean,
  ): Promise<void> => {
    const streak = makeFailureStreak(opts.command, opts.stderr)
    while (!stopped && !opts.shouldStop()) {
      const started = opts.now().getTime()
      const controller = new AbortController()
      inFlightReads.add(controller)
      try {
        await poll({ waitSeconds: readWaitSeconds(started), signal: controller.signal })
        streak.onSuccess()
        if (endCheck?.()) {
          requestStop()
          return
        }
      } catch (error) {
        // A cancelled held read is the command stopping, not a store
        // failure — never report it. The check stays on the external signal
        // (not the full guard), so a failure observed as the deadline
        // elapses is still reported.
        if (!stopped && !opts.aborted() && !controller.signal.aborted) streak.onFailure(error)
      } finally {
        inFlightReads.delete(controller)
      }
      if (stopped || opts.aborted()) return
      const elapsed = opts.now().getTime() - started
      if (elapsed < opts.intervalMs) {
        await opts.sleep(opts.intervalMs - elapsed, stopController.signal)
      }
    }
  }

  const launched = new Set<string>()
  const launch = (
    key: string,
    poll: (readOpts: RemotePollReadOpts) => Promise<unknown>,
    endCheck?: () => boolean,
  ): void => {
    if (launched.has(key)) return
    launched.add(key)
    track(runStreamTask(poll, endCheck))
  }

  const runDiscovery = (discovery: {
    step: () => Promise<void>
    launchPending: () => void
    endCheck?: () => boolean
  }): Promise<void> => {
    const task = (async (): Promise<void> => {
      const streak = makeFailureStreak(opts.command, opts.stderr)
      while (!stopped && !opts.shouldStop()) {
        try {
          await discovery.step()
          streak.onSuccess()
        } catch (error) {
          streak.onFailure(error)
        }
        // Unconditional — after the catch: streams registered before a
        // mid-discovery throw still get tasks whose polls then run
        // independently.
        discovery.launchPending()
        if (discovery.endCheck?.()) {
          requestStop()
          return
        }
        if (stopped || opts.aborted()) return
        await opts.sleep(opts.intervalMs, stopController.signal)
      }
    })()
    track(task)
    return task
  }

  const drain = async (): Promise<void> => {
    if (opts.drain === 'quiesce') {
      // Await every task — including ones launched while awaiting: the
      // discovery task adds stream tasks mid-wait, and the caller's exit
      // decision must observe every task settled.
      while (tasks.size > 0) await Promise.all(tasks)
      return
    }
    // One-shot snapshot: tasks launched during the await are NOT awaited.
    await Promise.all([...tasks])
  }

  return {
    get stopped(): boolean {
      return stopped
    },
    requestStop,
    launch,
    runDiscovery,
    drain,
  }
}
