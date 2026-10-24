/**
 * The hosted MCP OAuth flow from mcp.test.ts, run against a migrated isolated
 * Postgres schema: production adapter parity for the auth schema DDL end to
 * end. Needs AB_POSTGRES_TEST_URL.
 */
import { HumanAccess } from './access'
import { PostgresOrganizationStore } from '@defrex/autobuild-postgres-store/organizations'
import { PostgresProjectRegistry } from '@defrex/autobuild-postgres-store/projects'
import { describe, expect, test } from 'bun:test'
import { AUTH_SCHEMA_VERSION, migratePostgres } from '@defrex/autobuild-postgres-store'
import { TOOLS } from '@defrex/autobuild/operator'
import { DISPATCHER, parseConfig } from '@defrex/autobuild/testing'
import {
  authorizeFlow,
  baseEnv,
  buildApp,
  connectClient,
  discoverMetadata,
  dynamicRegister,
  REPO,
  seedUser,
  toolsListRequest,
} from '../testing/mcp-oauth'
import { createWebAuth } from './auth'

const postgresUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

if (postgresUrl) {
  describe('hosted MCP over OAuth (postgres adapter parity)', () => {
    test('the same flow runs against a migrated isolated schema', async () => {
      const { SQL } = await import('bun')
      const schema = `ab_mcp_e2e_${crypto.randomUUID().replaceAll('-', '')}`
      const admin = new SQL(postgresUrl)
      await admin.unsafe(`CREATE SCHEMA ${schema}`)
      await admin.close()
      const scoped = new URL(postgresUrl)
      scoped.searchParams.set('options', `-csearch_path=${schema}`)
      const url = scoped.toString()
      try {
        await migratePostgres(url)
        const env = { ...baseEnv, AB_POSTGRES_URL: url }
        const { Pool } = await import('pg')
        const pool = new Pool({ connectionString: url, max: 2 })
        const accessSql = new SQL(url)
        const access = new HumanAccess(async () => new PostgresOrganizationStore(accessSql), env)
        await new PostgresProjectRegistry(accessSql).add(REPO, 'fixture')
        const auth = createWebAuth(env, { database: pool, access })
        const { app, backing } = buildApp(env, auth, access)
        const seeded = await seedUser(auth, 'ada@example.com')
        const registeredClient = await dynamicRegister(app, await discoverMetadata(app))
        const tokens = await authorizeFlow(app, seeded.cookie, registeredClient)
        const response = await app(toolsListRequest(tokens.access_token!, 5))
        expect(response.status).toBe(200)
        const { result } = (await response.json()) as { result: { tools: unknown[] } }
        expect(result.tools).toHaveLength(TOOLS.length + 1)
        // DCR's client row really persisted through the pg adapter, with the
        // same authenticationScheme the memory adapter persists (the
        // registered client used token_endpoint_auth_method 'none'), and the
        // same column set the memory adapter carries.
        await backing.ensureRepo(REPO)
        const { verify, finalize, ...root } = parseConfig(
          '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
        )
        const artifact = await backing.putRepoArtifact(REPO, {
          kind: 'dispatcher-effective-config',
          content: JSON.stringify({
            ...root,
            verify: { steps: verify.steps },
            finalize: { steps: finalize.steps },
          }),
        })
        await backing.appendRepo(REPO, {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: 'tickets-readable',
            pid: 1,
            effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            roleWarnings: [],
          },
        })
        const mcp = await connectClient(app, tokens, registeredClient)
        try {
          const made = await mcp.callTool({
            name: 'tickets.create',
            arguments: { repo: REPO, title: 'Readable', body: 'Body', kind: 'node' },
          })
          expect(made.isError).toBeUndefined()
          expect(JSON.parse((made.content as { text: string }[])[0]!.text).ticket.ref.id).toBe(
            'ENG-1',
          )
          const child = await mcp.callTool({
            name: 'tickets.create',
            arguments: { repo: REPO, title: 'Child', body: 'Body', target: 'eNg-1' },
          })
          expect(child.isError).toBeUndefined()
          expect(JSON.parse((child.content as { text: string }[])[0]!.text).ticket).toMatchObject({
            kind: 'work',
            target: 'ENG-1',
          })
          const invalid = await mcp.callTool({
            name: 'tickets.update',
            arguments: { repo: REPO, id: 'ENG-1', title: 'Lost', kind: 'work' },
          })
          expect(invalid.isError).toBe(true)
          const cleared = await mcp.callTool({
            name: 'tickets.update',
            arguments: { repo: REPO, id: 'ENG-2', target: null },
          })
          expect(cleared.isError).toBeUndefined()
          const shown = await mcp.callTool({
            name: 'tickets.get',
            arguments: { repo: REPO, id: 'eNg-1' },
          })
          expect(shown.isError).toBeUndefined()
          expect(JSON.parse((shown.content as { text: string }[])[0]!.text).ticket.ref.id).toBe(
            'ENG-1',
          )
        } finally {
          await mcp.close()
        }
        const sql = new SQL(url)
        const clients = await sql`SELECT * FROM "oauthApplication"`
        const names = clients.map((row: { name: string }) => row.name)
        expect(names).toContain('e2e-mcp-client')
        const e2e = clients.find((row: { name: string }) => row.name === 'e2e-mcp-client') as
          | Record<string, unknown>
          | undefined
        expect(e2e?.authenticationScheme).toBe('none')
        // The same DCR-carried fields the memory adapter persists (pinned
        // by the 'DCR persists the authenticationScheme' test above): the
        // two adapters' visible behavior matches. Optional fields left
        // undefined read back as NULL on Postgres, so only the defined
        // values are compared.
        expect(e2e).toMatchObject({
          name: 'e2e-mcp-client',
          type: 'public',
          authenticationScheme: 'none',
        })
        expect(e2e?.redirectUrls as string).toContain('https://claude.ai/api/mcp/auth_callback')
        await sql.close()
        await accessSql.close()
        await pool.end()
      } finally {
        const cleanup = new SQL(postgresUrl)
        await cleanup.unsafe(`DROP SCHEMA ${schema} CASCADE`)
        await cleanup.close()
      }
      expect(AUTH_SCHEMA_VERSION).toBe(4)
    })
  })
}
