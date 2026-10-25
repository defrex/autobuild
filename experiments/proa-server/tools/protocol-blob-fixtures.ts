/** Provider-owned whole Buffer PUT request oracle; no real provider credentials. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { VercelBlobStore } from '../../../packages/postgres-store/src/vercel'

const root = resolve(import.meta.dir, '../../..')
const fixturePath = resolve(import.meta.dir, '../fixtures/protocol-blob-provider.json')
const sources = [
  'packages/postgres-store/src/vercel.ts',
  'packages/postgres-store/src/s3.ts',
  'packages/postgres-store/node_modules/@vercel/blob/dist/index.js',
  'packages/postgres-store/node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js',
]
function hashes() {
  return Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(root, file)))
        .digest('hex'),
    ]),
  )
}
export function checkBlobProviderFixtures() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  assert.deepEqual(
    fixture.sources,
    hashes(),
    'Blob provider source hashes changed; regenerate SDK oracle',
  )
  return fixture as { cases: unknown[] }
}
export async function generateBlobProviderFixtures() {
  const cases: object[] = []
  let captured: object | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const headers: Record<string, string> = {}
      for (const key of [
        'authorization',
        'x-vercel-blob-store-id',
        'x-api-version',
        'x-vercel-blob-access',
        'x-add-random-suffix',
        'x-allow-overwrite',
        'x-api-blob-request-attempt',
      ])
        headers[key] = request.headers.get(key) ?? ''
      assert.match(request.headers.get('x-api-blob-request-id') ?? '', /^fixture:\d+:[a-f0-9]+$/)
      assert.equal(request.headers.get('x-content-length'), null)
      assert.equal(request.headers.get('content-type'), null)
      captured = {
        method: request.method,
        target: new URL(request.url).pathname + new URL(request.url).search,
        headers,
        body: [...new Uint8Array(await request.arrayBuffer())],
      }
      return Response.json({
        url: 'fixture',
        downloadUrl: 'fixture',
        pathname: 'fixture',
        contentType: 'fixture',
        contentDisposition: 'fixture',
        etag: 'fixture',
      })
    },
  })
  const overrideNames = [
    'VERCEL_BLOB_API_URL',
    'NEXT_PUBLIC_VERCEL_BLOB_API_URL',
    'VERCEL_BLOB_API_VERSION_OVERRIDE',
    'NEXT_PUBLIC_VERCEL_BLOB_API_VERSION_OVERRIDE',
    'VERCEL_BLOB_USE_X_CONTENT_LENGTH',
    'NEXT_PUBLIC_VERCEL_BLOB_USE_X_CONTENT_LENGTH',
    'VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API',
    'NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API',
  ]
  const original = new Map(overrideNames.map((name) => [name, process.env[name]]))
  for (const name of overrideNames) delete process.env[name]
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${server.port}`
  try {
    for (const auth of ['token', 'oidc'] as const)
      for (const access of ['public', 'private'] as const)
        for (const body of [[], [0, 255, 128, 10]]) {
          const prefix = '//a b///snow-雪/'
          const hash = '0123abcd'
          const store = new VercelBlobStore({
            access,
            prefix,
            ...(auth === 'token'
              ? { token: 'vercel_blob_rw_fixture_secret' }
              : {
                  oidcToken: '  fixture-oidc  ',
                  storeId: '  store_fixture  ',
                }),
          })
          await store.put(hash, new Uint8Array(body))
          assert.ok(captured)
          cases.push({
            id: `${auth}/${access}/${body.length}`,
            auth,
            access,
            prefix,
            hash,
            bytes: body,
            request: captured,
          })
        }
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await server.stop(true)
  }
  const formatted = Bun.spawnSync(
    [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', fixturePath],
    {
      stdin: Buffer.from(JSON.stringify({ sources: hashes(), sdk: '@vercel/blob@2.8.0', cases })),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (formatted.exitCode) throw new Error('Cannot format blob provider fixtures')
  await Bun.write(fixturePath, formatted.stdout)
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) await generateBlobProviderFixtures()
  else checkBlobProviderFixtures()
  console.log('Blob provider SDK fixtures fresh')
}
