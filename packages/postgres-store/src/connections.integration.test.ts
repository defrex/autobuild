import { PostgresOrganizationStore } from './organizations'
import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { PostgresConnectionStore } from './connections'
import { PostgresCredentialStore } from './credentials'
import { PostgresProjectRegistry } from './projects'
import { migratePostgres } from './schema'
const testURL = process.env.AB_POSTGRES_TEST_URL
const live = testURL ? test : test.skip
live(
  'durable approval, denial, expiry, collisions and cancellation are atomic across instances',
  async () => {
    const admin = new SQL(testURL!),
      schema = `connect_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    let sql: SQL | undefined
    try {
      await migratePostgres(url.href)
      sql = new SQL(url.href)
      const principal = { email: 'owner@example.com', isSuperUser: () => true }
      const access = new PostgresOrganizationStore(sql)
      const org = await access.create(principal, 'Example', 'example')
      await access.addMember(principal, org.id, principal.email)
      let now = new Date('2026-10-15T12:00:00Z')
      let store = new PostgresConnectionStore(sql, () => now)
      const registry = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, registry)
      const repo = 'https://github.com/example/project',
        secret = 'f'.repeat(64)
      const proposal = (id: string) => ({
        repo,
        credentialId: id.repeat(32),
        digest: createHash('sha256').update(secret).digest('hex'),
      })
      const denied = await store.start(proposal('a'))
      await store.decide(denied.code, 'owner@example.com', false, principal)
      expect(await registry.has(repo)).toBe(false)
      expect(await credentials.list(repo)).toEqual([])
      const expired = await store.start(proposal('b'))
      now = new Date(now.getTime() + 600001)
      expect(
        (await store.decide(expired.code, 'owner@example.com', true, principal, org.id)).status,
      ).toBe('expired')
      expect(await registry.has(repo)).toBe(false)
      const approved = await store.start(proposal('c'))
      // A newly composed instance has no private memory of the start.
      store = new PostgresConnectionStore(sql, () => now)
      const results = await Promise.all([
        store.decide(approved.code, 'owner@example.com', true, principal, org.id),
        store.decide(approved.code, 'owner@example.com', true, principal, org.id),
      ])
      expect(results.map((value) => value.status)).toEqual(['approved', 'approved'])
      expect((await credentials.list(repo)).length).toBe(1)
      const token = `abp_1_${proposal('c').credentialId}_${secret}`
      expect((await credentials.authenticate(token, now))?.repo).toBe(repo)
      await expect(store.poll(approved.id, approved.code)).rejects.toThrow('unknown')
      expect((await store.poll(approved.id, approved.capability)).status).toBe('approved')
      await expect(store.poll(approved.id, approved.capability)).rejects.toThrow('five seconds')
      const collision = await store.start(proposal('c'))
      await expect(
        store.decide(collision.code, 'owner@example.com', true, principal, org.id),
      ).rejects.toThrow()
      expect((await store.lookup(collision.code, 'owner@example.com'))?.status).toBe('pending')
      expect((await credentials.list(repo)).length).toBe(1)
      await store.poll(approved.id, approved.capability, true)
      expect(await credentials.authenticate(token, now)).toBeNull()
      expect(await registry.has(repo)).toBe(true)
      const race = await store.start(proposal('d'))
      await Promise.all([
        store.decide(race.code, 'owner@example.com', true, principal, org.id),
        store.poll(race.id, race.capability, true),
      ])
      expect(
        await credentials.authenticate(`abp_1_${proposal('d').credentialId}_${secret}`, now),
      ).toBeNull()
    } finally {
      await sql?.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)

live(
  'browser context exposes eligible unassigned destinations and fixed assigned reconnects',
  async () => {
    const admin = new SQL(testURL!),
      schema = `context_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    let sql: SQL | undefined
    try {
      await migratePostgres(url.href)
      sql = new SQL(url.href)
      const root = { email: 'root@example.com', isSuperUser: () => true }
      const member = { email: 'member@example.com', isSuperUser: () => false }
      const outsider = { email: 'outsider@example.com', isSuperUser: () => false }
      const access = new PostgresOrganizationStore(sql),
        store = new PostgresConnectionStore(sql),
        registry = new PostgresProjectRegistry(sql)
      const a = await access.create(root, 'A', 'a'),
        b = await access.create(root, 'B', 'b')
      const start = (repo: string) =>
        store.start({
          repo,
          credentialId: crypto.randomUUID().replaceAll('-', ''),
          digest: 'a'.repeat(64),
        })
      const fresh = await start('https://github.com/example/new')
      expect(
        (await store.approvalContext(fresh.code, root.email, root)).organizations,
      ).toHaveLength(2)
      await expect(
        store.approvalContext(fresh.code, outsider.email, outsider),
      ).rejects.toMatchObject({ status: 403 })
      await access.addMember(root, a.id, member.email)
      expect(
        (await store.approvalContext(fresh.code, member.email, member)).organizations.map(
          (o) => o.id,
        ),
      ).toEqual([a.id])
      await access.addMember(root, b.id, member.email)
      expect(
        (await store.approvalContext(fresh.code, member.email, member)).organizations,
      ).toHaveLength(2)
      await access.removeMember(root, b.id, member.email)
      expect(
        (await store.approvalContext(fresh.code, member.email, member)).organizations,
      ).toHaveLength(1)
      expect(await registry.has(fresh.repo)).toBe(false)
      await expect(
        store.decide(fresh.code, member.email, true, member, b.id),
      ).rejects.toMatchObject({ status: 403 })
      await store.decide(fresh.code, member.email, true, member, a.id)
      const reconnect = await start(fresh.repo)
      expect(await store.approvalContext(reconnect.code, member.email, member)).toMatchObject({
        assignment: 'fixed',
        organizations: [],
        assignedOrganization: { id: a.id, name: 'A' },
      })
      await registry.remove(fresh.repo, 'fixture')
      expect((await store.approvalContext(reconnect.code, member.email, member)).assignment).toBe(
        'fixed',
      )
      await expect(store.decide(reconnect.code, root.email, true, root, b.id)).rejects.toThrow(
        'project moves',
      )
      await access.removeMember(root, a.id, member.email)
      await access.addMember(root, b.id, member.email)
      expect(
        (await store.approvalContext(reconnect.code, member.email, member)).connection,
      ).toBeNull()
      const legacy = await start('https://github.com/example/legacy')
      await registry.add(legacy.repo, 'fixture')
      await registry.remove(legacy.repo, 'fixture')
      expect((await store.approvalContext(legacy.code, root.email, root)).assignment).toBe('new')
      expect((await store.approvalContext(legacy.code, member.email, member)).connection).toBeNull()
      const emptyRoot = { email: root.email, isSuperUser: () => true }
      await sql`DELETE FROM project_organizations`
      await sql`DELETE FROM member`
      await sql`DELETE FROM organization_emails`
      await sql`DELETE FROM organization`
      const zero = await start('https://github.com/example/zero')
      expect(
        (await store.approvalContext(zero.code, emptyRoot.email, emptyRoot)).organizations,
      ).toEqual([])
    } finally {
      await sql?.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
)

live(
  'every unassigned registration history requires an eligible explicit destination with atomic rollback',
  async () => {
    const admin = new SQL(testURL!)
    const schema = `assignment_${crypto.randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const url = new URL(testURL!)
    url.searchParams.set('options', `-csearch_path=${schema}`)
    const sql = new SQL(url.href)
    try {
      await migratePostgres(url.href)
      const root = { email: 'root@example.com', isSuperUser: () => true }
      const member = { email: 'member@example.com', isSuperUser: () => false }
      const access = new PostgresOrganizationStore(sql)
      const registry = new PostgresProjectRegistry(sql)
      const store = new PostgresConnectionStore(sql)
      const start = (repo: string, credentialId = crypto.randomUUID().replaceAll('-', '')) =>
        store.start({ repo, credentialId, digest: 'a'.repeat(64) })
      const snapshot = async (repo: string) => ({
        history: [...(await sql`SELECT * FROM project_journal WHERE repo = ${repo} ORDER BY seq`)],
        credentials: [...(await sql`SELECT * FROM project_credentials WHERE repo = ${repo}`)],
        assignment: [...(await sql`SELECT * FROM project_organizations WHERE repo = ${repo}`)],
        decisions: [
          ...(await sql`SELECT * FROM project_connections WHERE repo = ${repo} ORDER BY id`),
        ],
      })
      const zero = await start('https://github.com/example/zero-org')
      const zeroBefore = await snapshot(zero.repo)
      await expect(store.decide(zero.code, root.email, true, root)).rejects.toMatchObject({
        status: 400,
      })
      await expect(
        store.decide(zero.code, root.email, true, root, 'missing'),
      ).rejects.toMatchObject({ status: 403 })
      expect(await snapshot(zero.repo)).toEqual(zeroBefore)
      await store.decide(zero.code, root.email, false, root)
      expect(await sql`SELECT * FROM project_organizations WHERE repo = ${zero.repo}`).toHaveLength(
        0,
      )
      const a = await access.create(root, 'A', 'a')
      const sole = await start('https://github.com/example/super-sole')
      const soleBefore = await snapshot(sole.repo)
      await expect(store.decide(sole.code, root.email, true, root)).rejects.toMatchObject({
        status: 400,
      })
      expect(await snapshot(sole.repo)).toEqual(soleBefore)
      expect((await store.decide(sole.code, root.email, true, root, a.id)).status).toBe('approved')
      const b = await access.create(root, 'B', 'b')
      await access.addMember(root, a.id, member.email)
      for (const history of ['fresh', 'active', 'removed']) {
        await sql`DELETE FROM connection_lookup_limits`
        const repo = `https://github.com/example/matrix-${history}`
        if (history !== 'fresh') await registry.add(repo, 'fixture')
        if (history === 'removed') await registry.remove(repo, 'fixture')
        const connection = await start(repo)
        const before = await snapshot(repo)
        expect(await store.approvalContext(connection.code, root.email, root)).toMatchObject({
          assignment: 'new',
          assignedOrganization: null,
        })
        await expect(store.decide(connection.code, root.email, true, root)).rejects.toMatchObject({
          status: 400,
        })
        await expect(
          store.decide(connection.code, root.email, true, root, 'missing'),
        ).rejects.toMatchObject({ status: 403 })
        if (history === 'fresh') {
          await expect(
            store.decide(connection.code, member.email, true, member),
          ).rejects.toMatchObject({ status: 400 })
          for (const id of [b.id, 'missing'])
            await expect(
              store.decide(connection.code, member.email, true, member, id),
            ).rejects.toMatchObject({ status: 403 })
        } else {
          expect(
            (await store.approvalContext(connection.code, member.email, member)).connection,
          ).toBeNull()
          await expect(
            store.decide(connection.code, member.email, true, member, a.id),
          ).rejects.toMatchObject({ status: 404 })
        }
        expect(await snapshot(repo)).toEqual(before)
        const actor = history === 'fresh' ? member : root
        expect((await store.decide(connection.code, actor.email, true, actor, a.id)).status).toBe(
          'approved',
        )
        const after = await snapshot(repo)
        expect(after.history.slice(0, before.history.length)).toEqual(before.history)
        expect(after.history).toHaveLength(before.history.length + (history === 'active' ? 0 : 1))
        expect(after.credentials).toHaveLength(1)
        expect(after.assignment).toHaveLength(1)
        expect(after.assignment[0]!.organization_id).toBe(a.id)
        expect(await registry.has(repo)).toBe(true)
        expect(await access.canAccess(member, repo)).toBe(true)
        // Denial, decided requests and removed assigned reconnects never move ownership.
        await registry.remove(repo, 'fixture')
        const denied = await start(repo)
        await store.decide(denied.code, member.email, false, member)
        const reconnect = await start(repo)
        expect(await store.approvalContext(reconnect.code, member.email, member)).toMatchObject({
          assignment: 'fixed',
          assignedOrganization: { id: a.id, name: 'A' },
          organizations: [],
        })
        await expect(
          store.decide(reconnect.code, root.email, true, root, b.id),
        ).rejects.toMatchObject({ status: 400 })
        await store.decide(reconnect.code, member.email, true, member)
        expect((await store.decide(reconnect.code, root.email, true, root, b.id)).status).toBe(
          'approved',
        )
        expect((await snapshot(repo)).assignment).toEqual(after.assignment)
      }
      // A conflicting credential aborts assignment and registration of a fresh repository.
      await sql`DELETE FROM connection_lookup_limits`
      const collisionId = (await sql`SELECT id FROM project_credentials LIMIT 1`)[0]!.id as string
      const collision = await start('https://github.com/example/collision-unassigned', collisionId)
      const beforeCollision = await snapshot(collision.repo)
      await expect(store.decide(collision.code, root.email, true, root, a.id)).rejects.toThrow()
      expect(await snapshot(collision.repo)).toEqual(beforeCollision)

      // Separate pending connections serialize on the access lock, not only their rows.
      const raceRepo = 'https://github.com/example/assignment-race'
      const first = await start(raceRepo),
        second = await start(raceRepo)
      const race = await Promise.allSettled([
        store.decide(first.code, root.email, true, root, a.id),
        store.decide(second.code, root.email, true, root, b.id),
      ])
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(race.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(race.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { status: 400 },
      })
      expect((await snapshot(raceRepo)).assignment).toHaveLength(1)
      expect((await snapshot(raceRepo)).credentials).toHaveLength(1)
    } finally {
      await sql.close()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  },
  30000,
)
