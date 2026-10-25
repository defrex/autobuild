import { expect, test } from 'bun:test'
import {
  assertProtocolIdentityFixtures,
  identityFixturePath,
  protocolIdentityFixtures,
} from './protocol-identity-fixtures'

test('identity fixture is reproducible and rejects changed oracle bytes', async () => {
  const bytes = await Bun.file(identityFixturePath).text()
  assertProtocolIdentityFixtures(bytes)
  const changed = JSON.parse(bytes)
  changed.service.protocolVersion = 'invented'
  expect(() => assertProtocolIdentityFixtures(`${JSON.stringify(changed, null, 2)}\n`)).toThrow(
    'Stale protocol identity',
  )
  changed.service.protocolVersion = JSON.parse(bytes).service.protocolVersion
  changed.sources['package.json'] = 'stale'
  expect(() => assertProtocolIdentityFixtures(`${JSON.stringify(changed, null, 2)}\n`)).toThrow(
    'Stale protocol identity',
  )
})

test('identity oracles include admitted prereleases and refused unknown historical protocols', () => {
  const corpus = protocolIdentityFixtures()
  expect(
    corpus.identities.some(
      (row) =>
        row.client === '1.0.0-beta.1' &&
        row.serviceVersion === '1.0.0-beta.1' &&
        row.error === null,
    ),
  ).toBe(true)
  expect(
    corpus.identities.some(
      (row) =>
        row.client === '2.0.0' &&
        row.serviceVersion === '2.1.0' &&
        row.error?.includes('unsupported protocol identity'),
    ),
  ).toBe(true)
  expect(
    corpus.identities.some(
      (row) =>
        row.client === '0.14.999' &&
        row.serviceVersion === '0.15.0' &&
        row.protocol === '4' &&
        row.error === null,
    ),
  ).toBe(true)
})

test('TypeScript health oracle is public and does not touch a backend', async () => {
  const { createStoreServer } = await import(
    '../../../packages/hosted-store-service/src/remote-store-server'
  )
  type BuildStore = import('../../../packages/core/src/store/types').BuildStore
  const inaccessible = new Proxy({} as BuildStore, {
    get() {
      throw new Error('health touched the backend')
    },
  })
  const server = createStoreServer({ store: inaccessible })
  const response = await server.fetch(new Request('http://127.0.0.1/health'))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(response.headers.get('x-autobuild-version')).toBeNull()
  expect(response.headers.get('x-autobuild-protocol-version')).toBeNull()
  expect(response.headers.get('x-autobuild-catalog-identity')).toBeNull()
  expect(await response.json()).toEqual(protocolIdentityFixtures().health)
})
