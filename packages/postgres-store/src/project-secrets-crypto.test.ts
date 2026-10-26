import { expect, test } from 'bun:test'
import { SecretCipher } from './project-secrets-crypto'
const key = Buffer.alloc(32, 1).toString('base64')
test('authenticated encryption is randomized, context-bound and safe on failure', () => {
  const cipher = new SecretCipher(key),
    value = { value: 'marker-secret' }
  const encrypted = cipher.encrypt('project/name/static/1', value)
  expect(cipher.decrypt('project/name/static/1', encrypted)).toEqual(value)
  expect(cipher.encrypt('project/name/static/1', value)).not.toBe(encrypted)
  expect(encrypted).not.toContain('marker-secret')
  for (const context of ['other/name/static/1', 'project/other/static/1', 'project/name/refresh/1'])
    expect(() => cipher.decrypt(context, encrypted)).toThrow('key-unavailable')
  const bytes = Buffer.from(encrypted, 'base64')
  bytes[15] = bytes[15]! ^ 1
  expect(() => cipher.decrypt('project/name/static/1', bytes.toString('base64'))).toThrow(
    'key-unavailable',
  )
  expect(() =>
    new SecretCipher(Buffer.alloc(32, 2).toString('base64')).decrypt(
      'project/name/static/1',
      encrypted,
    ),
  ).toThrow('key-unavailable')
  for (const raw of [undefined, '', 'wrong', Buffer.alloc(31).toString('base64')])
    expect(() => new SecretCipher(raw)).toThrow('key-unavailable')
  expect(cipher.fingerprint(value)).toBe(cipher.fingerprint(value))
  expect(cipher.fingerprint(value)).not.toBe(
    new SecretCipher(Buffer.alloc(32, 2).toString('base64')).fingerprint(value),
  )
})
