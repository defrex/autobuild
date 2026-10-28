import { countHistoricalRows, type ReducedReadCosts } from '@defrex/autobuild/testing'
import { resolveReducerValue } from '@defrex/autobuild/store-adapter'
import {
  PostgresProjectRegistry,
  openPostgresProjectRegistryFromEnv,
} from '@defrex/autobuild-postgres-store/projects'
import { openPostgresTicketDatabase } from '@defrex/autobuild-postgres-store'
import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import {
  MemoryBlobStore,
  describeBuildStoreContract,
  sampleBuildInput,
  systemClock,
  type BuildStore,
} from '@defrex/autobuild/plugin-sdk'
import { getOperatorDashboard } from '@defrex/autobuild/operator'
import {
  AuthError,
  RemoteBuildStore,
  mintToken,
  AUTOBUILD_VERSION_HEADER,
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '@defrex/autobuild/remote-store'
import { DISPATCHER, KERNEL, humanActor, parseConfig, type Via } from '@defrex/autobuild/testing'
import { migratePostgres } from '@defrex/autobuild-postgres-store/schema'
import { openPostgresBuildStore, PostgresBuildStore } from '@defrex/autobuild-postgres-store/store'
import { createHostedStoreService } from './service'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function isolatedDatabase(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_hosted_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  const url = scoped.toString()
  await migratePostgres(url)
  return {
    url,
    cleanup: async () => {
      const sql = new SQL(testUrl)
      try {
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await sql.close()
      }
    },
  }
}

if (!testUrl) {
  describe('hosted PostgreSQL live contract', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run HTTP → hosted service → PostgreSQL conformance', () => {})
  })
} else {
  describeBuildStoreContract('hosted HTTP → PostgreSQL', async (options) => {
    const database = await isolatedDatabase()
    const clock = options?.clock ?? systemClock
    const backing = await openPostgresBuildStore(database.url, new MemoryBlobStore(), {
      clock,
      ...(options?.retention ? { retention: options.retention } : {}),
    })
    const secret = crypto.randomUUID()
    // The service caches its registry pool; give this per-test service an
    // explicitly owned registry so contract cleanup releases that pool too.
    const projects = await openPostgresProjectRegistryFromEnv({ AB_POSTGRES_URL: database.url })
    const registrySql = new SQL(database.url)
    const service = createHostedStoreService({
      env: {
        AB_STORE_SECRET: secret,
        AB_POSTGRES_URL: database.url,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'injected',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'injected',
        AB_S3_SECRET_ACCESS_KEY: 'injected',
      },
      clock,
      openStore: async () => backing,
      openProjectRegistry: async () => projects,
    })
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        // Generic adapter fixtures use arbitrary repository identities. Seed
        // hosted admission directly, without changing the contract's names.
        const path = new URL(request.url).pathname
        let repo = /^\/repos\/([^/]+)/.exec(path)?.[1]
        if (repo) repo = decodeURIComponent(repo)
        if (request.method === 'POST' && ['/builds', '/repos'].includes(path)) {
          const body = (await request.clone().json()) as { repo?: string }
          repo = body.repo
        }
        if (repo) {
          const [exists] = await registrySql`SELECT 1 FROM project_generations WHERE repo=${repo}`
          if (!exists) {
            await registrySql`INSERT INTO project_generations (repo,generation) VALUES (${repo},${crypto.randomUUID()}) ON CONFLICT DO NOTHING`
            await registrySql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),${repo},'added','fixture',now())`
          }
        }
        return service.fetch(request)
      },
    })
    const token = mintToken(secret, {
      version: 1,
      ownerAdmin: { user: 'owner:fixture' },
      exp: clock().getTime() + 100 * 365 * 24 * 60 * 60 * 1000,
    })
    return {
      store: new RemoteBuildStore({ url: `http://127.0.0.1:${server.port}`, token }),
      // The suite-wide token is a via-less admin token, so the harness
      // declares the via-less token-authority posture: the via contract pins
      // 403 "token carries no via" rejections for delegated writes here.
      viaAuthority: {},
      cleanup: async () => {
        await server.stop(true)
        await backing.close()
        await projects.close()
        await registrySql.close()
        await database.cleanup()
      },
    }
  })

  describe('delegated writes over the hosted stack (§15.1)', () => {
    test('retired delegation is refused and raw admin writes cannot forge via', async () => {
      const database = await isolatedDatabase()
      const backing = await openPostgresBuildStore(database.url, new MemoryBlobStore(), {
        clock: systemClock,
      })
      const secret = crypto.randomUUID()
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: secret,
          AB_POSTGRES_URL: database.url,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'injected',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'injected',
          AB_S3_SECRET_ACCESS_KEY: 'injected',
        },
        clock: systemClock,
        openStore: async () => backing,
      })
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: service.fetch })
      const url = `http://127.0.0.1:${server.port}`
      const exp = systemClock().getTime() + 100 * 365 * 24 * 60 * 60 * 1000
      const admin = new RemoteBuildStore({
        url,
        token: mintToken(secret, { version: 1, ownerAdmin: { user: 'owner:fixture' }, exp }),
      })
      try {
        const registry = await openPostgresProjectRegistryFromEnv({ AB_POSTGRES_URL: database.url })
        await registry.add(sampleBuildInput('via-live').repo, 'fixture')
        await registry.close()
        await admin.createBuild(sampleBuildInput('via-live'))
        const via: Via = { kind: 'session', id: 'os_delegate' }

        // Retired delegated raw credentials cannot be replayed into the store.
        const delegated = new RemoteBuildStore({
          url,
          token: mintToken(secret, {
            resource: { kind: 'build', id: 'via-live' },
            session: '*',
            exp,
            via,
          }),
        })
        await expect(
          delegated.append('via-live', {
            actor: humanActor('operator'),
            type: 'build.pause-requested',
            payload: {},
          }),
        ).rejects.toThrow('credential format changed')

        // The via-less admin token may not write delegated events at all —
        // the exact rejection the via contract pins for this posture.
        const adminErr = await admin
          .append('via-live', {
            actor: humanActor('operator', via),
            type: 'build.pause-requested',
            payload: {},
          })
          .catch((e: unknown) => e)
        expect(adminErr).toBeInstanceOf(AuthError)
        expect((adminErr as Error).message).toBe(
          'token carries no via; it may not write delegated events',
        )

        // A plain admin human write still replays without via.
        const plain = await admin.append('via-live', {
          actor: humanActor('operator'),
          type: 'build.pause-requested',
          payload: {},
        })
        expect(plain.actor).toEqual({ kind: 'human', user: 'operator' })

        // The log holds the accepted delegated writes then the plain one.
        const events = await admin.getEvents('via-live')
        expect(events.map((e) => (e.actor as { via?: Via }).via ?? null)).toEqual([null])
      } finally {
        await admin.close()
        await server.stop(true)
        await backing.close()
        await database.cleanup()
      }
    })
  })
  describe('operator dashboard over hosted PostgreSQL snapshots', () => {
    test('restores build snapshots, reloads the bounded journal, and matches a full replay', async () => {
      const database = await isolatedDatabase()
      const backing = await openPostgresBuildStore(database.url, new MemoryBlobStore(), {
        clock: systemClock,
      })
      const repo = 'acme/live'
      const config = parseConfig(`
capacity = 2
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`)
      try {
        await backing.ensureRepo(repo)
        const artifact = await backing.putRepoArtifact(repo, {
          kind: 'dispatcher-effective-config',
          content: JSON.stringify({
            ...config,
            verify: { steps: [] },
            finalize: { steps: [] },
          }),
        })
        await backing.appendRepo(repo, {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: 'live_1',
            pid: 1,
            effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            roleWarnings: [],
          },
        })
        for (const slug of ['live-running', 'live-aborted']) {
          await backing.createBuild({ slug, repo })
          await backing.append(slug, {
            actor: KERNEL,
            type: 'runner.attached',
            payload: { instance: `${slug}-i`, host: 'host' },
          })
          await backing.append(slug, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
        }
        await backing.append('live-aborted', { actor: KERNEL, type: 'build.aborted', payload: {} })

        let rows = 0
        const counted = new Proxy(backing as unknown as Record<string, unknown>, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target)
            if (typeof value !== 'function') return value
            const fn = value as (...args: unknown[]) => Promise<unknown>
            if (prop === 'getEvents' || prop === 'getRepoEvents' || prop === 'getRepoStateEvents') {
              return async (...args: unknown[]) => {
                const events = (await fn.apply(target, args)) as unknown[]
                rows += events.length
                return events
              }
            }
            return fn.bind(target)
          },
        }) as unknown as BuildStore
        const withoutSnapshots = new Proxy(backing as unknown as Record<string, unknown>, {
          get(target, prop) {
            if (prop === 'getReducerValue')
              return async (...args: Parameters<BuildStore['getReducerValue']>) => {
                const [scope, request] = args
                const selected = resolveReducerValue(scope, request)
                const events =
                  scope.kind === 'build'
                    ? await backing.getEvents(scope.slug)
                    : await backing.getRepoEvents(scope.repo)
                return {
                  cursor: events.at(-1)?.seq ?? 0,
                  version: selected.reducer.version,
                  value: selected.entry.value(
                    selected.reducer.reduce(selected.entry.adapt(events)),
                  ),
                }
              }
            if (prop === 'getReducerSnapshot') return async () => null
            if (prop === 'putReducerSnapshot') return async () => false
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as unknown as BuildStore
        const clock = () => new Date('2026-10-06T12:00:00.000Z')

        const first = await getOperatorDashboard({ store: counted, repo, clock })
        expect(first.model.builds.map((row) => row.slug).sort()).toEqual([
          'live-aborted',
          'live-running',
        ])
        // The second poll restores build snapshots and reloads the one-row
        // bounded journal. The response stays unchanged.
        rows = 0
        const second = await getOperatorDashboard({ store: counted, repo, clock })
        expect(rows).toBe(0)
        expect(second).toEqual(first)
        // New build events add only their own rows to the journal load. The answer equals
        // the one a replay with every snapshot deleted gives.
        await backing.append('live-running', {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: 'o1', kind: 'followup', summary: 'noted' },
        })
        rows = 0
        const third = await getOperatorDashboard({ store: counted, repo, clock })
        expect(rows).toBe(0)
        expect(third).toEqual(await getOperatorDashboard({ store: withoutSnapshots, repo, clock }))
      } finally {
        await backing.close()
        await database.cleanup()
      }
    })
  })
}

