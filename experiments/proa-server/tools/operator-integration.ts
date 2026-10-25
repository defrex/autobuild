/** Native Rust-write / TypeScript-read proof. No live dispatcher or credentials are used. */
import { SQL } from 'bun'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { replayNativeControls } from './control-integration'
import { replayAdvancedControls } from './advanced-control-integration'
import { replayNativeReads } from './api-read-integration'
import { replayNativeRegistry } from './registry-integration'
import { replayAnswerFailures } from './answer-failure-integration'
import { replayRepositoryControls } from './repository-control-integration'
import { replayNativeDelegation } from './delegation-integration'
import { replaySessionConfiguration } from './session-config-integration'
import { replayNativeRegistryDomains } from './registry-domain-integration'
import { ticketIntegration } from './ticket-integration'
import {
  checkOperatorCoverage,
  operatorSourceClosureHash,
  operatorProofSourceHash,
} from './operator-coverage'
import type { OperatorCoverageEvidence, OperatorOperationWitness } from './operator-coverage-types'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { validateSessionEventWrite } from '../../../packages/core/src/events/sessions'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { reduceSession } from '../../../packages/core/src/store/session-reducer'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { bridge } from './data-integration'
import { withDataServices } from './data-services'
import {
  bindOperatorIds,
  checkOperatorCorpus,
  operatorClock,
  operatorRepo,
  type OperatorCorpus,
} from './operator-fixtures'

const project = resolve(import.meta.dir, '..')
const clock = () => new Date(operatorClock)

