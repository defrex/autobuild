import { expect, test } from 'bun:test'
import { paintTone } from './tone-ansi'

test('each shared tone paints its terminal color, and nothing when off', () => {
  expect(
    (['ok', 'live', 'held', 'alert', 'pending'] as const).map((tone) => paintTone('X', tone, true)),
  ).toEqual([
    '\x1b[32mX\x1b[0m',
    '\x1b[36mX\x1b[0m',
    '\x1b[33mX\x1b[0m',
    '\x1b[31mX\x1b[0m',
    '\x1b[2mX\x1b[0m',
  ])
  expect(paintTone('X', 'ok', false)).toBe('X')
})