if (testUrl)
  describe('durable hosted project registry', () => {
    test('concurrent bootstrap, idempotent administration, restart and retention', async () => {
      const database = await isolatedDatabase()
      const a = new SQL(database.url)
      const b = new SQL(database.url)
      const first = new PostgresProjectRegistry(a)
      const second = new PostgresProjectRegistry(b)
      const repo = 'https://github.com/acme/registry'
      try {
        await first.initialize([])
        expect(await first.list()).toEqual([])
        await Promise.all([first.initialize([repo]), second.initialize([repo])])
        const original = (await first.list())[0]!
        expect(original.addedBy).toBe('system:AB_WEB_REPOSITORIES')
        const duplicates = await Promise.all([first.add(repo, 'Ada'), second.add(repo, 'Grace')])
        expect(duplicates).toEqual([original, original])
        expect(Number((await a`SELECT count(*) AS count FROM project_journal`)[0].count)).toBe(1)

        // Real build, event, artifact and ticket data share this database, but
        // no registry deletion owns their lifetime.
        const blobs = new MemoryBlobStore()
        const store = await openPostgresBuildStore(database.url, blobs)
        const tickets = await openPostgresTicketDatabase(database.url)
        try {
          await store.createBuild({ slug: 'retained-project', repo })
          await store.append('retained-project', {
            actor: humanActor('Ada'),
            type: 'build.pause-requested',
            payload: {},
          })
          await store.putArtifact('retained-project', { kind: 'notes', content: 'retained' })
          const source = tickets.source({
            teamKey: 'AUT',
            repo,
            lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
          })
          const ticket = await source.create({ title: 'Retained ticket', body: 'Evidence' })
          await first.remove(repo, 'Ada')
          await second.remove(repo, 'Grace')
          expect(await second.has(repo)).toBe(false)
          await second.initialize([repo])
          expect(await first.list()).toEqual([])
          const restored = await second.add(repo, 'Grace')
          expect(restored.addedBy).toBe('Grace')
          expect(await store.getBuild('retained-project')).not.toBeNull()
          expect(await store.getEvents('retained-project')).toHaveLength(1)
          expect(await store.getArtifact('retained-project', 'notes')).not.toBeNull()
          expect(await source.get(ticket.ref.id)).not.toBeNull()
          // Timestamps may tie or go backwards; sequence is authoritative.
          await a`UPDATE project_journal SET ts = '2000-01-01' WHERE action = 'added'`
          expect(await first.has(repo)).toBe(true)
        } finally {
          await store.close()
          await tickets.close()
        }
        const restarted = await openPostgresProjectRegistryFromEnv({
          AB_POSTGRES_URL: database.url,
          AB_WEB_REPOSITORIES: repo,
        })
        try {
          expect(await restarted.has(repo)).toBe(true)
        } finally {
          await restarted.close()
        }
      } finally {
        await a.close()
        await b.close()
        await database.cleanup()
      }
    })

    test('concurrent first adds share metadata and bootstrap preserves preexisting attribution', async () => {
      const database = await isolatedDatabase()
      const a = new SQL(database.url)
      const b = new SQL(database.url)
      const first = new PostgresProjectRegistry(a)
      const second = new PostgresProjectRegistry(b)
      const repo = 'https://github.com/acme/first-add'
      try {
        const entries = await Promise.all([first.add(repo, 'Ada'), second.add(repo, 'Grace')])
        expect(entries[0]).toEqual(entries[1])
        expect(Number((await a`SELECT count(*) AS count FROM project_journal`)[0].count)).toBe(1)
        await second.initialize([repo])
        expect(await first.list()).toEqual([entries[0]!])
        await first.remove(repo, 'Ada')
        const ignoredEdit = await openPostgresProjectRegistryFromEnv({
          AB_POSTGRES_URL: database.url,
          AB_WEB_REPOSITORIES: '/invalid/deprecated/edit',
        })
        try {
          expect(await ignoredEdit.list()).toEqual([])
        } finally {
          await ignoredEdit.close()
        }
        const reopened = await openPostgresProjectRegistryFromEnv({
          AB_POSTGRES_URL: database.url,
          AB_WEB_REPOSITORIES: repo,
        })
        try {
          expect(await reopened.list()).toEqual([])
        } finally {
          await reopened.close()
        }
      } finally {
        await a.close()
        await b.close()
        await database.cleanup()
      }
    })

    test('failed import rolls back all additions and the bootstrap marker, then retries', async () => {
      const database = await isolatedDatabase()
      const sql = new SQL(database.url)
      const registry = new PostgresProjectRegistry(sql)
      const one = 'https://github.com/acme/one'
      const two = 'https://github.com/acme/two'
      try {
        await sql.unsafe(
          `ALTER TABLE project_journal ADD CONSTRAINT reject_second CHECK (repo <> '${two}')`,
        )
        await expect(registry.initialize([one, two])).rejects.toThrow()
        expect(await registry.list()).toEqual([])
        await sql.unsafe('ALTER TABLE project_journal DROP CONSTRAINT reject_second')
        await registry.initialize([one, two])
        expect((await registry.list()).map((entry) => entry.repo)).toEqual([one, two])
        await registry.remove(one, 'Ada')
        await registry.initialize([one, two])
        expect(await registry.has(one)).toBe(false)
      } finally {
        await sql.close()
        await database.cleanup()
      }
    })
  })

