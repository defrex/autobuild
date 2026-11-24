import { describe, expect, spyOn, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  createTerminalInputDecoder,
  processTerminalInput,
  type TerminalInputEvent,
  type TerminalInputHooks,
} from './terminal'

function inputStream(opts: { tty?: boolean; raw?: boolean; flowing?: boolean } = {}) {
  const stream = new PassThrough() as PassThrough &
    NodeJS.ReadStream & {
      rawCalls: boolean[]
      actualRaw: boolean
    }
  stream.isTTY = opts.tty ?? true
  stream.isRaw = opts.raw ?? false
  stream.rawCalls = []
  stream.actualRaw = stream.isRaw
  stream.setRawMode = (raw: boolean) => {
    stream.rawCalls.push(raw)
    if (stream.isRaw !== raw) stream.actualRaw = raw
    stream.isRaw = raw
    return stream
  }
  if (opts.flowing === true) stream.resume()
  else stream.pause()
  return stream
}

describe('processTerminalInput', () => {
  test('repairs cached raw state repeatedly and cancels before restoring prior state', () => {
    const callbacks: Array<() => void> = []
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      callbacks.push(callback)
      return { unref() {} }
    }) as typeof setInterval)
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    try {
      for (const raw of [false, true]) {
        const stream = inputStream({ raw, flowing: raw })
        stream.actualRaw = false
        const cleanup = processTerminalInput(stream).start(() => {})
        expect(stream.actualRaw).toBe(true)
        const tick = callbacks.at(-1)!
        for (let i = 0; i < 3; i++) {
          stream.actualRaw = false
          tick()
          expect(stream.actualRaw).toBe(true)
        }
        cleanup()
        const calls = stream.rawCalls.length
        tick()
        cleanup()
        expect(stream.rawCalls.length).toBe(calls)
        expect(stream.actualRaw).toBe(raw)
        expect(stream.readableFlowing).toBe(raw)
        expect(stream.listenerCount('keypress')).toBe(0)
      }
      const stream = inputStream()
      processTerminalInput(stream).start(() => {})
      stream.setRawMode = () => {
        throw new Error('lost tty')
      }
      expect(() => callbacks.at(-1)!()).not.toThrow()
      expect(stream.listenerCount('keypress')).toBe(0)
      expect(stream.readableFlowing).toBe(false)
      expect(clear).toHaveBeenCalledTimes(3)
    } finally {
      timer.mockRestore()
      clear.mockRestore()
    }
  })

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
    expect(stream.rawCalls).toEqual([false, true])
    expect(stream.readableFlowing).toBe(true)

    cleanup()
    cleanup()
    expect(stream.rawCalls).toEqual([false, true, false])
    expect(stream.readableFlowing).toBe(false)
    expect(stream.listenerCount('keypress')).toBe(0)
  })

  test('preserves an already-raw, flowing stream', () => {
    const stream = inputStream({ raw: true, flowing: true })
    const cleanup = processTerminalInput(stream).start(() => {})
    cleanup()
    expect(stream.rawCalls).toEqual([false, true, true])
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
    expect(() => processTerminalInput(stream).start(() => {})).toThrow('raw mode unavailable')
    expect(stream.rawCalls).toEqual([false, false])
    expect(stream.listenerCount('keypress')).toBe(0)
    expect(stream.readableFlowing).toBe(false)
  })

  test('a listening-hook failure cancels maintenance and restores the stream', () => {
    const stream = inputStream()
    const clear = spyOn(globalThis, 'clearInterval')
    try {
      expect(() =>
        processTerminalInput(stream).start(() => {}, {
          onListening: () => {
            throw new Error('listening failed')
          },
        }),
      ).toThrow('listening failed')
      expect(clear).toHaveBeenCalledTimes(1)
      expect(stream.actualRaw).toBe(false)
      expect(stream.readableFlowing).toBe(false)
      expect(stream.listenerCount('keypress')).toBe(0)
    } finally {
      clear.mockRestore()
    }
  })

  test('reports listening only after a real TTY is in raw, flowing mode', () => {
    const tty = inputStream()
    let listening = 0
    const cleanup = processTerminalInput(tty).start(() => {}, {
      onListening: () => {
        expect(tty.isRaw).toBe(true)
        expect(tty.readableFlowing).toBe(true)
        listening += 1
      },
    })
    expect(listening).toBe(1)
    cleanup()
  })

  test('a non-TTY is untouched and never reports listening', () => {
    const stream = inputStream({ tty: false })
    let listening = 0
    const cleanup = processTerminalInput(stream).start(() => {}, {
      onListening: () => (listening += 1),
    })
    cleanup()
    expect(listening).toBe(0)
    expect(stream.rawCalls).toEqual([])
    expect(stream.listenerCount('keypress')).toBe(0)
  })
})

