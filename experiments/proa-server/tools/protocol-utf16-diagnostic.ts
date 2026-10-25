/** Isolated public HTTP witness; raw issued credentials never leave memory. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { mkdir, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
export async function diagnoseProtocolUtf16(executable: string) {
  const cases: unknown[] = []
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const secret = 'isolated-utf16-fake-secret',
        clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      const repo = (await projects.add('https://github.com/proa/utf16-proof', 'proof')).repo,
        owner = await credentials.issue(repo, 'proof')
      const server = await startProtocolServer({
        executable,
        env: { ...env, PROA_TEST_AUTH: 'project', PROA_TEST_SECRET: secret },
        clock,
      })
      const oracle = createStoreServer({
        store: ts,
        clock,
        secret,
        auth: createMachineAuth({ secret, credentials, projects, store: ts, clock }),
      })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      try {
        const body = `{"repo":${JSON.stringify(repo)},"discarded":"\\ud800"}`
        const init = {
          method: 'POST',
          headers: { ...headers, authorization: `Bearer ${owner.token}` },
          body,
        }
        const [native, source] = await Promise.all([
          server.fetch(`${server.url}/repos`, init),
          oracle.fetch(new Request('http://source/repos', init)),
        ])
        assert.equal(native.status, 400)
        assert.equal(source.status, 200)
        cases.push({
          case: 'discarded-lone-surrogate-field',
          request: {
            path: '/repos',
            method: 'POST',
            body,
            authorization: 'valid issued project credential retained only in memory',
          },
          native: { status: native.status, body: await native.json() },
          source: { status: source.status, body: await source.json() },
        })
        await ts.createBuild({ slug: '\ufffd', repo })
        await ts.append('\ufffd', sampleEventWrite())
        await ts.createBuild({ slug: 'witness', repo })
        let resolved: unknown
        try {
          resolved = await ts.getBuild('\ud800')
        } catch (error) {
          resolved = { error: error instanceof Error ? error.message : String(error) }
        }
        const scope = {
            version: 2 as const,
            delegation: { repo, kind: 'build-runner' as const, id: '\ud800', anchor: 1 },
          },
          token = mintToken(secret, scope)
        const read = { headers: { ...headers, authorization: `Bearer ${token}` } }
        const [a, b] = await Promise.all([
          server.fetch(`${server.url}/builds/witness`, read),
          oracle.fetch(new Request('http://source/builds/witness', read)),
        ])
        assert.equal(a.status, 401)
        assert.equal(b.status, 200)
        cases.push({
          case: 'lone-surrogate-claim-public-read',
          scope,
          sourceBuildLookup: resolved,
          request: {
            path: '/builds/witness',
            method: 'GET',
            authorization: 'fake-key-signed grant retained only in memory',
          },
          native: { status: a.status, body: await a.json() },
          source: { status: b.status, body: await b.json() },
        })
        const path = '/builds/%EF%BF%BD/events',
          write = {
            method: 'POST',
            headers: read.headers,
            body: JSON.stringify(sampleEventWrite()),
          }
        const [x, y] = await Promise.all([
          server.fetch(`${server.url}${path}`, write),
          oracle.fetch(new Request(`http://source${path}`, write)),
        ])
        assert.equal(x.status, 401)
        assert.equal(y.status, 403)
        cases.push({
          case: 'lone-surrogate-does-not-own-replacement-identity',
          request: { path, method: 'POST' },
          native: { status: x.status, body: await x.json() },
          source: { status: y.status, body: await y.json() },
        })
      } finally {
        await server.close()
        await ts.close()
        await sql.close()
      }
    }),
  )
  return cases
}
if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..'),
    common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw new Error('Cannot resolve UTF16 diagnostic Cargo cache')
  const target =
    process.env.CARGO_TARGET_DIR ||
    process.env.PROA_VERIFY_CACHE ||
    cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
  if (!process.argv.includes('--caller-holds-lock')) {
    await mkdir(target, { recursive: true })
    const child = Bun.spawn(
      ['flock', join(target, '.verify.lock'), 'bun', import.meta.filename, '--caller-holds-lock'],
      { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: 'inherit', stderr: 'inherit' },
    )
    if (await child.exited) throw new Error('Known UTF16 mismatch diagnostic failed')
  } else {
    const { server } = await buildProtocolExecutables({ ...process.env, CARGO_TARGET_DIR: target })
    const cases = await diagnoseProtocolUtf16(server)
    const directory = resolve(root, '.ab/proa-protocol-utf16')
    await mkdir(directory, { recursive: true })
    await Bun.write(
      join(directory, 'known-divergence.json'),
      `${JSON.stringify({ knownDivergence: true, fullConformance: false, cases }, null, 2)}\n`,
    )
    console.log(
      `Confirmed three public HTTP UTF16 differences. This is diagnostic evidence, not a passing conformance gate: ${directory}`,
    )
  }
}
