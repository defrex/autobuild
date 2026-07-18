/**
 * The terminal seam (src/cli/terminal.ts) over fake write streams.
 *
 * Small surface, but it decides two things nothing downstream can recover
 * from: whether the dashboard runs at all, and how big it thinks the screen
 * is — on BOTH axes. A wrong width truncates lines to nothing; a wrong height
 * makes the frame unpaintable, because the live region repaints by cursoring
 * up over rows that have to still be on screen.
 */
import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  processTerminal,
  processTerminalInput,
  type TerminalInputEvent,
} from './terminal'

function stream(props: { isTTY?: boolean; columns?: number; rows?: number }): NodeJS.WriteStream {
  const writes: string[] = []
  return {
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
    ...props,
    // Exposed for the write test.
    writes,
  } as unknown as NodeJS.WriteStream
}

describe('processTerminal: interactive', () => {
  test('a real TTY is interactive', () => {
    expect(processTerminal(stream({ isTTY: true, columns: 100 })).interactive).toBe(true)
  })

  test('a pipe or redirect is NOT — isTTY is undefined there, which is the whole mechanism', () => {
    // This is what delivers "non-interactive output, including redirected or
    // piped output, automatically uses plain mode" for free.
    expect(processTerminal(stream({})).interactive).toBe(false)
    expect(processTerminal(stream({ isTTY: false })).interactive).toBe(false)
  })
})

describe('processTerminal: columns', () => {
  test('reports the stream width', () => {
    expect(processTerminal(stream({ isTTY: true, columns: 120 })).columns).toBe(120)
  })

  test('a stream with no width falls back to 80', () => {
    expect(processTerminal(stream({})).columns).toBe(80)
  })

  test('a TTY reporting ZERO columns falls back too', () => {
    // Regression: `script(1)`, many pty wrappers and some CI runners report a
    // TTY with columns 0. `columns ?? 80` yields 0 there — every line
    // truncates to nothing and the dashboard collapses into a column of
    // ellipses. Found by running the real binary under `script`, not by any
    // unit test. Zero is not a width; it means "this terminal will not say".
    expect(processTerminal(stream({ isTTY: true, columns: 0 })).columns).toBe(80)
  })

  test('columns is a GETTER — a resized window is picked up on the next frame', () => {
    const s = stream({ isTTY: true, columns: 100 })
    const term = processTerminal(s)
    expect(term.columns).toBe(100)
    ;(s as unknown as { columns: number }).columns = 60
    expect(term.columns).toBe(60)
  })
})

describe('processTerminal: rows', () => {
  test('reports the stream height', () => {
    expect(processTerminal(stream({ isTTY: true, columns: 100, rows: 50 })).rows).toBe(50)
  })

  test('a stream with no height falls back to 24', () => {
    expect(processTerminal(stream({})).rows).toBe(24)
  })

  test('a TTY reporting ZERO rows falls back too', () => {
    // Same trap as columns, same terminals: `0 ?? 24` is 0, which would clamp
    // the entire build list away and leave a header over an empty screen.
    expect(processTerminal(stream({ isTTY: true, rows: 0 })).rows).toBe(24)
  })

  test('rows is a GETTER too — a resized window is picked up on the next frame', () => {
    const s = stream({ isTTY: true, columns: 100, rows: 50 })
    const term = processTerminal(s)
    expect(term.rows).toBe(50)
    ;(s as unknown as { rows: number }).rows = 24
    expect(term.rows).toBe(24)
  })
})

describe('processTerminal: write', () => {
  test('passes the chunk through raw — no newline appended', () => {
    const s = stream({ isTTY: true, columns: 80 })
    processTerminal(s).write('frame')
    expect((s as unknown as { writes: string[] }).writes).toEqual(['frame'])
  })
})

function inputStream(opts: { tty?: boolean; raw?: boolean; flowing?: boolean } = {}) {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    rawCalls: boolean[]
  }
  stream.isTTY = opts.tty ?? true
  stream.isRaw = opts.raw ?? false
  stream.rawCalls = []
  stream.setRawMode = (raw: boolean) => {
    stream.rawCalls.push(raw)
    stream.isRaw = raw
    return stream
  }
  if (opts.flowing === true) stream.resume()
  else stream.pause()
  return stream
}

