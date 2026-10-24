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
      expect((await store.decide(expired.code, 'owner@example.com', true, principal)).status).toBe(
        'expired',
      )
      expect(await registry.has(repo)).toBe(false)
      const approved = await store.start(proposal('c'))
      // A newly composed instance has no private memory of the start.
      store = new PostgresConnectionStore(sql, () => now)
      const results = await Promise.all([
        store.decide(approved.code, 'owner@example.com', true, principal),
        store.decide(approved.code, 'owner@example.com', true, principal),
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
        store.decide(collision.code, 'owner@example.com', true, principal),
      ).rejects.toThrow()
      expect((await store.lookup(collision.code, 'owner@example.com'))?.status).toBe('pending')
      expect((await credentials.list(repo)).length).toBe(1)
      await store.poll(approved.id, approved.capability, true)
      expect(await credentials.authenticate(token, now)).toBeNull()
      expect(await registry.has(repo)).toBe(true)
      const race = await store.start(proposal('d'))
      await Promise.all([
        store.decide(race.code, 'owner@example.com', true, principal),
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
  'browser context exposes only eligible new-project destinations and fixes every reconnect',
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
      await store.decide(fresh.code, member.email, true, member)
      const reconnect = await start(fresh.repo)
      expect(await store.approvalContext(reconnect.code, member.email, member)).toMatchObject({
        assignment: 'fixed',
        organizations: [],
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
      expect((await store.approvalContext(legacy.code, root.email, root)).assignment).toBe('fixed')
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
