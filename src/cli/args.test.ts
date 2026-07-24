import { describe, expect, test } from 'bun:test'
import { parseArgs, stringFlag, type FlagSpec } from './args'

const USAGE = 'usage: ab sample <name> [--output <file>] [--json]'

describe('parseArgs', () => {
  test('preserves positional order while extracting interspersed value and boolean flags', () => {
    const parsed = parseArgs(
      ['before', '--output', 'result.txt', 'middle', '--json', 'after'],
      { output: 'value', json: 'boolean' },
      USAGE,
    )

    expect(parsed.positionals).toEqual(['before', 'middle', 'after'])
    expect(stringFlag(parsed, 'output')).toBe('result.txt')
    expect(parsed.flags.get('json')).toBe(true)
  })

  test('accepts an explicit empty value and a single-dash value', () => {
    const empty = parseArgs(['--labels', ''], { labels: 'value' }, USAGE)
    expect(stringFlag(empty, 'labels')).toBe('')

    const negative = parseArgs(['--count', '-1'], { count: 'value' }, USAGE)
    expect(stringFlag(negative, 'count')).toBe('-1')
  })

  test('rejects a value flag with no following token using the supplied usage', () => {
    expect(() => parseArgs(['--output'], { output: 'value' }, USAGE)).toThrow(
      `--output requires a value — ${USAGE}`,
    )
  })

  test('rejects a following flag token instead of consuming it as a value', () => {
    expect(() =>
      parseArgs(['--output', '--json'], { output: 'value', json: 'boolean' }, USAGE),
    ).toThrow(`--output requires a value, got "--json" — ${USAGE}`)
  })

  test('rejects duplicate value and boolean singleton flags', () => {
    expect(() =>
      parseArgs(['--output', 'one', '--output', 'two'], { output: 'value' }, USAGE),
    ).toThrow(`--output may be supplied only once — ${USAGE}`)

    expect(() => parseArgs(['--json', '--json'], { json: 'boolean' }, USAGE)).toThrow(
      `--json may be supplied only once — ${USAGE}`,
    )
  })

  test('rejects unknown and prototype-looking flag names', () => {
    expect(() => parseArgs(['--other'], {}, USAGE)).toThrow(`unknown flag --other — ${USAGE}`)
    expect(() => parseArgs(['--toString'], {}, USAGE)).toThrow(`unknown flag --toString — ${USAGE}`)

    const inherited = Object.create({ inherited: 'boolean' }) as FlagSpec
    expect(() => parseArgs(['--inherited'], inherited, USAGE)).toThrow(
      `unknown flag --inherited — ${USAGE}`,
    )
  })

  test('does not add equals-form flags or an end-of-options delimiter', () => {
    expect(() => parseArgs(['--output=result.txt'], { output: 'value' }, USAGE)).toThrow(
      `unknown flag --output=result.txt — ${USAGE}`,
    )
    expect(() => parseArgs(['--', '--json'], { json: 'boolean' }, USAGE)).toThrow(
      `unknown flag -- — ${USAGE}`,
    )
  })

  test('keeps command flag contracts isolated', () => {
    const first = { store: 'value', json: 'boolean' } as const
    const second = { notes: 'value' } as const

    expect(stringFlag(parseArgs(['--store', 'state'], first, USAGE), 'store')).toBe('state')
    expect(() => parseArgs(['--store', 'state'], second, USAGE)).toThrow(
      `unknown flag --store — ${USAGE}`,
    )
  })
})
