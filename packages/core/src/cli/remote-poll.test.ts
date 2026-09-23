/**
 * `remote-poll` tests — the shared remote long-poll task machinery extracted
 * from `ab watch` and `ab wait` (AUT-403). The runner is tested directly at
 * the new seam over injected `now`/`sleep` — no real timers, no store. The
 * behavioral parity proof for the commands themselves stays in each
 * command's remote cadence suite (`watch remote bounded-wait cadence`,
 * `wait remote bounded-wait cadence`), which pass unmodified; the source-scan
 * pin at the bottom keeps both commands on the shared helper so a
 * single-sided re-inline fails loudly.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { manualClock } from '../testing/fixed'
import { REMOTE_EVENT_WAIT_SECONDS } from '../store/remote/client'
import {
  createRemotePollRunner,
  defaultDelay,
  makeFailureStreak,
  type RemotePollRunnerOpts,
} from './remote-poll'

/** A macrotask turn: drains every microtask that is already runnable, so a
 * chain of auto-resolving sleeps and immediate polls advances to its next
 * real suspension point (a hanging poll or a pinned sleep). */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * An injected sleep that records every call and resolves pending turns via a
 * microtask — unless `hang` pins the call, in which case only an abort of
 * the passed signal resolves it. Loops therefore advance deterministically
 * without real timers, and abort-wake behavior stays assertable.
 */
function fakeSleep(hang?: (call: number, ms: number) => boolean) {
  const calls: { ms: number; signal?: AbortSignal }[] = []
  let n = 0
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    const call = ++n
    calls.push({ ms, signal })
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => finish()
      if (signal?.aborted === true) {
        finish()
        return
      }
      signal?.addEventListener('abort', onAbort)
      if (hang?.(call, ms) !== true) queueMicrotask(finish)
    })
  }
  return { sleep, calls }
}

/** A poll that never resolves on its own — it ends only when the runner
 * cancels it via its signal. A runner that fails to cancel would hang the
 * test until its timeout. */
