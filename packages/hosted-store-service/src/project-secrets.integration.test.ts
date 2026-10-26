import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PostgresOrganizationStore } from '@defrex/autobuild-postgres-store/organizations'
import { PostgresProjectRegistry } from '@defrex/autobuild-postgres-store/projects'
import { PostgresCredentialStore } from '@defrex/autobuild-postgres-store/credentials'
import { PostgresProjectSecrets } from '@defrex/autobuild-postgres-store/project-secrets'
import { migratePostgres } from '@defrex/autobuild-postgres-store/schema'
import { createHostedStoreService } from './service'
import { HumanAccess } from './web/access'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  mintToken,
} from '@defrex/autobuild/remote-store'
const testURL = process.env.AB_POSTGRES_TEST_URL
const live = testURL ? test : test.skip
live(
  'HTTP writes are write-only with real owner authentication, membership revocation and namespace isolation',
  async () => {
    const admin = new SQL(testURL!),
      schema = `secret_http_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      await migratePostgres(url.href)
      const repo = 'https://github.com/acme/project',
        member = 'member@example.com'
      const env = {
        AB_STORE_SECRET: 'signing',
        AB_POSTGRES_URL: url.href,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'unused',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'unused',
        AB_S3_SECRET_ACCESS_KEY: 'unused',
        BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
        BETTER_AUTH_URL: 'https://service',
        GITHUB_CLIENT_ID: 'client',
        GITHUB_CLIENT_SECRET: 'secret',
        AB_WEB_AUTH_PROVIDERS: 'github',
        AB_WEB_SUPER_USER_EMAILS: 'root@example.com',
      }
      const projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects),
        organizations = new PostgresOrganizationStore(sql)
      await projects.add(repo, 'root')
      const access = new HumanAccess(async () => organizations, env),
        root = access.actor('root@example.com')
      const org = await organizations.create(root, 'Example', 'example')
      await organizations.assign(root, org.id, repo)
      await organizations.addMember(root, org.id, member)
      const owner = await credentials.issue(repo, member),
        dispatcher = await credentials.issue(repo, 'system', { purpose: 'dispatcher' })
      const secrets = new PostgresProjectSecrets(sql, projects, () =>
        Buffer.alloc(32, 1).toString('base64'),
      )
      const errors: unknown[] = []
      const service = createHostedStoreService({
        env,
        openProjectRegistry: async () => projects,
        openCredentials: async () => credentials,
        openSecrets: async () => secrets,
        secretMembership: async (user, r) => {
          const actor = await access.principal(user)
          return !!actor && (await access.canAccess(actor, r))
        },
        reportInternalError: (e) => {
          errors.push(e)
        },
      })
      const request = (
        action: string,
        token = owner.token,
        body: unknown = { version: 1, repo, name: 'KIMI_API_KEY', value: 'sentinel-write-only' },
      ) =>
        service.fetch(
          new Request(
            `https://service/secrets/v1/${action}${action === 'list' ? `?repo=${encodeURIComponent(repo)}` : ''}`,
            {
              method: action === 'list' ? 'GET' : 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
                [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
              },
              ...(action === 'list' ? {} : { body: JSON.stringify(body) }),
            },
          ),
        )
      expect((await request('set')).status).toBe(200)
      const response = await request('list')
      expect(response.headers.get('cache-control')).toBe('no-store')
      const text = await response.text()
      expect(text).not.toContain('sentinel-write-only')
      expect(text).not.toContain('payload')
      expect(text).not.toContain('generation')
      for (const token of [
        dispatcher.token,
        'invalid',
        mintToken(env.AB_STORE_SECRET, {
          version: 1,
          ownerAdmin: { user: 'root@example.com' },
          exp: Date.now() + 60000,
        }),
        mintToken(env.AB_STORE_SECRET, {
          version: 1,
          internalOperator: { user: 'root@example.com', repo },
          exp: Date.now() + 60000,
        }),
        mintToken(env.AB_STORE_SECRET, {
          build: 'guest',
          session: 'session',
          exp: Date.now() + 60000,
        }),
      ]) {
        const rejected = await request('set', token)
        expect([401, 403]).toContain(rejected.status)
        expect(await rejected.text()).not.toContain('sentinel-write-only')
      }
      expect(
        (
          await request('set', owner.token, {
            version: 1,
            repo: 'https://github.com/acme/other',
            name: 'KIMI_API_KEY',
            value: 'sentinel-write-only',
          })
        ).status,
      ).toBe(403)
      // No generic namespace gains a plaintext secret accessor.
      for (const path of [
        '/secrets/v1/get',
        '/operator/secrets',
        '/builds/project_secrets',
        '/mcp/secrets',
      ]) {
        const probe = await service.fetch(
          new Request(`https://service${path}`, {
            headers: {
              authorization: `Bearer ${owner.token}`,
              [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            },
          }),
        )
        expect(await probe.text()).not.toContain('sentinel-write-only')
      }
      await organizations.removeMember(root, org.id, member)
      expect((await request('list')).status).toBe(403)
      expect((await request('set')).status).toBe(403)
      expect(JSON.stringify(errors)).not.toContain('sentinel-write-only')
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)
