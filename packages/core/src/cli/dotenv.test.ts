import { describe, expect, test } from 'bun:test'
import { parseDotEnv } from './dotenv'

describe('parseDotEnv', () => {
  test('parses KEY=VALUE lines', () => {
    expect(parseDotEnv('LINEAR_API_KEY=lin_api_abc\nFOO=bar\n')).toEqual({
      LINEAR_API_KEY: 'lin_api_abc',
      FOO: 'bar',
    })
  })

  test('skips blank lines and # comments', () => {
    expect(parseDotEnv('# secrets\n\nFOO=bar\n  # trailing comment line\n')).toEqual({
      FOO: 'bar',
    })
  })

  test('trims whitespace around keys and values', () => {
    expect(parseDotEnv('  FOO =  bar  \n')).toEqual({ FOO: 'bar' })
  })

  test('strips matching single or double quotes around the value', () => {
    expect(parseDotEnv('A="quoted value"\nB=\'single\'\n')).toEqual({
      A: 'quoted value',
      B: 'single',
    })
  })

  test('leaves unmatched quotes alone', () => {
    expect(parseDotEnv('A="dangling\n')).toEqual({ A: '"dangling' })
  })

  test('accepts an `export ` prefix', () => {
    expect(parseDotEnv('export FOO=bar\n')).toEqual({ FOO: 'bar' })
  })

  test('keeps = characters inside the value', () => {
    expect(parseDotEnv('A=b=c\n')).toEqual({ A: 'b=c' })
  })

  test('skips malformed lines: no =, invalid key names', () => {
    expect(parseDotEnv('not a var line\n1BAD=x\nGOOD=y\n')).toEqual({ GOOD: 'y' })
  })

  test('an empty value is kept as an empty string', () => {
    expect(parseDotEnv('EMPTY=\n')).toEqual({ EMPTY: '' })
  })
})
