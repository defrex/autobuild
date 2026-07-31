import { describe, expect, test } from 'bun:test'
import {
  createKeyboardProtocol,
  decodeCsi,
  DEVICE_ATTRIBUTES_QUERY,
  KITTY_KEYBOARD_FLAGS,
  POP_KEYBOARD_FLAGS,
  PUSH_KEYBOARD_FLAGS,
  QUERY_KEYBOARD_FLAGS,
  type CsiReport,
} from './keyboard'
import type { TerminalInputEvent } from './terminal'

const event = (type: string, text?: string): CsiReport => ({
  kind: 'input',
  event: (text === undefined ? { type } : { type, text }) as TerminalInputEvent,
})

describe('decodeCsi', () => {
  const cases: Array<[string, string, ReturnType<typeof decodeCsi>]> = [
    ['plain Return', '\x1b[13u', event('enter')],
    ['Return with caps lock', '\x1b[13;65u', event('enter')],
    ['Return with num lock', '\x1b[13;129u', event('enter')],
    ['Shift+Return', '\x1b[13;2u', event('newline')],
    ['Ctrl+Return', '\x1b[13;5u', event('newline')],
    ['Escape', '\x1b[27u', event('escape')],
    ['Backspace', '\x1b[127u', event('backspace')],
    ['Tab remains excluded', '\x1b[9u', { kind: 'ignored' }],
    ['Ctrl-C', '\x1b[99;5u', event('interrupt')],
    ['Ctrl-C with num lock', '\x1b[99;133u', event('interrupt')],
    ['Ctrl-C with caps lock', '\x1b[99;69u', event('interrupt')],
    ['Ctrl-J', '\x1b[106;5u', event('newline')],
    ['Ctrl-J with num lock', '\x1b[106;133u', event('newline')],
    ['Cyrillic Ctrl-C', '\x1b[1089::99;5u', event('interrupt')],
    ['Cyrillic Ctrl-C with num lock', '\x1b[1089::99;133u', event('interrupt')],
    ['Cyrillic Ctrl-J', '\x1b[1086::106;5u', event('newline')],
    ['Cyrillic Ctrl-J with num lock', '\x1b[1086::106;133u', event('newline')],
    ['Dvorak Ctrl-C', '\x1b[99::105;5u', event('interrupt')],
    // Produced `j` wins the physical QWERTY-C collision; see decoder comment.
    ['Dvorak collision', '\x1b[106::99;5u', event('newline')],
    ['non-Latin chord without alternate key', '\x1b[1089;5u', { kind: 'ignored' }],
    ['plain text', '\x1b[97u', event('text', 'a')],
    ['plain text with num lock', '\x1b[109;129;109u', event('text', 'm')],
    ['shifted alternate is not used without shift', '\x1b[97:65u', event('text', 'a')],
    ['shifted alternate is used with shift', '\x1b[97:65;2u', event('text', 'A')],
    ['associated text', '\x1b[97:65:97;;97u', event('text', 'a')],
    ['associated shifted text', '\x1b[97:65:97;2;65u', event('text', 'A')],
    ['Cyrillic text never falls back to physical key', '\x1b[1089::99;;1089u', event('text', 'с')],
    ['astral associated text', '\x1b[0;;128512u', event('text', '😀')],
    ['PUA associated text is text', '\x1b[0;;57345u', event('text', String.fromCodePoint(57345))],
    ['combining associated text', '\x1b[0;;101:769u', event('text', 'é')],
    ['associated C0 control is rejected', '\x1b[0;;9u', { kind: 'ignored' }],
    ['associated C1 control is rejected', '\x1b[0;;155u', { kind: 'ignored' }],
    ['functional primary key is rejected', '\x1b[57441u', { kind: 'ignored' }],
    ['functional shifted alternate is rejected', '\x1b[97:57441;2u', { kind: 'ignored' }],
    ['up', '\x1b[A', event('up')],
    ['up with shift', '\x1b[1;2A', event('up')],
    ['up with num lock', '\x1b[1;129A', event('up')],
    ['down', '\x1b[1;129B', event('down')],
    ['home tilde', '\x1b[1;129~', event('home')],
    ['home tilde legacy', '\x1b[7;129~', event('home')],
    ['end tilde', '\x1b[8~', event('end')],
    ['modifyOtherKeys Return', '\x1b[27;2;13~', event('newline')],
    ['release event', '\x1b[97;1:3u', { kind: 'ignored' }],
    ['keyboard flags', '\x1b[?29u', { kind: 'keyboard-flags', flags: 29 }],
    ['empty keyboard flags', '\x1b[?u', { kind: 'keyboard-flags', flags: 0 }],
    ['device attributes', '\x1b[?62;1;6c', { kind: 'device-attributes' }],
    ['long device attributes', '\x1b[?64;1;2;6;9;15;18;21;22c', { kind: 'device-attributes' }],
  ]

  for (const [label, sequence, expected] of cases) {
    test(label, () => expect(decodeCsi(sequence)).toEqual(expected))
  }

  test('a long multi-code-point associated-text report is folded without a spread limit', () => {
    const codes = Array.from({ length: 100_000 }, () => '128512')
    const report = decodeCsi(`\x1b[0;;${codes.join(':')}u`)
    expect(report.kind).toBe('input')
    if (report.kind === 'input' && report.event.type === 'text') {
      expect([...report.event.text]).toHaveLength(100_000)
    }
  })
})