test.skipIf(!testUrl)(
  'stored project credentials: redaction, revocation, registration and warm service enforcement',
  async () => {
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const projects = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, projects)
    const a = 'https://github.com/acme/credential-a'
    const b = 'https://github.com/acme/credential-b'
    const listingRows: Record<string, unknown>[][] = []
    const track = <T extends SQL>(connection: T): T =>
      new Proxy(connection, {
        apply(target, _receiver, args) {
          const query = Reflect.apply(target, target, args)
          if (!(args[0] as TemplateStringsArray).join('?').includes('projected_ticket_id'))
            return query
          return query.then((rows: Record<string, unknown>[]) => {
            listingRows.push(rows)
            return rows
          })
        },
        get(target, key) {
          if (key === 'reserve') return async () => track(await target.reserve())
          if (key === 'begin')
            return (work: (tx: SQL) => unknown) => target.begin((tx) => work(track(tx as SQL)))
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    const backing = new PostgresBuildStore(track(sql), { blobs: new MemoryBlobStore() })
    try {
      await projects.add(a, 'owner')
      await projects.add(b, 'owner')
      const first = await credentials.issue(a, 'owner')
      const second = await credentials.issue(a, 'owner')
      const other = await credentials.issue(b, 'owner', { purpose: 'dispatcher' })
      expect(first.token).not.toBe(second.token)
      const [stored] =
        await sql`SELECT * FROM project_credentials WHERE id = ${first.credential.id}`
      expect(JSON.stringify(stored)).not.toContain(first.token.split('_').at(-1)!)
      expect(JSON.stringify(await credentials.list(a))).not.toContain('digest')
      const now = new Date()
      expect(await credentials.authenticate(first.token, now)).toMatchObject({
        repo: a,
        lastUsedAt: now.toISOString(),
      })
      expect(
        await credentials.authenticate(
          `${first.token.slice(0, -1)}${first.token.endsWith('0') ? '1' : '0'}`,
          now,
        ),
      ).toBeNull()
      expect(await credentials.authenticate('abp_1_unknown', now)).toBeNull()
      // Exercise the real persisted reader through a warmed HTTP composition.
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: 'live-secret',
          AB_POSTGRES_URL: database.url,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'unused',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
        },
        openStore: async () => backing,
        openProjectRegistry: async () => projects,
        openCredentials: async () => credentials,
      })
      const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
        service.fetch(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch
      const client = (token: string) =>
        new RemoteBuildStore({ url: 'http://store', token, fetchFn })
      const firstClient = client(first.token)
      const secondClient = client(second.token)
      const otherClient = client(other.token)
      await otherClient.createBuild({ slug: 'early-foreign', repo: b })
      listingRows.length = 0
      expect(await firstClient.listBuilds()).toEqual([])
      expect(listingRows).toEqual([[]])
      const created = await firstClient.createBuild({ slug: 'fix-login', repo: a })
      const foreign = await otherClient.createBuild({ slug: 'fix-login', repo: b })
      expect(created.slug).not.toBe(foreign.slug)
      expect(created.branch).toBe(`ab/${created.slug}`)
      expect(await firstClient.getBuild(foreign.slug)).toBeNull()
      expect(await firstClient.getBuild('missing')).toBeNull()
      expect((await firstClient.listBuilds()).map((record) => record.slug)).toEqual([created.slug])
      listingRows.length = 0
      expect(await firstClient.listBuilds()).toEqual([created])
      expect(listingRows.map((rows) => rows.map((r) => r.repo))).toEqual([[a]])
      const admin = client(
        mintToken('live-secret', {
          version: 1,
          ownerAdmin: { user: 'owner' },
          exp: Date.now() + 60000,
        }),
      )
      expect(await admin.listBuilds()).toEqual(await backing.listBuilds())
      await credentials.revoke(b, first.credential.id, 'owner')
      expect(await credentials.authenticate(first.token, now)).not.toBeNull()
      await credentials.revoke(a, first.credential.id, 'owner')
      await credentials.revoke(a, first.credential.id, 'owner')
      expect(await credentials.authenticate(first.token, now)).toBeNull()
      await expect(firstClient.listBuilds()).rejects.toThrow('unknown or revoked credential')
      expect(await secondClient.getBuild(created.slug)).not.toBeNull()
      expect(await otherClient.getBuild(foreign.slug)).not.toBeNull()
      expect(await credentials.authenticate(second.token, now)).not.toBeNull()
      expect(await credentials.authenticate(other.token, now)).not.toBeNull()
      const expired = await credentials.issue(a, 'owner', {
        expiresAt: new Date(Date.now() + 10000),
      })
      expect(await credentials.authenticate(expired.token, new Date(Date.now() + 20000))).toBeNull()
      await migratePostgres(database.url)
      expect(await credentials.authenticate(second.token, now)).not.toBeNull()
      await projects.remove(a, 'owner')
      await expect(credentials.authenticate(second.token, now)).rejects.toThrow(
        'project not registered',
      )
      await expect(credentials.issue(a, 'owner')).rejects.toThrow('project not registered')
      await expect(credentials.issue(b, ' ')).rejects.toThrow('nonblank')
    } finally {
      await sql.close()
      await database.cleanup()
    }
  },
)

test.skipIf(!testUrl)(
  'delegated wire authority survives parent expiry and service reconstruction over Postgres, then retires',
  async () => {
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const { delegateCredential } = await import('@defrex/autobuild/remote-store')
    const { sampleEventWrite } = await import('@defrex/autobuild/plugin-sdk')
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const projects = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, projects)
    let time = Date.now()
    const clock = () => new Date(time)
    const backing = await openPostgresBuildStore(database.url, new MemoryBlobStore(), { clock })
    const a = 'https://github.com/acme/delegated-a'
    const b = 'https://github.com/acme/delegated-b'
    const compose = () =>
      createHostedStoreService({
        env: {
          AB_STORE_SECRET: 'delegated-live',
          AB_POSTGRES_URL: database.url,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'unused',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
        },
        clock,
        openStore: async () => backing,
        openProjectRegistry: async () => projects,
        openCredentials: async () => credentials,
      })
    let service = compose()
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => service.fetch(req) })
    const url = `http://127.0.0.1:${server.port}`
    try {
      await projects.add(a, 'owner')
      await projects.add(b, 'owner')
      const parent = await credentials.issue(a, 'owner', {
        purpose: 'dispatcher',
        expiresAt: new Date(time + 7 * 86400000),
      })
      for (const [slug, repo] of [
        ['own', a],
        ['other', a],
        ['foreign', b],
      ]) {
        await backing.createBuild(sampleBuildInput(slug!, { repo: repo! }))
        await backing.append(slug!, sampleEventWrite())
      }
      const token = await delegateCredential(url, parent.token, { kind: 'build-runner', id: 'own' })
      expect(token).not.toBe(parent.token)
      const runner = new RemoteBuildStore({ url, token })
      await expect(
        runner.putArtifact('other', { kind: 'notes', content: 'forbidden' }),
      ).rejects.toBeInstanceOf(AuthError)
      expect(await backing.listArtifacts('other')).toEqual([])
      expect(await runner.getBuild('foreign')).toBeNull()
      expect((await runner.getBuild('other'))?.repo).toBe(a)
      time += 10 * 86400000
      service = compose()
      await runner.putArtifact('own', { kind: 'notes', content: 'still active' })
      await runner.append('own', {
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session: 'phase',
          role: 'implement',
          runner: 'test',
          phase: 'implement',
          round: 1,
        },
      })
      const phaseToken = await delegateCredential(url, token, {
        kind: 'build-phase',
        id: 'own',
        session: 'phase',
      })
      const phase = new RemoteBuildStore({ url, token: phaseToken })
      await phase.append('own', {
        ...sampleEventWrite(),
        actor: { kind: 'agent', role: 'implement', session: 'phase' },
      })
      await runner.append('own', {
        actor: KERNEL,
        type: 'session.ended',
        payload: {
          session: 'phase',
          outcome: 'reclaimed',
          reclaimedBy: { instance: 'replacement', resumedFromSeq: 1 },
        },
      })
      time += 60000
      await expect(phase.getBuild('own')).rejects.toBeInstanceOf(AuthError)
      expect((await runner.getBuild('own'))?.repo).toBe(a)
      await runner.append('own', { actor: KERNEL, type: 'build.aborted', payload: {} })
      time += 60000
      await expect(runner.getBuild('own')).rejects.toBeInstanceOf(AuthError)
    } finally {
      await server.stop(true)
      await backing.close()
      await sql.close()
      await database.cleanup()
    }
  },
)
import { HostedTicketSource } from '@defrex/autobuild/hosted-tickets'
import { openPostgresCredentialStoreFromEnv } from '@defrex/autobuild-postgres-store/credentials'
import { OperatorApiClient } from './operator-client'

