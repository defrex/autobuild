import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
/** Actual native authority evidence, explicitly invoked by the protocol gate. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { sampleBuildInput, sampleEventWrite } from '../../../packages/core/src/store/contract'
import { mintToken, type DelegatedTokenScope } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

type AuthorityRow = {
  kind: string
  delegation: DelegatedTokenScope['delegation']
  path: string
  method: string
  raw: string
  status: number
  body: unknown
}
export async function proveProtocolDelegationAuthority(executable: string) {
  let comparisons = 0
  const failures: unknown[] = []
  const presenceRefusals: unknown[] = []
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (baseEnv) => {
      const secret = 'native-authority-proof'
      const env: Record<string, string | undefined> = {
        ...baseEnv,
        PROA_TEST_AUTH: 'project',
        PROA_TEST_SECRET: secret,
      }
      const clock = () => new Date('2026-01-01T00:00:00.000Z'),
        repo = 'https://github.com/acme/a',
        foreign = 'https://github.com/acme/b'
      const store = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      try {
        const projects = new PostgresProjectRegistry(sql)
        await projects.add(repo, 'proof')
        await projects.add(foreign, 'proof')
        for (const [slug, r] of [
          ['own', repo],
          ['other', repo],
          ['foreign', foreign],
        ]) {
          await store.createBuild(sampleBuildInput(slug!, { repo: r! }))
          await store.append(slug!, sampleEventWrite())
        }
        await store.append('own', {
          actor: { kind: 'kernel' },
          type: 'session.started',
          payload: {
            session: 'session',
            role: 'implement',
            runner: 'fake',
            phase: 'implement',
            round: 1,
          },
        })
        await store.ensureRepo(repo)
        await store.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.started',
          payload: {
            run: 'run',
            observations: [{ build: 'own', seq: 1 }],
            scan: { kind: 'harvest-scan', rev: 0 },
          },
        })
        await store.appendRepo(repo, {
          actor: { kind: 'dispatcher' },
          type: 'harvest.execution.authorized',
          payload: { run: 'run', execution: 'execution', launch: 'started', leaseHolder: 'holder' },
        })
        await store.appendRepo(repo, {
          actor: { kind: 'kernel' },
          type: 'harvest.session.started',
          payload: {
            run: 'run',
            session: 'session',
            role: 'harvest',
            runner: 'fake',
            args: [],
            step: 'synthesize',
            round: 1,
          },
        })
        server = await startProtocolServer({ executable, env, clock })
        const rows: AuthorityRow[] = await Bun.file(
          new URL('../fixtures/protocol-delegation-authority.json', import.meta.url),
        ).json()
        for (const row of rows) {
          const delegation = {
            ...row.delegation,
            anchor:
              row.kind === 'build-phase'
                ? 2
                : row.kind === 'harvest-runner'
                  ? 2
                  : row.kind === 'harvest-phase'
                    ? 3
                    : 1,
          }
          const token = mintToken(secret, { version: 2, delegation })
          const response: Response = await server.fetch(`${server.url}${row.path}`, {
            method: row.method,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'x-autobuild-version': AUTOBUILD_VERSION,
              'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
            },
            ...(row.method === 'GET' ? {} : { body: row.raw }),
          })
          const actual = { status: response.status, body: await response.json() }
          const expected = { status: row.status, body: row.body }
          try {
            assert.deepEqual(actual, expected)
          } catch {
            failures.push({
              label: `${row.kind} ${row.method} ${row.path} ${row.raw}`,
              actual,
              expected,
            })
          }
          comparisons++
        }

        // Separate memory oracle receives the same durable prefix. Generated stream
        // identifiers are paired explicitly; all other response fields compare.
        const mirror = new MemoryBuildStore({ clock })
        await mirror.ensureRepo(repo)
        for (const event of await store.getRepoEvents(repo)) {
          const { repo: _repo, seq: _seq, ts: _ts, ...write } = event
          await mirror.appendRepo(repo, write)
        }
        let current: DelegatedTokenScope['delegation'] = {
          kind: 'harvest-runner',
          repo,
          id: 'run',
          anchor: 2,
          execution: 'execution',
          leaseHolder: 'holder',
        }
        const domainOracle = createStoreServer({
          store: mirror,
          clock,
          auth: {
            authenticate: async () => ({
              kind: 'delegated',
              repo,
              user: 'delegated',
              delegation: current,
            }),
          },
        })
        const nativeIds = new Map<string, string>(),
          oracleIds = new Map<string, string>()
        const normalize = (input: unknown, ids: Map<string, string>): unknown => {
          if (typeof input === 'string') {
            let text = input
            for (const [id, paired] of ids) text = text.replaceAll(id, paired)
            return text
          }
          if (Array.isArray(input)) return input.map((v) => normalize(v, ids))
          if (input !== null && typeof input === 'object')
            return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, normalize(v, ids)]))
          return input
        }
        const domain = async (
          path: string,
          body?: unknown,
          method = 'POST',
          oraclePath = path,
          raw?: string,
        ) => {
          const init = {
            method,
            headers: {
              authorization: `Bearer ${mintToken(secret, { version: 2, delegation: current })}`,
              'content-type': 'application/json',
              'x-autobuild-version': AUTOBUILD_VERSION,
              'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
            },
            ...(raw !== undefined
              ? { body: raw }
              : body === undefined
                ? {}
                : { body: JSON.stringify(body) }),
          }
          const actual: Response = await server!.fetch(`${server!.url}${path}`, init)
          const expected: Response = await domainOracle.fetch(
            new Request(`http://oracle${oraclePath}`, init),
          )
          const a = await actual.json(),
            e = await expected.json()
          if (
            actual.status === 201 &&
            typeof a.id === 'string' &&
            typeof a.label === 'string' &&
            typeof e.id === 'string'
          ) {
            const id = `stream-${nativeIds.size}`
            nativeIds.set(a.id, id)
            oracleIds.set(e.id, id)
          }
          assert.deepEqual(
            { status: actual.status, body: normalize(a, nativeIds) },
            { status: expected.status, body: normalize(e, oracleIds) },
            `${current.kind} domain ${method} ${path} ${JSON.stringify(body)}`,
          )
          comparisons++
          return { status: actual.status, actual: a, expected: e }
        }
        const base = `/repos/${encodeURIComponent(repo)}`
        const wrongLabel = 'harvest:other:execution:runner'
        const nativeWrong = await store.createStream({ kind: 'repo', repo }, wrongLabel)
        const oracleWrong = await mirror.createStream({ kind: 'repo', repo }, wrongLabel)
        await domain(
          `/streams/${nativeWrong.id}/chunks`,
          { parts: [{ type: 'text', text: 'deny' }] },
          'POST',
          `/streams/${oracleWrong.id}/chunks`,
        )
        await domain(
          `${base}/streams/${nativeWrong.id}/chunks`,
          { parts: [{ type: 'text', text: 'deny' }] },
          'POST',
          `${base}/streams/${oracleWrong.id}/chunks`,
        )
        await domain(
          `/streams/${nativeWrong.id}/chunks`,
          undefined,
          'POST',
          `/streams/${oracleWrong.id}/chunks`,
          '{',
        )
        await mirror.createBuild(sampleBuildInput('other', { repo }))
        for (const event of await store.getEvents('other')) {
          const { build: _build, seq: _seq, ts: _ts, ...write } = event
          await mirror.append('other', write)
        }
        const nativeOther = await store.createStream(
          { kind: 'build', build: 'other' },
          'foreign-build',
        )
        const oracleOther = await mirror.createStream(
          { kind: 'build', build: 'other' },
          'foreign-build',
        )
        current = { kind: 'build-runner', repo, id: 'own', anchor: 1 }
        await domain(
          `/streams/${nativeOther.id}/chunks`,
          { parts: [{ type: 'text', text: 'deny' }] },
          'POST',
          `/streams/${oracleOther.id}/chunks`,
        )
        await domain(
          `/builds/other/streams/${nativeOther.id}/chunks`,
          { parts: [{ type: 'text', text: 'deny' }] },
          'POST',
          `/builds/other/streams/${oracleOther.id}/chunks`,
        )

        for (const kind of [
          'build-runner',
          'build-phase',
          'harvest-runner',
          'harvest-phase',
        ] as const) {
          current = {
            kind,
            repo,
            id: kind.startsWith('build') ? 'own' : 'run',
            anchor: kind === 'build-runner' ? 1 : kind === 'harvest-phase' ? 3 : 2,
            ...(kind.endsWith('phase') ? { session: 'session' } : {}),
            ...(kind.startsWith('harvest')
              ? {
                  execution: 'execution',
                  ...(kind === 'harvest-runner' ? { leaseHolder: 'holder' } : {}),
                }
              : {}),
          }
          for (const suffix of [
            'reducer-values',
            '%72educer-values',
            'reducer-values/',
            '/reducer-values',
          ]) {
            await domain(`/builds/other/${suffix}`, { reducer: 'build' })
            await domain(`${base}/${suffix}`, { reducer: 'harvestDelegation' })
          }
          for (const suffix of ['events', '%65vents', 'events/', '/events']) {
            await domain(`${base}/${suffix}`, {
              actor: { kind: 'kernel' },
              type: 'dispatcher.forge-degraded',
              payload: {
                forge: 'github',
                message: 'audit',
                resetAt: clock().toISOString(),
                firstFailureAt: clock().toISOString(),
              },
            })
          }
        }
        for (const kind of ['harvest-runner', 'harvest-phase'] as const) {
          current = {
            kind,
            repo,
            id: 'run',
            execution: 'execution',
            anchor: kind === 'harvest-runner' ? 2 : 3,
            ...(kind === 'harvest-runner' ? { leaseHolder: 'holder' } : { session: 'session' }),
          }
          for (const holder of ['other', 'holder']) {
            await domain(`${base}/lease/claim`, { holder, ttlMs: 60000 })
            await domain(`${base}/lease/heartbeat`, { holder })
            await domain(`${base}/lease/release`, { holder })
          }
          for (const artifactKind of [
            'harvest-proposals',
            'harvest-review',
            'harvest-report',
            'harvest-transcript',
            'other',
          ])
            for (const run of ['run', 'other']) {
              await domain(`${base}/artifacts`, {
                kind: artifactKind,
                contentBase64: 'dGVzdA==',
                metadata: { run },
              })
            }
          const prefix = 'harvest:run:execution:'
          for (const label of [
            `${prefix}session:session`,
            `${prefix}session:other`,
            `${prefix}runner`,
            'harvest:other:execution:session:session',
            'harvest:run:other:session:session',
          ]) {
            const created = await domain(`${base}/streams`, { label })
            if (created.status === 201) {
              const aid = created.actual.id,
                eid = created.expected.id
              await domain(
                `/streams/${aid}/chunks`,
                undefined,
                'POST',
                `/streams/${eid}/chunks`,
                '{',
              )
              await domain(
                `/streams/${aid}/chunks`,
                { parts: [{ type: 'text', text: 'owned' }] },
                'POST',
                `/streams/${eid}/chunks`,
              )
              await domain(
                `/streams/${aid}/close`,
                { outcome: 'completed' },
                'POST',
                `/streams/${eid}/close`,
              )
              await domain(
                `${base}/streams/${aid}/chunks`,
                { parts: [{ type: 'text', text: 'closed' }] },
                'POST',
                `${base}/streams/${eid}/chunks`,
              )
            }
          }
          const event = {
            actor: { kind: 'kernel' },
            type: 'harvest.proposal.id-reserved',
            payload: { run: 'run', proposalKey: 'p', id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
          }
          await domain(`${base}/events`, event)
          await domain(`${base}/events`, { ...event, payload: { ...event.payload, run: 'other' } })
          for (const artifactRun of ['run', 'other'])
            for (const artifactKind of ['harvest-proposals', 'other']) {
              await domain(`${base}/deposits`, {
                event,
                artifacts: [
                  { kind: artifactKind, contentBase64: 'dGVzdA==', metadata: { run: artifactRun } },
                ],
              })
            }
          await domain(`${base}/events`, {
            ...event,
            type: 'harvest.execution.authorized',
            payload: { run: 'run', execution: 'extra', launch: 'started', leaseHolder: 'holder' },
          })
        }
        const credentials = new PostgresCredentialStore(sql, projects)
        const oracle = createStoreServer({
          store,
          clock,
          auth: createMachineAuth({ secret, credentials, projects, store, clock }),
        })
        // The real service auth resolves the same valid lifecycle grants.
        // GET uses the source's dedicated refusal before presence lookup. POST
        // preserves its earlier generic mutation gate, including harvest JSON
        // parsing errors; every path must leave presence records untouched.
        await store.upsertOperatorPresence(repo, {
          id: 'private-operator',
          host: 'private-host',
          pid: 42,
          startedAt: clock().toISOString(),
        })
        const beforePresence =
          await sql`SELECT * FROM operator_presence WHERE repo=${repo} ORDER BY id`
        let presenceAccesses = 0
        const listPresence = store.listOperatorPresence.bind(store),
          upsertPresence = store.upsertOperatorPresence.bind(store)
        store.listOperatorPresence = async () => {
          presenceAccesses++
          throw new Error('delegated presence lookup reached')
        }
        store.upsertOperatorPresence = async () => {
          presenceAccesses++
          throw new Error('delegated presence mutation reached')
        }
        try {
          for (const kind of [
            'build-runner',
            'build-phase',
            'harvest-runner',
            'harvest-phase',
          ] as const) {
            const delegation = {
              kind,
              repo,
              id: kind.startsWith('build') ? 'own' : 'run',
              anchor: kind === 'build-runner' ? 1 : kind === 'harvest-phase' ? 3 : 2,
              ...(kind.endsWith('phase') ? { session: 'session' } : {}),
              ...(kind.startsWith('harvest')
                ? {
                    execution: 'execution',
                    ...(kind === 'harvest-runner' ? { leaseHolder: 'holder' } : {}),
                  }
                : {}),
            }
            for (const [method, raw] of [
              ['GET', ''],
              ['POST', '{'],
              [
                'POST',
                JSON.stringify({
                  id: 'private-operator',
                  host: 'changed-host',
                  pid: 99,
                  startedAt: clock().toISOString(),
                }),
              ],
            ] as const) {
              const path = `/repos/${encodeURIComponent(repo)}/operator-presence`
              const init = {
                method,
                headers: {
                  authorization: `Bearer ${mintToken(secret, { version: 2, delegation })}`,
                  'content-type': 'application/json',
                  'x-autobuild-version': AUTOBUILD_VERSION,
                  'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
                },
                ...(method === 'GET' ? {} : { body: raw }),
              }
              const actual: Response = await server.fetch(`${server.url}${path}`, init),
                expected = await oracle.fetch(new Request(`http://oracle${path}`, init))
              const expectedWire = { status: expected.status, body: await expected.json() }
              if (method === 'GET')
                assert.deepEqual(expectedWire, {
                  status: 403,
                  body: {
                    kind: 'auth',
                    error: 'operator presence requires repository operator authority',
                  },
                })
              else if (kind.startsWith('build'))
                assert.deepEqual(expectedWire, {
                  status: 403,
                  body: { kind: 'auth', error: 'write outside delegated resource' },
                })
              else if (raw !== '{')
                assert.deepEqual(expectedWire, {
                  status: 403,
                  body: { kind: 'auth', error: 'write outside delegated harvest run' },
                })
              else {
                assert.equal(expectedWire.status, 500)
                assert.equal(expectedWire.body.kind, 'internal')
                assert.match(expectedWire.body.error, /^JSON Parse error:/)
              }
              assert.deepEqual(
                { status: actual.status, body: await actual.json() },
                expectedWire,
                `${kind} native ${method} presence`,
              )
              presenceRefusals.push({ kind, method, malformed: raw === '{', ...expectedWire })
              comparisons++
            }
          }
          assert.equal(presenceAccesses, 0, 'source refuses before presence lookup or mutation')
          assert.deepEqual(
            await sql`SELECT * FROM operator_presence WHERE repo=${repo} ORDER BY id`,
            beforePresence,
            'native refusals leave every presence field unchanged',
          )
        } finally {
          store.listOperatorPresence = listPresence
          store.upsertOperatorPresence = upsertPresence
        }
        const emptyRepo = 'https://github.com/acme/registered-no-journal'
        await projects.add(emptyRepo, 'proof')
        for (const delegation of [
          { kind: 'build-runner' as const, repo, id: 'absent', anchor: 1 },
          {
            kind: 'harvest-runner' as const,
            repo: emptyRepo,
            id: 'run',
            anchor: 1,
            execution: 'execution',
            leaseHolder: 'holder',
          },
          {
            kind: 'harvest-runner' as const,
            repo,
            id: 'absent',
            anchor: 1,
            execution: 'execution',
            leaseHolder: 'holder',
          },
        ]) {
          const headers = {
            authorization: `Bearer ${mintToken(secret, { version: 2, delegation })}`,
            'x-autobuild-version': AUTOBUILD_VERSION,
            'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          }
          const path = `/repos/${encodeURIComponent(delegation.repo)}/events`
          const actual: Response = await server.fetch(`${server.url}${path}`, { headers })
          const expected: Response = await oracle.fetch(
            new Request(`http://oracle${path}`, { headers }),
          )
          assert.deepEqual(
            { status: actual.status, body: await actual.json() },
            { status: expected.status, body: await expected.json() },
            `missing lifecycle ${delegation.kind}/${delegation.repo}/${delegation.id}`,
          )
          comparisons++
        }
      } finally {
        await server?.close()
        await store.close()
        await sql.close()
      }
    }),
  )
  if (process.env.PROA_AUTHORITY_FAILURE_REPORT)
    await Bun.write(process.env.PROA_AUTHORITY_FAILURE_REPORT, JSON.stringify(failures, null, 2))
  assert.deepEqual(failures, [], `native authority mismatches: ${failures.length}`)
  return {
    comparisons,
    presenceRefusals,
    checks: [
      'all four delegated kinds refuse operator presence GET with exact operator-authority text and preserve source POST generic/malformed-JSON precedence without presence lookup or mutation',
      'positive harvest labels/artifacts/leases/events/deposits match a separate authoritative TypeScript oracle',
      'all four delegated kinds enforce raw authorization before body validation across own/other/foreign/missing builds, node writers, repository mutations, sessions and global streams',
    ],
  }
}
