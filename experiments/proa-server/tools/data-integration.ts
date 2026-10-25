import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { migratePostgres } from '../../../packages/postgres-store/src/schema'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import {
  buildCreatedWrite,
  messagePostedWrite,
  sampleEventWrite,
} from '../../../packages/core/src/store/contract'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { reduceSession } from '../../../packages/core/src/store/session-reducer'
import { withDataServices } from './data-services'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { expected } from './fixture-core'

const project = resolve(import.meta.dir, '..')
export async function buildNative(env: Record<string, string | undefined>) {
  const child = Bun.spawn(
    [
      'cargo',
      'build',
      '--locked',
      '--example',
      'data-proof',
      '--bin',
      'proa-server',
      '--message-format=json',
    ],
    {
      cwd: project,
      env,
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error('Native data proof build failed')
  const paths = new Map<string, string>()
  for (const line of output.split('\n').filter(Boolean)) {
    const artifact = JSON.parse(line) as {
      reason: string
      message?: { rendered?: string }
      executable?: string
      target?: { name: string }
    }
    if (artifact.reason === 'compiler-message' && artifact.message?.rendered)
      process.stderr.write(artifact.message.rendered)
    if (artifact.reason === 'compiler-artifact' && artifact.executable && artifact.target)
      paths.set(artifact.target.name, artifact.executable)
  }
  const reader = paths.get('data-proof'),
    server = paths.get('proa-server')
  if (!reader || !server) throw new Error('Cargo did not report native proof executables')
  return { reader, server }
}
export async function bridge(
  env: Record<string, string | undefined>,
  cwd: string,
  command: string[],
) {
  // Spawn the actual executable so timeouts/signals reap the reader, not a cargo parent.
  const child = Bun.spawn(command, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let diagnostics = ''
  const stderr = (async () => {
    for await (const bytes of child.stderr) {
      diagnostics += new TextDecoder().decode(bytes)
      process.stderr.write(bytes)
    }
  })()
  const lines = (async function* () {
    let pending = ''
    for await (const bytes of child.stdout) {
      pending += new TextDecoder().decode(bytes)
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n')
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        yield JSON.parse(line)
      }
    }
    const exit = await child.exited
    await stderr
    throw Error(`Rust data bridge closed (exit ${exit}): ${diagnostics}`)
  })()
  const next = async () => {
    const timer = setTimeout(() => child.kill(), 180000)
    try {
      return (await lines.next()).value
    } finally {
      clearTimeout(timer)
    }
  }
  assert.equal((await next()).ready, true)
  return {
    async request(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      await child.stdin.flush()
      return next()
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 10000)
      try {
        await child.exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
export async function integration(
  adminUrl: string,
  environment: Record<string, string | undefined>,
  options: { failRust?: boolean } = {},
) {
  const native = await buildNative(environment)
  const readerCommand = [native.reader, ...(options.failRust ? ['--fail-for-cleanup'] : [])]
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const database = `proa_proof_${suffix}`
  const role = `proa_read_${suffix}`
  const password = crypto.randomUUID()
  const admin = new SQL(adminUrl, { max: 1 })
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  let store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
  let writer: SQL | undefined
  let rust: Awaited<ReturnType<typeof bridge>> | undefined
  const runtime = await mkdtemp(resolve(tmpdir(), 'proa-data-runtime-'))
  let created = false,
    roleCreated = false
  const terminate = () => {
    void rust?.close()
  }
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  let failure: unknown
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`)
    created = true
    await migratePostgres(url.href)
    writer = new SQL(url.href, { max: 1 })
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    roleCreated = true
    await writer.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`)
    await writer.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await writer.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    store = await openPostgresBuildStoreFromEnv({ ...environment, AB_POSTGRES_URL: url.href })
    const registry = new PostgresProjectRegistry(writer)
    const repo = (await registry.add('https://github.com/proa/data-proof', 'integration')).repo
    await registry.add('https://github.com/proa/removed', 'integration')
    await registry.remove('https://github.com/proa/removed', 'integration')
    const createdWrite = buildCreatedWrite()
    createdWrite.payload.repo = repo
    await store.createBuild({ slug: 'healthy', repo, created: createdWrite })
    await store.createBuild({ slug: 'unknown', repo, created: createdWrite })
    await store.createBuild({ slug: 'empty', repo })
    await store.createBuild({ slug: 'foreign', repo: 'foreign' })
    await store.append('healthy', sampleEventWrite('first'))
    await store.ensureRepo(repo)
    await store.ensureRepo('empty-repository')
    await store.appendRepo(repo, {
      actor: { kind: 'human', user: 'integration' },
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })
    const session = await store.createSession({ repo, operator: 'integration' })
    await store.appendSessionEvent(session.id, messagePostedWrite('first'))
    const binary = new Uint8Array([0, 128, 255, 1, 0, 42])
    for (const [kind, content] of [
      ['binary', binary],
      ['missing-object', binary.slice(1)],
    ] as const)
      await store.putArtifact('healthy', { kind, content })
    await store.putArtifact('healthy', { kind: 'binary', content: new Uint8Array([7, 8, 9]) })
    await store.putRepoArtifact(repo, { kind: 'binary', content: binary })
    await store.putSessionArtifact(session.id, { kind: 'binary', content: binary })
    // A future writer's event bypasses the current validator only for compatibility fault injection.
    await writer`INSERT INTO events (build, seq, ts, actor, type, payload) VALUES ('unknown', 2, now(), ${JSON.stringify({ kind: 'kernel', id: 'integration' })}::jsonb, 'future.unknown', '{}'::jsonb)`
    const missing =
      await writer`SELECT blob_ref FROM artifacts WHERE build = 'healthy' AND kind = 'missing-object'`
    // Keep valid metadata while removing its object through the actual S3 client.
    const { S3Client, DeleteObjectCommand } = await import(
      '../../../packages/postgres-store/node_modules/@aws-sdk/client-s3'
    )
    const s3 = new S3Client({
      endpoint: environment.AB_S3_ENDPOINT,
      region: environment.AB_S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    })
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: environment.AB_S3_BUCKET,
          Key: `proof/artifacts/${missing[0].blob_ref}`,
        }),
      )
    } finally {
      s3.destroy()
    }
    const readerUrl = new URL(url)
    readerUrl.username = role
    readerUrl.password = password
    const env = { ...environment, AB_POSTGRES_URL: readerUrl.href }
    // Hash every table's content and schema before/after Rust reads (order independent).
    const snapshot = async () => {
      const tables =
        await writer!`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      const contents: unknown[] = []
      for (const { tablename } of tables)
        contents.push([
          tablename,
          await writer!.unsafe(
            `SELECT row_to_json(t)::text AS row FROM "${tablename}" t ORDER BY row_to_json(t)::text`,
          ),
        ])
      const columns =
        await writer!`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
      const constraints =
        await writer!`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conrelid::regclass::text, conname`
      const indexes =
        await writer!`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`
      return JSON.stringify({ contents, columns, constraints, indexes })
    }
    rust = await bridge(env, runtime, readerCommand)
    const value = async (command: Record<string, unknown>) => {
      const reply = await rust!.request({ repo, ...command })
      assert.equal(reply.error, undefined)
      return reply.value
    }
    const stream = await store.createStream({ kind: 'build', build: 'healthy' }, 'session:proof')
    await store.appendStreamParts(stream.id, [
      { type: 'text-delta', id: 'proof-text', delta: 'first streamed text' },
    ])
    const before = await snapshot()
    assert.equal((await value({ op: 'projects' })).length, 1)
    assert.equal((await value({ op: 'builds' })).length, 3)
    assert.equal((await value({ op: 'sessions' }))[0].id, session.id)
    assert.deepEqual(await value({ op: 'build', id: 'empty' }), {
      build: encodeReducerValue(reduceBuild([])),
    })
    assert.deepEqual(
      await value({ op: 'repository', repo: 'empty-repository' }),
      expected('repository', []),
    )
    for (const command of [
      { op: 'build', repo: 'foreign', id: 'healthy' },
      { op: 'build', repo, id: 'absent' },
      { op: 'repository', repo: 'absent' },
      { op: 'session', repo: 'foreign', id: session.id },
    ])
      assert.match(
        (await rust.request(command)).error,
        /scope does not exist in the selected project/,
      )
    const first = await value({ op: 'build', id: 'healthy' })
    assert.deepEqual(first, {
      build: encodeReducerValue(reduceBuild(await store.getEvents('healthy'))),
    })
    assert.deepEqual(await value({ op: 'session', id: session.id }), {
      session: encodeReducerValue(reduceSession(await store.getSessionEvents(session.id))),
    })
    assert.deepEqual(
      await value({ op: 'repository' }),
      expected('repository', await store.getRepoEvents(repo)),
    )
    for (const [scope, id] of [
      ['build', 'healthy'],
      ['repository', ''],
      ['session', session.id],
    ])
      assert.deepEqual(
        await value({
          op: 'artifact',
          scope,
          id,
          kind: 'binary',
          ...(scope === 'build' ? { revision: 0 } : {}),
        }),
        [...binary],
      )
    assert.deepEqual(
      await value({ op: 'artifact', scope: 'build', id: 'healthy', kind: 'binary' }),
      [7, 8, 9],
    )
    assert.equal(
      await value({ op: 'artifact', scope: 'build', id: 'healthy', kind: 'absent' }),
      null,
    )
    assert.match(
      (
        await rust.request({
          op: 'artifact',
          repo,
          scope: 'build',
          id: 'healthy',
          kind: 'missing-object',
        })
      ).error,
      /blob object is missing/,
    )
    const states = await value({ op: 'project' })
    assert.equal(states.find((v: { slug: string }) => v.slug === 'unknown').status, 'unreadable')
    assert.equal(states.find((v: { slug: string }) => v.slug === 'healthy').status, 'readable')
    assert.equal(await snapshot(), before, 'Rust changed TypeScript-owned tables')
    // An append-only unreadable stream stays poisoned, including after appends:
    // repeated project polls must not fetch its failed suffix again.
    const failedCounts = await value({ op: 'counts' })
    const unknownQueries = failedCounts.filter(
      (v: { scope: string }) => v.scope === 'build:unknown',
    )
    assert.deepEqual(
      unknownQueries.map((v: { rows: number }) => v.rows),
      [2],
    )
    await writer`INSERT INTO events (build, seq, ts, actor, type, payload) VALUES ('unknown', 3, now(), ${JSON.stringify({ kind: 'kernel' })}::jsonb, 'future.appended', '{}'::jsonb)`
    for (let poll = 0; poll < 3; poll++) {
      const again = await value({ op: 'project' })
      assert.deepEqual(
        again.find((v: { slug: string }) => v.slug === 'unknown'),
        states.find((v: { slug: string }) => v.slug === 'unknown'),
      )
    }
    assert.deepEqual(
      (await value({ op: 'counts' })).filter((v: { scope: string }) => v.scope === 'build:unknown'),
      unknownQueries,
    )

    const streamed = await value({ op: 'stream', id: 'healthy', stream: stream.id })
    assert.equal(streamed, 'first streamed text', JSON.stringify(await value({ op: 'counts' })))
    assert.equal(
      await value({ op: 'stream', id: 'healthy', stream: stream.id }),
      'first streamed text',
    )
    const streamReads = (await value({ op: 'counts' })).filter(
      (read: { scope: string }) => read.scope === `stream:${stream.id}`,
    )
    assert.deepEqual(
      streamReads.map((read: { after: number; rows: number }) => [read.after, read.rows]),
      [
        [0, 1],
        [1, 0],
      ],
    )
    await value({ op: 'artifact', scope: 'build', id: 'healthy', kind: 'binary' })
    const blobReads = (await value({ op: 'counts' })).filter((read: { scope: string }) =>
      read.scope.startsWith('artifact:binary@'),
    )
    assert.equal(
      new Set(blobReads.map((read: { scope: string }) => read.scope)).size,
      blobReads.length,
      'immutable scoped binary revision was downloaded more than once',
    )
    await store.append('healthy', sampleEventWrite('second'))
    const concurrent = await value({ op: 'concurrent', id: 'healthy' })
    assert.deepEqual(concurrent[0], concurrent[1])
    assert.deepEqual(concurrent[0], {
      build: encodeReducerValue(reduceBuild(await store.getEvents('healthy'))),
    })
    await value({ op: 'build', id: 'healthy' })
    const counts = (await value({ op: 'counts' })).filter(
      (v: { scope: string }) => v.scope === 'build:healthy',
    )
    assert.equal(counts[0].rows, 2)
    assert.deepEqual(
      counts.slice(-3).map((v: { rows: number }) => v.rows),
      [1, 0, 0],
    )
    // Kill all four actual reader backends. Each slot must reconnect while
    // retaining its independent cached reduction and suffix cursor.
    const oldBackends = await writer`SELECT pid FROM pg_stat_activity WHERE usename = ${role}`
    assert.equal(oldBackends.length, 4)
    await writer`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`
    for (let poll = 0; poll < 8; poll++) {
      let reply: { error?: string; value?: unknown } = await rust.request({
        op: 'build',
        repo,
        id: 'healthy',
      })
      for (let retry = 0; reply.error && retry < 20; retry++) {
        await Bun.sleep(25)
        reply = await rust.request({ op: 'build', repo, id: 'healthy' })
      }
      assert.equal(reply.error, undefined)
      assert.deepEqual(reply.value, concurrent[0])
    }
    const newBackends = await writer`SELECT pid FROM pg_stat_activity WHERE usename = ${role}`
    assert.equal(newBackends.length, 4)
    assert(
      newBackends.every(
        (row: { pid: number }) => !oldBackends.some((old: { pid: number }) => old.pid === row.pid),
      ),
    )
    await value({ op: 'clear' })
    assert.deepEqual(await value({ op: 'build', id: 'healthy' }), concurrent[0])
    for (let poll = 0; poll < 2; poll++)
      assert.match(
        (await rust.request({ op: 'build', repo, id: 'unknown' })).error,
        /future.unknown.*seq 2/,
      )
    assert.deepEqual(
      (await value({ op: 'counts' }))
        .filter((v: { scope: string }) => v.scope === 'build:unknown')
        .map((v: { rows: number }) => v.rows),
      [2, 3],
    )

    await rust.close()
    rust = undefined
    // A new process must replay with the same result.
    rust = await bridge(env, runtime, readerCommand)
    assert.deepEqual(await value({ op: 'build', id: 'healthy' }), concurrent[0])
    for (let poll = 0; poll < 2; poll++)
      assert.match(
        (await rust.request({ op: 'build', repo, id: 'unknown' })).error,
        /future.unknown.*seq 2/,
      )
    assert.deepEqual(
      (await value({ op: 'counts' }))
        .filter((v: { scope: string }) => v.scope === 'build:unknown')
        .map((v: { rows: number }) => v.rows),
      [3],
    )

    await rust.close()
    rust = undefined
    const healthySession = await store.createSession({ repo, operator: 'independent' })
    await writer`INSERT INTO repo_events (repo, seq, ts, actor, type, payload) VALUES (${repo}, 2, now(), ${JSON.stringify({ kind: 'kernel', id: 'integration' })}::jsonb, 'future.repo', '{}'::jsonb)`
    await writer`INSERT INTO session_events (session, seq, ts, actor, type, payload) VALUES (${session.id}, 3, now(), ${JSON.stringify({ kind: 'human', user: 'integration' })}::jsonb, 'future.session', '{}'::jsonb)`
    rust = await bridge(env, runtime, readerCommand)
    assert.match(
      (await rust.request({ op: 'repository', repo })).error,
      /repository.*future.repo.*seq 2/,
    )
    assert.match(
      (await rust.request({ op: 'session', repo, id: session.id })).error,
      /session.*future.session.*seq 3/,
    )
    assert.deepEqual(await value({ op: 'build', id: 'healthy' }), concurrent[0])
    assert.deepEqual(await value({ op: 'session', id: healthySession.id }), {
      session: encodeReducerValue(reduceSession(await store.getSessionEvents(healthySession.id))),
    })
    await store.createBuild({ slug: 'malformed', repo })
    await writer`INSERT INTO events (build, seq, ts, actor, type, payload) VALUES ('malformed', 1, now(), ${JSON.stringify({ kind: 'kernel' })}::jsonb, 'build.created', '{}'::jsonb)`
    const failedCommands = [
      { op: 'repository', repo },
      { op: 'session', repo, id: session.id },
      { op: 'build', repo, id: 'malformed' },
    ]
    const firstErrors = []
    for (const command of failedCommands) firstErrors.push((await rust.request(command)).error)
    assert(firstErrors.every((error) => typeof error === 'string'))
    const poisonedCounts = await value({ op: 'counts' })
    for (let poll = 0; poll < 3; poll++) {
      for (const [index, command] of failedCommands.entries())
        assert.equal((await rust.request(command)).error, firstErrors[index])
    }
    assert.deepEqual(await value({ op: 'counts' }), poisonedCounts)
    // Reconnection must also recheck the schema, never silently admit a changed marker.
    await writer`UPDATE ab_schema_migrations SET version = 999 WHERE singleton = true`
    await writer`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`
    let refusal = await rust.request({ op: 'projects' })
    for (
      let retry = 0;
      !String(refusal.error).includes('expected version 17, found 999') && retry < 20;
      retry++
    ) {
      await Bun.sleep(25)
      refusal = await rust.request({ op: 'projects' })
    }
    assert.match(refusal.error, /expected version 17, found 999/)
    await rust.close()
    rust = undefined
    await writer`UPDATE ab_schema_migrations SET version = 999 WHERE singleton = true`
    await assert.rejects(
      () => bridge(env, runtime, readerCommand),
      /expected version 17, found 999/,
    )
    // Normal production composition keeps health available while refusing schema
    // access. Private example flags must not open its bearer boundary.
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = reservation.port!
    reservation.stop(true)
    const secret = 'isolated-normal-server-secret'
    const startup = Bun.spawn([native.server], {
      cwd: runtime,
      env: {
        ...env,
        AB_STORE_SECRET: secret,
        PROA_HOST: '127.0.0.1',
        PORT: String(port),
        PROA_TEST_AUTH: 'open',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const origin = `http://127.0.0.1:${port}`
    const identity = {
      'x-autobuild-version': AUTOBUILD_VERSION,
      'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
    }
    const startupTimeout = setTimeout(() => startup.kill(), 30000)
    try {
      let healthy = false
      for (let i = 0; i < 200; i++) {
        if (startup.exitCode !== null) throw Error('Normal server exited before health')
        try {
          const response = await fetch(`${origin}/health`, {
            headers: { 'x-autobuild-version': '0.0.0', authorization: 'Bearer retired' },
          })
          assert.equal(response.status, 200)
          assert.equal(
            ((await response.json()) as { protocolVersion: string }).protocolVersion,
            REMOTE_STORE_PROTOCOL_VERSION,
          )
          healthy = true
          break
        } catch {}
        await Bun.sleep(25)
      }
      assert.ok(healthy, 'normal health unavailable during schema refusal')
      assert.equal((await fetch(`${origin}/readyz`)).status, 503)
      const unauthenticated = await fetch(`${origin}/builds`, {
        headers: { ...identity, origin: 'https://foreign.invalid', accept: 'text/html' },
      })
      assert.equal(unauthenticated.status, 401, 'private open flag must not affect production')
      assert.ok(unauthenticated.headers.get('content-type')?.startsWith('application/json'))
      assert.equal(unauthenticated.headers.get('location'), null)
      const headers = {
        ...identity,
        authorization: `Bearer ${mintToken(secret, { version: 1, ownerAdmin: { user: 'proof' }, exp: Date.now() + 60000 })}`,
      }
      const refused = await fetch(`${origin}/builds`, { headers })
      assert.equal(refused.status, 500)
      assert.deepEqual(await refused.json(), { kind: 'internal', error: 'internal server error' })
      // Failed initial preflight leaves the deferred slot retryable.
      await writer`UPDATE ab_schema_migrations SET version = 17 WHERE singleton = true`
      assert.equal((await fetch(`${origin}/readyz`)).status, 200)
      const admitted = await fetch(`${origin}/builds`, { headers })
      assert.equal(admitted.status, 200)
      assert.ok(Array.isArray(await admitted.json()))
    } finally {
      clearTimeout(startupTimeout)
      startup.kill()
      const timer = setTimeout(() => startup.kill('SIGKILL'), 5000)
      try {
        await startup.exited
      } finally {
        clearTimeout(timer)
      }
      // Consume but never persist process output (configuration can contain secrets).
      await Promise.all([new Response(startup.stdout).text(), new Response(startup.stderr).text()])
    }
    const missingSecret = Bun.spawn([native.server], {
      cwd: runtime,
      env: { ...env, AB_STORE_SECRET: '  ', PROA_HOST: '127.0.0.1', PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const secretTimer = setTimeout(() => missingSecret.kill(), 10000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(missingSecret.stdout).text(),
        new Response(missingSecret.stderr).text(),
        missingSecret.exited,
      ])
      assert.notEqual(code, 0)
      assert.match(stderr, /AB_STORE_SECRET is required and must be nonblank/)
      assert.doesNotMatch(stdout, /Proa site listening/)
    } finally {
      clearTimeout(secretTimer)
    }

    console.log(
      'TS-write/Rust-read proof passed: binary artifacts, scope isolation, read-only tables, N=2 M=1 zero=0, concurrency, restart, poisoned-scope zero-query polls, backend reconnection, schema refusal',
    )
    console.log(
      'Credentialed Vercel read proof unavailable unless explicitly provisioned; pinned-SDK wire tests run in Cargo suite',
    )
  } catch (error) {
    failure = error
  } finally {
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    const errors: unknown[] = []
    for (const close of [
      () => rust?.close(),
      () => store?.close(),
      () => writer?.close(),
      () => (created ? admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`) : undefined),
      () => (roleCreated ? admin.unsafe(`DROP ROLE ${role}`) : undefined),
      () => admin.close(),
      () => rm(runtime, { recursive: true, force: true }),
    ]) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      console.error('Data proof cleanup failed', errors)
      failure ??= new AggregateError(errors, 'Data proof cleanup failed')
    }
  }
  if (failure) throw failure
}
if (import.meta.main)
  await withDataServices(async (adminUrl, env) => {
    const admin = new SQL(adminUrl, { max: 1 })
    try {
      const resources = async () => ({
        databases:
          await admin`SELECT datname FROM pg_database WHERE datname LIKE 'proa_proof_%' ORDER BY datname`,
        roles:
          await admin`SELECT rolname FROM pg_roles WHERE rolname LIKE 'proa_read_%' ORDER BY rolname`,
      })
      const before = await resources()
      await assert.rejects(
        () =>
          integration(adminUrl, env, {
            failRust: true,
          }),
        /Rust data bridge closed/,
      )
      assert.deepEqual(await resources(), before, 'failed Rust child leaked or deleted resources')
      await integration(adminUrl, env)
      assert.deepEqual(await resources(), before, 'successful proof leaked or deleted resources')
    } finally {
      await admin.close()
    }
  })
