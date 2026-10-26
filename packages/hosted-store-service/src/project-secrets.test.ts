import { expect, test } from 'bun:test'
import { projectSecretsHandler } from './project-secrets'
import { createMachineAuth } from './machine-auth'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
const repo = 'https://github.com/acme/project',
  token = 'abp_owner'
const headers = {
  authorization: `Bearer ${token}`,
  [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
}
test('real purpose guard and fresh membership gate writes before reading values', async () => {
  let purpose: 'project-owner' | 'dispatcher' = 'project-owner',
    member = true,
    revoked = false,
    value = '',
    sets = 0
  const auth = createMachineAuth({
    secret: 'signing',
    projects: { has: async () => true, list: async () => [] },
    credentials: {
      authenticate: async (t) =>
        t === token && !revoked
          ? {
              id: 'id',
              repo,
              createdAt: new Date().toISOString(),
              createdBy: 'member',
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: null,
              purpose,
            }
          : null,
    },
  })
  const handler = projectSecretsHandler({
    auth: () => auth,
    canAccess: async () => member,
    store: async () => ({
      set: async (_r, _n, v, actor) => {
        expect(actor).toBe('member')
        sets++
        value = v
      },
      remove: async () => {
        value = ''
      },
      list: async () => [
        {
          name: 'KIMI_API_KEY',
          kind: 'static',
          owner: 'member',
          setAt: new Date().toISOString(),
          fingerprint: 'a'.repeat(16),
          status: 'ready',
          failureCode: null,
          lastSuppliedAt: null,
        },
      ],
    }),
  })
  const set = () =>
    handler(
      new Request('https://service/secrets/v1/set', {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, repo, name: 'KIMI_API_KEY', value: 'sentinel-secret' }),
      }),
    )
  let response = await set()
  expect(response.status).toBe(200)
  expect(await response.text()).not.toContain('sentinel-secret')
  expect(value).toBe('sentinel-secret')
  response = await handler(
    new Request(`https://service/secrets/v1/list?repo=${encodeURIComponent(repo)}`, { headers }),
  )
  expect(await response.text()).not.toContain('sentinel-secret')
  purpose = 'dispatcher'
  expect((await set()).status).toBe(403)
  purpose = 'project-owner'
  member = false
  expect((await set()).status).toBe(403)
  member = true
  revoked = true
  expect((await set()).status).toBe(401)
  expect(sets).toBe(1)
})