/**
 * The byte-level normalization, driven by the SAME raw sequences a probe of
 * Node/Bun's `emitKeypressEvents` produced — so the table the decoder was
 * designed against is executable rather than remembered.
 *
 * These assert on the COMPLETE event list, not merely the presence of the
 * expected event: one failure mode here is an EXTRA event (a CSI tail arriving
 * as text) rather than a missing one.
 */
function keyboard(hooks?: TerminalInputHooks) {
  const stream = inputStream()
  const inputs: TerminalInputEvent[] = []
  const cleanup = processTerminalInput(stream).start((input) => inputs.push(input), hooks)
  return {
    inputs,
    cleanup,
    async type(bytes: string, settleMs = 5): Promise<TerminalInputEvent[]> {
      inputs.length = 0
      stream.write(bytes)
      await new Promise((resolve) => setTimeout(resolve, settleMs))
      return inputs
    },
  }
}

describe('processTerminalInput: CR submits, LF inserts a newline', () => {
  test('Return and Ctrl-J are distinct at the byte level', async () => {
    const kb = keyboard()
    // Raw-mode Return is CR; Ctrl-J is literally LF. That is what makes the
    // newline binding work in every terminal with no protocol negotiation.
    expect(await kb.type('\r')).toEqual([{ type: 'enter' }])
    expect(await kb.type('\n')).toEqual([{ type: 'newline' }])
    // Alt+Enter, and what a terminal configured to send "Shift+Enter" emits.
    expect(await kb.type('\x1b\r')).toEqual([{ type: 'newline' }])
    expect(await kb.type('\x1b\n')).toEqual([{ type: 'newline' }])
    kb.cleanup()
  })

  test('the cursor motions the composer needs are all normalized', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[D')).toEqual([{ type: 'left' }])
    expect(await kb.type('\x1b[C')).toEqual([{ type: 'right' }])
    expect(await kb.type('\x1b[H')).toEqual([{ type: 'home' }])
    expect(await kb.type('\x1b[F')).toEqual([{ type: 'end' }])
    expect(await kb.type('\x1b[1~')).toEqual([{ type: 'home' }])
    expect(await kb.type('\x1b[4~')).toEqual([{ type: 'end' }])
    kb.cleanup()
  })
})

