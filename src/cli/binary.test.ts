import { describe, expect, test } from 'bun:test'
import { usesGenericSessionlessSigintHandler, withDispatchTerminalRestore } from './binary'
import type { TerminalOut } from './terminal'
import {
  ALTERNATE_SCREEN_MODE,
  createTerminalModeController,
  HIDDEN_CURSOR_MODE,
  type TerminalRestoreProcess,
} from './terminal-restore'

class FakeBoundary implements TerminalRestoreProcess {
  readonly pid = 99
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  kill(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

function fakeTerminal(): {
  terminal: TerminalOut
  normal: string[]
  emergency: string[]
} {
  const normal: string[] = []
  const emergency: string[] = []
  const write = (chunk: string): void => {
    normal.push(chunk)
  }
  return {
    normal,
    emergency,
    terminal: {
      interactive: true,
      columns: 80,
      rows: 24,
      write,
      modes: createTerminalModeController(write, (chunk) => emergency.push(chunk)),
    },
  }
}

describe('sessionless SIGINT ownership', () => {
  test('upgrade retains process-default SIGINT while other sessionless commands use cancellation', () => {
    expect(usesGenericSessionlessSigintHandler('upgrade')).toBe(false)
    for (const command of ['init', 'dispatch', 'ticket', 'builds', undefined]) {
      expect(usesGenericSessionlessSigintHandler(command)).toBe(true)
    }
  })
})

describe('dispatch process terminal restoration', () => {
  test('an abnormal boundary after activation restores each active mode exactly once', async () => {
    const boundary = new FakeBoundary()
    const { terminal, normal, emergency } = fakeTerminal()

    const result = await withDispatchTerminalRestore(
      'dispatch',
      terminal,
      async () => {
        terminal.modes.enter(ALTERNATE_SCREEN_MODE)
        terminal.modes.enter(HIDDEN_CURSOR_MODE)
        boundary.emit('exit', 1)
        return 17
      },
      boundary,
    )

    expect(result).toBe(17)
    expect(normal).toEqual([ALTERNATE_SCREEN_MODE.enter, HIDDEN_CURSOR_MODE.enter])
    expect(emergency).toEqual([ALTERNATE_SCREEN_MODE.restore, HIDDEN_CURSOR_MODE.restore])
    expect(boundary.listenerCount('exit')).toBe(0)
  })

  test('an exit before the first paint emits no restore bytes', async () => {
    const boundary = new FakeBoundary()
    const { terminal, emergency } = fakeTerminal()

    await withDispatchTerminalRestore(
      'dispatch',
      terminal,
      async () => {
        boundary.emit('exit', 1)
      },
      boundary,
    )

    expect(emergency).toEqual([])
  })

  test('non-dispatch commands install no process restore listeners', async () => {
    const boundary = new FakeBoundary()
    const { terminal } = fakeTerminal()

    await withDispatchTerminalRestore('builds', terminal, async () => {}, boundary)

    expect(boundary.listenerCount('exit')).toBe(0)
    expect(boundary.listenerCount('SIGTERM')).toBe(0)
  })
})
