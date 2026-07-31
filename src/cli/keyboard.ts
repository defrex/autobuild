import type { TerminalInputEvent } from './terminal'

/** Progressive enhancement flags requested from Kitty-compatible terminals. */
export const KITTY_KEYBOARD_FLAGS = 0b1_1101
/** Ask for the current progressive keyboard enhancement flags. */
export const QUERY_KEYBOARD_FLAGS = '\x1b[?u'
/**
 * Push disambiguated escape codes (1), alternate keys (4), all keys as escape
 * codes (8), and associated text (16). Alternate keys are essential: without
 * them Cyrillic Ctrl-C reports key 1089 and the decoder cannot recognize it.
 */
export const PUSH_KEYBOARD_FLAGS = `\x1b[>${KITTY_KEYBOARD_FLAGS}u`
/** Pop exactly the keyboard mode frame pushed by this process. */
export const POP_KEYBOARD_FLAGS = '\x1b[<1u'
/**
 * Primary Device Attributes is not a keyboard command. It follows the
 * verification query because its guaranteed, ordered reply lets verification
 * fail deterministically when no keyboard-flags reply arrives.
 */
export const DEVICE_ATTRIBUTES_QUERY = '\x1b[c'

/**
 * Kitty modifiers are `1 + bitfield`; caps and num lock are reported on every
 * key in report-all-keys mode and must not turn an ordinary key into a chord.
 */
export const MODIFIER_LOCK_MASK = 0b1100_0000
/** Shift and lock bits may still produce text; ctrl/alt/super/hyper/meta may not. */
const MODIFIER_TEXT_MASK = 0b1100_0001
/** No decoded numeric parameter can exceed Unicode's seven-digit maximum scalar. */
export const MAX_CSI_PARAM_DIGITS = 7
/**
 * Three 7-digit key fields, two colons, a semicolon, 3-digit modifier, `:1`,
 * `ESC[` and `u` fit in 32 bytes. Forty therefore covers every Ctrl-C report
 * while keeping the parallel, non-consuming interrupt watch deliberately tight.
 */
export const INTERRUPT_WATCH_MAX = 40

/** ECMA-48 parameter/intermediate bytes that may extend a CSI run. */
export function isCsiParameterByte(ch: string): boolean {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  return code >= 0x20 && code <= 0x3f
}

/**
 * CSI sequences end at a byte in 0x40-0x7e. This includes every ASCII letter,
 * so one ordinary letter always terminates an accumulating or draining run.
 */
export function endsCsi(sequence: string): boolean {
  if (sequence.length <= 2) return false
  const code = sequence.charCodeAt(sequence.length - 1)
  return code >= 0x40 && code <= 0x7e
}

/** Decode a `1 + bitfield` modifier parameter into submit-versus-newline. */
function modifiedReturn(mod: number | undefined): TerminalInputEvent {
  if (mod === undefined) return { type: 'enter' }
  const bits = Math.max(0, mod - 1)
  return (bits & ~MODIFIER_LOCK_MASK) === 0 ? { type: 'enter' } : { type: 'newline' }
}

function parseParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isTextCodePoint(code: number | undefined): code is number {
  return (
    code !== undefined &&
    code >= 0x20 &&
    code <= 0x10ffff &&
    !(code >= 0x7f && code <= 0x9f) &&
    !(code >= 0xd800 && code <= 0xdfff)
  )
}

/** Kitty reserves U+E000-U+F8FF in the key-code field for functional keys. */
function isFunctionalKeyCode(code: number): boolean {
  return code >= 57344 && code <= 63743
}

export type CsiReport =
  | { kind: 'input'; event: TerminalInputEvent }
  | { kind: 'keyboard-flags'; flags: number }
  | { kind: 'device-attributes' }
  | { kind: 'ignored' }

const ignored = (): CsiReport => ({ kind: 'ignored' })
const input = (event: TerminalInputEvent): CsiReport => ({ kind: 'input', event })

