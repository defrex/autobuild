import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { MemoryBuildStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
const repo = 'https://github.com/acme/a',
  foreign = 'https://github.com/acme/b'
const cases: unknown[] = []
const paths = [
  '/builds',
  '/repos',
  ...['own', 'other', 'foreign', 'absent'].flatMap((id) => [
    `/builds/${id}/events`,
    `/builds/${id}/node-writer/claim`,
    `/builds/${id}/artifacts`,
    `/builds/${id}/lease/claim`,
  ]),
  `/repos/${encodeURIComponent(repo)}/events`,
  `/repos/${encodeURIComponent(repo)}/events/conditional`,
  `/repos/${encodeURIComponent(repo)}/deposits`,
  `/repos/${encodeURIComponent(repo)}/artifacts`,
  `/repos/${encodeURIComponent(repo)}/streams`,
  `/repos/${encodeURIComponent(repo)}/lease/claim`,
  `/repos/${encodeURIComponent(repo)}/lease/heartbeat`,
  `/repos/${encodeURIComponent(repo)}/lease/release`,
  `/repos/${encodeURIComponent(repo)}/operator-presence`,
  `/sessions/absent/events`,
  `/streams/absent/chunks`,
]
for (const kind of ['build-runner', 'build-phase', 'harvest-runner', 'harvest-phase'] as const)
  for (const path of paths)
    for (const raw of [
      '{}',
      '{',
      'null',
      '[]',
      JSON.stringify({ actor: { kind: 'kernel' }, type: 7, payload: { run: 'run' } }),
      JSON.stringify({
        event: {
          actor: { kind: 'kernel' },
          type: 'harvest.future-unknown',
          payload: { run: 'run' },
        },
      }),
      JSON.stringify({
        event: {
          actor: { kind: 'kernel' },
          type: 'harvest.future-unknown',
          payload: { run: 'run' },
        },
        artifacts: [null],
      }),
      JSON.stringify({
        actor: { kind: 'agent', session: 'other' },
        type: 'harvest.future-unknown',
        payload: { run: 'run' },
      }),
      JSON.stringify({
        actor: { kind: 'human', user: 'operator', via: { kind: 'session', id: 'claimed' } },
        type: 'harvest.future-unknown',
        payload: { run: 'run' },
      }),
      JSON.stringify({
        actor: { kind: 'human', user: 'operator' },
        type: 'harvest.future-unknown',
        payload: { run: 'other' },
      }),
    ]) {
      const store = new MemoryBuildStore({ clock: () => new Date('2026-01-01T00:00:00Z') })
      for (const [slug, r] of [
        ['own', repo],
        ['other', repo],
        ['foreign', foreign],
      ]) {
        await store.createBuild(sampleBuildInput(slug!, { repo: r! }))
        await store.append(slug!, sampleEventWrite())
      }
      await store.ensureRepo(repo)
      const delegation = {
        kind,
        repo,
        id: kind.startsWith('build') ? 'own' : 'run',
        anchor: 1,
        ...(kind.endsWith('phase') ? { session: 'session' } : {}),
        ...(kind.startsWith('harvest')
          ? {
              execution: 'execution',
              ...(kind.endsWith('runner') ? { leaseHolder: 'holder' } : {}),
            }
          : {}),
      }
      const server = createStoreServer({
        store,
        auth: {
          authenticate: async () => ({ kind: 'delegated', repo, user: 'delegated', delegation }),
        },
      })
      const request = new Request(`http://store${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer injected',
          'content-type': 'application/json',
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        body: raw,
      })
      const response = await server.fetch(request)
      cases.push({
        kind,
        delegation,
        path,
        method: 'POST',
        raw,
        status: response.status,
        body: await response.json(),
      })
    }
// Presence is a separate operator boundary for every delegated kind, before
// lookup or mutation. POST keeps the source's generic mutation gate (and
// harvest malformed-JSON precedence); only GET reaches its presence refusal.
for (const kind of ['build-runner', 'build-phase', 'harvest-runner', 'harvest-phase'] as const) {
  const store = new MemoryBuildStore()
  let accesses = 0
  store.listOperatorPresence = async () => {
    accesses++
    throw new Error('presence lookup reached')
  }
  store.upsertOperatorPresence = async () => {
    accesses++
    throw new Error('presence mutation reached')
  }
  const delegation = {
    kind,
    repo,
    id: kind.startsWith('build') ? 'own' : 'run',
    anchor: 1,
    ...(kind.endsWith('phase') ? { session: 'session' } : {}),
    ...(kind.startsWith('harvest')
      ? { execution: 'execution', ...(kind.endsWith('runner') ? { leaseHolder: 'holder' } : {}) }
      : {}),
  }
  const server = createStoreServer({
    store,
    auth: {
      authenticate: async () => ({ kind: 'delegated', repo, user: 'delegated', delegation }),
    },
  })
  for (const [method, raw] of [
    ['GET', ''],
    ['POST', '{'],
    [
      'POST',
      JSON.stringify({
        id: 'operator',
        host: 'private-host',
        pid: 42,
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    ],
  ] as const) {
    const path = `/repos/${encodeURIComponent(repo)}/operator-presence`
    const response = await server.fetch(
      new Request(`http://store${path}`, {
        method,
        headers: {
          authorization: 'Bearer injected',
          'content-type': 'application/json',
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
        ...(method === 'GET' ? {} : { body: raw }),
      }),
    )
    const body = await response.json()
    if (method === 'GET') {
      assert.equal(response.status, 403)
      assert.deepEqual(body, {
        kind: 'auth',
        error: 'operator presence requires repository operator authority',
      })
    } else if (kind.startsWith('build')) {
      assert.equal(response.status, 403)
      assert.deepEqual(body, { kind: 'auth', error: 'write outside delegated resource' })
    } else if (raw !== '{') {
      assert.equal(response.status, 403)
      assert.deepEqual(body, { kind: 'auth', error: 'write outside delegated harvest run' })
    } else {
      assert.equal(response.status, 500)
      assert.equal(body.kind, 'internal')
      assert.match(body.error, /^JSON Parse error:/)
    }
    assert.equal(accesses, 0, 'delegated presence must not touch the store')
    cases.push({ kind, delegation, path, method, raw, status: response.status, body })
  }
}
const output = new URL('../fixtures/protocol-delegation-authority.json', import.meta.url)
const format = Bun.spawnSync(
  [
    resolve(import.meta.dir, '../../../node_modules/.bin/biome'),
    'format',
    '--stdin-file-path',
    output.pathname,
  ],
  { stdin: Buffer.from(JSON.stringify(cases, null, 2)) },
)
if (format.exitCode !== 0) throw new Error(format.stderr.toString())
const encoded = format.stdout.toString()
if (process.argv.includes('--generate')) await Bun.write(output, encoded)
else if ((await Bun.file(output).text()) !== encoded)
  throw new Error('Delegation fixture drift; regenerate protocol-delegation-authority-fixtures.ts')
console.log(`${cases.length} actual TS delegation comparisons fresh`)
