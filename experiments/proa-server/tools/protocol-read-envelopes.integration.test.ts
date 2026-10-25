/** Differential legacy JSONB read envelopes, replay and delegated authority. */
import { strict as assert } from 'node:assert'
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
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

import { persistedReducerArgs } from './protocol-persisted-reducer-fixtures'
import { supportedReducers } from './protocol-reducer-fixtures'
import { resolveReducerValue } from '../../../packages/core/src/store/reducer-values'
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

export async function proveProtocolReadEnvelopes(executable: string) {
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

          assert.deepEqual(actualWire, sourceWire, name)
          cases.push({
            name,
            request: { path, method, ...(body === undefined ? {} : { body }), authority },
            native: sanitized(actualWire),
            source: sanitized(sourceWire),
          })
          return { native: actualWire, source: sourceWire }
        }
        // Cover every column whose source reader deliberately unwraps one layer.
        const encodedRepo = encodeURIComponent(repo)
        const storedSession = await ts.createSession({ repo, operator: 'read-proof' })
        const scopes = [
          {
            table: 'events',
            artifacts: 'artifacts',
            column: 'build',
            id: 'envelope-future',
            path: '/builds/envelope-future',
          },
          {
            table: 'repo_events',
            artifacts: 'repo_artifacts',
            column: 'repo',
            id: repo,
            path: `/repos/${encodedRepo}`,
          },
          {
            table: 'session_events',
            artifacts: 'session_artifacts',
            column: 'session',
            id: storedSession.id,
            path: `/sessions/${storedSession.id}`,
          },
        ]
        await ts.ensureRepo(repo)
        for (const scope of scopes) {
          if (scope.table !== 'events') {
            await sql.unsafe(`DELETE FROM ${scope.table} WHERE ${scope.column}=$1`, [scope.id])
            await sql.unsafe(
              `INSERT INTO ${scope.table} (${scope.column},seq,ts,actor,type,payload) VALUES ($1,1,$2::timestamptz,'{"kind":"kernel"}'::jsonb,'future.read-envelope','{}'::jsonb)`,
              [scope.id, clock().toISOString()],
            )
          }
          await sql.unsafe(
            `UPDATE ${scope.table} SET actor=to_jsonb($1::text),payload=to_jsonb($2::text) WHERE ${scope.column}=$3`,
            [
              JSON.stringify({ kind: 'human', user: session }),
              JSON.stringify({ x: session, nested: { [session]: '\ufffd' } }),
              scope.id,
            ],
          )
          const read = await compare(
            `${scope.table}-actor-and-payload-envelopes`,
            `${scope.path}/events`,
          )
          assert.ok(Array.isArray(read.source.body))
          assert.equal(record(record(read.source.body[0])?.actor)?.user, session)
          await sql.unsafe(
            `INSERT INTO ${scope.artifacts} (${scope.column},kind,revision,blob_ref,metadata,created_at) VALUES ($1,'read-proof',1,'sha256:read-envelope-fixture',to_jsonb($2::text),$3::timestamptz)`,
            [scope.id, JSON.stringify({ [session]: { x: session } }), clock().toISOString()],
          )
          const meta = await compare(
            `${scope.artifacts}-metadata-envelope`,
            `${scope.path}/artifact-list`,
          )
          assert.ok(Array.isArray(meta.source.body))
          assert.deepEqual(record(meta.source.body[0])?.metadata, { [session]: { x: session } })
          if (scope.table !== 'session_events') {
            for (const compatibility of [
              'null',
              'false',
              '0',
              '""',
              JSON.stringify(JSON.stringify({ writerVersion: '1.0.0', extra: session })),
            ]) {
              await sql.unsafe(
                `UPDATE ${scope.table} SET compatibility=$1::jsonb WHERE ${scope.column}=$2`,
                [compatibility, scope.id],
              )
              await compare(`${scope.table}-compatibility-${compatibility}`, `${scope.path}/events`)
            }
            await sql.unsafe(
              `UPDATE ${scope.table} SET compatibility=NULL WHERE ${scope.column}=$1`,
              [scope.id],
            )
          }
        }
        for (const ticket of [
          JSON.stringify({ id: session, title: session }),
          JSON.stringify(JSON.stringify({ id: session })),
          'null',
          'false',
          '0',
          '""',
        ]) {
          // Direct JSONB with lone escapes is invalid PostgreSQL; only the inner
          // document may carry them. Scalar false/zero/null exercise JS truthiness.
          const stored =
            ticket.includes('\\ud800') && !ticket.startsWith('"') ? JSON.stringify(ticket) : ticket
          await sql.unsafe('UPDATE builds SET ticket=$1::jsonb WHERE slug=$2', [
            stored,
            'envelope-future',
          ])
          await compare(`build-ticket-${stored}`, '/builds/envelope-future')
          await compare(`build-ticket-list-${stored}`, '/builds')
        }
        await sql.unsafe("UPDATE builds SET ticket=NULL WHERE slug='envelope-future'")
        await sql.unsafe(
          "UPDATE events SET actor=jsonb_build_object('kind','kernel'),payload=to_jsonb($1::text) WHERE build='envelope-future'",
          [JSON.stringify({ x: session })],
        )
        const future = await compare(
          'future-payload-envelope-retains-lone-unit',
          '/builds/envelope-future/events',
        )
        assert.ok(Array.isArray(future.source.body) && Array.isArray(future.native.body))
        assert.equal(record(record(future.source.body[0])?.payload)?.x, session)
        assert.deepEqual(record(future.native.body[0])?.payload, { x: session })
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
        for (const reducer of supportedReducers) {
          const args = persistedReducerArgs(reducer)
          for (const scope of ['build', 'repo'] as const) {
            try {
              resolveReducerValue(
                scope === 'build'
                  ? { kind: 'build', slug: 'envelope-known' }
                  : { kind: 'repo', repo },
                { reducer, args },
              )
            } catch {
              continue
            }
            const response = await compare(
              `${scope}-${reducer}-persisted-lone`,
              scope === 'build'
                ? '/builds/envelope-known/reducer-values'
                : `/repos/${encodedRepo}/reducer-values`,
              'POST',
              { reducer, args },
            )
            assert.equal(response.source.status, 200, `${reducer}: source replay fixture valid`)
          }
        }
        // Parse one envelope only. Inner strings remain strings, and malformed
        // inner JSON is a source error rather than silently returned as text.
        for (const scope of scopes) {
          for (const inner of [
            JSON.stringify('\\ud800'),
            '{',
            '\ufeff{}',
            '\ud800',
            '😀{}',
            '{\ud800}',
            '\u0085{}',
          ]) {
            await sql.unsafe(
              `UPDATE ${scope.table} SET payload=to_jsonb($1::text) WHERE ${scope.column}=$2`,
              [inner, scope.id],
            )
            await compare(
              `${scope.table}-one-layer-or-error-${JSON.stringify(inner)}`,
              `${scope.path}/events`,
            )
          }
          await sql.unsafe(
            `UPDATE ${scope.table} SET payload='{}'::jsonb WHERE ${scope.column}=$1`,
            [scope.id],
          )
          await sql.unsafe(
            `UPDATE ${scope.artifacts} SET metadata=to_jsonb($1::text) WHERE ${scope.column}=$2`,
            ['{', scope.id],
          )
          await compare(`${scope.artifacts}-malformed-envelope`, `${scope.path}/artifact-list`)
        }
        await sql.unsafe(
          "UPDATE builds SET ticket=to_jsonb('{'::text) WHERE slug='envelope-future'",
        )
        await compare('build-ticket-malformed-envelope', '/builds/envelope-future')
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
    knownDivergence: false,
    fullConformance: false,
    acceptanceEvidence: true,
    fixture: 'legacy JSONB scalar-string envelopes in valid shared-schema event rows',
    fixtureRows,
    caseCount: cases.length,
    sourceSuccessfulCases: cases.filter((row) => row.source.status === 200).length,
    nativeDifferingCases: 0,
    cases,
  }
}
