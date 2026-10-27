import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { PostgresConnectionStore } from '@defrex/autobuild-postgres-store/connections'
import { PostgresOrganizationStore } from '@defrex/autobuild-postgres-store/organizations'
import { PostgresProjectRegistry } from '@defrex/autobuild-postgres-store/projects'
import { PostgresCredentialStore } from '@defrex/autobuild-postgres-store/credentials'
import { migratePostgres } from '@defrex/autobuild-postgres-store/schema'
import { createConnectionHandler } from './connections'
import { HumanAccess } from './web/access'

const testURL = process.env.AB_POSTGRES_TEST_URL
const live = testURL ? test : test.skip
live(
  'browser reconnect preserves removed-project ownership and hides foreign connection codes',
  async () => {
    const admin = new SQL(testURL!)
    const schema = `reconnect_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      await migratePostgres(url.href)
      const organizations = new PostgresOrganizationStore(sql)
      const projects = new PostgresProjectRegistry(sql)
      const connections = new PostgresConnectionStore(sql)
      const credentials = new PostgresCredentialStore(sql, projects)
      const env = {
        BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
        BETTER_AUTH_URL: 'https://operator.example',
        GITHUB_CLIENT_ID: 'client',
        GITHUB_CLIENT_SECRET: 'secret',
        AB_WEB_AUTH_PROVIDERS: 'github',
        AB_WEB_SUPER_USER_EMAILS: 'root@example.com',
        AB_POSTGRES_URL: url.href,
      }
      const access = new HumanAccess(async () => organizations, env)
      const root = access.actor('root@example.com')
      const orgA = await organizations.create(root, 'A', 'a')
      const orgB = await organizations.create(root, 'B', 'b')
      const memberA = access.actor('a@example.com'),
        memberB = access.actor('b@example.com')
      await organizations.addMember(root, orgA.id, memberA.email)
      await organizations.addMember(root, orgB.id, memberB.email)
      let email = memberB.email
      const handler = createConnectionHandler({
        store: async () => connections,
        credentials: async () => credentials,
        machineAuth: () => {
          throw new Error('browser routes must not use machine auth')
        },
        baseURL: env.BETTER_AUTH_URL,
        browser: {
          access,
          getSession: async () => ({ user: { email }, session: { expiresAt: '2030-01-01' } }),
        },
      })
      const request = (action: string, code: string, extra = {}) =>
        handler(
          new Request(`${env.BETTER_AUTH_URL}/connect/v1/browser/${action}`, {
            method: 'POST',
            headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json' },
            body: JSON.stringify({ code, ...extra }),
          }),
        )
      const response = async (action: string, code: string, extra = {}) => {
        const result = await request(action, code, extra)
        return { status: result.status, body: await result.json() }
      }
      const start = (repo: string) =>
        connections.start({
          repo,
          credentialId: crypto.randomUUID().replaceAll('-', ''),
          digest: 'f'.repeat(64),
        })
      const missing = '0000000000'
      expect(await connections.lookup(missing, root.email, root)).toBeNull()
      const unknownLookup = await response('lookup', missing)
      const unknownDecision = await response('decide', missing, { approve: true })
      expect(unknownLookup).toEqual({
        status: 200,
        body: {
          connection: null,
          assignment: 'fixed',
          organizations: [],
          assignedOrganization: null,
        },
      })
      expect(unknownDecision).toEqual({ status: 404, body: { error: 'unknown connection' } })

      for (const removed of [false, true]) {
        const repo = `https://github.com/example/${removed ? 'removed' : 'active'}`
        await projects.add(repo, root.email)
        await organizations.assign(root, orgA.id, repo)
        if (removed) await projects.remove(repo, root.email)
        const proposal = await start(repo)
        email = memberB.email
        expect(await response('lookup', proposal.code)).toEqual(unknownLookup)
        for (const approve of [false, true]) {
          for (const organizationId of [undefined, orgB.id]) {
            expect(await response('decide', proposal.code, { approve, organizationId })).toEqual(
              unknownDecision,
            )
          }
        }
        expect((await connections.lookup(proposal.code, root.email, root))?.status).toBe('pending')
        expect(await credentials.list(repo)).toEqual([])
        expect(await projects.has(repo)).toBe(!removed)
        expect(
          (await sql`SELECT organization_id FROM project_organizations WHERE repo = ${repo}`)[0]
            .organization_id,
        ).toBe(orgA.id)

        // Re-registration is a reconnect, not a chance to select a different org.
        // The owning member needs no selection even though the repo is inactive.
        email = memberA.email
        expect((await response('lookup', proposal.code)).status).toBe(200)
        expect(
          (await response('decide', proposal.code, { approve: true, organizationId: orgB.id }))
            .status,
        ).toBe(400)
        email = root.email
        expect(
          (await response('decide', proposal.code, { approve: true, organizationId: orgB.id }))
            .status,
        ).toBe(400)
        email = memberA.email
        expect(
          (await response('decide', proposal.code, { approve: true })).body.connection.status,
        ).toBe('approved')
        expect(await organizations.canAccess(memberA, repo)).toBe(true)
        expect(await organizations.canAccess(memberB, repo)).toBe(false)
        expect(
          (await sql`SELECT organization_id FROM project_organizations WHERE repo = ${repo}`)[0]
            .organization_id,
        ).toBe(orgA.id)
        // Resolved requests must remain just as opaque to the foreign member.
        email = memberB.email
        expect(await response('lookup', proposal.code)).toEqual(unknownLookup)
        expect(await response('decide', proposal.code, { approve: true })).toEqual(unknownDecision)

        if (removed) {
          await projects.remove(repo, root.email)
          const superReconnect = await start(repo)
          email = root.email
          expect(
            (await response('decide', superReconnect.code, { approve: true })).body.connection
              .status,
          ).toBe('approved')
          expect(
            (await sql`SELECT organization_id FROM project_organizations WHERE repo = ${repo}`)[0]
              .organization_id,
          ).toBe(orgA.id)
          // Grant removal after lookup still blocks the decision under the lock.
          await projects.remove(repo, root.email)
          const revoked = await start(repo)
          email = memberA.email
          expect((await response('lookup', revoked.code)).body.connection.status).toBe('pending')
          await organizations.removeMember(root, orgA.id, memberA.email)
          await organizations.addMember(root, orgB.id, memberA.email)
          expect(await response('decide', revoked.code, { approve: true })).toEqual(unknownDecision)
          expect(await projects.has(repo)).toBe(false)
        }
      }
      // Legacy history has no owning org, including after registry removal.
      // A fresh member identity keeps these checks independent of rate limits.
      const legacyMember = access.actor('legacy@example.com')
      await organizations.addMember(root, orgB.id, legacyMember.email)
      for (const removed of [false, true]) {
        const repo = `https://github.com/example/legacy-${removed ? 'removed' : 'active'}`
        await projects.add(repo, root.email)
        if (removed) await projects.remove(repo, root.email)
        const history =
          await sql`SELECT seq, action, actor FROM project_journal WHERE repo = ${repo} ORDER BY seq`
        const proposal = await start(repo)
        email = legacyMember.email
        expect(await response('lookup', proposal.code)).toEqual(unknownLookup)
        for (const approve of [false, true]) {
          for (const organizationId of [undefined, orgB.id]) {
            expect(await response('decide', proposal.code, { approve, organizationId })).toEqual(
              unknownDecision,
            )
          }
        }
        expect(await projects.has(repo)).toBe(!removed)
        expect(await credentials.list(repo)).toEqual([])
        expect(await sql`SELECT * FROM project_organizations WHERE repo = ${repo}`).toHaveLength(0)
        expect(
          await sql`SELECT seq, action, actor FROM project_journal WHERE repo = ${repo} ORDER BY seq`,
        ).toEqual(history)
        email = root.email
        expect((await response('lookup', proposal.code)).body.connection.status).toBe('pending')
        // An authorized reconnect assigns retained history atomically.
        expect((await response('decide', proposal.code, { approve: true })).status).toBe(400)
        expect(await credentials.list(repo)).toEqual([])
        expect(await sql`SELECT * FROM project_organizations WHERE repo = ${repo}`).toHaveLength(0)
        expect(
          (await response('decide', proposal.code, { approve: true, organizationId: orgB.id })).body
            .connection.status,
        ).toBe('approved')
        expect(await projects.has(repo)).toBe(true)
        expect(await sql`SELECT * FROM project_organizations WHERE repo = ${repo}`).toHaveLength(1)
        expect(await organizations.canAccess(root, repo)).toBe(true)
        expect(await organizations.canAccess(legacyMember, repo)).toBe(true)
        expect(
          (
            await sql`SELECT seq, action, actor FROM project_journal WHERE repo = ${repo} ORDER BY seq`
          ).slice(0, history.length),
        ).toEqual(history)
        email = legacyMember.email
        expect((await response('lookup', proposal.code)).body.assignment).toBe('fixed')
        expect(
          (await response('decide', proposal.code, { approve: true })).body.connection.status,
        ).toBe('approved')
      }
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
  30000,
)