describe('processTerminalInput: the CSI-u modifier is a BITFIELD, not a threshold', () => {
  // The lock bits are the trap. Once "report all keys as escape codes" is on —
  // the very mode that makes Return arrive as CSI-u — caps lock (64) and num
  // lock (128) ARE reported, so an unmodified Enter is `ESC[13;65u`. A
  // `mod >= 2` test would read that as Shift+Enter and stop submitting for
  // every operator with a lock key engaged.
  const cases: Array<[string, string, TerminalInputEvent[]]> = [
    ['no modifier', '\x1b[13u', [{ type: 'enter' }]],
    ['modifier 1 (none)', '\x1b[13;1u', [{ type: 'enter' }]],
    ['caps lock only', '\x1b[13;65u', [{ type: 'enter' }]],
    ['num lock only', '\x1b[13;129u', [{ type: 'enter' }]],
    ['both locks', '\x1b[13;193u', [{ type: 'enter' }]],
    ['shift', '\x1b[13;2u', [{ type: 'newline' }]],
    ['ctrl', '\x1b[13;5u', [{ type: 'newline' }]],
    ['super', '\x1b[13;9u', [{ type: 'newline' }]],
    ['shift + caps', '\x1b[13;66u', [{ type: 'newline' }]],
    ['shift + num', '\x1b[13;130u', [{ type: 'newline' }]],
    ['shift + both locks', '\x1b[13;194u', [{ type: 'newline' }]],
    ['shift + caps, press event', '\x1b[13;66:1u', [{ type: 'newline' }]],
    ['caps, RELEASE event', '\x1b[13;65:3u', []],
  ]

  for (const [label, bytes, expected] of cases) {
    test(label, async () => {
      const kb = keyboard()
      expect(await kb.type(bytes)).toEqual(expected)
      kb.cleanup()
    })
  }
})

describe('processTerminalInput: partial CSI sequences are reassembled', () => {
  test('a Kitty Shift+Enter is ONE newline and no text at all (f_e94f5b39)', async () => {
    // Node fragments `ESC[13;2:1u` into three events, the tail arriving as
    // ordinary printable text. Without reassembly the operator's guidance
    // silently gains a `1u`.
    const kb = keyboard()
    expect(await kb.type('\x1b[13;2:1u')).toEqual([{ type: 'newline' }])
    kb.cleanup()
  })

  test('repeat acts, release does not', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[13;2:2u')).toEqual([{ type: 'newline' }])
    expect(await kb.type('\x1b[13;2:3u')).toEqual([])
    expect(await kb.type('\x1b[13;1:3u')).toEqual([])
    kb.cleanup()
  })

  test('modifyOtherKeys reports are decoded rather than injected as text', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[27;2;13~')).toEqual([{ type: 'newline' }])
    expect(await kb.type('\x1b[27;1;13~')).toEqual([{ type: 'enter' }])
    kb.cleanup()
  })

  test('a report for a key OTHER than Return produces nothing — this is not a keymap', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[9;2u')).toEqual([])
    expect(await kb.type('\x1b[27;2;65~')).toEqual([])
    kb.cleanup()
  })

  test('Ctrl-C arriving mid-fragment still interrupts', async () => {
    // Quitting must never depend on the terminal's keyboard protocol, which is
    // why the interrupt check runs BEFORE reassembly.
    const kb = keyboard()
    expect(await kb.type('\x1b[13;2:\x03')).toEqual([{ type: 'interrupt' }])
    // And the buffer is gone: an ordinary keystroke lands immediately after.
    expect(await kb.type('a')).toEqual([{ type: 'text', text: 'a' }])
    kb.cleanup()
  })

  test('an impossible eight-digit parameter drains through its final byte', () => {
    const decoder = createTerminalInputDecoder()
    expect(decoder.press(undefined, { name: 'undefined', sequence: '\x1b[13;' })).toBeUndefined()
    for (let i = 0; i < 20; i += 1) {
      expect(decoder.press('1', { name: '1', sequence: '1' })).toBeUndefined()
    }
    // Every ASCII letter is a CSI final byte, so it closes and is consumed.
    expect(decoder.press('h', { name: 'h', sequence: 'h' })).toBeUndefined()
    expect(decoder.press('x', { name: 'x', sequence: 'x' })).toEqual({ type: 'text', text: 'x' })
  })

  test('a fresh CSI restarts a drain', () => {
    const decoder = createTerminalInputDecoder()
    expect(
      decoder.press(undefined, { name: 'undefined', sequence: '\x1b[12345678' }),
    ).toBeUndefined()
    expect(decoder.press(undefined, { name: 'undefined', sequence: '\x1b[13;2u' })).toEqual({
      type: 'newline',
    })
  })
})

