import { expect, test } from 'bun:test'
import {
  classifyClient,
  supportedClientRange,
  compatibilityAdvice,
  clientIdentityError,
  stableVersion,
} from './compatibility'

test('release lines ignore patches and enforce both window boundaries', () => {
  const range = supportedClientRange('0.13.0')
  expect(range).toEqual({ minVersion: '0.11.0', maxVersionExclusive: '0.14.0' })
  for (const version of ['0.11.0', '0.11.999', '0.12.3', '0.13.999'])
    expect(classifyClient(version, range)).toBe('supported')
  expect(classifyClient('0.10.999', range)).toBe('older')
  expect(classifyClient('0.14.0', range)).toBe('newer')
  expect(compatibilityAdvice('0.14.0', '0.13.0', range)).toContain(
    'upgrade the service to at least 0.14.0',
  )
  expect(compatibilityAdvice('0.10.0', '0.13.0', range)).toContain(
    "upgrade the project's Autobuild",
  )
  for (const [client, service] of [
    ['0.11.3', '0.11.0'],
    ['0.11.0', '0.11.3'],
  ])
    expect(classifyClient(client, supportedClientRange(service))).toBe('supported')
})

test('major families clamp rather than inventing previous major lines', () => {
  expect(supportedClientRange('2.0.0')).toEqual({
    minVersion: '2.0.0',
    maxVersionExclusive: '2.1.0',
  })
  expect(supportedClientRange('2.1.0')).toEqual({
    minVersion: '2.0.0',
    maxVersionExclusive: '2.2.0',
  })
  expect(classifyClient('1.99.0', supportedClientRange('2.0.0'))).toBe('older')
  expect(supportedClientRange('0.100.0').minVersion).toBe('0.98.0')
})

test('identities are strict stable versions with known independent protocols', () => {
  for (const value of [
    null,
    '',
    'v0.11.0',
    '0.11',
    '0.11.0-rc.1',
    '0.11.0+build',
    '00.11.0',
    ' 0.11.0',
  ]) {
    expect(stableVersion(value)).toBeUndefined()
    expect(classifyClient(value, supportedClientRange())).toBe('invalid')
  }
  for (const value of ['0.9.0', '0.10.99', '0.11.999'])
    expect(clientIdentityError(value, '3')).toBeUndefined()
  for (const protocol of [null, '2', '4', '03'])
    expect(clientIdentityError('0.9.0', protocol)).toContain('version mismatch')
})
