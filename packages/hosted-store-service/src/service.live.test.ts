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
import { AuthError, RemoteBuildStore, mintToken } from '@defrex/autobuild/remote-store'
import { DISPATCHER, KERNEL, humanActor, parseConfig, type Via } from '@defrex/autobuild/testing'
import { migratePostgres } from '@defrex/autobuild-postgres-store/schema'
import { openPostgresBuildStore } from '@defrex/autobuild-postgres-store/store'
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
    })
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: service.fetch })
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
    test('polls through reducer snapshots, reading no rows at idle and matching a full replay', async () => {
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
        // The second poll restores from the snapshots the first one left: no
        // event rows, same response.
        rows = 0
        const second = await getOperatorDashboard({ store: counted, repo, clock })
        expect(rows).toBe(0)
        expect(second).toEqual(first)
        // New events cost exactly their own rows, and the answer still equals
        // the one a replay with every snapshot deleted gives.
        await backing.append('live-running', {
          actor: KERNEL,
          type: 'observation.recorded',
          payload: { id: 'o1', kind: 'followup', summary: 'noted' },
        })
        rows = 0
        const third = await getOperatorDashboard({ store: counted, repo, clock })
        expect(rows).toBe(1)
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
        const tickets = await openPostgresTicketDatabase(database.url, {
          triage: 'Triage',
          ready: 'Ready',
          doing: 'Doing',
          done: 'Done',
        })
        try {
          await store.createBuild({ slug: 'retained-project', repo })
          await store.append('retained-project', {
            actor: humanActor('Ada'),
            type: 'build.pause-requested',
            payload: {},
          })
          await store.putArtifact('retained-project', { kind: 'notes', content: 'retained' })
          const source = tickets.source({ teamKey: repo })
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
        openStore: async () =>
          new (await import('@defrex/autobuild/plugin-sdk')).MemoryBuildStore(),
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
      const created = await firstClient.createBuild({ slug: 'fix-login', repo: a })
      const foreign = await otherClient.createBuild({ slug: 'fix-login', repo: b })
      expect(created.slug).not.toBe(foreign.slug)
      expect(created.branch).toBe(`ab/${created.slug}`)
      expect(await firstClient.getBuild(foreign.slug)).toBeNull()
      expect(await firstClient.getBuild('missing')).toBeNull()
      expect((await firstClient.listBuilds()).map((record) => record.slug)).toEqual([created.slug])
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
