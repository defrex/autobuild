import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sources, root, experiment } from './fixture-core'
import {
  releaseVersion,
  stableVersion,
  supportedClientRange,
  classifyClient,
  clientSupportsIntegrationAuditPending,
  compatibilityAdvice,
  clientIdentityError,
  RELEASE_LINE_PROTOCOLS,
} from '../../../packages/core/src/store/remote/compatibility'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { READ_CATALOG_IDENTITY } from '../../../packages/core/src/events/compatibility'

export const identityFixturePath = resolve(experiment, 'fixtures/protocol-identity.json')
export function protocolIdentityFixtures() {
  const sourceHashes = Object.fromEntries(
    Object.entries(sources()).filter(
      ([path]) =>
        path.startsWith('packages/core/src/events/') ||
        path.startsWith('packages/core/src/store/remote/') ||
        ['package.json', 'bun.lock', 'packages/core/package.json'].includes(path),
    ),
  )
  const generator = 'experiments/proa-server/tools/protocol-identity-fixtures.ts'
  sourceHashes[generator] = createHash('sha256')
    .update(readFileSync(resolve(root, generator)))
    .digest('hex')
  const versions = [
    null,
    '',
    '0.9.0',
    '0.12.3',
    '0.14.0',
    '0.15.999',
    AUTOBUILD_VERSION,
    '1.0.0-beta.0',
    '1.0.99-rc.a-1',
    '1.0.0-0',
    '1.0.0-a.1.Z-2',
    '1.0.0--',
    '1.0.0-900719925474099100000000000000',
    '2.0.0',
    '2.1.0-beta.0',
    '0.100.0',
    '9007199254740991.0.0',
    '9007199254740992.0.0',
    '1.0.9007199254740992',
    'v1.0.0',
    '1.0',
    '1.0.0+a',
    '1.0.0-beta+a',
    '1.0.0-01',
    '1.0.0-a..b',
    '1.0.0-',
    '01.0.0',
    ' 1.0.0',
    '1.0.0\n',
    '1.0.0-α',
    '1.0.0-a_b',
    `1.0.0-${'a'.repeat(250)}`,
    `1.0.0-${'a'.repeat(251)}`,
    // Exercise the unknown-value guards, not only HTTP header strings.
    100,
    {},
    false,
  ]
  const rangeServices = [
    ...new Set([
      AUTOBUILD_VERSION,
      '0.14.0',
      '0.15.0',
      '1.0.0-beta.1',
      '2.0.0',
      '2.1.0',
      '0.100.0',
    ]),
  ]
  const identityClients = [
    null,
    '',
    '0.12.0-beta.0',
    '0.13.0',
    '0.14.999',
    '0.15.0',
    AUTOBUILD_VERSION,
    '1.0.0-beta.1',
    '1.1.0-beta.0',
    '2.0.0',
    '2.1.0',
    'v1.0.0',
  ]
  return {
    format: 1,
    generator,
    sources: sourceHashes,
    service: {
      autobuildVersion: AUTOBUILD_VERSION,
      protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
      catalogIdentity: READ_CATALOG_IDENTITY,
      supportedClientRange: supportedClientRange(),
      releaseLineProtocols: RELEASE_LINE_PROTOCOLS,
    },
    health: {
      ok: true,
      autobuildVersion: AUTOBUILD_VERSION,
      protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
      supportedClientRange: supportedClientRange(),
    },
    versions: versions.map((input) => ({
      input,
      release: releaseVersion(input) !== undefined,
      stable: stableVersion(input) !== undefined,
      integrationAuditPending: clientSupportsIntegrationAuditPending(input),
    })),
    ranges: rangeServices.map((serviceVersion) => {
      const range = supportedClientRange(serviceVersion)
      return {
        serviceVersion,
        range,
        clients: versions.map((client) => ({
          client,
          classification: classifyClient(client, range),
          advice: compatibilityAdvice(client, serviceVersion, range) ?? null,
        })),
      }
    }),
    identities: rangeServices.flatMap((serviceVersion) =>
      identityClients.flatMap((client) =>
        [null, '3', '4', '5', '05'].map((protocol) => {
          const error =
            clientIdentityError(client, protocol, serviceVersion, REMOTE_STORE_PROTOCOL_VERSION) ??
            null
          return {
            client,
            protocol,
            serviceVersion,
            serviceProtocol: REMOTE_STORE_PROTOCOL_VERSION,
            error,
            status: error === null ? 200 : 409,
            body: error === null ? null : { kind: 'conflict', error },
          }
        }),
      ),
    ),
  }
}
export function identityFixtureBytes() {
  return `${JSON.stringify(protocolIdentityFixtures(), null, 2)}\n`
}

export function assertProtocolIdentityFixtures(bytes: string) {
  if (bytes !== identityFixtureBytes())
    throw new Error('Stale protocol identity fixtures; run bun tools/protocol-identity-generate.ts')
}
