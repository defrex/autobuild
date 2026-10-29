import assert from 'node:assert/strict'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  mintToken,
} from '@defrex/autobuild/remote-store'
import { createHostedStoreService } from '../service'
import { ticketProject } from './ticket-project'

assert.equal(AUTOBUILD_VERSION, '1.4.0-beta.1')
const repo = 'https://github.com/acme/widgets'
const secret = 'beta-secret'
const project = await ticketProject(repo, secret)
const source = new FakeTicketSource()
const ticket = await source.create({ title: 'Beta ticket', body: 'Body' })
const service = createHostedStoreService({
  ...project,
  env: {
    AB_STORE_SECRET: secret,
    AB_POSTGRES_URL: 'postgres://unused/test',
    AB_BLOB_BACKEND: 's3',
    AB_S3_BUCKET: 'unused',
    AB_S3_REGION: 'us-east-1',
    AB_S3_ACCESS_KEY_ID: 'unused',
    AB_S3_SECRET_ACCESS_KEY: 'unused',
  },
  sourceFor: () => source,
})
const health = await service.fetch(new Request('http://test/health'))
assert.equal(health.status, 200)
assert.deepEqual(await health.json(), {
  ok: true,
  autobuildVersion: AUTOBUILD_VERSION,
  protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
  supportedClientRange: { minVersion: '1.2.0', maxVersionExclusive: '1.5.0' },
})
const owner = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'Beta owner' },
  exp: Date.now() + 60_000,
})
for (const version of ['1.4.0-beta.0', '1.4.0-beta.1', '1.4.0', '1.1.0', 'wrong-protocol']) {
  const accepted = version.startsWith('1.4.')
  for (const route of ['store', 'ticket', 'operator']) {
    const headers = {
      authorization: `Bearer ${route === 'ticket' ? project.token : owner}`,
      [AUTOBUILD_VERSION_HEADER]: version === 'wrong-protocol' ? '1.4.0-beta.0' : version,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]:
        version === 'wrong-protocol' ? 'wrong' : REMOTE_STORE_PROTOCOL_VERSION,
      'content-type': 'application/json',
    }
    const path =
      route === 'store'
        ? '/builds'
        : route === 'ticket'
          ? '/tickets/get'
          : `/operator/v1/repos/${encodeURIComponent(repo)}/sessions`
    const response = await service.fetch(
      new Request(`http://test${path}`, {
        headers,
        ...(route === 'ticket'
          ? {
              method: 'POST',
              body: JSON.stringify({
                context: { teamKey: 'ENG', repo },
                input: { id: ticket.ref.id },
              }),
            }
          : {}),
      }),
    )
    const body = await response.json()
    assert.equal(response.status, accepted ? 200 : 409, JSON.stringify({ route, version, body }))
    if (accepted && route === 'ticket')
      assert.ok(JSON.stringify(body).includes('Beta ticket'), JSON.stringify(body))
  }
}
console.log('beta service verified')
