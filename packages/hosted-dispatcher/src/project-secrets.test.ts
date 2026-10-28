import { expect, test } from 'bun:test'
import { createHostedDispatcher } from './dispatcher'
import { testProjects } from './testing/projects'
const one = 'https://github.com/acme/one',
  two = 'https://github.com/acme/two'
const env = {
  AB_STORE_SECRET: 'secret',
  AB_POSTGRES_URL: 'postgres://unused/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
  AB_DISPATCHER_ORIGIN: 'https://example.test',
  KIMI_API_KEY: 'deployment',
  AB_PROJECT_SECRETS_KEY: 'encryption-key',
}
test('fresh project environment, next tick mutations, key exclusion and redaction in every sink', async () => {
  let current: Record<string, string> = { KIMI_API_KEY: 'project-one-marker' },
    fail = false
  const logs: string[] = [],
    seen: Record<string, string | undefined>[] = [],
    supplied: string[] = []
  const dispatcher = createHostedDispatcher({
    env,
    openProjectRegistry: async () => testProjects([one, two]),
    openDispatcherCredentials: async () => ({
      issue: async () => ({
        token: 'dispatcher-token',
        credential: {
          id: 'dispatcher-id',
          repo: '',
          purpose: 'dispatcher',
          createdAt: '',
          createdBy: '',
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
        },
      }),
      deleteDispatcherCredential: async () => 1,
      pruneDispatcherCredentials: async () => 0,
      close: async () => {},
    }),
    openSecrets: async () => ({
      resolveForTick: async (repo) => {
        if (fail && repo === one) throw new Error('private-refresh-state')
        return {
          repo,
          env: repo === one ? { ...current } : { KIMI_API_KEY: 'project-two-marker' },
          versions: [],
        }
      },
      markSupplied: async (s) => {
        supplied.push(s.repo)
      },
    }),
    dispatch: async (opts) => {
      seen.push({ ...opts.env })
      opts.stdout?.(`token=${opts.env!.KIMI_API_KEY}`)
      opts.stderr?.(`token=${opts.env!.KIMI_API_KEY}`)
      if (opts.repository === one) throw new Error(`failed ${opts.env!.KIMI_API_KEY}`)
    },
    log: (s) => logs.push(s),
    logError: (s) => logs.push(s),
    stdout: (s) => logs.push(s),
    stderr: (s) => logs.push(s),
  })
  let summary = await dispatcher.tick()
  expect(seen.map((e) => e.KIMI_API_KEY)).toEqual(['project-one-marker', 'project-two-marker'])
  expect(seen.every((e) => e.AB_PROJECT_SECRETS_KEY === undefined)).toBe(true)
  expect(env.KIMI_API_KEY).toBe('deployment')
  expect(supplied).toEqual([one, two])
  expect(JSON.stringify([summary, logs])).not.toContain('project-one-marker')
  expect(JSON.stringify(logs)).not.toContain('project-two-marker')
  current = {}
  await dispatcher.tick()
  expect(seen[2]!.KIMI_API_KEY).toBe('deployment')
  current = { KIMI_API_KEY: 'replacement-marker' }
  await dispatcher.tick()
  expect(seen[4]!.KIMI_API_KEY).toBe('replacement-marker')
  fail = true
  summary = await dispatcher.tick()
  expect(summary.repositories.map((r) => r.outcome)).toEqual(['failed', 'ticked'])
  expect(JSON.stringify([summary, logs])).not.toContain('private-refresh-state')
})
