import { AUTOBUILD_VERSION, REMOTE_STORE_PROTOCOL_VERSION } from './version'
import { expect, test } from 'bun:test'
import {
  clientSupportsIntegrationAuditPending,
  classifyClient,
  supportedClientRange,
  compatibilityAdvice,
  clientIdentityError,
  stableVersion,
  releaseVersion,
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

test('identities reject noncanonical versions and enforce independent protocols', () => {
  for (const value of [null, '', 'v0.11.0', '0.11', '0.11.0+build', '00.11.0', ' 0.11.0']) {
    expect(stableVersion(value)).toBeUndefined()
    expect(classifyClient(value, supportedClientRange())).toBe('invalid')
  }
  const oldest = supportedClientRange().minVersion
  for (const value of [
    oldest,
    `${releaseVersion(AUTOBUILD_VERSION)!.major}.${releaseVersion(AUTOBUILD_VERSION)!.minor}.999`,
  ])
    expect(
      clientIdentityError(
        value,
        releaseVersion(value)!.minor === releaseVersion(AUTOBUILD_VERSION)!.minor
          ? REMOTE_STORE_PROTOCOL_VERSION
          : RELEASE_LINE_PROTOCOLS[oldest.split('.').slice(0, 2).join('.')]!,
      ),
    ).toBeUndefined()
  for (const protocol of [null, '2', '3', '04'])
    expect(clientIdentityError(AUTOBUILD_VERSION, protocol)).toContain('version mismatch')
})

// Exercise negotiation, rather than just range arithmetic, against the actual
// distribution and a synthetic next release before package.json is bumped.
const installed = releaseVersion(AUTOBUILD_VERSION)!
const nextMinor = `${installed.major}.${installed.minor + 1}.0`
for (const serviceVersion of [AUTOBUILD_VERSION, nextMinor, '2.0.0']) {
  test(`recorded lines negotiate and unknown lines fail closed for service ${serviceVersion}`, () => {
    const range = supportedClientRange(serviceVersion)
    const first = stableVersion(range.minVersion)!
    const end = stableVersion(range.maxVersionExclusive)!
    for (let minor = first.minor; minor < end.minor; minor++) {
      const line = `${first.major}.${minor}`
      const protocol =
        minor === end.minor - 1 ? REMOTE_STORE_PROTOCOL_VERSION : RELEASE_LINE_PROTOCOLS[line]
      for (const patch of [0, 999]) {
        const error = clientIdentityError(`${line}.${patch}`, protocol ?? null, serviceVersion)
        if (protocol === undefined) expect(error).toContain('unsupported protocol identity')
        else expect(error).toBeUndefined()
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

test('a 1.2 service retains the published 1.0 protocol-4 and 1.1 protocol-6 clients', () => {
  expect(RELEASE_LINE_PROTOCOLS['1.1']).toBe('6')
  for (const [client, protocol] of [
    ['1.0.0', '4'],
    ['1.0.999', '4'],
    ['1.1.0', '6'],
    ['1.1.999', '6'],
  ] as const) {
    expect(clientIdentityError(client, protocol, '1.2.0', '6')).toBeUndefined()
    expect(clientIdentityError(client, '5', '1.2.0', '6')).toContain(
      'unsupported protocol identity',
    )
  }
})

test('a later service retains the published 0.14 protocol-4 identity', () => {
  expect(RELEASE_LINE_PROTOCOLS['0.14']).toBe('4')
  for (const client of ['0.14.0', '0.14.999']) {
    expect(clientIdentityError(client, '4', '0.15.0', '4')).toBeUndefined()
    expect(clientIdentityError(client, '3', '0.15.0', '4')).toContain(
      'unsupported protocol identity',
    )
  }
})

test('canonical prereleases share stable release lines and independent protocol gates', () => {
  const range = supportedClientRange('1.0.0-beta.1')
  expect(range).toEqual(supportedClientRange('1.0.0'))
  for (const client of [
    '1.0.0-beta.0',
    '1.0.0-beta.1',
    '1.0.0',
    '1.0.99-rc.a-1',
    '1.0.0-0',
    '1.0.0-alpha',
    '1.0.0-a.1.Z-2',
  ]) {
    expect(releaseVersion(client)).toBeDefined()
    expect(stableVersion(client)?.version).toBe(client.includes('-') ? undefined : client)
    expect(
      clientIdentityError(client, REMOTE_STORE_PROTOCOL_VERSION, '1.0.0-beta.1'),
    ).toBeUndefined()
    expect(clientIdentityError(client, '3', '1.0.0-beta.1')).toContain('unsupported protocol')
    expect(classifyClient(client, supportedClientRange('1.0.0'))).toBe('supported')
  }
  for (const client of ['0.14.0', '1.1.0-beta.0']) {
    expect(compatibilityAdvice(client, '1.0.0-beta.1', range)).toBe(
      compatibilityAdvice(client, '1.0.0', range)?.replace(
        'service Autobuild 1.0.0 ',
        'service Autobuild 1.0.0-beta.1 ',
      ),
    )
  }
  expect(compatibilityAdvice('1.1.0-beta.0', '1.0.0', range)).toContain('service first')
  expect(clientIdentityError('0.12.0-beta.0', '3', '0.14.0')).toBeUndefined()
  expect(clientIdentityError('0.12.0-beta.0', '4', '0.14.0')).toContain('unsupported protocol')
  expect(clientIdentityError('2.0.0-beta.0', '4', '2.1.0')).toContain('unsupported protocol')
  for (const value of [
    '1.0.0-',
    '1.0.0-a..b',
    '1.0.0-01',
    '1.0.0+a',
    '1.0.0-beta+a',
    'v1.0.0',
    ' 1.0.0',
    '1.0.0\n',
    '01.0.0',
  ]) {
    expect(releaseVersion(value)).toBeUndefined()
    expect(classifyClient(value, range)).toBe('invalid')
  }
})

test('audit capability follows its introduction line independently of admission', () => {
  for (const version of [
    '0.14.0',
    '0.14.999',
    '0.14.0-beta.0',
    '0.15.0',
    '1.0.0-beta.0',
    '1.0.0',
    AUTOBUILD_VERSION,
    '1.99.0',
    '2.0.0',
  ])
    expect(clientSupportsIntegrationAuditPending(version)).toBe(true)
  for (const version of [
    '0.0.0',
    '0.12.0',
    '0.13.999',
    null,
    undefined,
    '',
    'v1.0.0',
    '1.0',
    '1.0.0+build',
    '01.0.0',
    '1.0.0-01',
    ' 1.0.0',
  ])
    expect(clientSupportsIntegrationAuditPending(version)).toBe(false)
  expect(clientIdentityError('0.13.0', '3', '0.14.0', '4')).toBeUndefined()
  expect(clientSupportsIntegrationAuditPending('0.13.0')).toBe(false)
})

test('operator presence protocol rejects peers without the new required operations', () => {
  expect(REMOTE_STORE_PROTOCOL_VERSION).toBe('6')
  expect(clientIdentityError(AUTOBUILD_VERSION, '4')).toContain('unsupported protocol identity')
  expect(clientIdentityError(AUTOBUILD_VERSION, '5')).toContain('unsupported protocol identity')
  expect(clientIdentityError(AUTOBUILD_VERSION, '6')).toBeUndefined()
})

test('next minor withdrawal protocol retains published 1.0 protocol 4 only', () => {
  for (const version of ['1.0.0', '1.0.1']) {
    expect(clientIdentityError(version, '4', '1.1.0', '6')).toBeUndefined()
    for (const protocol of ['5', '6'])
      expect(clientIdentityError(version, protocol, '1.1.0', '6')).toContain(
        'unsupported protocol identity',
      )
  }
  expect(clientIdentityError('1.1.0', '6', '1.1.0', '6')).toBeUndefined()
  expect(clientIdentityError('1.1.0', '6', '1.0.1', '4')).toContain('upgrade the service')
})

test('supported peer admission does not make advisory polling facts decisive', async () => {
  const { buildEventPolicy } = await import('../../events/policy')
  const { initialCompatibility, advanceCompatibility, decodeStoredEvent } = await import(
    '../../events/compatibility'
  )
  const { newerFact } = await import('../../testing/newer-writer')
  const { mixedVersionDeferred } = await import('../../kernel/mixed-version')
  expect(clientIdentityError('1.0.1', '4', '1.1.0', '6')).toBeUndefined()
  const classification = buildEventPolicy['node.poll-checked']
  expect(classification).toBe('advisory')
  const opaque = { ...newerFact(1, classification), type: 'old-reader-unknown.node.poll-checked' }
  expect(decodeStoredEvent(opaque)).toBeNull()
  const compatibility = initialCompatibility()
  advanceCompatibility(compatibility, [opaque])
  expect(mixedVersionDeferred({ compatibility })).toBe(false)
  advanceCompatibility(compatibility, [newerFact(2, 'decisive')])
  expect(mixedVersionDeferred({ compatibility })).toBe(true)
})
