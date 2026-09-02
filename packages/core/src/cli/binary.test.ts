import { describe, expect, test } from 'bun:test'
import {
  installSessionlessSigintHandler,
  usesGenericSessionlessSigintHandler,
  withDispatchTerminalRestore,
} from './binary'
import type { TerminalOut } from './terminal'
import {
  ALTERNATE_SCREEN_MODE,
  createTerminalModeController,
  HIDDEN_CURSOR_MODE,
  type TerminalRestoreProcess,
} from './terminal-restore'

class FakeBoundary implements TerminalRestoreProcess {
  readonly pid = 99
  readonly kills: NodeJS.Signals[] = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped)
      listener(...args)
    }
    this.on(event, wrapped)
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  kill(_pid: number, signal: NodeJS.Signals): void {
    this.kills.push(signal)
  }

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
  test('upgrade and update retain process-default SIGINT while other sessionless commands use cancellation', () => {
    expect(usesGenericSessionlessSigintHandler('upgrade')).toBe(false)
    expect(usesGenericSessionlessSigintHandler('update')).toBe(false)
    for (const command of ['init', 'dispatch', 'ticket', 'builds', undefined]) {
      expect(usesGenericSessionlessSigintHandler(command)).toBe(true)
    }
  })

  test('dispatch keeps its SIGINT handler armed through repeated interrupts', () => {
    const boundary = new FakeBoundary()
    let stops = 0
    const remove = installSessionlessSigintHandler(
      'dispatch',
      () => {
        stops += 1
      },
      boundary,
    )

    boundary.emit('SIGINT')
    boundary.emit('SIGINT')
    expect(stops).toBe(2)
    expect(boundary.listenerCount('SIGINT')).toBe(1)

    remove()
    expect(boundary.listenerCount('SIGINT')).toBe(0)
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

  test('a terminating signal aborts immediately but is replayed only after run settles', async () => {
    const boundary = new FakeBoundary()
    const { terminal, emergency } = fakeTerminal()
    let finish!: () => void
    const drain = new Promise<void>((resolve) => {
      finish = resolve
    })
    let stops = 0

    const running = withDispatchTerminalRestore(
      'dispatch',
      terminal,
      async () => {
        terminal.modes.enter(ALTERNATE_SCREEN_MODE)
        await drain
      },
      boundary,
      () => {
        stops += 1
      },
    )
    boundary.emit('SIGTERM')

    expect(stops).toBe(1)
    expect(emergency).toEqual([ALTERNATE_SCREEN_MODE.restore])
    expect(boundary.kills).toEqual([])
    expect(boundary.listenerCount('SIGTERM')).toBe(1)

    finish()
    await running
    expect(boundary.kills).toEqual(['SIGTERM'])
    expect(boundary.listenerCount('SIGTERM')).toBe(0)
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