const hangUntilAborted = async (signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

function testRunner(overrides: Partial<RemotePollRunnerOpts> = {}): {
  runner: ReturnType<typeof createRemotePollRunner>
  errs: string[]
  clock: ReturnType<typeof manualClock>
  sleeps: ReturnType<typeof fakeSleep>
} {
  const errs: string[] = []
  const clock = manualClock()
  const sleeps = fakeSleep()
  const runner = createRemotePollRunner({
    command: 'watch',
    stderr: (line) => errs.push(line),
    now: clock,
    sleep: sleeps.sleep,
    intervalMs: 1000,
    deadlineMs: Number.POSITIVE_INFINITY,
    aborted: () => false,
    shouldStop: () => false,
    drain: 'snapshot',
    ...overrides,
  })
  return { runner, errs, clock, sleeps }
}

// ── makeFailureStreak ────────────────────────────────────────────────────────

describe('makeFailureStreak', () => {
  test('reports once per streak, suppresses repeats, and re-arms on success', () => {
    const errs: string[] = []
    const streak = makeFailureStreak('watch', (line) => errs.push(line))
    streak.onFailure(new Error('read failed'))
    streak.onFailure(new Error('read failed again'))
    expect(errs).toEqual([expect.stringContaining('ab watch: a store read failed (read failed)')])
    streak.onSuccess()
    streak.onFailure(new Error('read failed once more'))
    expect(errs).toEqual([
      expect.stringContaining('ab watch: a store read failed (read failed)'),
      expect.stringContaining('ab watch: a store read failed (read failed once more)'),
    ])
  })

  test('the message embeds the command name', () => {
    const errs: string[] = []
    makeFailureStreak('wait', (line) => errs.push(line)).onFailure(new Error('nope'))
    expect(errs).toEqual([expect.stringContaining('ab wait: a store read failed (nope)')])
  })
})

// ── The runner ───────────────────────────────────────────────────────────────

describe('createRemotePollRunner', () => {
  test('requestStop aborts every in-flight read and marks the runner stopped', async () => {
    const { runner } = testRunner()
    const signals: AbortSignal[] = []
    runner.launch('a', async (readOpts) => {
      signals.push(readOpts.signal!)
      await hangUntilAborted(readOpts.signal)
    })
    runner.launch('b', async (readOpts) => {
      signals.push(readOpts.signal!)
      await hangUntilAborted(readOpts.signal)
    })
    await flush()
    expect(signals).toHaveLength(2)
    expect(runner.stopped).toBe(false)
    runner.requestStop()
    expect(runner.stopped).toBe(true)
    for (const signal of signals) expect(signal.aborted).toBe(true)
  })

  test('requestStop resolves a pending gap-fill sleep immediately', async () => {
    // Every sleep hangs until aborted: the only way the gap-fill can end is
    // the runner's own stop controller firing.
    const { runner } = testRunner({ sleep: fakeSleep(() => true).sleep })
    runner.launch('a', async () => {})
    const drained = runner.drain()
    let done = false
    void drained.then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)
    runner.requestStop()
    await drained
  })

  test('the held-read wait bound is the remote default capped at the remaining budget', async () => {
    // 3.5 s remaining → 3 whole seconds.
    const clock = manualClock()
    const { runner } = testRunner({ now: clock, deadlineMs: clock().getTime() + 3500 })
    const waits: (number | undefined)[] = []
    const signals: (AbortSignal | undefined)[] = []
    runner.launch(
      'a',
      async (readOpts) => {
        waits.push(readOpts.waitSeconds)
        signals.push(readOpts.signal)
      },
      () => true,
    )
    await flush()
    expect(waits).toEqual([3])
    expect(signals[0]).toBeInstanceOf(AbortSignal)

    // Past the deadline → clamped at 0.
    const past = testRunner({ now: clock, deadlineMs: clock().getTime() - 500 })
    const pastWaits: (number | undefined)[] = []
    past.runner.launch(
      'a',
      async (readOpts) => {
        pastWaits.push(readOpts.waitSeconds)
      },
      () => true,
    )
    await flush()
    expect(pastWaits).toEqual([0])

    // An unbounded deadline (--timeout 0) yields exactly the remote default.
    const unbounded = testRunner({ deadlineMs: Number.POSITIVE_INFINITY })
    const unboundedWaits: (number | undefined)[] = []
    unbounded.runner.launch(
      'a',
      async (readOpts) => {
        unboundedWaits.push(readOpts.waitSeconds)
      },
      () => true,
    )
    await flush()
    expect(unboundedWaits).toEqual([REMOTE_EVENT_WAIT_SECONDS])
  })

  test('launch is idempotent per key, and the poll closure receives the read opts', async () => {
    const { runner } = testRunner()
    let calls = 0
    const seen: { waitSeconds: number; signal: AbortSignal }[] = []
    const poll = async (readOpts: { waitSeconds?: number; signal?: AbortSignal }) => {
      calls += 1
      seen.push({ waitSeconds: readOpts.waitSeconds ?? -1, signal: readOpts.signal! })
    }
    runner.launch('a', poll, () => true)
    runner.launch('a', poll, () => true)
    await flush()
    expect(calls).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.waitSeconds).toBe(REMOTE_EVENT_WAIT_SECONDS)
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  test('an endCheck that fires after a poll stops the runner and cancels the other in-flight read', async () => {
    const { runner, errs } = testRunner()
    const signals: AbortSignal[] = []
    runner.launch(
      'a',
      async () => {},
      () => true,
    )
    runner.launch(
      'b',
      async (readOpts) => {
        signals.push(readOpts.signal!)
        await hangUntilAborted(readOpts.signal)
      },
      () => true,
    )
    await flush()
    expect(runner.stopped).toBe(true)
    expect(signals[0]!.aborted).toBe(true)
    // The cancelled read is the runner stopping, not a store failure.
    expect(errs).toEqual([])
  })

  test('onStop fires on every stop path — endCheck and caller-initiated alike', async () => {
    const stops: number[] = []
    const { runner } = testRunner({ onStop: () => stops.push(stops.length + 1) })
    // An endCheck stop fires the hook from inside the runner...
    runner.launch(
      'a',
      async () => {},
      () => true,
    )
    await flush()
    expect(runner.stopped).toBe(true)
    expect(stops).toEqual([1])
    // ...and a caller-initiated stop fires it again: the hook must be
    // idempotent, matching the pre-extraction `requestStop`, which executed
    // the command's `stop = true` on every call.
    runner.requestStop()
    expect(stops).toEqual([1, 2])
  })

  test('a failing poll is reported once per streak, retried, and re-armed by success', async () => {
    const { runner, errs } = testRunner()
    let calls = 0
    // Fail, succeed (keep going), fail again, succeed (stop): the second
    // failure proves the success re-armed the streak report.
    runner.launch(
      'a',
      async () => {
        calls += 1
        if (calls === 1 || calls === 3) throw new Error('held read failed')
      },
      () => calls >= 4,
    )
    await flush()
    expect(calls).toBe(4)
    expect(errs).toEqual([
      expect.stringContaining('ab watch: a store read failed (held read failed)'),
      expect.stringContaining('ab watch: a store read failed (held read failed)'),
    ])
  })

  test('a failure observed while the external signal is aborted is never reported', async () => {
    let externallyAborted = false
    const { runner, errs } = testRunner({ aborted: () => externallyAborted })
    runner.launch(
      'a',
      async () => {
        externallyAborted = true
        throw new Error('cancelled read')
      },
      () => true,
    )
    await flush()
    expect(errs).toEqual([])
  })

  test('runDiscovery launches streams registered before a mid-discovery throw (launchPending runs after the catch)', async () => {
    const { runner, errs } = testRunner()
    const registered: string[] = []
    let pollCalls = 0
    const discovery = runner.runDiscovery({
      step: async () => {
        registered.push('x')
        throw new Error('discovery blew up')
      },
      launchPending: () => {
        for (const key of registered) {
          runner.launch(
            key,
            async () => {
              pollCalls += 1
            },
            () => true,
          )
        }
      },
    })
    await discovery
    // The step threw, yet the launch loop still ran: the registered stream's
    // poll was issued, and the failure was reported exactly once.
    expect(pollCalls).toBe(1)
    expect(errs).toEqual([
      expect.stringContaining('ab watch: a store read failed (discovery blew up)'),
    ])
  })

  test('runDiscovery evaluates its endCheck after launchPending, throw or not', async () => {
    const { runner } = testRunner()
    await runner.runDiscovery({
      step: async () => {
        throw new Error('discovery blew up')
      },
      launchPending: () => {},
      endCheck: () => true,
    })
    expect(runner.stopped).toBe(true)
  })

  test('the quiesce drain keeps awaiting tasks a still-running discovery launches', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let discoveryRan = 0
    const { runner } = testRunner({ drain: 'quiesce', shouldStop: () => discoveryRan >= 3 })
    let pollEntered = false
    const discovery = runner.runDiscovery({
      step: async () => {
        discoveryRan += 1
      },
      launchPending: () => {
        if (discoveryRan === 1) {
          runner.launch(
            'x',
            async () => {
              pollEntered = true
              await released
            },
            () => true,
          )
        }
      },
    })
    let drained = false
    const drainedPromise = runner.drain().then(() => {
      drained = true
    })
    await flush()
    // The discovery task kept cycling while 'x' stayed pending, and the
    // quiesce drain is still awaiting — the late-launched task is not
    // abandoned.
    expect(discoveryRan).toBeGreaterThanOrEqual(3)
    expect(pollEntered).toBe(true)
    expect(drained).toBe(false)
    release()
    await Promise.all([discovery, drainedPromise])
  })

  test('the snapshot drain resolves while a late-launched task is still pending', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let discoveryRan = 0
    const { runner } = testRunner({ drain: 'snapshot', shouldStop: () => discoveryRan >= 3 })
    let pollEntered = false
    const discovery = runner.runDiscovery({
      step: async () => {
        discoveryRan += 1
      },
      launchPending: () => {
        if (discoveryRan === 1) {
          runner.launch(
            'x',
            async () => {
              pollEntered = true
              await released
            },
            () => true,
          )
        }
      },
    })
    let drained = false
    void runner.drain().then(() => {
      drained = true
    })
    await flush()
    // One-shot semantics: only the tasks present when drain() was called are
    // awaited, so it resolves even though 'x' is still pending.
    expect(pollEntered).toBe(true)
    expect(drained).toBe(true)
    release()
    await discovery
  })
})