if (testUrl)
  test('real hosted project credentials isolate same-team queues and assets with project lifecycle', async () => {
    const database = await isolatedDatabase()
    const backing = await openPostgresBuildStore(database.url, new MemoryBlobStore())
    const registry = await openPostgresProjectRegistryFromEnv({ AB_POSTGRES_URL: database.url })
    const credentials = await openPostgresCredentialStoreFromEnv({ AB_POSTGRES_URL: database.url })
    const tickets = await openPostgresTicketDatabase(database.url)
    const repos = ['https://github.com/acme/one', 'https://github.com/acme/two']
    const diagnostics: string[] = []
    try {
      const tokens: string[] = []
      for (const [index, repo] of repos.entries()) {
        await registry.add(repo, 'owner')
        tokens.push((await credentials.issue(repo, 'owner')).token)
        await backing.ensureRepo(repo)
        const { verify, finalize, ...root } = parseConfig(
          `[tickets]\nsource = "hosted"\nteamKey = "SAME"\nreadyState = "Ready"\nclaimedState = "Active${index}"\ndoneState = "Complete${index}"\ncreateState = "Draft${index}"\n[verify]\nsteps = []\n[finalize]\nsteps = []`,
        )
        const artifact = await backing.putRepoArtifact(repo, {
          kind: 'dispatcher-effective-config',
          content: JSON.stringify({
            ...root,
            verify: { steps: verify.steps },
            finalize: { steps: finalize.steps },
          }),
        })
        await backing.appendRepo(repo, {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: repo,
            pid: 1,
            effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            roleWarnings: [],
          },
        })
      }
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: 'secret',
          AB_POSTGRES_URL: database.url,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
          AB_TICKET_BACKEND: 'linear',
          LINEAR_API_KEY: 'never-used',
          AB_TICKET_DONE_STATE: ' ',
        },
        diagnostic: (message) => diagnostics.push(message),
        openStore: async () => backing,
        openProjectRegistry: async () => registry,
        openCredentials: async () => credentials,
        openTicketDatabase: async () => tickets,
      })
      expect(diagnostics).toHaveLength(1)
      const fetchFn = async (input: string | URL | Request, init?: RequestInit) =>
        service.fetch(new Request(input, init))
      const clients = tokens.map(
        (token) =>
          new HostedTicketSource({
            url: 'http://test',
            token,
            teamKey: 'FORGED',
            claimedState: 'FORGED',
            createState: 'FORGED',
            fetchFn,
          }),
      )
      const one = clients[0]!,
        two = clients[1]!
      // Publish before any CRUD call: the empty legacy Backlog role must survive.
      await one.synchronizePolicy({
        version: 1,
        tickets: {
          source: 'hosted',
          teamKey: 'SAME',
          triageState: 'Inbox',
          readyState: 'Ready',
          claimedState: 'Active0',
          doneState: 'Complete0',
          createState: 'Draft0',
          proposalState: 'Inbox',
        },
      })
      expect((await one.listStates()).map((s) => s.name)).toEqual([
        'Inbox',
        'Ready',
        'Active0',
        'Complete0',
        'Backlog',
        'Draft0',
      ])
      await one.addState('icebox', { about: 'Deferred' })
      await expect(two.listReady({ state: 'icebox' })).rejects.toThrow('unknown state')
      await expect(one.addState('icebox')).rejects.toThrow('already exists')
      const custom = await one.create({ title: 'Custom', body: 'Body' }, { state: 'icebox' })
      await one.transition(custom.ref.id, 'Backlog')
      expect((await one.listReady({ state: 'Backlog' })).tickets.map((t) => t.title)).toEqual([
        'Custom',
      ])
      expect((await one.listStates()).find((s) => s.name === 'icebox')).toEqual({
        name: 'icebox',
        tickets: 0,
        about: 'Deferred',
      })
      const forged = new HostedTicketSource({
        url: 'http://test',
        token: tokens[0]!,
        repo: repos[1]!,
        teamKey: 'SAME',
        fetchFn,
      })
      await expect(forged.addState('foreign')).rejects.toThrow('wrong project')
      expect((await two.listStates()).map((s) => s.name)).not.toContain('foreign')
      const a = await one.create({ title: 'One', body: 'Body' }, { idempotencyKey: 'same' })
      const b = await two.create({ title: 'Two', body: 'Body' }, { idempotencyKey: 'same' })
      const commentBody = '  note\r\n\r\n☃\nAttached asset: evidence/test.png\n'
      await one.comment(a.ref.id, commentBody)
      const history = (await one.get(a.ref.id))?.comments
      expect(history).toHaveLength(1)
      expect(history![0]!.body).toBe(commentBody)
      expect(history![0]!.author).toBeUndefined()
      expect(new Date(history![0]!.createdAt).toISOString()).toBe(history![0]!.createdAt)
      expect(a.state).toBe('Draft0')
      expect(b.state).toBe('Draft1')
      expect(custom.ref.id).toBe('SAME-1')
      expect(a.ref.id).toBe('SAME-2')
      expect(b.ref.id).toBe('SAME-1')
      expect((await two.get('same-1'))?.title).toBe('Two')
      const [internal] =
        await tickets.sql`SELECT id FROM ab_tickets WHERE repo = ${repos[0]!} AND readable_id = ${a.ref.id}`
      expect(await two.get(String(internal.id))).toBeNull()
      await expect(two.addBlocker('same-1', String(internal.id))).rejects.toThrow('unknown ticket')
      await one.claim('sAmE-2')
      expect((await one.get(a.ref.id))?.state).toBe('Active0')
      await one.transition('same-2', 'Complete0')
      expect((await one.get(a.ref.id))?.resolved).toBe(true)
      expect((await two.listReady({})).tickets.map((ticket) => ticket.title)).toEqual(['Two'])
      const operator = new OperatorApiClient({
        url: 'http://test',
        token: tokens[0]!,
        fetchFn: fetchFn as typeof fetch,
      })
      expect(
        (await operator.listTickets(repos[0]!, { state: 'Complete0' })).tickets.map(
          (ticket) => ticket.title,
        ),
      ).toEqual(['One'])
      await expect(operator.listTickets(repos[1]!)).rejects.toThrow('wrong project')
      const stores = tokens.map(
        (token) =>
          new RemoteBuildStore({ url: 'http://test', token, fetchFn: fetchFn as typeof fetch }),
      )
      await stores[0]!.putTicketAsset(repos[0]!, a.ref.id, {
        kind: 'reference',
        name: 'proof.txt',
        layout: 'file',
        entries: [{ type: 'file', path: 'proof.txt', content: new TextEncoder().encode('proof') }],
      })
      await expect(stores[1]!.listTicketAssets(repos[0]!, a.ref.id)).rejects.toThrow(
        'wrong project',
      )
      expect(await stores[1]!.listTicketAssets(repos[1]!, a.ref.id)).toEqual([])
      expect(diagnostics).toHaveLength(1)
    } finally {
      await tickets.close()
      await credentials.close()
      await registry.close()
      await backing.close()
      await database.cleanup()
    }
  })

/** Count returned SQL rows, including auth/config paths and cache failures. */
function countStoreRows(store: BuildStore) {
  const costs: ReducedReadCosts = { events: 0, metadata: 0, bytes: 0, historicalEvents: 0 }
  const run = Reflect.get(store, 'run').bind(store)
  Reflect.set(store, 'run', (body: (q: unknown) => Promise<unknown>) =>
    run((q: unknown) =>
      body(
        new Proxy(q as object, {
          get(target, key) {
            const method = Reflect.get(target, key)
            if (key === 'unsafe' && typeof method === 'function')
              return (...args: unknown[]) =>
                Promise.resolve(Reflect.apply(method, target, args)).then((rows) => {
                  const events = /SELECT \* FROM (?:repo_)?events\b/i.test(String(args[0]))
                  costs[events ? 'events' : 'metadata'] += Array.isArray(rows) ? rows.length : 0
                  if (events) costs.historicalEvents += countHistoricalRows(costs, rows)
                  costs.bytes += Buffer.byteLength(JSON.stringify(rows) ?? '')
                  return rows
                })
            return typeof method === 'function' ? method.bind(target) : method
          },
          apply(target, thisArg, args) {
            const result = Reflect.apply(target as CallableFunction, thisArg, args)
            const events = /SELECT \* FROM (?:repo_)?events\b/i.test(args[0].join(' '))
            return Promise.resolve(result).then((rows) => {
              costs[events ? 'events' : 'metadata'] += Array.isArray(rows) ? rows.length : 0
              if (events) costs.historicalEvents += countHistoricalRows(costs, rows)
              costs.bytes += Buffer.byteLength(JSON.stringify(rows) ?? '')
              return rows
            })
          },
        }),
      ),
    ),
  )
  return costs
}