describe('createKeyboardProtocol', () => {
  const setup = () => {
    const writes: string[] = []
    return { writes, protocol: createKeyboardProtocol((chunk) => writes.push(chunk)) }
  }
  const verification = PUSH_KEYBOARD_FLAGS + QUERY_KEYBOARD_FLAGS + DEVICE_ATTRIBUTES_QUERY

  test('queries once and supports reply-before-screen', () => {
    const { writes, protocol } = setup()
    protocol.query()
    protocol.query()
    expect(writes.join('')).toBe(QUERY_KEYBOARD_FLAGS)
    protocol.reported(0)
    protocol.screenEntered()
    expect(writes.join('')).toBe(QUERY_KEYBOARD_FLAGS + verification)
  })

  test('supports screen-before-reply and pushes once', () => {
    const { writes, protocol } = setup()
    protocol.query()
    protocol.screenEntered()
    protocol.reported(0)
    protocol.screenEntered()
    expect(writes.join('')).toBe(QUERY_KEYBOARD_FLAGS + verification)
  })

  test('an unanswered query never pushes or pops', () => {
    const { writes, protocol } = setup()
    protocol.query()
    protocol.screenEntered()
    protocol.screenLeaving()
    expect(writes.join('')).toBe(QUERY_KEYBOARD_FLAGS)
  })

  test('a device-attributes reply deterministically declines verification', () => {
    const { writes, protocol } = setup()
    protocol.query()
    protocol.reported(0)
    protocol.screenEntered()
    expect(protocol.pushed).toBe(true)
    protocol.deviceAttributes()
    expect(writes.at(-1)).toBe(POP_KEYBOARD_FLAGS)
    expect(protocol.pushed).toBe(false)
    const count = writes.length
    protocol.screenLeaving()
    expect(writes).toHaveLength(count)
  })

  for (const flags of [KITTY_KEYBOARD_FLAGS, 31]) {
    test(`verification accepts required flag superset ${flags}`, () => {
      const { writes, protocol } = setup()
      protocol.query()
      protocol.reported(0)
      protocol.screenEntered()
      protocol.reported(flags)
      protocol.deviceAttributes()
      expect(protocol.pushed).toBe(true)
      protocol.screenLeaving()
      expect(writes.at(-1)).toBe(POP_KEYBOARD_FLAGS)
    })
  }

  for (const flags of [9, 25, 13, 1, 0]) {
    test(`partial verification ${flags} pops once`, () => {
      const { writes, protocol } = setup()
      protocol.query()
      protocol.reported(0)
      protocol.screenEntered()
      protocol.reported(flags)
      expect(writes.at(-1)).toBe(POP_KEYBOARD_FLAGS)
      const count = writes.length
      protocol.screenLeaving()
      protocol.reported(29)
      expect(writes).toHaveLength(count)
    })
  }

  test('teardown while verifying pops and latches late replies', () => {
    const { writes, protocol } = setup()
    protocol.query()
    protocol.reported(0)
    protocol.screenEntered()
    protocol.screenLeaving()
    const count = writes.length
    protocol.reported(29)
    protocol.deviceAttributes()
    expect(writes).toHaveLength(count)
    expect(writes.at(-1)).toBe(POP_KEYBOARD_FLAGS)
  })

  test('device attributes outside verification are inert', () => {
    const { writes, protocol } = setup()
    protocol.deviceAttributes()
    protocol.query()
    protocol.deviceAttributes()
    protocol.reported(0)
    protocol.deviceAttributes()
    expect(writes).toEqual([QUERY_KEYBOARD_FLAGS])
  })
})
