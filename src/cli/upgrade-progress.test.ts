import { describe, expect, test } from 'bun:test'
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import type { ResolveConflict } from './upgrade'
import { UPGRADE_RESOLUTION_CANCELLED_MESSAGE } from './upgrade'
import { withUpgradeProgress } from './upgrade-progress'

const CONFLICT = {
  skill: 'ab-guide',
  path: 'references/operator.md',
  base: 'base',
  local: 'local',
  incoming: 'incoming',
}

function fakeInput(): TerminalInput & {
  press: (event: TerminalInputEvent) => void
  starts: number
  cleanups: number
} {
  let handler: ((event: TerminalInputEvent) => void) | undefined
  const input = {
    starts: 0,
    cleanups: 0,
    start(onInput: (event: TerminalInputEvent) => void): () => void {
      input.starts += 1
      handler = onInput
      let cleaned = false
      return () => {
        if (cleaned) return
        cleaned = true
        input.cleanups += 1
        handler = undefined
      }
    },
    press(event: TerminalInputEvent): void {
      handler?.(event)
    },
  }
  return input
}

function fakeTerminal(interactive = true): TerminalOut & { writes: string[] } {
  return {
    interactive,
    columns: 100,
    rows: 24,
    writes: [],
    write(chunk: string): void {
      this.writes.push(chunk)
    },
  }
}

function fakeSchedule() {
  let now = 0
  let next = 0
  const callbacks = new Map<number, () => void>()
  return {
    now: () => now,
    schedule(callback: () => void): ReturnType<typeof setInterval> {
      const id = ++next
      callbacks.set(id, callback)
      return id as unknown as ReturnType<typeof setInterval>
    },
    cancel(timer: unknown): void {
      callbacks.delete(timer as number)
    },
    tick(milliseconds: number): void {
      now += milliseconds
      for (const callback of callbacks.values()) callback()
    },
    active: () => callbacks.size,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withUpgradeProgress', () => {
  test('paints immediate moving frames with identity, elapsed time, guidance, then clears', async () => {
    const terminal = fakeTerminal()
    const input = fakeInput()
    const clock = fakeSchedule()
    const result = deferred<string | null>()
    const resolve: ResolveConflict = () => result.promise
    const decorated = withUpgradeProgress(resolve, {
      terminal,
      input,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
    })

    const pending = decorated(CONFLICT)
    expect(terminal.writes).toHaveLength(1)
    expect(terminal.writes[0]).toContain('| Resolving ab-guide/references/operator.md')
    expect(terminal.writes[0]).toContain('elapsed 0s — Ctrl-C to cancel')
    expect(input.starts).toBe(1)
    expect(clock.active()).toBe(1)

    clock.tick(1_000)
    expect(terminal.writes[1]).toContain('/ Resolving ab-guide/references/operator.md')
    expect(terminal.writes[1]).toContain('elapsed 1s — Ctrl-C to cancel')

    result.resolve('resolved bytes')
    expect(await pending).toBe('resolved bytes')
    expect(terminal.writes.at(-1)).toBe('\r\u001b[2K')
    expect(input.cleanups).toBe(1)
    expect(clock.active()).toBe(0)
  })

  test('Ctrl-C cancels once, aborts the resolver signal, and discards a late proposal', async () => {
    const terminal = fakeTerminal()
    const input = fakeInput()
    const clock = fakeSchedule()
    const late = deferred<string | null>()
    let signal: AbortSignal | undefined
    const decorated = withUpgradeProgress(
      (_conflict, options) => {
        signal = options?.signal
        return late.promise
      },
      {
        terminal,
        input,
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancel,
      },
    )

    const pending = decorated(CONFLICT)
    input.press({ type: 'text', text: 'x' })
    expect(signal?.aborted).toBe(false)
    input.press({ type: 'interrupt' })
    input.press({ type: 'interrupt' })

    await expect(pending).rejects.toThrow(UPGRADE_RESOLUTION_CANCELLED_MESSAGE)
    expect(signal?.aborted).toBe(true)
    expect(input.cleanups).toBe(1)
    expect(clock.active()).toBe(0)
    late.resolve('must not be accepted')
  })

  test('success, decline, and failure all restore input and clear the line', async () => {
    const endings: Array<() => Promise<string | null>> = [
      async () => 'resolved',
      async () => null,
      async () => {
        throw new Error('provider failed')
      },
    ]

    for (const ending of endings) {
      const terminal = fakeTerminal()
      const input = fakeInput()
      const clock = fakeSchedule()
      const pending = withUpgradeProgress(ending, {
        terminal,
        input,
        now: clock.now,
        schedule: clock.schedule,
        cancelSchedule: clock.cancel,
      })(CONFLICT)
      await pending.catch(() => null)
      expect(input.cleanups).toBe(1)
      expect(clock.active()).toBe(0)
      expect(terminal.writes.at(-1)).toBe('\r\u001b[2K')
    }
  })

  test('non-interactive output performs no rendering, scheduling, or input activation', async () => {
    const terminal = fakeTerminal(false)
    const input = fakeInput()
    const clock = fakeSchedule()
    let calls = 0
    const resolve: ResolveConflict = async () => {
      calls += 1
      return 'plain result'
    }
    const decorated = withUpgradeProgress(resolve, {
      terminal,
      input,
      now: clock.now,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel,
    })

    expect(decorated).toBe(resolve)
    expect(await decorated(CONFLICT)).toBe('plain result')
    expect(calls).toBe(1)
    expect(terminal.writes).toEqual([])
    expect(input.starts).toBe(0)
    expect(input.cleanups).toBe(0)
    expect(clock.active()).toBe(0)
  })
})