if (testUrl)
  test('fresh hosted policy publication and delegated requests have flat SQL row cost', async () => {
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const { MemoryTicketPolicyStore } = await import(
      '@defrex/autobuild-postgres-store/ticket-policy'
    )
    const { sampleEventWrite, harvestStartedWrite } = await import('@defrex/autobuild/plugin-sdk')
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const blobs = new MemoryBlobStore()
    const writer = await openPostgresBuildStore(database.url, blobs)
    const projects = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, projects)
    const tickets = await openPostgresTicketDatabase(database.url)
    const handles: BuildStore[] = []
    const ticketPolicy = {
      version: 1 as const,
      tickets: {
        source: 'hosted' as const,
        teamKey: 'ENG',
        triageState: 'Inbox',
        readyState: 'Ready',
        claimedState: 'Active',
        doneState: 'Done',
        createState: 'Inbox',
        proposalState: 'Inbox',
      },
    }
    const compose = async () => {
      const backing = await openPostgresBuildStore(database.url, blobs)
      handles.push(backing)
      const costs = countStoreRows(backing)
      let stateListings = 0
      const countedTickets = new Proxy(tickets, {
        get(target, key) {
          if (key === 'source')
            return (...args: Parameters<typeof tickets.source>) => {
              const source = target.source(...args)
              const list = source.listStates.bind(source)
              source.listStates = async () => {
                stateListings++
                return list()
              }
              return source
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: 'cost-secret',
          AB_POSTGRES_URL: database.url,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'unused',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
        },
        openStore: async () => backing,
        openProjectRegistry: async () => projects,
        openCredentials: async () => credentials,
        openTicketDatabase: async () => countedTickets,
        openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      })
      const fetchFn = async (input: string | URL | Request, init?: RequestInit) =>
        service.fetch(new Request(input, init))
      return { backing, costs, fetchFn, stateListings: () => stateListings }
    }
    try {
      for (const count of [10, 3000])
        for (const reference of [false, true]) {
          const repo = `https://github.com/acme/cost-${count}-${reference}`
          await projects.add(repo, 'owner')
          const { token } = await credentials.issue(repo, 'owner')
          await writer.ensureRepo(repo)
          if (reference) {
            const { verify, finalize, ...root } = parseConfig(
              '[tickets]\nsource="hosted"\nteamKey="ENG"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
            )
            const artifact = await writer.putRepoArtifact(repo, {
              kind: 'dispatcher-effective-config',
              content: JSON.stringify({
                ...root,
                verify: { steps: verify.steps },
                finalize: { steps: finalize.steps },
              }),
            })
            await writer.appendRepo(repo, {
              actor: DISPATCHER,
              type: 'dispatcher.run-started',
              payload: {
                run: 'cost-run',
                pid: 1,
                effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
                roleWarnings: [],
              },
            })
          }
          const start = reference ? 2 : 1
          await sql`INSERT INTO repo_events(repo,seq,ts,actor,type,payload) SELECT ${repo},n,now(),'{"kind":"human","user":"operator"}'::jsonb,'dispatcher.intake-set','{"enabled":true}'::jsonb FROM generate_series(${start}::integer,${start + count - 1}::integer) n`
          await writer.getReducerValue({ kind: 'repo', repo }, { reducer: 'effectiveConfig' })
          for (const delta of [0, 3]) {
            for (let i = 0; i < delta; i++)
              await writer.appendRepo(repo, {
                actor: humanActor('operator'),
                type: 'dispatcher.intake-set',
                payload: { enabled: true },
              })
            const { backing, costs, fetchFn, stateListings } = await compose()
            const client = new HostedTicketSource({
              url: 'http://test',
              token,
              repo,
              teamKey: 'ENG',
              fetchFn,
            })
            await client.synchronizePolicy(ticketPolicy)
            expect(stateListings()).toBe(reference ? 1 : 0)
            expect(costs.events).toBe(delta)
            expect(costs.metadata).toBeLessThan(20)
            await client.listStates()
            expect(costs.events).toBe(delta)
            await backing.close()
            handles.pop()
          }
        }
      const repo = 'https://github.com/acme/cost-3000-true'
      const { token } = await credentials.issue(repo, 'owner')
      await writer.createBuild(sampleBuildInput('cost-build', { repo }))
      const event = sampleEventWrite()
      await sql`INSERT INTO events(build,seq,ts,actor,type,payload) SELECT 'cost-build',n,now(),${JSON.stringify(event.actor)}::jsonb,${event.type},${JSON.stringify(event.payload)}::jsonb FROM generate_series(1,3000) n`
      await writer.appendRepo(repo, harvestStartedWrite('cost-harvest'))
      await writer.claimRepoLease(repo, 'cost-holder', 60000)
      await writer.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.authorized',
        payload: {
          run: 'cost-harvest',
          execution: 'cost-execution',
          leaseHolder: 'cost-holder',
          launch: 'started',
        },
      })
      for (const target of [
        { kind: 'build-runner' as const, id: 'cost-build' },
        {
          kind: 'harvest-runner' as const,
          id: 'cost-harvest',
          repo,
          execution: 'cost-execution',
          leaseHolder: 'cost-holder',
        },
      ]) {
        // Warm issuance and authentication facts once, then discard all handlers.
        let current = await compose()
        const issue = async (fetchFn: typeof current.fetchFn) => {
          const response = await fetchFn('http://test/credentials/delegate', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            },
            body: JSON.stringify(target),
          })
          expect(response.status).toBe(200)
          return (await response.json()).token as string
        }
        const delegated = await issue(current.fetchFn)
        const client = new RemoteBuildStore({
          url: 'http://test',
          token: delegated,
          fetchFn: current.fetchFn as typeof fetch,
        })
        if (target.kind === 'build-runner') await client.getBuild('cost-build')
        else await client.getRepo(repo)
        await current.backing.close()
        handles.pop()
        current = await compose()
        const again = await issue(current.fetchFn)
        expect(current.costs.events).toBe(0)
        const fresh = new RemoteBuildStore({
          url: 'http://test',
          token: again,
          fetchFn: current.fetchFn as typeof fetch,
        })
        if (target.kind === 'build-runner')
          await fresh.getReducerValue(
            { kind: 'build', slug: 'cost-build' },
            { reducer: 'setupStreak' },
          )
        else await fresh.getReducerValue({ kind: 'repo', repo }, { reducer: 'effectiveConfig' })
        // setupStreak needs its own initial checkpoint; repeat on a fresh handler.
        await current.backing.close()
        handles.pop()
        current = await compose()
        const answer = new RemoteBuildStore({
          url: 'http://test',
          token: again,
          fetchFn: current.fetchFn as typeof fetch,
        })
        if (target.kind === 'build-runner')
          await answer.getReducerValue(
            { kind: 'build', slug: 'cost-build' },
            { reducer: 'setupStreak' },
          )
        else await answer.getReducerValue({ kind: 'repo', repo }, { reducer: 'effectiveConfig' })
        expect(current.costs.events).toBe(0)
        expect(current.costs.metadata).toBeLessThan(20)
        await current.backing.close()
        handles.pop()
        for (let index = 0; index < 3; index++) {
          if (target.kind === 'build-runner') await writer.append('cost-build', sampleEventWrite())
          else
            await writer.appendRepo(repo, {
              actor: humanActor('operator'),
              type: 'dispatcher.intake-set',
              payload: { enabled: true },
            })
        }
        current = await compose()
        const latest = await issue(current.fetchFn)
        const latestClient = new RemoteBuildStore({
          url: 'http://test',
          token: latest,
          fetchFn: current.fetchFn as typeof fetch,
        })
        if (target.kind === 'build-runner') await latestClient.getBuild('cost-build')
        else await latestClient.getRepo(repo)
        expect(current.costs.events).toBe(3)
        expect(current.costs.metadata).toBeLessThan(30)
        await current.backing.close()
        handles.pop()
      }
    } finally {
      for (const handle of handles) await handle.close()
      await writer.close()
      await sql.close()
      await database.cleanup()
    }
  }, 30_000)

