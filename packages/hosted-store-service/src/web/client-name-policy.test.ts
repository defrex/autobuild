import { describe, expect, test } from 'bun:test'
import { CLIENT_NAME_MAX_LENGTH, clientNameProblem } from './client-name-policy'

describe('clientNameProblem', () => {
  test('accepts plain, unicode, emoji, and 64-character names', () => {
    for (const name of [
      'Acme MCP Console',
      'Ünïcodé — naïve, 日本語',
      '🤖 builds things ✅',
      'a'.repeat(CLIENT_NAME_MAX_LENGTH),
    ]) {
      expect(clientNameProblem(name)).toBeNull()
    }
  })

  test('rejects empty and whitespace-only names', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(clientNameProblem(name)).toBe('client_name must not be empty')
    }
  })

  test('rejects names longer than the 64-character cap', () => {
    const problem = clientNameProblem('a'.repeat(CLIENT_NAME_MAX_LENGTH + 1))
    expect(problem).toContain('at most 64')
  })

  test('cap counts code points: 33 emoji are 33 characters and pass', () => {
    // 33 astral emoji measure 66 UTF-16 code units but only 33 code points;
    // the cap is on characters (code points), so this name is accepted.
    expect(clientNameProblem('🤖'.repeat(33))).toBeNull()
  })

  test('rejects names past the cap even when they fit in UTF-16 units', () => {
    // 64 ASCII 'a' plus one trailing emoji is 65 code points (66 UTF-16 code
    // units) — over the cap despite measuring 66 units either way, proving
    // the count is by code point and nothing loosened past 64.
    const problem = clientNameProblem(`${'a'.repeat(CLIENT_NAME_MAX_LENGTH)}🤖`)
    expect(problem).toContain('at most 64')
  })

  test('rejects C0 and C1 control characters', () => {
    expect(clientNameProblem('acme\u0000')).toContain('control')
    expect(clientNameProblem('ac\u0001me')).toContain('control')
    expect(clientNameProblem('acme\u001F')).toContain('control')
    expect(clientNameProblem('ac\u0080me')).toContain('control')
    expect(clientNameProblem('acme\u009F')).toContain('control')
  })

  test('rejects bidi and invisible formatting characters', () => {
    for (const character of [
      '\u200B', // zero-width space
      '\u200E', // left-to-right mark
      '\u200F', // right-to-left mark
      '\u202A', // left-to-right embedding
      '\u202E', // right-to-left override
      '\u2066', // left-to-right isolate
      '\u2069', // pop directional isolate
      '\uFEFF', // zero-width no-break space / BOM
    ]) {
      const problem = clientNameProblem(`ac${character}me`)
      expect(problem).toContain('invisible formatting')
    }
  })

  test('the rejected boundary names name the offending code point', () => {
    expect(clientNameProblem('ac\u202Eme')).toContain('U+202E')
  })
})
