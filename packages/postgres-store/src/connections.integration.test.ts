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
      await store.decide(denied.code, 'owner@example.com', false)
      expect(await registry.has(repo)).toBe(false)
      expect(await credentials.list(repo)).toEqual([])
      const expired = await store.start(proposal('b'))
      now = new Date(now.getTime() + 600001)
      expect((await store.decide(expired.code, 'owner@example.com', true)).status).toBe('expired')
      expect(await registry.has(repo)).toBe(false)
      const approved = await store.start(proposal('c'))
      // A newly composed instance has no private memory of the start.
      store = new PostgresConnectionStore(sql, () => now)
      const results = await Promise.all([
        store.decide(approved.code, 'owner@example.com', true),
        store.decide(approved.code, 'owner@example.com', true),
      ])
      expect(results.map((value) => value.status)).toEqual(['approved', 'approved'])
      expect((await credentials.list(repo)).length).toBe(1)
      const token = `abp_1_${proposal('c').credentialId}_${secret}`
      expect((await credentials.authenticate(token, now))?.repo).toBe(repo)
      await expect(store.poll(approved.id, approved.code)).rejects.toThrow('unknown')
      expect((await store.poll(approved.id, approved.capability)).status).toBe('approved')
      await expect(store.poll(approved.id, approved.capability)).rejects.toThrow('five seconds')
      const collision = await store.start(proposal('c'))
      await expect(store.decide(collision.code, 'owner@example.com', true)).rejects.toThrow()
      expect((await store.lookup(collision.code, 'owner@example.com'))?.status).toBe('pending')
      expect((await credentials.list(repo)).length).toBe(1)
      await store.poll(approved.id, approved.capability, true)
      expect(await credentials.authenticate(token, now)).toBeNull()
      expect(await registry.has(repo)).toBe(true)
      const race = await store.start(proposal('d'))
      await Promise.all([
        store.decide(race.code, 'owner@example.com', true),
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
