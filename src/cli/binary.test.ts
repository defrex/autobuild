import { describe, expect, test } from 'bun:test'
import { usesGenericSessionlessSigintHandler } from './binary'

describe('sessionless SIGINT ownership', () => {
  test('upgrade retains process-default SIGINT while other sessionless commands use cancellation', () => {
    expect(usesGenericSessionlessSigintHandler('upgrade')).toBe(false)
    for (const command of ['init', 'dispatch', 'ticket', 'builds', undefined]) {
      expect(usesGenericSessionlessSigintHandler(command)).toBe(true)
    }
  })
})