describe('processTerminalInput', () => {
  test('normalizes navigation, editing controls, printable text, and raw-mode Ctrl-C', () => {
    const stream = inputStream()
    const inputs: TerminalInputEvent[] = []
    const cleanup = processTerminalInput(stream).start((input) => inputs.push(input))

    stream.emit('keypress', undefined, { name: 'up' })
    stream.emit('keypress', undefined, { name: 'down' })
    // Command letters deliberately remain text; dispatch interprets them only
    // when no feedback field is active.
    stream.emit('keypress', 'm', { name: 'm' })
    stream.emit('keypress', 'P', { name: 'p' })
    stream.emit('keypress', 'answer', {})
    stream.emit('keypress', undefined, { name: 'space', sequence: ' ' })
    stream.emit('keypress', undefined, { name: 'return', sequence: '\r' })
    stream.emit('keypress', undefined, { name: 'backspace', sequence: '\u007f' })
    stream.emit('keypress', undefined, { name: 'escape', sequence: '\u001b' })
    stream.emit('keypress', undefined, { name: 'c', ctrl: true, sequence: '\u0003' })

    expect(inputs).toEqual([
      { type: 'up' },
      { type: 'down' },
      { type: 'text', text: 'm' },
      { type: 'text', text: 'P' },
      { type: 'text', text: 'answer' },
      { type: 'text', text: ' ' },
      { type: 'enter' },
      { type: 'backspace' },
      { type: 'escape' },
      { type: 'interrupt' },
    ])
    cleanup()
  })

  test('excludes control/meta input that is not a supported editing key', () => {
    const stream = inputStream()
    const inputs: TerminalInputEvent[] = []
    const cleanup = processTerminalInput(stream).start((input) => inputs.push(input))

    stream.emit('keypress', '\t', { name: 'tab', sequence: '\t' })
    stream.emit('keypress', '\u0001', { name: 'a', ctrl: true, sequence: '\u0001' })
    stream.emit('keypress', 'x', { name: 'x', meta: true })
    stream.emit('keypress', undefined, { name: 'f1' })

    expect(inputs).toEqual([])
    cleanup()
  })

  test('enters raw mode and idempotently restores prior raw and flow state', () => {
    const stream = inputStream({ raw: false, flowing: false })
    const cleanup = processTerminalInput(stream).start(() => {})
    expect(stream.rawCalls).toEqual([true])
    expect(stream.readableFlowing).toBe(true)

    cleanup()
    cleanup()
    expect(stream.rawCalls).toEqual([true, false])
    expect(stream.readableFlowing).toBe(false)
    expect(stream.listenerCount('keypress')).toBe(0)
  })

  test('preserves an already-raw, flowing stream', () => {
    const stream = inputStream({ raw: true, flowing: true })
    const cleanup = processTerminalInput(stream).start(() => {})
    cleanup()
    expect(stream.rawCalls).toEqual([true, true])
    expect(stream.readableFlowing).toBe(true)
  })

  test('activation failure still removes listeners and restores flow', () => {
    const stream = inputStream({ flowing: false })
    const original = stream.setRawMode.bind(stream)
    let first = true
    stream.setRawMode = (raw: boolean) => {
      if (first) {
        first = false
        stream.rawCalls.push(raw)
        throw new Error('raw mode unavailable')
      }
      return original(raw)
    }
    expect(() => processTerminalInput(stream).start(() => {})).toThrow(
      'raw mode unavailable',
    )
    expect(stream.rawCalls).toEqual([true, false])
    expect(stream.listenerCount('keypress')).toBe(0)
    expect(stream.readableFlowing).toBe(false)
  })

  test('a non-TTY is untouched', () => {
    const stream = inputStream({ tty: false })
    const cleanup = processTerminalInput(stream).start(() => {})
    cleanup()
    expect(stream.rawCalls).toEqual([])
    expect(stream.listenerCount('keypress')).toBe(0)
  })
})