if (testUrl)
  test('persisted consumer reads have flat SQL row cost through the real hosted stack', async () => {
    const { reducedReadBudget } = await import('@defrex/autobuild/testing')
    const database = await isolatedDatabase()
    const { countSql, projectQueryCounts } = await import('./testing/count-sql')
    const { AsyncLocalStorage } = await import('node:async_hooks')
    const invocationStatements = new AsyncLocalStorage<string[]>()
    const pool = new SQL(database.url)
    const counted = countSql(pool, () => invocationStatements.getStore() ?? [])
    const backing = new PostgresBuildStore(counted, { blobs: new MemoryBlobStore() })
    const projects = new PostgresProjectRegistry(counted)
    const costs = countStoreRows(backing)
    const secret = crypto.randomUUID()
    const service = createHostedStoreService({
      env: {
        AB_STORE_SECRET: secret,
        AB_POSTGRES_URL: database.url,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'injected',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'injected',
        AB_S3_SECRET_ACCESS_KEY: 'injected',
      },
      openStore: async () => backing,
      openProjectRegistry: async () => projects,
    })
    const token = mintToken(secret, {
      version: 1,
      ownerAdmin: { user: 'owner:budget' },
      exp: Date.now() + 3600_000,
    })
    const url = 'http://hosted-budget.test'
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
      invocationStatements.run([], async () => {
        const response = await service.fetch(new Request(input, init))
        expect(projectQueryCounts(invocationStatements.getStore()!).admissions).toBeLessThanOrEqual(
          1,
        )
        return response
      })) as typeof fetch
    const fresh = async () => new RemoteBuildStore({ url, token, fetchFn })
    try {
      const fixtureSql = new SQL(database.url)
      try {
        await fixtureSql`INSERT INTO project_generations (repo,generation) VALUES ('/reduced-read-budget',${crypto.randomUUID()}),('https://github.com/budget/cold-once',${crypto.randomUUID()})`
        await fixtureSql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),'/reduced-read-budget','added','fixture',now()),(nextval('project_journal_seq'),'https://github.com/budget/cold-once','added','fixture',now())`
      } finally {
        await fixtureSql.close()
      }
      await reducedReadBudget({ store: await fresh(), costs, fresh })
    } finally {
      await backing.close()
      await database.cleanup()
    }
    // Measured 17.2s on the 4-vCPU sandbox while unit/integration and diagnostic
    // checks overlapped; preserve the full hosted SQL budget with explicit headroom.
  }, 30_000)

;(testUrl ? test : test.skip)(
  'repository HTTP operations read repo_streams once, including compound and polling reads',
  async () => {
    const { PostgresBuildStore } = await import('@defrex/autobuild-postgres-store/store')
    const { countSql } = await import('./testing/count-sql')
    const { createStoreServer } = await import('./remote-store-server')
    const { createOperatorServer } = await import('./operator-server')
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const statements: string[] = []
    const store = new PostgresBuildStore(countSql(sql, statements), {
      blobs: new MemoryBlobStore(),
    })
    const repo = 'query-budget'
    const headers = {
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
    }
    const event = {
      actor: humanActor('owner'),
      type: 'dispatcher.auto-merge-default-set' as const,
      payload: { enabled: false },
    }
    try {
      await store.ensureRepo(repo)
      const server = createStoreServer({ store })
      const reads = () => statements.filter((s) => /\b(FROM|JOIN)\s+repo_streams\b/i.test(s))
      const invoke = async (method: string, path: string, body?: unknown, expected = 200) => {
        statements.length = 0
        const response = await server.fetch(
          new Request(`http://test/repos/${repo}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        )
        const data = await response.json()
        expect({
          path,
          status: response.status,
          data: response.status >= 400 ? data : undefined,
        }).toEqual({ path, status: expected, data: undefined })
        expect(reads().length).toBeLessThanOrEqual(1)
        if (path !== '/reducer-values') expect(reads().length).toBe(1)
        return data
      }
      await invoke('GET', '')
      await invoke('GET', '/events?wait=1')
      expect(statements.filter((s) => /FROM repo_events/i.test(s)).length).toBeGreaterThan(1)
      await invoke('GET', '/high-water')
      await invoke('GET', '/state-events')
      await invoke('POST', '/reducer-values', { reducer: 'dispatchSettings' })
      await invoke('POST', '/reducer-values', { reducer: 'dispatchSettings' })
      await invoke('POST', '/events', event, 201)
      await invoke('POST', '/reducer-values', { reducer: 'dispatchSettings' })
      await sql`UPDATE reducer_snapshots SET state='null'::jsonb WHERE scope_key=${repo}`
      await invoke('POST', '/reducer-values', { reducer: 'dispatchSettings' })
      await invoke('PUT', '/snapshots/test', { version: 1, cursor: 1, state: {} })
      await invoke('GET', '/snapshots/test?version=1')
      await invoke('POST', '/artifacts', { kind: 'test', contentBase64: btoa('hello') }, 201)
      await invoke('GET', '/artifacts?kind=test')
      await invoke('GET', '/artifact-list')
      await invoke(
        'POST',
        '/deposits',
        {
          event,
          artifacts: [{ kind: 'test', contentBase64: btoa('hello') }],
        },
        201,
      )
      await invoke('POST', '/lease/claim', { holder: 'dispatcher', ttlMs: 60_000 })
      await invoke('POST', '/lease/heartbeat', { holder: 'dispatcher' })
      await invoke('POST', '/tick/begin', { holder: 'dispatcher' })
      await invoke('POST', '/tick/finish', {
        holder: 'dispatcher',
        completion: { outcome: 'failed', error: 'test failure' },
        events: [
          { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run: 'dispatcher' } },
          {
            actor: DISPATCHER,
            type: 'dispatcher.tick-failed',
            payload: { run: 'dispatcher', error: 'test failure' },
          },
        ],
      })
      await invoke('POST', '/lease/release', { holder: 'dispatcher' })
      await invoke('POST', '/streams', { label: 'output' }, 201)
      await invoke('GET', '/streams')
      const config = parseConfig(
        '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
      )
      const artifact = await store.putRepoArtifact(repo, {
        kind: 'dispatcher-effective-config',
        content: JSON.stringify({ ...config, verify: { steps: [] }, finalize: { steps: [] } }),
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'dispatcher',
          pid: 1,
          effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
          roleWarnings: [],
        },
      })
      const operator = createOperatorServer({
        secret: 'secret',
        store,
        projects: { has: async () => true, list: async () => [] },
        auth: { authenticate: async () => ({ kind: 'internal', repo, user: 'owner' }) },
      })
      statements.length = 0
      const response = await operator.fetch(
        new Request(`http://test/operator/v1/repos/${repo}/dashboard`, { headers }),
      )
      expect(response.status).toBe(200)
      expect(reads()).toHaveLength(1)
      const { harvestStartedWrite } = await import('@defrex/autobuild/plugin-sdk')
      const { createMachineAuth } = await import('./machine-auth')
      await store.appendRepo(repo, harvestStartedWrite('budget-harvest'))
      const authorization = await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'harvest.execution.authorized',
        payload: {
          run: 'budget-harvest',
          execution: 'budget-execution',
          leaseHolder: 'dispatcher',
          launch: 'started',
        },
      })
      const delegated = createStoreServer({
        store,
        auth: createMachineAuth({
          secret: 'secret',
          store,
          projects: { has: async () => true, list: async () => [] },
          credentials: { authenticate: async () => null },
        }),
      })
      const token = mintToken('secret', {
        version: 2,
        delegation: {
          kind: 'harvest-runner',
          id: 'budget-harvest',
          repo,
          execution: 'budget-execution',
          leaseHolder: 'dispatcher',
          anchor: authorization.seq,
        },
      })
      for (let i = 0; i < 2; i++) {
        statements.length = 0
        const response = await delegated.fetch(
          new Request(`http://test/repos/${repo}/lease/claim`, {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${token}` },
            body: JSON.stringify({ holder: 'dispatcher', ttlMs: 60_000 }),
          }),
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(reads()).toHaveLength(1)
      }
      for (const path of ['/events', '/reducer-values', '/snapshots/test?version=1', '/streams']) {
        const response = await server.fetch(
          new Request(`http://test/repos/missing${path}`, {
            headers,
            ...(path === '/reducer-values'
              ? { method: 'POST', body: JSON.stringify({ reducer: 'dispatchSettings' }) }
              : {}),
          }),
        )
        expect(response.status).toBe(404)
      }
    } finally {
      await sql.close()
      await database.cleanup()
    }
  },
)

