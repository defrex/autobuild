/** Native Rust-write / TypeScript-read proof. No live dispatcher or credentials are used. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
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
) {
  const native = executable ?? (await buildOperatorNative(environment))
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
  let created = false
  const roles: string[] = []
  let failure: unknown
  let evidence:
    | {
        checkpoint: string
        claims: typeof operatorFoundationClaims
        sessionCases: string[]
        httpParity: boolean
        dispatcherProof: boolean
      }
    | undefined
  const terminate = () => {
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
    // Exact exercised writer capabilities. No DDL, deletes, ownership or broad table-write grant.
    await sql.unsafe(
      `GRANT INSERT, UPDATE ON sessions, session_events, builds, events, repo_streams, repo_events, repo_change_positions TO ${writerRole}`,
    )
    await sql.unsafe(`GRANT USAGE ON SEQUENCE sessions_creation_seq TO ${writerRole}`)
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
    const writerEnv = withRole(writerRole)
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

    evidence = {
      checkpoint: 'native-session-storage-foundation',
      claims: operatorFoundationClaims,
      sessionCases: checked,
      httpParity: false,
      dispatcherProof: false,
    }
    console.log(JSON.stringify(evidence))
  } catch (error) {
    failure = error
  } finally {
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    const errors: unknown[] = []
    for (const close of [
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
