import { describe, expect, test } from 'bun:test'
import { registeredClientName, type AuthContextLike } from './client-name'

function stubAuth(findOne: AuthContextLike['adapter']['findOne']) {
  return { $context: Promise.resolve({ adapter: { findOne } }) }
}

describe('registeredClientName', () => {
  test('returns the registered name for a named client', async () => {
    const auth = stubAuth(() => Promise.resolve({ name: 'Acme MCP Console' }))
    expect(await registeredClientName('client-123', auth)).toBe('Acme MCP Console')
  })

  test('returns null when no client record exists', async () => {
    const auth = stubAuth(() => Promise.resolve(null))
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })

  test('returns null for a blank name', async () => {
    for (const name of ['', '   ']) {
      const auth = stubAuth(() => Promise.resolve({ name }))
      expect(await registeredClientName('client-123', auth)).toBeNull()
    }
  })

  test('returns null when the adapter rejects, without throwing', async () => {
    const auth = stubAuth(() => Promise.reject(new Error('database down')))
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })

  test('returns null when resolving the auth context rejects, without throwing', async () => {
    const auth = { $context: Promise.reject(new Error('context unavailable')) }
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })
})