// ── defaultDelay ─────────────────────────────────────────────────────────────

describe('defaultDelay', () => {
  test('resolves after the requested delay and as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const slept = defaultDelay(5)
    const aborted = defaultDelay(1000, controller.signal)
    const alreadyAborted = defaultDelay(1000, AbortSignal.abort())
    const timer = setTimeout(() => controller.abort(), 1)
    await Promise.all([slept, aborted, alreadyAborted])
    clearTimeout(timer)
  })
})

// ── AC3: both commands exercise the shared helper ────────────────────────────

describe('both commands run the shared remote long-poll machinery', () => {
  const sources: [string, string][] = [
    ['watch.ts', readFileSync(new URL('./watch.ts', import.meta.url), 'utf8')],
    ['wait.ts', readFileSync(new URL('./wait.ts', import.meta.url), 'utf8')],
  ]

  for (const [name, source] of sources) {
    const command = name.replace('.ts', '')

    test(`ab ${command} imports the shared remote-poll helper`, () => {
      expect(source).toContain("from './remote-poll'")
    })

    test(`ab ${command} no longer declares the machinery locally`, () => {
      expect(source).not.toContain('new Set<AbortController>()')
      expect(source).not.toContain('new AbortController()')
      expect(source).not.toMatch(/(?:const|function) readWaitSeconds/)
      expect(source).not.toMatch(/(?:const|function) makeFailureStreak/)
      expect(source).not.toMatch(/(?:const|function) runStreamTask/)
      expect(source).not.toContain('REMOTE_EVENT_WAIT_SECONDS')
    })
  }
})