/** Decode one complete CSI sequence, whether legacy, Kitty CSI-u, or a reply. */
export function decodeCsi(sequence: string): CsiReport {
  if (!sequence.startsWith('\x1b[') || !endsCsi(sequence)) return ignored()
  const final = sequence.at(-1)
  const body = sequence.slice(2, -1)

  if (final === 'u' && body.startsWith('?')) {
    return { kind: 'keyboard-flags', flags: parseParam(body.slice(1)) ?? 0 }
  }
  if (final === 'c' && body.startsWith('?')) return { kind: 'device-attributes' }

  const params = body.split(';')
  if (final === 'u') {
    const [primaryRaw, shiftedRaw, baseRaw] = (params[0] ?? '').split(':')
    const primary = parseParam(primaryRaw)
    const shifted = parseParam(shiftedRaw)
    const base = parseParam(baseRaw)
    const [modRaw, eventRaw] = (params[1] ?? '').split(':')
    const mod = parseParam(modRaw)
    const event = parseParam(eventRaw) ?? 1
    if (event !== 1 && event !== 2) return ignored()

    if (primary === 13) return input(modifiedReturn(mod))
    if (primary === 27) return input({ type: 'escape' })
    if (primary === 127 || primary === 8) return input({ type: 'backspace' })
    if (primary === 9) return ignored()

    const bits = Math.max(0, (mod ?? 1) - 1)
    if ((bits & 0b100) !== 0) {
      const chordKeys = base === undefined ? [primary] : [primary, base]
      // The Dvorak physical-QWERTY-C collision contains both 106 and 99. The
      // produced `j` wins: a newline is recoverable while an interrupt is not.
      if (chordKeys.includes(106)) return input({ type: 'newline' })
      if (chordKeys.includes(99)) return input({ type: 'interrupt' })
    }

    if ((bits & ~MODIFIER_TEXT_MASK) !== 0) return ignored()

    if (params[2] !== undefined) {
      const codes = params[2].split(':').map(parseParam)
      if (codes.length === 0 || !codes.every(isTextCodePoint)) return ignored()
      // Do not spread: valid associated text is unbounded and a large argument
      // list eventually throws. Folding remains safe for long IME commits.
      let text = ''
      for (const code of codes) text += String.fromCodePoint(code)
      return input({ type: 'text', text })
    }

    const shiftedOnly = (bits & ~MODIFIER_LOCK_MASK) === 0b1
    // The base-layout subfield names a physical position, not text in the
    // operator's layout, and is intentionally never a printable fallback.
    const code = shiftedOnly && shifted !== undefined ? shifted : primary
    if (!isTextCodePoint(code) || isFunctionalKeyCode(code)) return ignored()
    const text = String.fromCodePoint(code)
    // Best effort for the bounded pre-verification window. Associated text is
    // required after verification because this is wrong for shifted layouts.
    return input({
      type: 'text',
      text: shiftedOnly && shifted === undefined ? text.toUpperCase() : text,
    })
  }

  if (final === '~') {
    if (params[0] === '27' && parseParam(params[2]) === 13) {
      return input(modifiedReturn(parseParam(params[1])))
    }
    if (params[0] === '1' || params[0] === '7') return input({ type: 'home' })
    if (params[0] === '4' || params[0] === '8') return input({ type: 'end' })
    return ignored()
  }

  type Motion = Exclude<TerminalInputEvent['type'], 'text' | 'paste'>
  const motions: Record<string, Motion | undefined> = {
    A: 'up',
    B: 'down',
    C: 'right',
    D: 'left',
    H: 'home',
    F: 'end',
  }
  const motion = final === undefined ? undefined : motions[final]
  return motion === undefined ? ignored() : input({ type: motion })
}

export function isInterruptSequence(sequence: string): boolean {
  const report = decodeCsi(sequence)
  return report.kind === 'input' && report.event.type === 'interrupt'
}

type KeyboardPhase =
  | 'idle'
  | 'probing'
  | 'supported'
  | 'verifying'
  | 'active'
  | 'declined'
  | 'finished'

export interface KeyboardProtocol {
  query(): void
  reported(flags: number): void
  deviceAttributes(): void
  screenEntered(): void
  screenLeaving(): void
  readonly pushed: boolean
}

/** Negotiate and balance the per-screen Kitty keyboard mode stack. */
export function createKeyboardProtocol(write: (chunk: string) => void): KeyboardProtocol {
  let phase: KeyboardPhase = 'idle'
  let onScreen = false

  const push = (): void => {
    if (phase !== 'supported' || !onScreen) return
    write(PUSH_KEYBOARD_FLAGS + QUERY_KEYBOARD_FLAGS + DEVICE_ATTRIBUTES_QUERY)
    phase = 'verifying'
  }

  return {
    query(): void {
      if (phase !== 'idle') return
      write(QUERY_KEYBOARD_FLAGS)
      phase = 'probing'
    },
    reported(flags: number): void {
      if (phase === 'probing') {
        phase = 'supported'
        push()
        return
      }
      if (phase !== 'verifying') return
      if ((flags & KITTY_KEYBOARD_FLAGS) === KITTY_KEYBOARD_FLAGS) {
        phase = 'active'
      } else {
        write(POP_KEYBOARD_FLAGS)
        phase = 'declined'
      }
    },
    deviceAttributes(): void {
      if (phase !== 'verifying') return
      write(POP_KEYBOARD_FLAGS)
      phase = 'declined'
    },
    screenEntered(): void {
      if (phase === 'finished') return
      onScreen = true
      push()
    },
    screenLeaving(): void {
      if (phase === 'finished') return
      if (phase === 'verifying' || phase === 'active') write(POP_KEYBOARD_FLAGS)
      phase = 'finished'
      onScreen = false
    },
    get pushed(): boolean {
      return phase === 'verifying' || phase === 'active'
    },
  }
}
