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
      build: '*',
      session: '*',
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
    test('a via-carrying token stamps and gates delegated writes end-to-end', async () => {
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
        token: mintToken(secret, { build: '*', session: '*', exp }),
      })
      try {
        await admin.createBuild(sampleBuildInput('via-live'))
        const via: Via = { kind: 'session', id: 'os_delegate' }
        const otherVia: Via = { kind: 'mcp', client: 'claude-code' }

        // A build-scoped resource token carrying a via stamps it onto a
        // via-less human write (the token is authoritative).
        const delegated = new RemoteBuildStore({
          url,
          token: mintToken(secret, {
            resource: { kind: 'build', id: 'via-live' },
            session: '*',
            exp,
            via,
          }),
        })
        const stamped = await delegated.append('via-live', {
          actor: humanActor('operator'),
          type: 'build.pause-requested',
          payload: {},
        })
        expect(stamped.actor).toEqual({ kind: 'human', user: 'operator', via })

        // A write claiming the token's own via is accepted unchanged.
        const claimed = await delegated.append('via-live', {
          actor: humanActor('operator', via),
          type: 'build.resume-requested',
          payload: {},
        })
        expect(claimed.actor).toEqual({ kind: 'human', user: 'operator', via })

        // A write claiming a different via → 403 authority failure.
        const mismatch = await delegated
          .append('via-live', {
            actor: humanActor('operator', otherVia),
            type: 'build.pause-requested',
            payload: {},
          })
          .catch((e: unknown) => e)
        expect(mismatch).toBeInstanceOf(AuthError)

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
        expect(events.map((e) => (e.actor as { via?: Via }).via ?? null)).toEqual([via, via, null])
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
