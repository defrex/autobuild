import { describe, expect, test } from 'bun:test'
import { admittedUser } from './auth'

describe('GitHub identity admission', () => {
  test('accepts and normalizes an allowed current provider email', () => {
    expect(
      admittedUser(new Set(['ada@example.com']), { email: ' Ada@Example.COM ', name: 'Ada' }),
    ).toEqual({
      data: { email: 'ada@example.com', name: 'Ada' },
    })
  })

  test('refuses an identity before user or session creation', () => {
    expect(admittedUser(new Set(['ada@example.com']), { email: 'mallory@example.com' })).toBe(false)
  })
})
