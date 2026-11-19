import { describe, expect, test } from 'bun:test'
import { GENERATION_SIGNALS } from './dispatch-launch-contract'
import { holdDrainedStop, operatorStopped, restoreLauncherTerminal } from './dispatch-launch-stop'

const RESTORES = ['\x1b[?1004l', '\x1b[<1u', '\x1b[?2004l', '\x1b[?1049l', '\x1b[?25h']

function terminal(isTTY: boolean) {
  const raw: boolean[] = []
  const written: string[] = []
  return {
    raw,
    written,
    stdin: { isTTY, setRawMode: (value: boolean) => raw.push(value) },
    stdout: { isTTY, write: (chunk: string) => written.push(chunk) },
  }
}

describe('operatorStopped', () => {
  test('a generation dying of the launcher signal is the requested stop', () => {
    expect(operatorStopped('SIGINT', 'SIGINT')).toBe(true)
    expect(operatorStopped('SIGTERM', 'SIGTERM')).toBe(true)
  })

  test('any other signal death remains a failure', () => {
    expect(operatorStopped(undefined, 'SIGINT')).toBe(false)
    expect(operatorStopped('SIGINT', 'SIGKILL')).toBe(false)
    expect(operatorStopped('SIGINT', null)).toBe(false)
  })
})

describe('restoreLauncherTerminal', () => {
  test('--plain on a TTY restores no terminal mode but leaves raw mode', () => {
    const tty = terminal(true)
    restoreLauncherTerminal(true, tty.stdin, tty.stdout)
    for (const sequence of RESTORES) expect(tty.written.join('')).not.toContain(sequence)
    expect(tty.raw).toEqual([false])
  })

  test('the interactive dashboard restores every mode in order', () => {
    const tty = terminal(true)
    restoreLauncherTerminal(false, tty.stdin, tty.stdout)
    expect(tty.written).toEqual(RESTORES)
  })

  test('a non-TTY stdout receives nothing', () => {
    const pipe = terminal(false)
    restoreLauncherTerminal(false, pipe.stdin, pipe.stdout)
    expect(pipe.written).toEqual([])
    expect(pipe.raw).toEqual([])
  })
})

describe('holdDrainedStop', () => {
  test('every generation stop signal exits once', () => {
    const listeners = new Map<string, () => void>()
    let exits = 0
    holdDrainedStop(() => exits++, { on: (signal, listener) => listeners.set(signal, listener) })
    expect([...listeners.keys()]).toEqual([...GENERATION_SIGNALS])
    for (const signal of GENERATION_SIGNALS) {
      const before = exits
      listeners.get(signal)!()
      expect(exits).toBe(before + 1)
    }
  })
})