describe('processTerminalInput: legacy and Kitty encodings normalize identically', () => {
  const cases: Array<[string, string, string, TerminalInputEvent]> = [
    ['submit', '\r', '\x1b[13;129u', { type: 'enter' }],
    ['newline', '\n', '\x1b[13;130u', { type: 'newline' }],
    ['Escape', '\x1b', '\x1b[27u', { type: 'escape' }],
    ['Backspace', '\x7f', '\x1b[127u', { type: 'backspace' }],
    ['Up', '\x1b[A', '\x1b[1;129A', { type: 'up' }],
    ['Down', '\x1b[B', '\x1b[1;129B', { type: 'down' }],
    ['Ctrl-C', '\x03', '\x1b[99;133u', { type: 'interrupt' }],
    ['command letter', 'm', '\x1b[109;129;109u', { type: 'text', text: 'm' }],
  ]

  for (const [label, legacy, kitty, expected] of cases) {
    test(label, async () => {
      const kb = keyboard()
      // readline waits briefly to decide whether a lone Escape starts a CSI.
      expect(await kb.type(legacy, label === 'Escape' ? 600 : 5)).toEqual([expected])
      expect(await kb.type(kitty)).toEqual([expected])
      kb.cleanup()
    })
  }
})

describe('processTerminalInput: full CSI-u reports survive parser fragmentation', () => {
  test('astral and multi-code-point text each arrive as one event', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[0;;128512u')).toEqual([{ type: 'text', text: '😀' }])
    expect(await kb.type('\x1b[0;;101:769u')).toEqual([{ type: 'text', text: 'é' }])
    expect(await kb.type('\x1b[0;;128104:8205:128105:8205:128103:8205:128102u')).toEqual([
      { type: 'text', text: '👨‍👩‍👧‍👦' },
    ])
    expect(await kb.type('\x1b[0;;128075:127997u')).toEqual([{ type: 'text', text: '👋🏽' }])
    kb.cleanup()
  })

  for (const count of [40, 90, 10_000]) {
    test(`a valid associated-text report with ${count} code points has no total cap`, async () => {
      const kb = keyboard()
      const expected = '😀'.repeat(count)
      const report = `\x1b[0;;${Array.from({ length: count }, () => '128512').join(':')}u`
      expect(await kb.type(report)).toEqual([{ type: 'text', text: expected }])
      kb.cleanup()
    })
  }

  test('keyboard flags and device attributes call hooks, never input', async () => {
    const flags: number[] = []
    let attributes = 0
    const kb = keyboard({
      onKeyboardFlags: (value) => flags.push(value),
      onDeviceAttributes: () => (attributes += 1),
    })
    expect(await kb.type('\x1b[?29u')).toEqual([])
    expect(flags).toEqual([29])
    expect(await kb.type('\x1b[?62;1;6c')).toEqual([])
    expect(attributes).toBe(1)
    kb.cleanup()
  })
})

describe('processTerminalInput: CSI-u interrupt watch', () => {
  for (const bytes of ['\x1b[99;5u', '\x1b[99;133u', '\x1b[1089::99;133u']) {
    test(`${JSON.stringify(bytes)} interrupts idle and clears for the next key`, async () => {
      const kb = keyboard()
      expect(await kb.type(bytes)).toEqual([{ type: 'interrupt' }])
      expect(await kb.type('a')).toEqual([{ type: 'text', text: 'a' }])
      kb.cleanup()
    })

    test(`${JSON.stringify(bytes)} interrupts an open CSI run`, async () => {
      const kb = keyboard()
      // The colon makes readline give up and emit a partial keypress, leaving
      // our reassembler (rather than readline itself) with the open run.
      expect(await kb.type('\x1b[13;2:')).toEqual([])
      expect(await kb.type(bytes)).toEqual([{ type: 'interrupt' }])
      expect(await kb.type('a')).toEqual([{ type: 'text', text: 'a' }])
      kb.cleanup()
    })

    test(`${JSON.stringify(bytes)} interrupts a bracketed paste`, async () => {
      const kb = keyboard()
      expect(await kb.type(`\x1b[200~content${bytes}`)).toEqual([{ type: 'interrupt' }])
      expect(await kb.type('a')).toEqual([{ type: 'text', text: 'a' }])
      kb.cleanup()
    })
  }

  test('Ctrl-J on a non-Latin layout reassembles as newline', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[1086::106;5u')).toEqual([{ type: 'newline' }])
    kb.cleanup()
  })

  test('both interrupt encodings escape a draining run', async () => {
    for (const bytes of ['\x03', '\x1b[99;133u']) {
      const kb = keyboard()
      expect(await kb.type(`\x1b[12345678${bytes}`)).toEqual([{ type: 'interrupt' }])
      kb.cleanup()
    }
  })
})

