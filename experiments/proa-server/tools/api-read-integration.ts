/** Full native HTTP read replay over TypeScript-seeded PostgreSQL/S3. */
import { strict as assert } from 'node:assert'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { validateEventWrite, type EventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import {
  apiReadRepo,
  apiReadSlug,
  apiReadForeignRepo,
  checkApiReadCorpus,
  type ApiReadFixture,
  type ApiReadArtifact,
} from './api-read-fixtures'
import { operatorClock } from './operator-fixtures'

function bind(value: unknown, repo: string, slug: string, foreign: string): unknown {
  if (typeof value === 'string')
    return value
      .replaceAll(apiReadRepo, repo)
      .replaceAll(apiReadForeignRepo, foreign)
      .replaceAll(apiReadSlug, slug)
  if (Array.isArray(value)) return value.map((item) => bind(item, repo, slug, foreign))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        bind(key, repo, slug, foreign) as string,
        bind(item, repo, slug, foreign),
      ]),
    )
  return value
}
async function seedArtifact(
  store: BuildStore,
  scope: { repo: string; slug?: string },
  artifact: ApiReadArtifact,
) {
  const input = {
    kind: artifact.meta.kind,
    content: Buffer.from(artifact.base64, 'base64'),
    metadata: artifact.meta.metadata,
  }
  const meta = scope.slug
    ? await store.putArtifact(scope.slug, input)
    : await store.putRepoArtifact(scope.repo, input)
  assert.equal(meta.revision, artifact.meta.revision, 'seed artifact revision')
  assert.equal(meta.blobRef, artifact.meta.blobRef, 'seed content address')
}
/** Exposed independently so callers can inspect only test-owned seed rows. */
export async function seedNativeApiRead(
  options: { sql: SQL; store: BuildStore },
  fixture: ApiReadFixture,
) {
  const { sql, store } = options
  for (const input of fixture.seed.builds) {
    const { record, events } = input,
      first = events[0]
    assert.equal(first?.type, 'build.created', 'every build seed begins at its creation fact')
    await store.createBuild({
      slug: record.slug,
      repo: record.repo,
      ...(record.ticket ? { ticket: record.ticket } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.repoOrigin ? { repoOrigin: record.repoOrigin } : {}),
      created: validateEventWrite(first!) as EventWrite<'build.created'>,
    })
    for (const event of events.slice(1)) await store.append(record.slug, validateEventWrite(event))
    for (const artifact of input.artifacts)
      await seedArtifact(store, { repo: record.repo, slug: record.slug }, artifact)
    // Mutable liveness metadata is an explicit input, never inferred from events.
    await sql`UPDATE builds SET created_at=${record.createdAt},updated_at=${record.updatedAt},heartbeat_at=${record.heartbeatAt ?? null},lease_holder=${record.lease?.holder ?? null},lease_expires_at=${record.lease?.expiresAt ?? null},lease_ttl_ms=${record.lease ? 30000 : null} WHERE slug=${record.slug}`
    for (const event of events)
      await sql`UPDATE events SET ts=${event.ts} WHERE build=${record.slug} AND seq=${event.seq}`
    assert.deepEqual(await store.getBuild(record.slug), record, 'native seed build metadata')
  }
  const { record, events, artifacts } = fixture.seed.repository
  if (record) {
    await store.ensureRepo(record.repo)
    for (const artifact of artifacts) await seedArtifact(store, { repo: record.repo }, artifact)
    for (const event of events)
      await store.appendRepo(record.repo, validateRepositoryEventWrite(event))
    await sql`UPDATE repo_streams SET created_at=${record.createdAt},updated_at=${record.updatedAt},heartbeat_at=${record.heartbeatAt ?? null},lease_holder=${record.lease?.holder ?? null},lease_expires_at=${record.lease?.expiresAt ?? null},lease_ttl_ms=${record.lease ? 30000 : null},tick=${record.tick ?? null} WHERE repo=${record.repo}`
    for (const event of events)
      await sql`UPDATE repo_events SET ts=${event.ts} WHERE repo=${record.repo} AND seq=${event.seq}`
    assert.deepEqual(await store.getRepo(record.repo), record, 'native seed repository metadata')
  }
}
export async function replayNativeReads(options: {
  sql: SQL
  store: BuildStore
  address: string
  include?: readonly string[]
}) {
  const corpus = await checkApiReadCorpus(),
    checked: string[] = []
  for (const original of corpus.fixtures) {
    if (options.include && !options.include.includes(original.scenario.id)) continue
    const repo = `api-read-fixture/${original.scenario.id}`,
      slug = `api-read-fixture-${original.scenario.id}`,
      foreign = `api-read-foreign/${original.scenario.id}`
    const fixture = bind(original, repo, slug, foreign) as ApiReadFixture
    await options.sql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    await seedNativeApiRead(options, fixture)
    const beforeBuilds = await Promise.all(
      fixture.seed.builds.map(async (input) => ({
        record: await options.store.getBuild(input.record.slug),
        events: await options.store.getEvents(input.record.slug),
      })),
    )
    const beforeRepo = await options.store.getRepo(repo)
    const beforeJournal = beforeRepo ? await options.store.getRepoEvents(repo) : []
    const token = mintToken('offline-operator-fixture-secret', {
      version: 1,
      internalOperator: { user: 'operator@example.com', repo },
      exp: new Date(operatorClock).getTime() + 60000,
    })
    const response = await fetch(
      `${options.address}/operator/v1/repos/${encodeURIComponent(repo)}/${fixture.scenario.path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        },
      },
    )
    const body: unknown = await response.json()
    assert.equal(
      response.status,
      fixture.status,
      `${fixture.scenario.id}: status; ${JSON.stringify(body)}`,
    )
    assert.equal(
      response.headers.get('content-type'),
      fixture.headers['content-type'],
      `${fixture.scenario.id}: content type`,
    )
    assert.deepEqual(body, fixture.body, `${fixture.scenario.id}: complete API read/refusal body`)
    assert.deepEqual(
      await options.store.getRepo(repo),
      beforeRepo,
      `${fixture.scenario.id}: read changed/created repository metadata`,
    )
    if (beforeRepo)
      assert.deepEqual(
        await options.store.getRepoEvents(repo),
        beforeJournal,
        `${fixture.scenario.id}: read wrote repository events`,
      )
    for (const input of beforeBuilds) {
      assert.deepEqual(
        await options.store.getBuild(input.record!.slug),
        input.record,
        `${fixture.scenario.id}: read changed build metadata`,
      )
      assert.deepEqual(
        await options.store.getEvents(input.record!.slug),
        input.events,
        `${fixture.scenario.id}: read wrote build events`,
      )
    }
    checked.push(fixture.scenario.id)
  }
  return checked
}

/** Prove the seed manifest independently before using it as a native oracle. */
export async function replayTypeScriptReadSeeds(options: { sql: SQL; store: BuildStore }) {
  const {
    getOperatorBuild,
    getOperatorDashboard,
    getRepositoryStatus,
    getHarvestStatus,
    OperatorQueryError,
  } = await import('../../../packages/core/src/operator/query')
  const corpus = await checkApiReadCorpus(),
    checked: string[] = []
  for (const original of corpus.fixtures) {
    const repo = `api-seed-proof/${original.scenario.id}`,
      slug = `api-seed-proof-${original.scenario.id}`,
      foreign = `api-seed-foreign/${original.scenario.id}`
    const fixture = bind(original, repo, slug, foreign) as ApiReadFixture
    await seedNativeApiRead(options, fixture)
    let status = 200,
      body: unknown
    try {
      if (fixture.scenario.path === 'dashboard')
        body = await getOperatorDashboard({
          store: options.store,
          repo,
          clock: () => new Date(corpus.now),
        })
      else if (fixture.scenario.path === 'status')
        body = await getRepositoryStatus(options.store, repo, new Date(corpus.now))
      else if (fixture.scenario.path === 'harvest/status')
        body = await getHarvestStatus(options.store, repo)
      else
        body = await getOperatorBuild({
          store: options.store,
          repo,
          slug: fixture.scenario.path.slice('builds/'.length),
          now: new Date(corpus.now),
        })
    } catch (error) {
      if (error instanceof OperatorQueryError) {
        status = error.code === 'not-found' ? 404 : 409
        body = {
          kind: error.code === 'not-found' ? 'not-found' : 'conflict',
          error: error.message,
          code: error.code,
        }
      } else {
        status = 500
        body = { kind: 'internal', error: 'operator API is unavailable' }
      }
    }
    assert.equal(status, fixture.status, `${fixture.scenario.id}: PostgreSQL seed status`)
    assert.deepEqual(
      JSON.parse(JSON.stringify(body)),
      fixture.body,
      `${fixture.scenario.id}: PostgreSQL seed response`,
    )
    checked.push(fixture.scenario.id)
  }
  return checked
}
if (import.meta.main) {
  const { SQL } = await import('bun')
  const { migratePostgres } = await import('../../../packages/postgres-store/src/schema')
  const { openPostgresBuildStoreFromEnv } = await import(
    '../../../packages/postgres-store/src/config'
  )
  const { withDataServices } = await import('./data-services')
  await withDataServices(async (adminUrl, env) => {
    const name = `proa_api_reads_${crypto.randomUUID().replaceAll('-', '')}`,
      admin = new SQL(adminUrl, { max: 1 }),
      url = new URL(adminUrl)
    url.pathname = `/${name}`
    let sql: SQL | undefined,
      store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined,
      created = false,
      failure: unknown,
      result: string[] | undefined
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`)
      created = true
      await migratePostgres(url.href)
      sql = new SQL(url.href, { max: 1 })
      store = await openPostgresBuildStoreFromEnv(
        { ...env, AB_POSTGRES_URL: url.href },
        { clock: () => new Date(operatorClock) },
      )
      result = await replayTypeScriptReadSeeds({ sql, store })
    } catch (error) {
      failure = error
    } finally {
      for (const close of [
        () => store?.close(),
        () => sql?.close(),
        () => (created ? admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`) : undefined),
        () => admin.close(),
      ]) {
        try {
          await close()
        } catch (error) {
          failure ??= error
        }
      }
    }
    if (failure) throw failure
    console.log(
      JSON.stringify({
        checkpoint: 'api-read-oracle-seed-replay',
        cases: result,
        nativeHttpParity: false,
      }),
    )
  })
}
