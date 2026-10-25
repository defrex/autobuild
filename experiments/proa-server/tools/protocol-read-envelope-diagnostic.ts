/** Standalone known-divergence diagnostic, deliberately outside acceptance gates.
 * SQL installs legacy JSONB string envelopes allowed by the shared schema. The
 * source adapter unwraps these before event decoding; the native read path must
 * eventually do the same without losing UTF-16 identities. Never logs tokens. */
import { strict as assert } from 'node:assert'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { verifyToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { cachePath } from './verify'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { buildProtocolExecutables, startProtocolServer } from './protocol-server-harness'

type Wire = { status: number; body: unknown }
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function sanitized(wire: Wire): Wire {
  return typeof record(wire.body)?.token === 'string'
    ? { status: wire.status, body: { token: 'issued credential withheld; checked in memory' } }
    : wire
}

export async function diagnoseProtocolReadEnvelopes(executable: string) {
  const cases: {
    name: string
    request: { path: string; method: string; body?: unknown; authority: string }
    native: Wire
    source: Wire
  }[] = []
  let fixtureRows: unknown
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const secret = 'isolated-read-envelope-fake-secret',
        clock = () => new Date('2030-01-01T00:00:00.000Z'),
        repo = 'https://github.com/proa/read-envelope',
        session = '\ud800'
      const ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      let sourceServer: ReturnType<typeof Bun.serve> | undefined
      let failure: unknown
      try {
        await projects.add(repo, 'proof')
        const owner = await credentials.issue(repo, 'proof')
        for (const slug of ['envelope-future', 'envelope-known']) {
          await ts.createBuild({ slug, repo })
          await ts.append(slug, sampleEventWrite())
        }
        // to_jsonb(TEXT) unambiguously stores a JSONB scalar string, rather
        // than depending on how a driver infers a parameter's JSONB encoding.
        await sql.unsafe(
          "UPDATE events SET type='future.read-envelope', payload=to_jsonb($1::text) WHERE build='envelope-future'",
          [JSON.stringify({ x: session })],
        )
        await sql.unsafe(
          "UPDATE events SET actor=jsonb_build_object('kind','kernel'), type='session.started', payload=to_jsonb($1::text) WHERE build='envelope-known'",
          [
            JSON.stringify({
              session,
              role: 'implement',
              runner: 'fake',
              phase: 'implement',
              round: 1,
              args: [],
            }),
          ],
        )
        fixtureRows = await sql.unsafe(
          'SELECT build,type,jsonb_typeof(actor) AS actor_storage,jsonb_typeof(payload) AS payload_storage,payload::text AS payload_wire FROM events ORDER BY build,seq',
        )
        native = await startProtocolServer({
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
        sourceServer = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request) => oracle.fetch(request),
        })
        const sourceUrl = `http://127.0.0.1:${sourceServer.port}`
        const compare = async (
          name: string,
          path: string,
          method = 'GET',
          body?: unknown,
          token = owner.token,
          authority = 'valid issued project credential retained only in memory',
        ) => {
          const init: RequestInit = {
            method,
            headers: {
              'content-type': 'application/json',
              'x-autobuild-version': AUTOBUILD_VERSION,
              'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
              authorization: `Bearer ${token}`,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(8000),
          }
          const actual: Response = await native!.fetch(`${native!.url}${path}`, init)
          const expected: Response = await fetch(`${sourceUrl}${path}`, init)
          const actualWire: Wire = { status: actual.status, body: await actual.json() }
          const sourceWire: Wire = { status: expected.status, body: await expected.json() }
          assert.equal(sourceWire.status, 200, `${name}: source fixture is readable`)
          assert.equal(
            isDeepStrictEqual(actualWire, sourceWire),
            false,
            `${name}: diagnostic no longer diverges`,
          )
          cases.push({
            name,
            request: { path, method, ...(body === undefined ? {} : { body }), authority },
            native: sanitized(actualWire),
            source: sanitized(sourceWire),
          })
          return { native: actualWire, source: sourceWire }
        }
        const future = await compare(
          'future-payload-envelope-retains-lone-unit',
          '/builds/envelope-future/events',
        )
        assert.ok(Array.isArray(future.source.body) && Array.isArray(future.native.body))
        assert.equal(record(record(future.source.body[0])?.payload)?.x, session)
        assert.equal(typeof record(future.native.body[0])?.payload, 'string')
        const facts = await compare(
          'known-session-envelope-produces-lossless-delegation-facts',
          '/builds/envelope-known/reducer-values',
          'POST',
          { reducer: 'buildDelegation' },
        )
        const sessions = record(record(facts.source.body)?.value)?.sessions
        assert.deepEqual(record(record(sessions)?.[`id:${session}`])?.starts, [1])
        const issuance = await compare(
          'known-session-envelope-issues-phase-grant',
          '/credentials/delegate',
          'POST',
          { kind: 'build-phase', id: 'envelope-known', session },
        )
        const phaseToken = record(issuance.source.body)?.token
        assert.equal(typeof phaseToken, 'string')
        if (typeof phaseToken !== 'string') throw new Error('source did not issue a phase grant')
        const claims = verifyToken(secret, phaseToken, clock())
        assert.ok(claims && 'delegation' in claims)
        assert.equal(claims.delegation.session, session)
        await compare(
          'source-issued-phase-grant-reads-wrapped-known-lifecycle',
          '/builds/envelope-known',
          'GET',
          undefined,
          phaseToken,
          'source-issued phase credential retained only in memory',
        )
      } catch (error) {
        failure = error
      } finally {
        sourceServer?.stop(true)
        await native?.close().catch((error) => {
          failure ??= error
        })
        await ts.close().catch((error) => {
          failure ??= error
        })
        await sql.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return {
    knownDivergence: true,
    fullConformance: false,
    acceptanceEvidence: false,
    fixture: 'legacy JSONB scalar-string envelopes in valid shared-schema event rows',
    fixtureRows,
    caseCount: cases.length,
    sourceSuccessfulCases: cases.filter((row) => row.source.status === 200).length,
    nativeDifferingCases: cases.length,
    cases,
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..')
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw new Error('Cannot resolve read-envelope diagnostic Cargo cache')
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
    if (await child.exited) throw new Error('Read-envelope diagnostic failed')
  } else {
    const { server } = await buildProtocolExecutables({ ...process.env, CARGO_TARGET_DIR: target })
    const report = await diagnoseProtocolReadEnvelopes(server)
    const directory = resolve(root, '.ab/proa-protocol-read-envelopes')
    await mkdir(directory, { recursive: true })
    await Bun.write(
      join(directory, 'known-divergence.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    console.log(
      `Confirmed ${report.caseCount} known read-envelope differences; not acceptance evidence: ${directory}`,
    )
  }
}