export async function buildOperatorNative(env: Record<string, string | undefined>) {
  const child = Bun.spawn(
    ['cargo', 'build', '--locked', '--example', 'operator-proof', '--message-format=json'],
    { cwd: project, env, stdout: 'pipe', stderr: 'inherit' },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw new Error('Native operator proof build failed')
  let executable: string | undefined
  for (const line of output.split('\n').filter(Boolean)) {
    const item = JSON.parse(line) as {
      reason: string
      target?: { name: string }
      executable?: string
      message?: { rendered?: string }
    }
    if (item.reason === 'compiler-message' && item.message?.rendered)
      process.stderr.write(item.message.rendered)
    if (
      item.reason === 'compiler-artifact' &&
      item.target?.name === 'operator-proof' &&
      item.executable
    )
      executable = item.executable
  }
  if (!executable) throw new Error('Cargo did not report native operator proof executable')
  return executable
}

const sessionCases = new Set([
  'session-message',
  'session-other-writer',
  'session-wake',
  'session-wake-empty',
  'session-approval-approve',
  'session-approval-deny',
  'session-approval-mismatch',
  'session-approval-none',
  'session-archive',
  'session-archive-again',
  'session-archived-message',
])
export const operatorFoundationClaims = [
  'Rust session policy and storage produce the same ordered facts and reduced states as TypeScript',
  'Native session creation and creation fact are readable through the TypeScript PostgreSQL adapter',
  'TypeScript validates native build, repository and session writes',
  'Independent native and TypeScript writers allocate unique ordered sequences',
  'Stale compare-and-append refuses without writing and one same-sequence native race wins',
  'SELECT-only credentials cannot perform native writes',
  'Restart reads recover native durable state',
] as const

export async function operatorIntegration(
  adminUrl: string,
  environment: Record<string, string | undefined>,
  executable?: string,
  selection?: {
    readCases?: readonly string[]
    skipAdvanced?: boolean
    skipAnswerFailures?: boolean
  },
) {
  const proofSourcesSha256 = operatorProofSourceHash()
  const native = executable ?? (await buildOperatorNative(environment))
  if (operatorProofSourceHash() !== proofSourcesSha256)
    throw new Error('Native/proof sources changed during build; retry against stable sources')
  const operationWitnesses: OperatorOperationWitness[] = []
  const coverage: OperatorCoverageEvidence = {
    format: 1,
    sourceClosureSha256: operatorSourceClosureHash(),
    proofSourcesSha256,
    suites: {},
    operationWitnesses,
  }
  const recordSuite = <
    T extends
      | readonly string[]
      | { cases: readonly string[]; witnesses?: OperatorOperationWitness[] },
  >(
    name: string,
    result: T,
  ): T => {
    const parsed: { cases: readonly string[]; witnesses?: OperatorOperationWitness[] } =
      Array.isArray(result)
        ? { cases: result }
        : (result as { cases: readonly string[]; witnesses?: OperatorOperationWitness[] })
    coverage.suites[name] = parsed.cases
    if (parsed.witnesses) operationWitnesses.push(...parsed.witnesses)
    return result
  }
  const readWitness = (id: string, path: string, status: number, responseBody: unknown) => {
    coverage.suites['operator-reads'] = [
      ...new Set([...(coverage.suites['operator-reads'] ?? []), id]),
    ]
    operationWitnesses.push({
      suite: 'operator-reads',
      id,
      method: 'GET',
      path: path.replace(/^\/operator\/v1\/repos\/[^/]+\//, ''),
      status,
      responseBody,
    })
  }
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const database = `proa_operator_${suffix}`
  const writerRole = `proa_op_write_${suffix}`
  const readerRole = `proa_op_read_${suffix}`
  const password = crypto.randomUUID()
  const admin = new SQL(adminUrl, { max: 1 })
  const databaseUrl = new URL(adminUrl)
  databaseUrl.pathname = `/${database}`
  const runtime = await mkdtemp(resolve(tmpdir(), 'proa-operator-proof-'))
  let sql: SQL | undefined
  let store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
  let rust: Awaited<ReturnType<typeof bridge>> | undefined
  let readonly: Awaited<ReturnType<typeof bridge>> | undefined
  const extraServers = new Set<() => Promise<void>>()
  let created = false
  const roles: string[] = []
  let failure: unknown
  let evidence:
    | {
        checkpoint: string
        claims: typeof operatorFoundationClaims
        sessionCases: string[]
        httpParity: boolean
        coverage: OperatorCoverageEvidence
        httpSessionCases: string[]
        controlCases: string[]
        readCases: string[]
      }
    | undefined
  const terminate = () => {
    for (const close of extraServers) void close()
    void rust?.close()
    void readonly?.close()
  }
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(databaseUrl.href)
    sql = new SQL(databaseUrl.href, { max: 1 })
    for (const role of [writerRole, readerRole]) {
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
      roles.push(role)
      await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    }
    // Scoped writer capabilities, including retention and blocker relation deletes. No DDL or ownership.
    await sql.unsafe(
      `GRANT INSERT, UPDATE ON sessions, session_events, builds, events, repo_streams, repo_events, repo_change_positions, artifacts, repo_artifacts TO ${writerRole}`,
    )
    await sql.unsafe(`GRANT USAGE ON SEQUENCE sessions_creation_seq TO ${writerRole}`)
    await sql.unsafe(`GRANT DELETE ON repo_artifacts TO ${writerRole}`)
    await sql.unsafe(`GRANT UPDATE(last_used_at) ON project_credentials TO ${writerRole}`)
    await sql.unsafe(
      `GRANT INSERT,UPDATE ON ab_tickets,ab_ticket_counters,ab_ticket_states TO ${writerRole}`,
    )
    await sql.unsafe(`GRANT INSERT,DELETE ON ab_ticket_blockers TO ${writerRole}`)
    store = await openPostgresBuildStoreFromEnv(
      { ...environment, AB_POSTGRES_URL: databaseUrl.href },
      { clock },
    )
    const withRole = (role: string) => {
      const url = new URL(databaseUrl)
      url.username = role
      url.password = password
      return { ...environment, AB_POSTGRES_URL: url.href }
    }
    const writerEnv = {
      ...withRole(writerRole),
      AB_STORE_SECRET: 'offline-operator-fixture-secret',
    }
    rust = await bridge(writerEnv, runtime, [native])
    const request = async (command: Record<string, unknown>) => {
      const response = await rust!.request({ now: operatorClock, ...command })
      if (response.error) throw new Error(`Native operator write refused: ${response.error}`)
      return response
    }
    const createdSession = (
      await request({
        op: 'service-create',
        repo: operatorRepo,
        user: 'operator@example.com',
        title: 'Native session',
      })
    ).value as { id: string }
    const createdRecord = await store.getSession(createdSession.id)
    assert.equal(createdRecord?.operator, 'operator@example.com')
    assert.equal(createdRecord?.title, 'Native session')
    assert.equal(createdRecord?.createdAt, operatorClock)
    const createdEvents = await store.getSessionEvents(createdSession.id)
    assert.equal(createdEvents.length, 1)
    assert.deepEqual(validateSessionEventWrite(createdEvents[0]!), {
      actor: { kind: 'human', user: 'operator@example.com' },
      type: 'session.created',
      payload: { title: 'Native session' },
    })

    // Same-clock ties follow the store-assigned sequence, never random session ids.
    // Deliberately descending ids make this regression deterministic.
    const orderingRepo = 'ordering/repo'
    const orderingIds = [`os_order_z_${suffix}`, `os_order_a_${suffix}`]
    for (const id of orderingIds) {
      await sql`INSERT INTO sessions (id, repo, operator, creation_seq, created_at, updated_at)
        VALUES (${id}, ${orderingRepo}, 'operator@example.com', nextval('sessions_creation_seq'), ${operatorClock}, ${operatorClock})`
      await sql`INSERT INTO session_events (session, seq, ts, actor, type, payload)
        VALUES (${id}, 1, ${operatorClock}, ${{ kind: 'human', user: 'operator@example.com' }}, 'session.created', ${{}})`
    }
    const listed = (await request({ op: 'service-list', repo: orderingRepo })).value as {
      id: string
    }[]
    assert.deepEqual(
      listed.map((record) => record.id),
      orderingIds,
      'same-clock session list tiebreak',
    )

    // Owner admission precedes history decoding, including an unreadable stored log.
    const unreadable = (await request({ op: 'create', repo: operatorRepo })).value as { id: string }
    await sql`INSERT INTO session_events (session, seq, ts, actor, type, payload)
      VALUES (${unreadable.id}, 2, ${operatorClock}, ${{ kind: 'agent', role: 'operator', session: 'seed' }}, 'unknown.future-session-event', ${{}})`
    const deniedUnreadable = await request({
      op: 'service-message',
      repo: operatorRepo,
      id: unreadable.id,
      user: 'other@example.com',
      text: 'Must not fold history before checking owner',
    })
    assert.equal(deniedUnreadable.status, 403)
    assert.deepEqual(deniedUnreadable.body, {
      kind: 'auth',
      error: `session "${unreadable.id}" belongs to operator "operator@example.com"; "other@example.com" may not write message.posted`,
    })
    const [unreadableCount] =
      await sql`SELECT count(*) AS n FROM session_events WHERE session = ${unreadable.id}`
    assert.equal(
      Number(unreadableCount.n),
      2,
      'nonowner refusal leaves unreadable history unchanged',
    )

    const corpus = (await Bun.file(
      resolve(project, 'fixtures/operator-corpus.json'),
    ).json()) as OperatorCorpus
    await checkOperatorCorpus(corpus)
    for (const item of corpus.manifest.operatorNormalization) {
      const response = await rust.request({
        op: 'create',
        repo: operatorRepo,
        user: item.input,
        now: operatorClock,
      })
      if ('error' in item) {
        assert.equal(response.error, item.error)
      } else {
        const record = response.value as { id: string; operator: string }
        assert.equal(record.operator, item.owner)
        assert.equal((await store.getSession(record.id))?.operator, item.owner)
        assert.deepEqual((await store.getSessionEvents(record.id))[0]?.actor, {
          kind: 'human',
          user: item.owner,
        })
      }
    }
    const checked: string[] = []
    for (const fixture of corpus.fixtures.filter((fixture) =>
      sessionCases.has(fixture.scenario.id),
    )) {
      const seed = fixture.seed[0]!
      const seedRecord = seed.record as { operator: string; title?: string; repo: string }
      const record = (
        await request({
          op: 'create',
          repo: seedRecord.repo,
          user: seedRecord.operator,
          title: seedRecord.title,
        })
      ).value as { id: string }
      for (const raw of seed.events.slice(1)) {
        const event = raw as { actor: unknown; type: string; payload: unknown }
        await request({
          op: 'append-session',
          repo: seedRecord.repo,
          id: record.id,
          write: { actor: event.actor, type: event.type, payload: event.payload },
        })
      }
      const input = fixture.scenario.requests[0]!
      const body = input.body as
        | { text?: string; globs?: string[]; turn?: string; toolCallId?: string; decision?: string }
        | undefined
      const operation = input.path.endsWith('/messages')
        ? 'message'
        : input.path.endsWith('/wake')
          ? 'wake'
          : input.path.endsWith('/approvals')
            ? 'approval'
            : 'archive'
      // This checkpoint exercises the service seam; HTTP schema parsing is covered by the oracle only.
      const response = await request({
        op: `service-${operation}`,
        repo: seedRecord.repo,
        id: record.id,
        user: input.user ?? 'operator@example.com',
        ...body,
        ...(body?.text !== undefined ? { text: body.text.trim() } : {}),
      })
      const expected = fixture.observations[0]!
      if (expected.status >= 400) {
        assert.equal(response.status, expected.status, `${fixture.scenario.id}: refusal status`)
        assert.deepEqual(
          bindOperatorIds(response.body, [record.id]),
          expected.body,
          `${fixture.scenario.id}: refusal text`,
        )
      } else {
        assert.equal(response.status, undefined, `${fixture.scenario.id}: mutation should succeed`)
        validateSessionEventWrite(response.value)
      }
      const events = await store.getSessionEvents(record.id)
      for (const event of events) validateSessionEventWrite(event)
      const actual: unknown = {
        record: await store.getSession(record.id),
        events,
        state: reduceSession(events),
      }
      assert.deepEqual(
        bindOperatorIds(actual, [record.id]),
        expected.sessions[0],
        `${fixture.scenario.id}: full durable state`,
      )
      const nativeView = (
        await request({ op: 'service-get', repo: seedRecord.repo, id: record.id })
      ).value
      assert.deepEqual(
        nativeView.state,
        encodeReducerValue(reduceSession(events)),
        `${fixture.scenario.id}: native restartable reduction`,
      )
      checked.push(fixture.scenario.id)
    }
    assert.equal(checked.length, sessionCases.size)

    const human = { kind: 'human' as const, user: 'operator@example.com' }
    const message = { actor: human, type: 'message.posted', payload: { text: 'Native CAS' } }
    const cas = await request({
      op: 'cas-session',
      repo: operatorRepo,
      id: createdSession.id,
      expected: 1,
      write: message,
    })
    assert.equal(cas.value.seq, 2)
    const stale = await request({
      op: 'cas-session',
      repo: operatorRepo,
      id: createdSession.id,
      expected: 1,
      write: message,
    })
    assert.equal(stale.value, null)
    const raced = await request({
      op: 'race-session',
      repo: operatorRepo,
      id: createdSession.id,
      expected: 2,
      write: message,
    })
    assert.equal(raced.value.filter((value: unknown) => value !== null).length, 1)
    const afterRace = await store.getSessionEvents(createdSession.id)
    assert.equal(afterRace.length, 3, 'same-sequence CAS race must append exactly once')
    assert.deepEqual(
      afterRace.map((event) => event.seq),
      [1, 2, 3],
    )
    assert.deepEqual(validateSessionEventWrite(afterRace[2]!), message)
    const beforeConcurrent = (await store.getSessionEvents(createdSession.id)).length
    await Promise.all([
      request({ op: 'append-session', repo: operatorRepo, id: createdSession.id, write: message }),
      store.appendSessionEvent(createdSession.id, {
        actor: human,
        type: 'message.posted',
        payload: { text: 'Concurrent TypeScript' },
      }),
    ])
    const concurrentEvents = await store.getSessionEvents(createdSession.id)
    assert.equal(concurrentEvents.length, beforeConcurrent + 2)
    assert.deepEqual(
      concurrentEvents.map((event) => event.seq),
      Array.from({ length: concurrentEvents.length }, (_, index) => index + 1),
    )
    concurrentEvents.forEach(validateSessionEventWrite)

    const createdWrite = buildCreatedWrite()
    createdWrite.payload.repo = operatorRepo
    await store.createBuild({ slug: 'native-control', repo: operatorRepo, created: createdWrite })
    const control = { actor: human, type: 'build.pause-requested', payload: {} }
    const build = await request({
      op: 'append-build',
      repo: operatorRepo,
      id: 'native-control',
      write: control,
    })
    validateEventWrite(build.value)
    const buildEvents = await store.getEvents('native-control')
    const buildState = reduceBuild(buildEvents)
    assert.equal(buildState.pendingCommands.at(-1)?.command, 'pause')
    const stateBeforeStale = encodeReducerValue(buildState)
    assert.equal(
      (
        await request({
          op: 'cas-build',
          repo: operatorRepo,
          id: 'native-control',
          expected: 1,
          write: control,
        })
      ).value,
      null,
    )
    assert.deepEqual(
      encodeReducerValue(reduceBuild(await store.getEvents('native-control'))),
      stateBeforeStale,
    )
    await store.ensureRepo(operatorRepo)
    const repoWrite = { actor: human, type: 'dispatcher.intake-set', payload: { enabled: false } }
    const repository = await request({ op: 'append-repo', repo: operatorRepo, write: repoWrite })
    validateRepositoryEventWrite(repository.value)
    assert.deepEqual((await store.getRepoEvents(operatorRepo)).at(-1), repository.value)

    const wrongProject = await rust.request({
      op: 'append-session',
      repo: 'foreign/repo',
      id: createdSession.id,
      write: message,
    })
    assert.equal(typeof wrongProject.error, 'string')
    assert.equal((await store.getSessionEvents(createdSession.id)).length, concurrentEvents.length)
    readonly = await bridge(withRole(readerRole), runtime, [native])
    const denied = await readonly.request({
      op: 'append-session',
      repo: operatorRepo,
      id: createdSession.id,
      write: message,
    })
    assert.equal(denied.error, 'PostgreSQL write failed')
    assert.equal((await store.getSessionEvents(createdSession.id)).length, concurrentEvents.length)
    await readonly.close()
    readonly = undefined
    await rust.close()
    rust = await bridge(writerEnv, runtime, [native])
    const restarted = await request({
      op: 'service-get',
      repo: operatorRepo,
      id: createdSession.id,
    })
    assert.deepEqual(restarted.value.state, encodeReducerValue(reduceSession(concurrentEvents)))

    // Replay the TypeScript HTTP session contract through the real native socket.
    for (const repo of [operatorRepo, 'foreign/repo'])
      await sql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),${repo},'added','proof',${operatorClock})`
    const address = (await request({ op: 'http-address' })).value as string
    const projectRegistry = new PostgresProjectRegistry(sql)
    const credentialRepo = 'https://github.com/acme/native-first-use'
    await projectRegistry.add(credentialRepo, 'test-owner')
    const issued = await new PostgresCredentialStore(sql, projectRegistry).issue(
      credentialRepo,
      'owner@example.com',
    )
    const credentialHeaders = {
      authorization: `Bearer ${issued.token}`,
      'x-autobuild-version': AUTOBUILD_VERSION,
      'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
      'content-type': 'application/json',
    }
    const firstUse = await fetch(
      `${address}/operator/v1/repos/${encodeURIComponent(credentialRepo)}/settings/intake`,
      { method: 'PUT', headers: credentialHeaders, body: JSON.stringify({ enabled: false }) },
    )
    assert.equal(
      firstUse.status,
      200,
      'fresh native owner credential can update last-use metadata and write',
    )
    const firstUseBody = (await firstUse.json()) as { event: { actor: unknown } }
    assert.deepEqual(firstUseBody.event.actor, { kind: 'human', user: 'owner@example.com' })
    const [lastUse] =
      await sql`SELECT last_used_at FROM project_credentials WHERE id=${issued.credential.id}`
    assert.equal(new Date(lastUse.last_used_at).toISOString(), operatorClock)
    const ownerFacts = await store.getRepoEvents(credentialRepo)
    ownerFacts.forEach(validateRepositoryEventWrite)
    assert.equal(ownerFacts.length, 1)
    await sql`UPDATE project_credentials SET revoked_at=${operatorClock} WHERE id=${issued.credential.id}`
    const revoked = await fetch(
      `${address}/operator/v1/repos/${encodeURIComponent(credentialRepo)}/settings/intake`,
      { method: 'PUT', headers: credentialHeaders, body: JSON.stringify({ enabled: true }) },
    )
    assert.equal(revoked.status, 401)
    assert.equal(
      (await store.getRepoEvents(credentialRepo)).length,
      1,
      'revocation rechecked without lifecycle write',
    )
    const controlEvidence = recordSuite(
      'control',
      await replayNativeControls({ sql, store, address }),
    )
    const readOracle = createOperatorServer({
      store,
      projects: testProjects([operatorRepo]),
      secret: 'offline-operator-fixture-secret',
      clock,
    })
    const readHeaders = {
      authorization: `Bearer ${mintToken('offline-operator-fixture-secret', { version: 1, internalOperator: { repo: operatorRepo, user: 'operator@example.com' }, exp: clock().getTime() + 60000 })}`,
      'x-autobuild-version': AUTOBUILD_VERSION,
      'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
    }
    await store.createBuild({
      slug: 'native-queued-read',
      repo: operatorRepo,
      created: createdWrite,
    })
    for (const scope of ['active', 'queued', 'all', 'invalid']) {
      const path = `/operator/v1/repos/${encodeURIComponent(operatorRepo)}/builds?scope=${scope}`
      const expected = await readOracle.fetch(
        new Request(`http://oracle.invalid${path}`, { headers: readHeaders }),
      )
      const actual = await fetch(`${address}${path}`, { headers: readHeaders })
      assert.equal(actual.status, expected.status)
      const body = await actual.json()
      assert.deepEqual(body, await expected.json(), `native builds ${scope} read parity`)
      readWitness(
        scope === 'invalid' ? 'builds:invalid-scope' : `builds:${scope}`,
        path,
        actual.status,
        body,
      )
    }
    await store.putArtifact('native-control', {
      kind: 'proof bytes',
      content: new Uint8Array([0, 255, 1, 128]),
      metadata: { source: 'native-read-proof' },
    })
    for (const suffix of [
      '',
      '?rev=0',
      '?rev=0000',
      '?rev=9007199254740991',
      '?rev=9007199254740992',
      '?rev=-1',
      '?rev=1e0',
    ]) {
      const path = `/operator/v1/repos/${encodeURIComponent(operatorRepo)}/builds/native-control/artifacts/proof%20bytes${suffix}`
      const expected = await readOracle.fetch(
        new Request(`http://oracle.invalid${path}`, { headers: readHeaders }),
      )
      const actual = await fetch(`${address}${path}`, { headers: readHeaders })
      assert.equal(actual.status, expected.status, `artifact ${suffix} status`)
      for (const key of [
        'content-type',
        'content-disposition',
        'x-autobuild-artifact-kind',
        'x-autobuild-artifact-revision',
        'x-autobuild-artifact-blob-ref',
      ])
        assert.equal(
          actual.headers.get(key),
          expected.headers.get(key),
          `artifact ${suffix} ${key}`,
        )
      const bytes = new Uint8Array(await actual.arrayBuffer())
      assert.deepEqual(
        bytes,
        new Uint8Array(await expected.arrayBuffer()),
        `artifact ${suffix} bytes`,
      )
      readWitness('artifacts:binary-revisions', path, actual.status, {
        contentBase64: Buffer.from(bytes).toString('base64'),
      })
    }
    recordSuite(
      'api-reads',
      await replayNativeReads({ sql, store, address, include: selection?.readCases }),
    )
    recordSuite(
      'advanced',
      selection?.skipAdvanced ? [] : await replayAdvancedControls({ sql, store, address }),
    )
    const outcomeCases: string[] = [],
      schemaCases: string[] = []
    await replayNativeRegistry({ sql, store, address, outcomeCases, schemaCases })
    recordSuite('registry', outcomeCases)
    recordSuite('registry-schemas', schemaCases)
    recordSuite('registry-domains', await replayNativeRegistryDomains({ sql, store, address }))
    const spawnProofServer = async (overrides: Record<string, string | undefined>) => {
      const spawned = await bridge({ ...writerEnv, ...overrides }, runtime, [native])
      let closed = false
      const close = async () => {
        if (closed) return
        closed = true
        extraServers.delete(close)
        await spawned.close()
      }
      extraServers.add(close)
      try {
        const address = (await spawned.request({ op: 'http-address' })).value as string
        return { address, close }
      } catch (error) {
        await close()
        throw error
      }
    }
    recordSuite(
      'repository-controls',
      await replayRepositoryControls({ sql, store, address, witnesses: operationWitnesses }),
    )
    recordSuite(
      'delegation',
      await replayNativeDelegation({
        sql,
        store,
        address,
        spawnServer: ({ secret }) => spawnProofServer({ AB_STORE_SECRET: secret }),
      }),
    )
    if (!selection?.skipAnswerFailures) {
      const upstreamS3Endpoint = environment.AB_S3_ENDPOINT
      if (!upstreamS3Endpoint) throw new Error('Answer failure proof requires isolated S3 endpoint')
      const failureEvidence = await replayAnswerFailures({
        sql,
        store,
        address,
        upstreamS3Endpoint,
        spawnServer: spawnProofServer,
        witnesses: operationWitnesses,
      })
      recordSuite('answer-failures', failureEvidence)
    }
    recordSuite('session-config', await replaySessionConfiguration({ sql, store, address }))
    const httpStore = store
    const httpChecked: string[] = []
    for (const fixture of corpus.fixtures.filter((f) => f.scenario.route.includes('sessions'))) {
      await sql`TRUNCATE sessions CASCADE`
      const bindings: string[] = []
      for (const seed of fixture.seed) {
        const source = seed.record as { repo: string; operator: string; title?: string }
        const record = await httpStore.createSession({
          repo: source.repo,
          operator: source.operator,
          title: source.title,
        })
        bindings.push(record.id)
        // The seed's first creation fact is produced by the same store call above.
        for (const raw of seed.events.slice(1)) {
          const e = raw as { actor: unknown; type: string; payload: unknown }
          await httpStore.appendSessionEvent(record.id, validateSessionEventWrite(e))
        }
      }
      for (let i = 0; i < fixture.scenario.requests.length; i++) {
        const input = fixture.scenario.requests[i]!
        const token = mintToken(
          'offline-operator-fixture-secret',
          input.auth === 'admin'
            ? {
                version: 1,
                ownerAdmin: { user: input.user ?? 'operator@example.com' },
                exp: clock().getTime() + 60000,
              }
            : {
                version: 1,
                internalOperator: {
                  repo: input.auth === 'foreign' ? 'foreign/repo' : operatorRepo,
                  user: input.user ?? 'operator@example.com',
                },
                exp: clock().getTime() + (input.auth === 'expired' ? -1 : 60000),
              },
        )
        const headers = new Headers()
        if (input.version !== null)
          headers.set('X-Autobuild-Version', input.version ?? AUTOBUILD_VERSION)
        if (input.protocol !== null)
          headers.set(
            'X-Autobuild-Protocol-Version',
            input.protocol ?? String(REMOTE_STORE_PROTOCOL_VERSION),
          )
        if (input.auth !== 'missing')
          headers.set('Authorization', `Bearer ${input.auth === 'invalid' ? 'invalid' : token}`)
        const path = bindings.reduce(
          (p, id, n) => p.replaceAll(`$session:${n}`, encodeURIComponent(id)),
          input.path,
        )
        const response = await fetch(
          `${address}/operator/v1/repos/${encodeURIComponent(operatorRepo)}/${path}`,
          {
            method: input.method,
            headers,
            body:
              input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body)),
          },
        )
        const actual = (await response.json()) as { id?: string }
        if (response.status === 201 && actual.id) bindings.push(actual.id)
        const expected = fixture.observations[i]!
        assert.equal(response.status, expected.status, `${fixture.scenario.id}: real HTTP status`)
        assert.deepEqual(
          bindOperatorIds(actual, bindings),
          expected.body,
          `${fixture.scenario.id}: real HTTP body`,
        )
        assert.equal(response.headers.get('content-type'), expected.headers['content-type'])
        const records = [
          ...(await httpStore.listSessions(operatorRepo)),
          ...(await httpStore.listSessions('foreign/repo')),
        ]
        const snapshots = await Promise.all(
          records.map(async (record) => {
            const events = await httpStore.getSessionEvents(record.id)
            events.forEach(validateSessionEventWrite)
            return { record, events, state: reduceSession(events) }
          }),
        )
        assert.deepEqual(
          bindOperatorIds(snapshots, bindings),
          expected.sessions,
          `${fixture.scenario.id}: real HTTP durable state`,
        )
      }
      httpChecked.push(fixture.scenario.id)
    }

    const streamSession = await store.createSession({
      repo: operatorRepo,
      operator: 'operator@example.com',
    })
    const stream = await store.createStream(
      { kind: 'session', session: streamSession.id },
      'turn:stream-proof',
    )
    await store.appendSessionEvent(streamSession.id, {
      actor: { kind: 'agent', role: 'orchestrator', session: 'turn-proof' },
      type: 'turn.started',
      payload: {
        turn: 'turn-proof',
        stream: stream.id,
        trigger: { kind: 'message', messageSeq: 1 },
      },
    })
    await store.appendStreamParts(stream.id, [
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Native stream bytes' },
    ])
    const streamPath = `/operator/v1/repos/${encodeURIComponent(operatorRepo)}/sessions/${streamSession.id}/turns/turn-proof/stream`
    for (const suffix of ['', '?since=0', '?since=1&wait=-1']) {
      const expected = await readOracle.fetch(
        new Request(`http://oracle.invalid${streamPath}${suffix}`, { headers: readHeaders }),
      )
      const actual = await fetch(`${address}${streamPath}${suffix}`, { headers: readHeaders })
      assert.equal(actual.status, expected.status)
      const body = await actual.json()
      assert.deepEqual(body, await expected.json(), `session stream ${suffix}`)
      readWitness('sessions:open-closed-stream', `${streamPath}${suffix}`, actual.status, body)
    }
    let responded = false
    const held = fetch(`${address}${streamPath}?since=1&wait=2`, { headers: readHeaders }).then(
      (response) => {
        responded = true
        return response
      },
    )
    await Bun.sleep(100)
    assert.equal(responded, false, 'open stream waits for a newer chunk')
    await store.appendStreamParts(stream.id, [
      { type: 'text-delta', id: 'text-1', delta: ' delayed' },
    ])
    const awakened = await held
    assert.deepEqual(
      await awakened.json(),
      await store.readStream(stream.id, { since: 1 }),
      'bounded stream wait observes actual later PostgreSQL chunk',
    )
    const deadline = Date.now()
    const emptyWait = await fetch(`${address}${streamPath}?since=2&wait=1`, {
      headers: readHeaders,
    })
    const waited = Date.now() - deadline
    assert(waited >= 900 && waited < 2500, 'empty open stream returns at its one-second bound')
    assert.deepEqual(await emptyWait.json(), await store.readStream(stream.id, { since: 2 }))
    await store.closeStream(stream.id, 'completed')
    const closedExpected = await readOracle.fetch(
      new Request(`http://oracle.invalid${streamPath}`, { headers: readHeaders }),
    )
    const closedActual = await fetch(`${address}${streamPath}`, { headers: readHeaders })
    assert.equal(closedActual.status, closedExpected.status)
    const closedBody = await closedActual.json()
    assert.deepEqual(
      closedBody,
      await closedExpected.json(),
      'closed session stream artifact metadata',
    )
    readWitness('sessions:open-closed-stream', streamPath, closedActual.status, closedBody)
    const ticketProof = await ticketIntegration(adminUrl, environment)
    recordSuite('ticket-http', {
      cases: ticketProof.witnesses.map((w) => w.id),
      witnesses: ticketProof.witnesses,
    })
    recordSuite('operator-sessions', httpChecked)
    if (!selection) await checkOperatorCoverage(coverage)

    evidence = {
      checkpoint: 'native-operator-contract',
      claims: operatorFoundationClaims,
      sessionCases: checked,
      httpParity: !selection,
      httpSessionCases: httpChecked,
      controlCases: controlEvidence,
      readCases: [
        'builds:active',
        'builds:queued',
        'builds:all',
        'builds:invalid-scope',
        'artifacts:binary-revisions',
        'sessions:open-closed-stream',
      ],
      coverage,
    }
    const output = resolve(project, '../../.ab/proa-operator-evidence')
    await mkdir(output, { recursive: true })
    const resultPath = resolve(output, 'results.json')
    await Bun.write(resultPath, `${JSON.stringify(evidence, null, 2)}\n`)
    await Bun.write(resolve(output, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`)
    console.log(
      JSON.stringify({
        resultPath,
        httpParity: evidence.httpParity,
        suites: Object.fromEntries(
          Object.entries(coverage.suites).map(([suite, cases]) => [suite, cases.length]),
        ),
      }),
    )
  } catch (error) {
    failure = error
  } finally {
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    const errors: unknown[] = []
    for (const close of [
      ...extraServers,
      () => readonly?.close(),
      () => rust?.close(),
      () => store?.close(),
      () => sql?.close(),
      () => (created ? admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`) : undefined),
      ...roles.map((role) => () => admin.unsafe(`DROP ROLE ${role}`)),
      () => admin.close(),
      () => rm(runtime, { recursive: true, force: true }),
    ]) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) failure ??= new AggregateError(errors, 'Operator proof cleanup failed')
  }
  if (failure) throw failure
  if (!evidence) throw new Error('Operator proof did not produce evidence')
  return evidence
}
if (import.meta.main) await withDataServices((adminUrl, env) => operatorIntegration(adminUrl, env))
