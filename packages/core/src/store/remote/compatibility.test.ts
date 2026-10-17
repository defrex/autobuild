import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'
import { expect, test } from 'bun:test'
import {
  classifyClient,
  supportedClientRange,
  compatibilityAdvice,
  clientIdentityError,
  stableVersion,
  RELEASE_LINE_PROTOCOLS,
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
  const oldest = supportedClientRange().minVersion
  for (const value of [oldest, AUTOBUILD_VERSION.replace(/\.\d+$/, '.999')])
    expect(
      clientIdentityError(
        value,
        value === oldest ? RELEASE_LINE_PROTOCOLS[oldest.split('.').slice(0, 2).join('.')]! : '4',
      ),
    ).toBeUndefined()
  for (const protocol of [null, '2', '3', '04'])
    expect(clientIdentityError(AUTOBUILD_VERSION, protocol)).toContain('version mismatch')
})

// Exercise negotiation, rather than just range arithmetic, against the actual
// distribution and a synthetic next release before package.json is bumped.
const installed = stableVersion(AUTOBUILD_VERSION)!
const nextMinor = `${installed.major}.${installed.minor + 1}.0`
for (const serviceVersion of [AUTOBUILD_VERSION, nextMinor, '2.0.0']) {
  test(`every advertised line has a protocol identity for service ${serviceVersion}`, () => {
    const range = supportedClientRange(serviceVersion)
    const first = stableVersion(range.minVersion)!
    const end = stableVersion(range.maxVersionExclusive)!
    for (let minor = first.minor; minor < end.minor; minor++) {
      const line = `${first.major}.${minor}`
      const protocol =
        minor === end.minor - 1 ? REMOTE_STORE_PROTOCOL_VERSION : RELEASE_LINE_PROTOCOLS[line]
      expect(protocol).toBeDefined()
      for (const patch of [0, 999]) {
        expect(
          clientIdentityError(`${line}.${patch}`, protocol ?? null, serviceVersion),
        ).toBeUndefined()
      }
    }
  })
}

test('the own-line protocol comes from service identity, including new major/minor lines', () => {
  for (const serviceVersion of ['0.11.0', '0.12.0', '2.0.0']) {
    const service = stableVersion(serviceVersion)!
    const client = `${service.major}.${service.minor}.999`
    expect(clientIdentityError(client, '4', serviceVersion, '4')).toBeUndefined()
    expect(clientIdentityError(client, '3', serviceVersion, '4')).toContain(
      'unsupported protocol identity',
    )
  }
  // A new current protocol does not overwrite historical identities.
  expect(clientIdentityError('0.10.0', '3', '0.12.0', '4')).toBeUndefined()
  expect(clientIdentityError('0.10.0', '4', '0.12.0', '4')).toContain(
    'unsupported protocol identity',
  )
  // Unknown historical lines remain closed, rather than inheriting a guessed identity.
  expect(clientIdentityError('2.0.0', '4', '2.1.0', '4')).toContain('unsupported protocol identity')
})

test('a protocol-4 service on 0.14 retains the published 0.13 protocol-3 clients', () => {
  expect(RELEASE_LINE_PROTOCOLS['0.13']).toBe('3')
  for (const client of ['0.12.0', '0.13.0', '0.13.999']) {
    expect(clientIdentityError(client, '3', '0.14.0', '4')).toBeUndefined()
    expect(clientIdentityError(client, '4', '0.14.0', '4')).toContain(
      'unsupported protocol identity',
    )
  }
  expect(clientIdentityError('0.14.0', '4', '0.14.0', '4')).toBeUndefined()
})

test('the 0.14 historical line retains protocol 4 when a newer service changes protocol', () => {
  expect(RELEASE_LINE_PROTOCOLS['0.14']).toBe('4')
  for (const client of ['0.14.0', '0.14.999']) {
    expect(clientIdentityError(client, '4', '0.15.0', '5')).toBeUndefined()
    for (const protocol of ['3', '5'])
      expect(clientIdentityError(client, protocol, '0.15.0', '5')).toContain(
        'unsupported protocol identity',
      )
  }
})