;(testUrl ? test : test.skip)(
  'credential authentication uses one fresh read and database-fenced coarse last use',
  async () => {
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const { countSql } = await import('./testing/count-sql')
    const { createMachineAuth } = await import('./machine-auth')
    const admin = new SQL(testUrl!)
    const schema = `auth_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testUrl!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    let sql: SQL | undefined
    try {
      await migratePostgres(url.href)
      sql = new SQL(url.href)
      const statements: string[] = []
      const counted = countSql(sql, statements)
      const registry = new PostgresProjectRegistry(sql)
      const repo = 'https://github.com/example/auth'
      await registry.add(repo, 'owner')
      const stores = Array.from({ length: 8 }, () => new PostgresCredentialStore(counted, registry))
      const issued = await stores[0]!.issue(repo, 'owner')
      await sql.unsafe('CREATE TABLE credential_updates (used_at timestamptz)')
      await sql.unsafe(`CREATE FUNCTION audit_use() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO credential_updates VALUES (NEW.last_used_at); RETURN NEW; END $$`)
      await sql.unsafe(`CREATE TRIGGER audit_use AFTER UPDATE OF last_used_at ON project_credentials
      FOR EACH ROW EXECUTE FUNCTION audit_use()`)
      let now = new Date(Date.now() + 86_400_000)
      let hasCalls = 0
      const auth = createMachineAuth({
        secret: 'secret',
        credentials: stores[0]!,
        projects: {
          list: () => registry.list(),
          has: async (repo) => {
            hasCalls++
            return registry.has(repo)
          },
        },
        clock: () => now,
      })
      const request = new Request('http://test', {
        headers: { authorization: `Bearer ${issued.token}` },
      })
      const authenticate = async (updates: number) => {
        statements.length = 0
        await auth.authenticate(request)
        expect(
          statements.filter(
            (s) =>
              /^SELECT/i.test(s) &&
              !s.includes('pg_advisory_xact_lock') &&
              !s.includes('SELECT g.generation') &&
              !/FROM project_generations/.test(s),
          ),
        ).toHaveLength(1)
        expect(statements.filter((s) => /^UPDATE/i.test(s))).toHaveLength(updates)
        expect(hasCalls).toBe(0)
      }
      await authenticate(1)
      const start = now.getTime()
      now = new Date(start + 59_999)
      await authenticate(0)
      now = new Date(start - 1)
      await authenticate(0)
      for (let minute = 1; minute <= 3; minute++) {
        now = new Date(start + minute * 60_000)
        await Promise.all(stores.map((store) => store.authenticate(issued.token, now)))
        const [count] = await sql`SELECT COUNT(*)::int AS n FROM credential_updates`
        expect(count.n).toBe(minute + 1)
        await authenticate(0)
      }
      now = new Date(start + 600_000)
      await Promise.all([
        stores[0]!.authenticate(issued.token, now),
        stores[1]!.authenticate(issued.token, new Date(now.getTime() - 1)),
      ])
      const [last] =
        await sql`SELECT last_used_at FROM project_credentials WHERE id=${issued.credential.id}`
      expect(new Date(last.last_used_at).getTime()).toBeGreaterThanOrEqual(now.getTime() - 1)
      const [count] = await sql`SELECT COUNT(*)::int AS n FROM credential_updates`
      expect(count.n).toBe(5)
      await registry.remove(repo, 'owner')
      await expect(auth.authenticate(request)).rejects.toThrow('project not registered')
      await expect(auth.authenticate(new Request(request))).rejects.toThrow(
        'project not registered',
      )
      await expect(
        auth.authenticate(
          new Request('http://test', {
            headers: {
              authorization: `Bearer ${issued.token.slice(0, -1)}${issued.token.endsWith('0') ? '1' : '0'}`,
            },
          }),
        ),
      ).rejects.toThrow()
      await registry.add(repo, 'owner')
      await authenticate(0)
      await stores[0]!.revoke(repo, issued.credential.id, 'owner')
      await expect(auth.authenticate(request)).rejects.toThrow('unknown or revoked')
      const expiresAt = new Date(now.getTime() + 86_400_000)
      const expiring = await stores[0]!.issue(repo, 'owner', { expiresAt })
      expect(await stores[0]!.authenticate(expiring.token, now)).not.toBeNull()
      expect(await stores[0]!.authenticate(expiring.token, expiresAt)).toBeNull()
    } finally {
      await sql?.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)

;(testUrl ? test : test.skip)(
  'permanent deletion refuses old credentials across routes and approved reconnection starts empty',
  async () => {
    const { PostgresProjectDeletion } = await import(
      '@defrex/autobuild-postgres-store/project-deletion'
    )
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const { PostgresConnectionStore } = await import('@defrex/autobuild-postgres-store/connections')
    const { PostgresOrganizationStore } = await import(
      '@defrex/autobuild-postgres-store/organizations'
    )
    const { PostgresTicketDatabase } = await import('@defrex/autobuild-postgres-store')
    const database = await isolatedDatabase(),
      sql = new SQL(database.url)
    const blobs = new MemoryBlobStore(),
      backing = await openPostgresBuildStore(database.url, blobs)
    const registry = new PostgresProjectRegistry(sql),
      credentials = new PostgresCredentialStore(sql, registry)
    const connections = new PostgresConnectionStore(sql),
      orgs = new PostgresOrganizationStore(sql)
    const actor = { email: 'owner@example.com', isSuperUser: () => true },
      repo = 'https://github.com/acme/delete-live'
    const org = await orgs.create(actor, 'Acme', 'acme')
    await registry.add(repo, actor.email)
    await orgs.assign(actor, org.id, repo)
    const old = await credentials.issue(repo, actor.email)
    const stale = await connections.start({
      repo,
      credentialId: 'c'.repeat(32),
      digest: 'd'.repeat(64),
    })
    const tickets = new PostgresTicketDatabase(sql).source({
      repo,
      teamKey: 'AUT',
      lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
    })
    const previousTicket = await tickets.create({ title: 'Before deletion', body: 'body' })
    await backing.createBuild(sampleBuildInput('deleted-build', { repo }))
    const service = createHostedStoreService({
      env: {
        AB_STORE_SECRET: 'secret',
        AB_POSTGRES_URL: database.url,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'injected',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'injected',
        AB_S3_SECRET_ACCESS_KEY: 'injected',
      },
      openStore: async () => backing,
      openProjectRegistry: async () => registry,
      openCredentials: async () => credentials,
    })
    const request = (path: string, token: string) =>
      service.fetch(
        new Request(`http://test${path}`, {
          ...(path.startsWith('/tickets/')
            ? { method: 'POST', body: JSON.stringify({ repo }) }
            : {}),
          headers: {
            authorization: `Bearer ${token}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: String(REMOTE_STORE_PROTOCOL_VERSION),
          },
        }),
      )
    try {
      const deletion = new PostgresProjectDeletion(sql, { delete: async () => {} })
      await deletion.delete(actor, repo, (await deletion.preview(actor, repo)).token)
      for (const path of [
        '/connect/v1/status',
        `/repos/${encodeURIComponent(repo)}`,
        '/tickets/states',
        `/secrets/v1/list?repo=${encodeURIComponent(repo)}`,
        `/operator/v1/repos/${encodeURIComponent(repo)}/status`,
      ])
        expect((await request(path, old.token)).status, path).toBe(401)
      const internal = mintToken('secret', {
        version: 1,
        internalOperator: { repo, user: actor.email },
        exp: Date.now() + 60000,
      })
      const refused = await request(`/repos/${encodeURIComponent(repo)}`, internal)
      expect(refused.status).toBe(403)
      expect(await refused.text()).toContain('project not registered')
      await expect(
        connections.decide(stale.code, actor.email, true, actor, org.id),
      ).rejects.toThrow()
      const fresh = await connections.start({
        repo,
        credentialId: 'e'.repeat(32),
        digest: 'f'.repeat(64),
      })
      expect(await registry.has(repo)).toBe(false)
      await connections.decide(fresh.code, actor.email, true, actor, org.id)
      expect(await registry.has(repo)).toBe(true)
      expect(await backing.listBuildsForRepo(repo)).toEqual([])
      expect(await tickets.get(previousTicket.ref.id)).toBeNull()
      expect((await tickets.create({ title: 'Fresh ticket', body: 'body' })).ref.id).toBe('AUT-1')
      expect((await request('/connect/v1/status', old.token)).status).toBe(401)
    } finally {
      await backing.close()
      await sql.close()
      await database.cleanup()
    }
  },
)

;(testUrl ? test : test.skip)(
  'one admission spans authentication and arbitrarily many store operations, on a single-connection pool',
  async () => {
    const { PostgresCredentialStore } = await import('@defrex/autobuild-postgres-store/credentials')
    const { PostgresTicketDatabase } = await import('@defrex/autobuild-postgres-store')
    const { PostgresTicketPolicyStore } = await import(
      '@defrex/autobuild-postgres-store/ticket-policy'
    )
    const { PostgresTicketGrantStore } = await import(
      '@defrex/autobuild-postgres-store/ticket-grants'
    )
    const { countSql, projectQueryCounts } = await import('./testing/count-sql')
    const { withHostedProjectContext } = await import(
      '@defrex/autobuild-postgres-store/request-context'
    )
    const database = await isolatedDatabase()
    const sql = new SQL(database.url, { max: 1 })
    const statements: string[] = []
    const counted = countSql(sql, statements)
    const projects = new PostgresProjectRegistry(counted)
    const credentials = new PostgresCredentialStore(counted, projects)
    const grants = new PostgresTicketGrantStore(counted)
    const tickets = new PostgresTicketDatabase(counted)
    const policies = new PostgresTicketPolicyStore(counted)
    const backing = new PostgresBuildStore(counted, { blobs: new MemoryBlobStore() })
    const repo = 'https://github.com/acme/admission-budget'
    try {
      await projects.add(repo, 'owner')
      const issued = await credentials.issue(repo, 'owner')
      await backing.ensureRepo(repo)
      const { verify, finalize, ...root } = parseConfig('[tickets]\nsource="hosted"\nteamKey="BUD"')
      const configArtifact = await backing.putRepoArtifact(repo, {
        kind: 'dispatcher-effective-config',
        content: JSON.stringify({
          ...root,
          verify: { steps: verify.steps },
          finalize: { steps: finalize.steps },
        }),
      })
      await backing.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'budget-run',
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
        },
      })
      let now = new Date()
      await credentials.authenticate(issued.token, now) // warm the bounded last-use write
      const grant = await grants.issue(repo, 'execution', 'runner', null, now)
      for (const operations of [1, 12]) {
        // A fresh service cannot rely on a process cache for the admission bound.
        const store = new Proxy(backing, {
          get(target, key) {
            if (key === 'getRepo')
              return async (repository: string) => {
                for (let n = 0; n < operations; n++) {
                  expect(await projects.has(repository)).toBe(true)
                  await backing.getRepoChangePosition(repository)
                  await backing.listBuildsForRepo(repository)
                }
                return backing.getRepo(repository)
              }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const service = createHostedStoreService({
          env: {
            AB_STORE_SECRET: 'budget',
            AB_POSTGRES_URL: database.url,
            AB_BLOB_BACKEND: 's3',
            AB_S3_BUCKET: 'injected',
            AB_S3_REGION: 'injected',
            AB_S3_ACCESS_KEY_ID: 'injected',
            AB_S3_SECRET_ACCESS_KEY: 'injected',
          },
          clock: () => now,
          openStore: async () => store,
          openProjectRegistry: async () => projects,
          openCredentials: async () => credentials,
          openTicketDatabase: async () => tickets,
          openTicketGrants: async () => grants,
          openTicketPolicy: async () => policies,
        })
        const remote = new RemoteBuildStore({
          url: 'http://budget.test',
          token: issued.token,
          fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
            service.fetch(new Request(input, init))) as typeof fetch,
        })
        statements.length = 0
        expect(await remote.getRepo(repo)).not.toBeNull()
        expect(projectQueryCounts(statements).admissions).toBe(1)
        expect(projectQueryCounts(statements).lifecycleLocks).toBe(0)
        expect(projectQueryCounts(statements).boundaries).toBe(0)
        now = new Date(now.getTime() + 61_000)
        statements.length = 0
        expect(await remote.getRepo(repo)).not.toBeNull()
        expect(projectQueryCounts(statements).admissions).toBe(1)
        expect(projectQueryCounts(statements).lifecycleLocks).toBe(0)
        expect(projectQueryCounts(statements).boundaries).toBe(1) // due credential bookkeeping only
        statements.length = 0
        await remote.putRepoArtifact(repo, { kind: 'budget', content: 'bytes' })
        expect(projectQueryCounts(statements).admissions).toBe(1)
        expect(projectQueryCounts(statements).lifecycleLocks).toBe(0)
        expect(projectQueryCounts(statements).boundaries).toBe(2) // reservation and publication
        statements.length = 0
        const ticketClient = new HostedTicketSource({
          url: 'http://budget.test',
          token: issued.token,
          repo,
          teamKey: 'BUD',
          fetchFn: (input, init) => service.fetch(new Request(input, init)),
        })
        await ticketClient.listStates()
        const stateCountLists = () =>
          statements.filter((text) => text.includes('LEFT JOIN ab_tickets')).length
        expect(stateCountLists()).toBe(1)
        for (const operation of [
          () => ticketClient.get('BUD-999'),
          () => ticketClient.claim('BUD-999'),
          () => ticketClient.listReady({}),
        ]) {
          statements.length = 0
          await operation()
          expect(stateCountLists()).toBe(0)
        }
        statements.length = 0
        await ticketClient.create({ title: 'No eager listing', body: 'Body' })
        expect(stateCountLists()).toBe(1) // state resolution only
        expect(projectQueryCounts(statements).admissions).toBe(1)
        expect(projectQueryCounts(statements).lifecycleLocks).toBe(0)
        expect(projectQueryCounts(statements).boundaries).toBeGreaterThan(0)
        // Grant auth, registry and ticket/store transactions share the same scope.
        statements.length = 0
        await withHostedProjectContext(async () => {
          expect(await grants.authenticate(grant.token, now)).not.toBeNull()
          for (let n = 0; n < operations; n++) {
            expect(await projects.has(repo)).toBe(true)
            await backing.ensureRepo(repo)
            await policies.get(repo)
            await tickets
              .source({
                repo,
                teamKey: 'BUD',
                lifecycle: { triage: 'Inbox', ready: 'Ready', doing: 'Active', done: 'Done' },
              })
              .get('BUD-1')
          }
        })
        expect(projectQueryCounts(statements).admissions).toBe(1)
        expect(projectQueryCounts(statements).lifecycleLocks).toBe(0)
        expect(projectQueryCounts(statements).boundaries).toBe(operations * 2)
      }
      await projects.remove(repo, 'owner')
      statements.length = 0
      await withHostedProjectContext(async () => {
        expect(await projects.has(repo)).toBe(false)
        expect(await grants.authenticate(grant.token, now)).toBeNull()
        expect(await projects.has(repo)).toBe(false)
      })
      expect(projectQueryCounts(statements).admissions).toBe(1)
    } finally {
      await sql.close()
      await database.cleanup()
    }
  },
  15_000,
)