describe('processTerminalInput: bracketed paste', () => {
  test('a multi-line paste is ONE event that keeps its line structure', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[200~first line\nsecond line\x1b[201~')).toEqual([
      { type: 'paste', text: 'first line\nsecond line' },
    ])
    kb.cleanup()
  })

  test('CRLF and CR normalize to LF; other control characters drop out', async () => {
    const kb = keyboard()
    expect(await kb.type('\x1b[200~a\r\nb\rc\td\x1b[201~')).toEqual([
      { type: 'paste', text: 'a\nb\nc' + 'd' },
    ])
    kb.cleanup()
  })

  test('a paste well past 64 KiB arrives WHOLE (f_f490ec43)', async () => {
    // There is no size cap anywhere on this path: the buffer must hold what
    // the operator actually pasted, and a cap would cost both the submitted
    // guidance and the paste itself.
    const kb = keyboard()
    const pasted = `${'lorem ipsum dolor sit amet '.repeat(10)}\n`.repeat(260)
    expect(pasted.length).toBeGreaterThan(64 * 1024)
    const events = await kb.type(`\x1b[200~${pasted}\x1b[201~`)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'paste', text: pasted })
    kb.cleanup()
  })

  test('no part of a paste is interpreted as submit', async () => {
    const kb = keyboard()
    const events = await kb.type('\x1b[200~one\ntwo\x1b[201~')
    expect(events.some((event) => event.type === 'enter')).toBe(false)
    expect(events.some((event) => event.type === 'newline')).toBe(false)
    kb.cleanup()
  })
})

test('readline focus reports never become text or interaction, including split CSI', async () => {
  const stream = inputStream()
  const inputs: TerminalInputEvent[] = []
  const focuses: boolean[] = []
  let ignoredKeys = 0
  let suspends = 0
  const cleanup = processTerminalInput(stream).start((event) => inputs.push(event), {
    onFocus: (focused) => focuses.push(focused),
    onInteraction: () => {
      ignoredKeys++
    },
    onSuspend: () => {
      suspends++
    },
  })
  stream.write('\x1b[I\x1b[O')
  await Bun.sleep(10)
  expect(focuses).toEqual([true, false])
  expect(inputs).toEqual([])
  expect(ignoredKeys).toBe(0)
  // Also pin both known and unknown readline CSI shapes and decoder fragments.
  stream.emit('keypress', undefined, { name: 'focus', sequence: '\x1b[I' })
  stream.emit('keypress', undefined, { name: 'undefined', sequence: '\x1b[' })
  stream.emit('keypress', 'O', { name: 'o', sequence: 'O' })
  expect(focuses).toEqual([true, false, true, false])
  stream.emit('keypress', '\t', { name: 'tab', sequence: '\t' })
  expect(ignoredKeys).toBe(1)
  stream.write('\x1a')
  await Bun.sleep(10)
  expect(suspends).toBe(1)
  stream.write('\x1b[122;5u')
  await Bun.sleep(10)
  expect(suspends).toBe(2)
  expect(inputs).toEqual([])
  cleanup()
})
