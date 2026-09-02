import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { abDispatch } from '../../core/src/cli/dispatch'
import { spawnExec } from '../../core/src/ports/workspace/git-worktree'
import { RemoteBuildStore, mintToken } from 'autobuild/remote-store'
import {
  happyHandlers,
  makeHarness,
  readyTicket,
  typesOf,
  type E2eHarness,
} from '../../core/src/integration/harness'
import { createHostedStoreService } from './service'

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

test('AB_STORE/AB_TOKEN drive dispatch and every phase through the hosted service', async () => {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = []
  let serviceUrl = ''
  let serviceToken = ''
  const h = await makeHarness({
    handlers: happyHandlers(),
    tickets: [readyTicket('T-1')],
    storeAdapter: async (backing) => {
      const secret = 'integration-signing-secret'
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: secret,
          AB_POSTGRES_URL: 'postgres://injected/test',
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'injected',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'injected',
          AB_S3_SECRET_ACCESS_KEY: 'injected',
        },
        openStore: async () => backing,
      })
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.headers.get('authorization'),
          })
          return service.fetch(request)
        },
      })
      serviceUrl = `http://127.0.0.1:${server.port}`
      serviceToken = mintToken(secret, {
        build: '*',
        session: '*',
        exp: Date.now() + 60 * 60 * 1000,
      })
      return {
        store: new RemoteBuildStore({ url: serviceUrl, token: serviceToken }),
        storeRef: serviceUrl,
        token: serviceToken,
        cleanup: async () => server.stop(true),
      }
    },
  })
  harnesses.push(h)

  const { store: _store, storeRef: _storeRef, token: _token, ...ports } = h.wiring
  const dispatch = () =>
    abDispatch({
      targetRepo: h.origin,
      env: { AB_STORE: serviceUrl, AB_TOKEN: serviceToken },
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      plain: true,
      nonStoreWire: () => ports,
    })
  await dispatch()

  const events = await h.events('add-rate-limiting')
  expect(typesOf(events)).toContain('finalize.completed')
  expect(h.cliErrors).toEqual([])
  expect(requests.some((entry) => entry.method === 'POST' && entry.path.endsWith('/events'))).toBe(
    true,
  )
  expect(
    requests.some((entry) => entry.method === 'POST' && entry.path.endsWith('/artifacts')),
  ).toBe(true)
  expect(
    requests
      .filter((entry) => entry.path !== '/health')
      .every((entry) => entry.authorization === `Bearer ${serviceToken}`),
  ).toBe(true)
  expect(existsSync(join(h.origin, '.autobuild'))).toBe(false)
})
