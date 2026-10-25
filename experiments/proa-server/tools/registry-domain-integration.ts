/** Actual registry HTTP dispatch against PostgreSQL, including hosted ticket mutations. */
import type { OperatorOperationWitness } from './operator-coverage-types'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
import type { SQL } from 'bun'
import type { BuildStore } from '../../../packages/core/src/store/types'
import { createOperatorServer } from '../../../packages/hosted-store-service/src/operator-server'
import { testProjects } from '../../../packages/hosted-store-service/src/testing/projects'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import {
  checkApiReadCorpus,
  apiReadRepo,
  apiReadSlug,
  apiReadForeignRepo,
  type ApiReadFixture,
} from './api-read-fixtures'
import { seedNativeApiRead } from './api-read-integration'
import { operatorClock } from './operator-fixtures'
import { replayControlScenario } from './control-fixtures'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'

const secret = 'offline-operator-fixture-secret'
const user = 'operator@example.com'
const lifecycle = { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' }
const tickets = {
  source: 'hosted',
  teamKey: 'ENG',
  triageState: 'triage',
  readyState: 'ready',
  claimedState: 'doing',
  doneState: 'done',
  createState: 'triage',
  proposalState: 'triage',
} as const
const calls = [
  ['states-initial', 'tickets.states', {}],
  ['create-parent', 'tickets.create', { title: 'Parent', body: 'Parent bytes\n', kind: 'node' }],
  [
    'create-child',
    'tickets.create',
    { title: 'Child', body: 'Child bytes\n  preserved\n', target: 'ENG-1', labels: ['parity'] },
  ],
  ['tree-published-no-root', 'tickets.tree', {}],
  ['list-positive', 'tickets.list', {}],
  ['list-label-filter', 'tickets.list', { labels: ['parity'] }],
  ['list-unknown-state', 'tickets.list', { state: 'absent' }],
  ['get-positive', 'tickets.get', { id: 'ENG-2' }],
  ['get-missing', 'tickets.get', { id: 'ENG-999' }],
  [
    'update-positive',
    'tickets.update',
    { id: 'ENG-2', body: '\nreplacement bytes  \n', expectedRevision: '1' },
  ],
  ['update-stale', 'tickets.update', { id: 'ENG-2', title: 'stale', expectedRevision: '1' }],
  ['move-positive', 'tickets.move', { id: 'ENG-2', state: 'ready', expectedRevision: '2' }],
  ['move-unknown-state', 'tickets.move', { id: 'ENG-2', state: 'absent' }],
  [
    'block-positive',
    'tickets.block',
    { id: 'ENG-2', blockerIds: ['ENG-1'], expectedRevision: '3' },
  ],
  ['block-missing', 'tickets.block', { id: 'ENG-2', blockerIds: ['ENG-999'] }],
  [
    'unblock-positive',
    'tickets.unblock',
    { id: 'ENG-2', blockerIds: ['ENG-1'], expectedRevision: '4' },
  ],
  ['unblock-missing', 'tickets.unblock', { id: 'ENG-2', blockerIds: ['ENG-999'] }],
  [
    'state-create-positive',
    'tickets.state.create',
    { name: 'waiting', about: 'Waiting for review' },
  ],
  ['state-create-duplicate', 'tickets.state.create', { name: 'waiting' }],
  ['states-populated', 'tickets.states', {}],
  ['create-blank', 'tickets.create', { title: ' ', body: ' ' }],
] as const
const refusals = new Set([
  'tree-published-no-root',
  'list-unknown-state',
  'get-missing',
  'update-stale',
  'move-unknown-state',
  'block-missing',
  'unblock-missing',
  'state-create-duplicate',
  'create-blank',
])
export function registryDomainScenarios() {
  return [
    ...calls.map(([id, tool, input]) => ({
      id: `registry-domain-${id}`,
      tool,
      input: { repo: 'registry-domain/native', ...input },
      category: refusals.has(id) ? ('applicable-refusal' as const) : ('success' as const),
    })),
    ...[
      ['build-detail', 'builds.get', { slug: 'registry-domain-detail-running' }, 'success'],
      ['build-missing', 'builds.get', { slug: 'missing-build' }, 'applicable-refusal'],
      [
        'build-events',
        'builds.events',
        { slug: 'registry-domain-detail-running', cursor: 0, waitSeconds: 0 },
        'success',
      ],
      [
        'build-artifact',
        'builds.artifact',
        { slug: 'registry-domain-detail-running', kind: 'proof-bytes' },
        'success',
      ],
      ['repository-status', 'repository.status', {}, 'success'],
      ['harvest-status', 'harvest.status', {}, 'success'],
      ['tree-positive', 'tickets.tree', {}, 'success'],
      ['landings-consent', 'landings.list', {}, 'success'],
      ['landings-pinned', 'landings.list', {}, 'success'],
      ['landings-invalid-pin', 'landings.list', {}, 'applicable-refusal'],
    ].map(([id, tool, input, category]) => ({
      id: `registry-domain-${id}`,
      tool: tool as string,
      input: { repo: 'registry-domain/read', ...(input as object) },
      category: category as 'success' | 'applicable-refusal',
    })),
  ]
}
export async function replayNativeRegistryDomains(options: {
  sql: SQL
  store: BuildStore
  address: string
}) {
  const { sql, store, address } = options
  const checked: string[] = [],
    witnesses: OperatorOperationWitness[] = []
  const oracleRepos: string[] = []
  const sources = new Map<string, PostgresTicketSource>()
  const projects = testProjects(oracleRepos)
  const oracle = createOperatorServer({
    store,
    projects,
    secret,
    clock: () => new Date(operatorClock),
    auth: {
      authenticate: async (request) => ({
        kind: 'internal',
        repo: decodeURIComponent(new URL(request.url).pathname.split('/')[4]!),
        user,
      }),
    },
    ticketBackend: {
      contextFor: async (repo) => ({
        repo,
        tickets,
        teamKey: 'ENG',
        ...(repo === 'registry-domain/tree-positive' ? { baseBranch: 'main' } : {}),
      }),
      sourceFor: (context) => sources.get(context.repo)!,
      statesFor: async (context) =>
        (await sources.get(context.repo)!.listStates()).map((state) => state.name),
    },
  })
  const register = async (repo: string) => {
    await sql`INSERT INTO project_journal(seq,repo,action,actor,ts) VALUES(nextval('project_journal_seq'),${repo},'added','fixture',${operatorClock})`
    await projects.add(repo, 'fixture')
  }
  const call = async (repo: string, tool: string, input: object, native: boolean) => {
    const token = mintToken(secret, {
      version: 1,
      internalOperator: { repo, user },
      exp: new Date(operatorClock).getTime() + 60000,
    })
    const request = new Request(
      `${native ? address : 'http://oracle.invalid'}/operator/v1/repos/${encodeURIComponent(repo)}/tools/${encodeURIComponent(tool)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': String(REMOTE_STORE_PROTOCOL_VERSION),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ repo, ...input }),
      },
    )
    const response = native ? await fetch(request) : await oracle.fetch(request)
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.json(),
    }
  }
  const compare = async (
    id: string,
    tool: string,
    input: object,
    nativeRepo: string,
    oracleRepo = nativeRepo,
  ) => {
    const expected = await call(oracleRepo, tool, input, false)
    const actual = await call(nativeRepo, tool, input, true)
    // Separate ticket repos share identical public IDs; repo-qualified values bind explicitly.
    const bound = JSON.parse(JSON.stringify(expected).replaceAll(oracleRepo, nativeRepo))
    assert.deepEqual(actual, bound, `${id} ${tool}`)
    if (id === 'landings-consent' || id === 'landings-pinned')
      assert.equal(actual.body.length, 1, `${id} populated consent queue`)
    const manifest = registryDomainScenarios().find(
      (entry) => entry.id === `registry-domain-${id}`,
    )!
    assert.equal(
      actual.status < 400,
      manifest.category === 'success',
      `${id} expected witness category ${JSON.stringify(actual)}`,
    )
    checked.push(manifest.id)
    witnesses.push({
      suite: 'registry-domains',
      id: manifest.id,
      method: 'POST',
      path: `tools/${tool}`,
      requestBody: { repo: nativeRepo, ...input },
      status: actual.status,
      responseBody: actual.body,
    })
  }
  const nativeRepo = 'registry-domain/native',
    oracleRepo = 'registry-domain/oracle'
  for (const repo of [nativeRepo, oracleRepo]) {
    await register(repo)
    await new PostgresTicketPolicyStore(sql).put(repo, { version: 1, tickets }, 'fixture')
    sources.set(repo, new PostgresTicketSource(sql, { repo, teamKey: 'ENG', lifecycle }, lifecycle))
  }
  for (const [id, tool, input] of calls) await compare(id, tool, input, nativeRepo, oracleRepo)
  const corpus = await checkApiReadCorpus()
  for (const [id, tool, fixtureId, input] of [
    ['build-detail', 'builds.get', 'detail-running', { slug: 'registry-domain-detail-running' }],
    ['build-missing', 'builds.get', 'detail-missing', { slug: 'missing-build' }],
    ['repository-status', 'repository.status', 'status-absent', {}],
    ['harvest-status', 'harvest.status', 'harvest-harvest-multi', {}],
  ] as const) {
    const repo = `registry-domain/${fixtureId}`,
      slug = `registry-domain-${fixtureId}`
    const original = corpus.fixtures.find((fixture) => fixture.scenario.id === fixtureId)
    assert.ok(original, fixtureId)
    const fixture = JSON.parse(
      JSON.stringify(original)
        .replaceAll(apiReadRepo, repo)
        .replaceAll(apiReadForeignRepo, `${repo}-foreign`)
        .replaceAll(apiReadSlug, slug),
    ) as ApiReadFixture
    await register(repo)
    await seedNativeApiRead(options, fixture)
    await compare(id, tool, input, repo)
    if (id === 'build-detail') {
      await compare('build-events', 'builds.events', { slug, cursor: 0, waitSeconds: 0 }, repo)
      await store.putArtifact(slug, {
        kind: 'proof-bytes',
        content: new Uint8Array([0, 255, 10, 32, 13]),
        metadata: {},
      })
      await compare('build-artifact', 'builds.artifact', { slug, kind: 'proof-bytes' }, repo)
    }
  }
  const treeRepo = 'registry-domain/tree-positive'
  await register(treeRepo)
  const treeFixture = JSON.parse(
    JSON.stringify(corpus.fixtures.find((f) => f.scenario.id === 'detail-configured')).replaceAll(
      apiReadRepo,
      treeRepo,
    ),
  ) as ApiReadFixture
  const treeArtifact = treeFixture.seed.repository.artifacts[0]!
  const treeConfig = JSON.parse(Buffer.from(treeArtifact.base64, 'base64').toString())
  treeConfig.tickets = tickets
  const treeBytes = Buffer.from(JSON.stringify(treeConfig))
  treeArtifact.base64 = treeBytes.toString('base64')
  treeArtifact.meta.blobRef = createHash('sha256').update(treeBytes).digest('hex')
  await seedNativeApiRead(options, treeFixture)
  const treeSource = new PostgresTicketSource(
    sql,
    { repo: treeRepo, teamKey: 'ENG', lifecycle },
    lifecycle,
  )
  sources.set(treeRepo, treeSource)
  await treeSource.create({ title: 'Tree parent', body: 'Parent', kind: 'node' })
  await treeSource.create({ title: 'Tree child', body: 'Child', target: 'ENG-1' })
  await compare('tree-positive', 'tickets.tree', {}, treeRepo)
  const landing = await replayControlScenario({
    id: 'registry-landing-seed',
    seed: 'landing',
    path: 'builds/control-build/control',
    body: { action: 'hold' },
  })
  for (const variant of ['consent', 'pinned', 'invalid-pin'] as const) {
    const repo = `registry-domain/landing-${variant}`,
      slug = `registry-domain-landing-${variant}`
    await register(repo)
    const events = landing.seed.events
    await store.createBuild({
      repo,
      slug,
      created: validateEventWrite({
        ...events[0]!,
        payload: { ...events[0]!.payload, repo },
      }) as never,
    })
    for (const event of events.slice(1)) {
      const write =
        event.type === 'landing.decided'
          ? {
              ...event,
              payload: {
                ...event.payload,
                candidate: {
                  head: 'head',
                  parent: 'base',
                  cycle: String(events.find((e) => e.type === 'finalize.completed')!.seq),
                },
              },
            }
          : event
      await store.append(slug, validateEventWrite(write))
    }
    await store.append(slug, {
      type: 'workspace.provisioned',
      actor: { kind: 'kernel' },
      payload: {
        provider: 'test',
        ref: 'workspace',
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: 'base' },
      },
    })
    if (variant !== 'consent') {
      const configured = corpus.fixtures.find(
        (fixture) => fixture.scenario.id === 'detail-configured',
      )!
      const effective = configured.seed.repository.artifacts.find(
        (artifact) => artifact.meta.kind === 'dispatcher-effective-config',
      )!
      assert.ok(effective, 'effective config seed')
      await store.putArtifact(slug, {
        kind: 'build-runner-effective-config',
        content:
          variant === 'invalid-pin'
            ? new TextEncoder().encode('{')
            : Buffer.from(effective.base64, 'base64'),
        metadata: {},
      })
    }
    await compare(`landings-${variant}`, 'landings.list', {}, repo)
  }
  return { cases: checked, witnesses }
}

if (import.meta.main) {
  const { SQL } = await import('bun'),
    { resolve } = await import('node:path'),
    { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os')
  const { withDataServices } = await import('./data-services'),
    { bridge } = await import('./data-integration'),
    { migratePostgres } = await import('../../../packages/postgres-store/src/schema'),
    { openPostgresBuildStoreFromEnv } = await import('../../../packages/postgres-store/src/config')
  await withDataServices(async (adminUrl, environment) => {
    const project = resolve(import.meta.dir, '..'),
      name = `proa_registry_domains_${crypto.randomUUID().replaceAll('-', '')}`,
      admin = new SQL(adminUrl, { max: 1 }),
      url = new URL(adminUrl),
      runtime = await mkdtemp(resolve(tmpdir(), 'proa-registry-domain-proof-'))
    url.pathname = `/${name}`
    const env = { ...environment, AB_POSTGRES_URL: url.href, AB_STORE_SECRET: secret }
    let created = false,
      sql: SQL | undefined,
      store: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined,
      failure: unknown,
      evidence: Awaited<ReturnType<typeof replayNativeRegistryDomains>> | undefined
    const children: Awaited<ReturnType<typeof bridge>>[] = []
    try {
      const child = Bun.spawn(
        ['cargo', 'build', '--locked', '--example', 'operator-proof', '--message-format=json'],
        { cwd: project, env, stdout: 'pipe', stderr: 'inherit' },
      )
      const output = await new Response(child.stdout).text()
      if (await child.exited) throw new Error('Native delegation proof build failed')
      let executable: string | undefined
      for (const line of output.split('\n').filter(Boolean)) {
        const item = JSON.parse(line) as {
          reason: string
          target?: { name: string }
          executable?: string
          message?: { rendered?: string }
        }
        if (item.message?.rendered) process.stderr.write(item.message.rendered)
        if (
          item.reason === 'compiler-artifact' &&
          item.target?.name === 'operator-proof' &&
          item.executable
        )
          executable = item.executable
      }
      if (!executable) throw new Error('Cargo did not report delegation proof executable')
      await admin.unsafe(`CREATE DATABASE ${name}`)
      created = true
      await migratePostgres(url.href)
      sql = new SQL(url.href, { max: 1 })
      store = await openPostgresBuildStoreFromEnv(env, { clock: () => new Date(operatorClock) })
      const spawn = async (settings: { secret?: string }) => {
        const native = await bridge({ ...env, AB_STORE_SECRET: settings.secret }, runtime, [
          executable!,
        ])
        children.push(native)
        const address = (await native.request({ op: 'http-address' })).value as string
        const close = native.close.bind(native)
        let closing: Promise<void> | undefined
        native.close = () => {
          closing ??= close()
          return closing
        }
        return { address, close: () => native.close() }
      }
      const main = await spawn({ secret })
      evidence = await replayNativeRegistryDomains({
        sql,
        store,
        address: main.address,
      })
    } catch (error) {
      failure = error
    } finally {
      for (const close of [
        ...children.map((child) => () => child.close()),
        () => store?.close(),
        () => sql?.close(),
        () => (created ? admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`) : undefined),
        () => admin.close(),
        () => rm(runtime, { recursive: true, force: true }),
      ]) {
        try {
          await close()
        } catch (error) {
          failure ??= error
        }
      }
    }
    if (failure) throw failure
    console.log(JSON.stringify({ checkpoint: 'native-registry-domains', ...evidence }))
  })
}
