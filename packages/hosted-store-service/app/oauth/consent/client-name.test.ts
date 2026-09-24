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

  test('returns the registered name for a conforming unicode/emoji name', async () => {
    const auth = stubAuth(() => Promise.resolve({ name: 'Ünïcodé 🤖' }))
    expect(await registeredClientName('client-123', auth)).toBe('Ünïcodé 🤖')
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

  test('returns null for a stored name violating the client-name policy (AUT-399)', async () => {
    // Defense in depth: rows registered before the registration hook existed
    // must not render on the consent page either — they take the same
    // unnamed fallback to the raw client_id as a missing name.
    const cases = [
      'acme\u0000console', // control character
      'ac\u202Eme', // bidi override
      'ac\u200Bme', // zero-width space
      'a'.repeat(65), // over the 64-character cap
    ]
    for (const name of cases) {
      const auth = stubAuth(() => Promise.resolve({ name }))
      expect(await registeredClientName('client-123', auth)).toBeNull()
    }
  })

  test('returns null when resolving the auth context rejects, without throwing', async () => {
    const auth = { $context: Promise.reject(new Error('context unavailable')) }
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })
})
