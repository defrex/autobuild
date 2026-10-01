import { describe, expect, test } from 'bun:test'
import {
  effectiveTicketAssetLimits,
  summarizeTicketAsset,
  TICKET_ASSET_MAX_BYTES,
  TICKET_ASSET_MAX_ENTRIES,
  TicketAssetValidationError,
  validateTicketAssetInput,
  type TicketAssetEntryInput,
  type TicketAssetInput,
} from './ticket-assets'

const bytes = (n: number) => new Uint8Array(n)
const file = (path: string, n = 1): TicketAssetEntryInput => ({
  type: 'file',
  path,
  content: bytes(n),
})
const tree = (...entries: TicketAssetEntryInput[]): TicketAssetInput => ({
  kind: 'design',
  name: 'home',
  layout: 'tree',
  entries,
})

describe('validateTicketAssetInput', () => {
  test('accepts a file, a tree, an empty tree, and nested empty directories', () => {
    expect(
      validateTicketAssetInput({
        kind: 'design',
        name: 'a.png',
        layout: 'file',
        entries: [file('a.png', 3)],
      }),
    ).toBe(3)
    expect(validateTicketAssetInput(tree(file('index.html', 2), file('img/a.png', 5)))).toBe(7)
    expect(validateTicketAssetInput(tree())).toBe(0)
    expect(validateTicketAssetInput(tree({ type: 'dir', path: 'img/empty' }))).toBe(0)
  })

  test.each(['', ' ', 'a b', 'a/b', '..', '.', 'é', 'x'.repeat(65)])(
    'rejects kind/name %p',
    (value) => {
      expect(() => validateTicketAssetInput({ ...tree(), kind: value })).toThrow(
        TicketAssetValidationError,
      )
      expect(() => validateTicketAssetInput({ ...tree(), name: value })).toThrow(
        TicketAssetValidationError,
      )
    },
  )

  test.each(['', '/abs', '../x', 'a/../b', 'a//b', './a', 'a/', 'a\0b', 'a\\b'])(
    'rejects path %p',
    (path) => {
      expect(() => validateTicketAssetInput(tree(file(path)))).toThrow(TicketAssetValidationError)
    },
  )

  test('bounds path and segment length in UTF-8 bytes', () => {
    expect(() => validateTicketAssetInput(tree(file('é'.repeat(65))))).toThrow(/segment/)
    expect(() =>
      validateTicketAssetInput(tree(file(`${'a'.repeat(100)}/`.repeat(3) + 'b'))),
    ).toThrow(/path exceeds/)
    expect(validateTicketAssetInput(tree(file('a'.repeat(128))))).toBe(1)
  })

  test('rejects duplicates and file/dir conflicts', () => {
    expect(() => validateTicketAssetInput(tree(file('a'), file('a')))).toThrow(/duplicate/)
    expect(() => validateTicketAssetInput(tree(file('a'), { type: 'dir', path: 'a' }))).toThrow(
      /duplicate/,
    )
    expect(() => validateTicketAssetInput(tree(file('a'), file('a/b')))).toThrow(/ancestor/)
  })

  test('file layout needs exactly one top-level file and no dirs', () => {
    const base = { kind: 'design', name: 'a', layout: 'file' as const }
    expect(() => validateTicketAssetInput({ ...base, entries: [] })).toThrow(
      TicketAssetValidationError,
    )
    expect(() => validateTicketAssetInput({ ...base, entries: [file('a'), file('b')] })).toThrow(
      TicketAssetValidationError,
    )
    expect(() =>
      validateTicketAssetInput({ ...base, entries: [{ type: 'dir', path: 'a' }] }),
    ).toThrow(TicketAssetValidationError)
    expect(() => validateTicketAssetInput({ ...base, entries: [file('x/a')] })).toThrow(
      TicketAssetValidationError,
    )
  })

  test('refuses over the size limit, naming it', () => {
    expect(validateTicketAssetInput(tree(file('a', TICKET_ASSET_MAX_BYTES)))).toBe(
      TICKET_ASSET_MAX_BYTES,
    )
    expect(() => validateTicketAssetInput(tree(file('a', TICKET_ASSET_MAX_BYTES + 1)))).toThrow(
      'ticket asset exceeds the 26214400-byte (25 MiB) limit',
    )
  })

  test('applies caller-supplied limits and the entry bound', () => {
    expect(() =>
      validateTicketAssetInput(tree(file('a', 11)), { maxBytes: 10, maxEntries: 5 }),
    ).toThrow('exceeds the 10-byte')
    const many = Array.from({ length: TICKET_ASSET_MAX_ENTRIES + 1 }, (_, i) => file(`f${i}`, 0))
    expect(() => validateTicketAssetInput(tree(...many))).toThrow(/1000-entry/)
    expect(validateTicketAssetInput(tree(...many.slice(1)))).toBe(0)
  })
})

describe('effectiveTicketAssetLimits', () => {
  test('is the plain constants without a ceiling', () => {
    expect(effectiveTicketAssetLimits()).toEqual({
      maxBytes: TICKET_ASSET_MAX_BYTES,
      maxEntries: TICKET_ASSET_MAX_ENTRIES,
    })
  })

  test('pins the hosted 4 MiB ceiling', () => {
    expect(effectiveTicketAssetLimits(4 * 1024 * 1024).maxBytes).toBe(2_904_960)
  })

  test('applies the formula, caps at the default, and floors at zero', () => {
    const overhead = 1024 + 1000 * 320
    expect(effectiveTicketAssetLimits(overhead + 4000).maxBytes).toBe(3000)
    expect(effectiveTicketAssetLimits(1024 ** 4).maxBytes).toBe(TICKET_ASSET_MAX_BYTES)
    expect(effectiveTicketAssetLimits(overhead).maxBytes).toBe(0)
    expect(effectiveTicketAssetLimits(10).maxBytes).toBe(0)
  })
})

test('summarizeTicketAsset counts files and dirs from the manifest', () => {
  const summary = summarizeTicketAsset({
    repo: 'r',
    ticketId: 'T-1',
    kind: 'design',
    name: 'home',
    revision: 2,
    layout: 'tree',
    size: 5,
    createdAt: 'now',
    entries: [
      { type: 'file', path: 'a', size: 5, blobRef: 'x' },
      { type: 'dir', path: 'd' },
    ],
  })
  expect(summary).toMatchObject({ fileCount: 1, dirCount: 1, size: 5, revision: 2 })
  expect('entries' in summary).toBe(false)
})
