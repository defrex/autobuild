import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { PostgresCredentialStore } from './credentials'
import { PostgresOrganizationStore, type HumanActor } from './organizations'
import { PostgresProjectRegistry } from './projects'
import { PostgresConnectionStore } from './connections'
import { migratePostgres } from './schema'
import { AUTH_SCHEMA_V3_DDL, AUTH_SCHEMA_V3_CHECKSUM } from './auth-schema'
import { HumanAccess } from '@defrex/autobuild-hosted-store-service/web/access'
import { createOrganizationHandler } from '@defrex/autobuild-hosted-store-service'
import { createWebGateway } from '@defrex/autobuild-hosted-store-service'

const live = process.env.AB_POSTGRES_TEST_URL ? test : test.skip
live(
  'organization grants, management HTTP, live revocation, connect and constraints',
  async () => {
    const admin = new SQL(process.env.AB_POSTGRES_TEST_URL!)
    const schema = `org_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(process.env.AB_POSTGRES_TEST_URL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      // A real v3 auth marker upgrades without losing identity/session state.
      await sql.unsafe(AUTH_SCHEMA_V3_DDL)
      await sql`INSERT INTO ab_auth_schema_migrations VALUES (true, 3, ${AUTH_SCHEMA_V3_CHECKSUM}, now())`
      await sql`INSERT INTO "user" VALUES ('old', 'Old', 'old@example.com', true, null, now(), now())`
      await sql`INSERT INTO session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES ('old-session', now() + interval '1 day', 'old-token', now(), now(), 'old')`
      await migratePostgres(url.href)
      expect((await sql`SELECT token FROM session`)[0].token).toBe('old-token')
      const store = new PostgresOrganizationStore(sql)
      const registry = new PostgresProjectRegistry(sql)
      const superActor: HumanActor = { email: 'root@example.com', isSuperUser: () => true }
      const owner: HumanActor = { email: 'owner@example.com', isSuperUser: () => false }
      const member: HumanActor = { email: 'member@example.com', isSuperUser: () => false }
      const a = await store.create(superActor, 'A', 'a')
      const b = await store.create(superActor, 'B', 'b')
      expect(a).toMatchObject({ ownerEmail: null, membershipRole: null })
      expect(await store.admitted(superActor.email)).toBe(false)
      expect(await sql`SELECT * FROM member`).toHaveLength(0)
      await expect(store.create(member, 'No', 'no')).rejects.toMatchObject({ status: 403 })
      await expect(store.create(superActor, 'Duplicate', 'a')).rejects.toMatchObject({
        status: 409,
      })
      await store.addMember(superActor, a.id, ' OWNER@Example.com ')
      await store.addMember(superActor, a.id, member.email)
      await store.setOwner(superActor, a.id, owner.email)
      await store.addMember(superActor, b.id, member.email)
      expect(await store.admitted(owner.email)).toBe(true)
      await store.addMember(superActor, a.id, owner.email)
      expect((await store.members(owner, a.id)).find((m) => m.email === owner.email)?.role).toBe(
        'owner',
      )
      await expect(store.removeMember(owner, a.id, owner.email)).rejects.toMatchObject({
        status: 403,
      })
      await expect(store.setOwner(owner, a.id, member.email)).rejects.toMatchObject({ status: 403 })
      await expect(store.members(member, a.id)).rejects.toMatchObject({ status: 403 })
      await expect(store.addMember(owner, b.id, 'foreign@example.com')).rejects.toMatchObject({
        status: 403,
      })
      await expect(store.setOwner(superActor, a.id, 'absent@example.com')).rejects.toMatchObject({
        status: 400,
      })
      // Pre-sign-in grants become plugin rows only after a real user exists.
      await sql`INSERT INTO "user" VALUES ('owner', 'Owner', ${owner.email}, true, null, now(), now())`
      await store.materialize('owner', owner.email)
      await store.materialize('owner', owner.email)
      expect((await sql`SELECT role FROM member WHERE "userId" = 'owner'`)[0].role).toBe('owner')
      const repoA = 'https://github.com/example/a',
        repoB = 'https://github.com/example/b',
        legacy = 'https://github.com/example/legacy'
      for (const repo of [repoA, repoB, legacy]) await registry.add(repo, 'fixture')
      await store.assign(superActor, a.id, repoA)
      await store.assign(superActor, b.id, repoB)
      expect(await store.projects(owner)).toEqual([repoA])
      expect(await store.projects(member)).toEqual([repoA, repoB])
      expect(await store.unassigned(superActor)).toEqual([legacy])
      expect(await store.canAccess(owner, legacy)).toBe(false)
      await expect(store.unassigned(member)).rejects.toMatchObject({ status: 403 })
      await registry.remove(repoA, 'fixture')
      expect(await store.projects(owner)).toEqual([])
      await registry.add(repoA, 'fixture')
      expect(await store.projects(owner)).toEqual([repoA])
      // Database-level constraints, independent of the adapter's guards.
      await expect(
        Promise.resolve(
          sql`INSERT INTO organization_emails VALUES (${a.id}, 'UPPER@example.com', 'member')`,
        ),
      ).rejects.toThrow()
      await expect(
        Promise.resolve(
          sql`INSERT INTO organization_emails VALUES ('missing', 'x@example.com', 'member')`,
        ),
      ).rejects.toThrow()
      await expect(
        Promise.resolve(
          sql`INSERT INTO organization_emails VALUES (${a.id}, 'x@example.com', 'owner')`,
        ),
      ).rejects.toThrow()
      const env = {
        BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
        BETTER_AUTH_URL: 'https://operator.example',
        GITHUB_CLIENT_ID: 'client',
        GITHUB_CLIENT_SECRET: 'secret',
        AB_WEB_AUTH_PROVIDERS: 'github',
        AB_WEB_SUPER_USER_EMAILS: superActor.email,
        AB_POSTGRES_URL: url.href,
        AB_STORE_SECRET: 'store-secret',
      }
      const access = new HumanAccess(async () => store, env)
      let email = owner.email
      const getSession = async () => ({ user: { email }, session: { expiresAt: '2030-01-01' } })
      const handler = createOrganizationHandler({ access, getSession })
      const req = (path: string, method = 'GET', body?: unknown, headers = {}) =>
        new Request(`${env.BETTER_AUTH_URL}/api/web/${path}`, {
          method,
          headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const discovery = await (await handler(req('orgs'))).json()
      expect(discovery).toEqual({
        isSuperUser: false,
        organizations: [{ ...a, ownerEmail: owner.email, membershipRole: 'owner' }],
      })
      expect((await handler(req(`orgs/${a.id}`))).status).toBe(403)
      expect((await handler(req(`orgs/${a.id}/members`))).status).toBe(200)
      expect(
        (await handler(req(`orgs/${a.id}/members`, 'POST', { email: 'new@example.com' }))).status,
      ).toBe(200)
      expect(
        (await handler(req(`orgs/${a.id}/members`, 'DELETE', { email: 'new@example.com' }))).status,
      ).toBe(200)
      expect(
        (
          await handler(
            req(`orgs/${a.id}/members`, 'POST', { email: 'new@example.com', role: 'owner' }),
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await handler(
            req(
              `orgs/${a.id}/members`,
              'POST',
              { email: 'new@example.com' },
              { origin: 'https://evil.example' },
            ),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await handler(
            req(
              `orgs/${a.id}/members`,
              'POST',
              { email: 'new@example.com' },
              { 'content-type': 'text/plain' },
            ),
          )
        ).status,
      ).toBe(400)
      email = member.email
      expect((await (await handler(req('orgs'))).json()).organizations).toHaveLength(2)
      expect((await handler(req(`orgs/${a.id}/members`))).status).toBe(403)
      expect((await handler(req('projects/unassigned'))).status).toBe(403)
      for (const [path, method, body] of [
        ['orgs', 'POST', { name: 'No', slug: 'no' }],
        [`orgs/${a.id}`, 'GET', undefined],
        [`orgs/${a.id}/members`, 'POST', { email: 'no@example.com' }],
        [`orgs/${a.id}/members`, 'DELETE', { email: owner.email }],
        [`orgs/${a.id}/owner`, 'PUT', { email: member.email }],
        [`orgs/${a.id}/projects`, 'PUT', { repo: legacy }],
      ] as const)
        expect((await handler(req(path, method, body))).status).toBe(403)
      email = superActor.email
      const created = await handler(req('orgs', 'POST', { name: 'C', slug: 'c' }))
      expect(created.status).toBe(201)
      const { organization: c } = await created.json()
      expect(c).toEqual({
        id: expect.any(String),
        name: 'C',
        slug: 'c',
        ownerEmail: null,
        membershipRole: null,
      })
      expect((await handler(req('orgs', 'POST', { name: 'Again', slug: 'c' }))).status).toBe(409)
      expect(await (await handler(req(`orgs/${a.id}`))).json()).toEqual({
        organization: { ...a, ownerEmail: owner.email, membershipRole: null },
        projects: [repoA],
      })
      expect((await handler(req(`orgs/${c.id}/owner`, 'PUT', { email: owner.email }))).status).toBe(
        400,
      )
      const ownerUpdate = await handler(req(`orgs/${a.id}/owner`, 'PUT', { email: owner.email }))
      expect((await ownerUpdate.json()).organization).toEqual({
        ...a,
        ownerEmail: owner.email,
        membershipRole: null,
      })
      const unavailable = createOrganizationHandler({
        access: new HumanAccess(async () => {
          throw new Error('private database details')
        }, env),
        getSession,
      })
      const failure = await unavailable(req('orgs'))
      expect(failure.status).toBe(503)
      expect(await failure.text()).not.toContain('private database')
      for (const expiresAt of ['bad-date', '2000-01-01']) {
        const expired = createOrganizationHandler({
          access,
          getSession: async () => ({ user: { email }, session: { expiresAt } }),
        })
        expect((await expired(req('orgs'))).status).toBe(401)
      }
      expect(
        (await (await handler(req('orgs'))).json()).organizations.every(
          (o: { membershipRole: null }) => o.membershipRole === null,
        ),
      ).toBe(true)
      expect(await (await handler(req('projects/unassigned'))).json()).toEqual({
        projects: [legacy],
      })
      expect((await handler(req(`orgs/${a.id}/projects`, 'PUT', { repo: legacy }))).status).toBe(
        200,
      )
      expect(await (await handler(req('projects/unassigned'))).json()).toEqual({ projects: [] })
      let delegated = 0
      const gateway = createWebGateway({
        env,
        access,
        projects: registry,
        getSession,
        delegate: async () => {
          delegated++
          return Response.json({ ok: true })
        },
      })
      email = owner.email
      const foreign = await gateway.fetch(req(`repos/${encodeURIComponent(repoB)}/dashboard`))
      const missing = await gateway.fetch(
        req(`repos/${encodeURIComponent('https://github.com/example/missing')}/dashboard`),
      )
      expect(foreign.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(delegated).toBe(0)
      expect(
        (await gateway.fetch(req(`repos/${encodeURIComponent(repoA)}/dashboard`))).status,
      ).toBe(200)
      // Same endpoint and same session identity after a live grant removal.
      await store.removeMember(superActor, a.id, owner.email)
      expect(await sql`SELECT * FROM member WHERE "userId" = 'owner'`).toHaveLength(0)
      await store.materialize('owner', owner.email)
      expect(await sql`SELECT * FROM member WHERE "userId" = 'owner'`).toHaveLength(0)
      expect((await handler(req('orgs'))).status).toBe(403)
      expect(
        (await gateway.fetch(req(`repos/${encodeURIComponent(repoA)}/dashboard`))).status,
      ).toBe(403)
      email = superActor.email
      env.AB_WEB_SUPER_USER_EMAILS = 'replacement@example.com'
      expect((await handler(req('orgs'))).status).toBe(403)
      env.AB_WEB_SUPER_USER_EMAILS = superActor.email
      // Concurrent owner changes serialize to exactly one owner.
      await store.addMember(superActor, a.id, owner.email)
      await Promise.all([
        store.setOwner(superActor, a.id, member.email),
        store.setOwner(superActor, a.id, owner.email),
      ])
      expect(
        (await store.members(superActor, a.id)).filter((m) => m.role === 'owner'),
      ).toHaveLength(1)
      await store.setOwner(superActor, a.id, null)
      expect((await store.inspect(superActor, a.id)).organization.ownerEmail).toBeNull()
      const connect = new PostgresConnectionStore(sql)
      const secret = 'e'.repeat(64)
      const start = (digit: string, repo = 'https://github.com/example/new') =>
        connect.start({
          repo,
          credentialId: digit.repeat(32),
          digest: createHash('sha256').update(secret).digest('hex'),
        })
      const proposal = await start('1')
      await expect(connect.decide(proposal.code, member.email, true, member)).rejects.toThrow(
        'organization is required',
      )
      await expect(
        connect.decide(proposal.code, superActor.email, true, superActor),
      ).rejects.toThrow('organization is required')
      await expect(connect.decide(proposal.code, superActor.email, true)).rejects.toThrow(
        'browser principal required',
      )
      await connect.decide(proposal.code, member.email, true, member, b.id)
      expect(await store.canAccess(owner, 'https://github.com/example/new')).toBe(false)
      await expect(connect.lookup(proposal.code, owner.email, owner)).rejects.toMatchObject({
        status: 404,
      })
      await expect(
        connect.decide(proposal.code, owner.email, true, owner, b.id),
      ).rejects.toMatchObject({ status: 404 })
      const reconnect = await start('2', repoA)
      await expect(
        connect.decide(reconnect.code, member.email, true, member, b.id),
      ).rejects.toThrow('project moves')
      await connect.decide(reconnect.code, member.email, true, member, a.id)
      await store.removeMember(superActor, a.id, member.email)
      await store.removeMember(superActor, b.id, member.email)
      await expect(
        connect.decide(reconnect.code, member.email, true, member),
      ).rejects.toMatchObject({ status: 403 })
      const [{ count }] =
        await sql`SELECT count(*)::int AS count FROM project_credentials WHERE revoked_at IS NULL`
      expect(count).toBe(2)
      const credentials = new PostgresCredentialStore(sql, registry)
      expect(
        (await credentials.authenticate(`abp_1_${'1'.repeat(32)}_${secret}`, new Date()))?.repo,
      ).toBe('https://github.com/example/new')
      const rollbackRepo = 'https://github.com/example/rolled-back'
      const collision = await start('1', rollbackRepo)
      await expect(
        connect.decide(collision.code, superActor.email, true, superActor, a.id),
      ).rejects.toThrow()
      expect(await registry.has(rollbackRepo)).toBe(false)
      expect(
        await sql`SELECT * FROM project_organizations WHERE repo = ${rollbackRepo}`,
      ).toHaveLength(0)
      expect((await connect.lookup(collision.code, superActor.email, superActor))?.status).toBe(
        'pending',
      )
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
  30000,
)
