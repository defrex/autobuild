import { describe, expect, test } from 'bun:test'
import {
  ALTERNATE_SCREEN_MODE,
  BRACKETED_PASTE_MODE,
  createTerminalModeController,
  HIDDEN_CURSOR_MODE,
  installTerminalRestoreHook,
  KITTY_KEYBOARD_MODE,
  TERMINATING_SIGNALS,
  type TerminalRestoreProcess,
} from './terminal-restore'

class FakeProcess implements TerminalRestoreProcess {
  readonly pid = 4242
  readonly actions: string[] = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    this.actions.push(`on:${event}`)
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener)
    this.actions.push(`off:${event}`)
  }

  kill(pid: number, signal: NodeJS.Signals): void {
    expect(pid).toBe(this.pid)
    expect(this.listenerCount(signal)).toBe(0)
    this.actions.push(`kill:${signal}`)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

describe('terminal mode ledger', () => {
  test('arms before enter, disarms after leave, and makes both operations idempotent', () => {
    const writes: string[] = []
    let modes!: ReturnType<typeof createTerminalModeController>
    modes = createTerminalModeController((chunk) => {
      if (chunk === ALTERNATE_SCREEN_MODE.enter) {
        expect(modes.isActive(ALTERNATE_SCREEN_MODE)).toBe(true)
      }
      if (chunk === ALTERNATE_SCREEN_MODE.restore) {
        expect(modes.isActive(ALTERNATE_SCREEN_MODE)).toBe(true)
      }
      writes.push(chunk)
    })

    modes.enter(ALTERNATE_SCREEN_MODE)
    modes.enter(ALTERNATE_SCREEN_MODE)
    modes.leave(ALTERNATE_SCREEN_MODE)
    modes.leave(ALTERNATE_SCREEN_MODE)

    expect(writes).toEqual([ALTERNATE_SCREEN_MODE.enter, ALTERNATE_SCREEN_MODE.restore])
    expect(modes.activeModes).toEqual([])
  })

  test('a failed ordinary write remains armed for emergency recovery', () => {
    const emergency: string[] = []
    const modes = createTerminalModeController(
      (chunk) => {
        if (chunk === HIDDEN_CURSOR_MODE.restore) throw new Error('stream stopped')
      },
      (chunk) => emergency.push(chunk),
    )
    modes.enter(HIDDEN_CURSOR_MODE)

    expect(() => modes.leave(HIDDEN_CURSOR_MODE)).toThrow('stream stopped')
    expect(modes.isActive(HIDDEN_CURSOR_MODE)).toBe(true)
    modes.restoreAll()
    expect(emergency).toEqual([HIDDEN_CURSOR_MODE.restore])
    expect(modes.activeModes).toEqual([])
  })

  test('emergency restoration filters active modes, orders them deterministically, and is idempotent', () => {
    const emergency: string[] = []
    const modes = createTerminalModeController(
      () => {},
      (chunk) => emergency.push(chunk),
    )
    modes.enter(ALTERNATE_SCREEN_MODE)
    modes.enter(HIDDEN_CURSOR_MODE)
    modes.enter(BRACKETED_PASTE_MODE)
    modes.enter(KITTY_KEYBOARD_MODE)
    modes.leave(BRACKETED_PASTE_MODE)

    modes.restoreAll()
    modes.restoreAll()

    expect(emergency).toEqual([
      KITTY_KEYBOARD_MODE.restore,
      ALTERNATE_SCREEN_MODE.restore,
      HIDDEN_CURSOR_MODE.restore,
    ])
    expect(modes.activeModes).toEqual([])
  })

  test('one failed emergency write does not prevent other modes and remains retryable', () => {
    const emergency: string[] = []
    let failPaste = true
    const modes = createTerminalModeController(
      () => {},
      (chunk) => {
        emergency.push(chunk)
        if (chunk === BRACKETED_PASTE_MODE.restore && failPaste) {
          failPaste = false
          throw new Error('retry me')
        }
      },
    )
    modes.enter(BRACKETED_PASTE_MODE)
    modes.enter(ALTERNATE_SCREEN_MODE)

    modes.restoreAll()
    expect(modes.activeModes).toEqual([BRACKETED_PASTE_MODE])
    modes.restoreAll()

    expect(emergency).toEqual([
      BRACKETED_PASTE_MODE.restore,
      ALTERNATE_SCREEN_MODE.restore,
      BRACKETED_PASTE_MODE.restore,
    ])
    expect(modes.activeModes).toEqual([])
  })
})

describe('process terminal restore hook', () => {
  test('uncaught-fault and exit boundaries synchronously restore without duplication', () => {
    const boundary = new FakeProcess()
    const emergency: string[] = []
    const modes = createTerminalModeController(
      () => {},
      (chunk) => emergency.push(chunk),
    )
    const hook = installTerminalRestoreHook(modes, boundary)
    modes.enter(ALTERNATE_SCREEN_MODE)
    modes.enter(HIDDEN_CURSOR_MODE)

    boundary.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException')
    boundary.emit('exit', 1)
    hook.close()

    expect(emergency).toEqual([ALTERNATE_SCREEN_MODE.restore, HIDDEN_CURSOR_MODE.restore])
  })

  for (const signal of TERMINATING_SIGNALS) {
    test(`${signal} restores, removes the hooks, and re-terminates with the same signal`, () => {
      const boundary = new FakeProcess()
      const emergency: string[] = []
      const modes = createTerminalModeController(
        () => {},
        (chunk) => {
          emergency.push(chunk)
          boundary.actions.push(`restore:${JSON.stringify(chunk)}`)
        },
      )
      installTerminalRestoreHook(modes, boundary)
      modes.enter(BRACKETED_PASTE_MODE)

      boundary.emit(signal)

      expect(emergency).toEqual([BRACKETED_PASTE_MODE.restore])
      expect(boundary.actions.at(-1)).toBe(`kill:${signal}`)
      expect(boundary.listenerCount('exit')).toBe(0)
      expect(boundary.listenerCount('uncaughtExceptionMonitor')).toBe(0)
      expect(boundary.listenerCount('SIGINT')).toBe(0)
    })
  }

  test('close restores before disposal, is idempotent, and an empty ledger writes nothing', () => {
    const boundary = new FakeProcess()
    const emergency: string[] = []
    const modes = createTerminalModeController(
      () => {},
      (chunk) => emergency.push(chunk),
    )
    const hook = installTerminalRestoreHook(modes, boundary)

    hook.close()
    hook.close()
    boundary.emit('exit', 0)

    expect(emergency).toEqual([])
    expect(boundary.listenerCount('exit')).toBe(0)
    for (const signal of TERMINATING_SIGNALS) expect(boundary.listenerCount(signal)).toBe(0)
  })
})
