import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { migratePostgres } from '@defrex/autobuild-postgres-store/schema'
import { PostgresProjectRegistry } from '@defrex/autobuild-postgres-store/projects'
import { PostgresProjectSecrets } from '@defrex/autobuild-postgres-store/project-secrets'
import { createHostedDispatcher } from './dispatcher'
const testURL = process.env.AB_POSTGRES_TEST_URL
const live = testURL ? test : test.skip
live(
  'hosted ticks dispatch projects without secrets when the encryption key is not configured',
  async () => {
    const admin = new SQL(testURL!),
      schema = `secrets_tick_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      await migratePostgres(url.href)
      const projects = new PostgresProjectRegistry(sql)
      const empty = 'https://github.com/example/empty',
        affected = 'https://github.com/example/secrets'
      await projects.add(empty, 'owner')
      await projects.add(affected, 'owner')
      const writer = new PostgresProjectSecrets(sql, projects, () =>
        Buffer.alloc(32, 1).toString('base64'),
      )
      const resolver = new PostgresProjectSecrets(sql, projects, () => undefined)
      const dispatched: string[] = [],
        logs: string[] = []
      const dispatcher = createHostedDispatcher({
        env: {
          AB_STORE_SECRET: 'signing',
          AB_POSTGRES_URL: url.href,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
          AB_DISPATCHER_ORIGIN: 'https://service.example',
        },
        openProjectRegistry: async () => projects,
        openSecrets: async () => resolver,
        issueDispatcherCredential: async () => 'dispatcher-token',
        dispatch: async (opts) => {
          dispatched.push(opts.repository!)
        },
        log: (s) => logs.push(s),
        logError: (s) => logs.push(s),
      })
      // Upgrade behavior: no project has opted in, so every tick still dispatches.
      let summary = await dispatcher.tick()
      expect(summary.repositories.map((r) => r.outcome)).toEqual(['ticked', 'ticked'])
      expect(dispatched).toEqual([empty, affected])
      await writer.set(affected, 'KIMI_API_KEY', 'sentinel-secret', 'member')
      dispatched.length = 0
      summary = await dispatcher.tick()
      expect(summary.repositories.map((r) => r.outcome)).toEqual(['ticked', 'failed'])
      expect(dispatched).toEqual([empty])
      expect(summary.repositories[1]!.error).toBe('Project secrets: key-unavailable')
      expect(JSON.stringify([summary, logs])).not.toContain('sentinel-secret')
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)

live(
  'failed rotating credentials preserve ready peers in an observation-only hosted tick',
  async () => {
    const admin = new SQL(testURL!)
    const schema = `secrets_repair_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      await migratePostgres(url.href)
      const projects = new PostgresProjectRegistry(sql)
      const repo = 'https://github.com/example/mixed'
      await projects.add(repo, 'owner')
      let calls = 0
      const secrets = new PostgresProjectSecrets(
        sql,
        projects,
        () => Buffer.alloc(32, 1).toString('base64'),
        new Map([
          [
            'chatgpt-subscription',
            {
              validateState: () => true,
              async refresh() {
                calls++
                throw new Error('invalid_grant')
              },
            },
          ],
        ]),
      )
      await secrets.set(repo, 'CLAUDE_ACCESS', 'ready-claude', 'owner')
      await secrets.setPayload(
        repo,
        'PLAN_ACCESS',
        'chatgpt-subscription',
        { accessToken: 'old-plan', expiresAt: Date.now() + 1000, state: {} },
        'owner',
      )
      const ticks: Record<string, string | undefined>[] = []
      const dispatcher = createHostedDispatcher({
        env: {
          AB_STORE_SECRET: 'signing',
          AB_POSTGRES_URL: url.href,
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
          AB_DISPATCHER_ORIGIN: 'https://service.example',
        },
        openProjectRegistry: async () => projects,
        openSecrets: async () => secrets,
        issueDispatcherCredential: async () => 'dispatcher-token',
        dispatch: async (opts) => {
          ticks.push(opts.env)
        },
        log() {},
        logError() {},
      })
      for (let i = 0; i < 2; i++) {
        expect((await dispatcher.tick()).repositories[0]!.outcome).toBe('failed')
        expect(ticks[i]!.CLAUDE_ACCESS).toBe('ready-claude')
        expect(ticks[i]!.PLAN_ACCESS).toBeUndefined()
        expect(ticks[i]!.AB_PROJECT_SECRETS_FAILED).toBe('1')
        expect(JSON.parse(ticks[i]!.AB_PROJECT_SECRETS_UNAVAILABLE!)).toEqual(['PLAN_ACCESS'])
      }
      expect(calls).toBe(1)
      const snapshot = await secrets.resolveForObservation(repo)
      await secrets.set(repo, 'CLAUDE_ACCESS', 'replacement', 'owner')
      await expect(secrets.markSupplied(snapshot)).rejects.toThrow('stale-secrets')
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)
