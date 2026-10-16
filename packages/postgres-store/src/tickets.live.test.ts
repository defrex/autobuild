import { describe, test } from 'bun:test'
import { SQL } from 'bun'
import { describeTicketSourceContract } from '@defrex/autobuild/plugin-sdk'
import { migratePostgres } from './schema'
import { openPostgresTicketDatabase } from './tickets'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function isolatedDatabase(): Promise<{ url: string; cleanup(): Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_tickets_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  await migratePostgres(scoped.toString())
  return {
    url: scoped.toString(),
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
  describe('PostgreSQL TicketSource live contract', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run TicketSource conformance', () => {})
  })
} else {
  describeTicketSourceContract('PostgresTicketSource', async () => {
    const isolated = await isolatedDatabase()
    const database = await openPostgresTicketDatabase(isolated.url)
    return {
      source: database.source({
        repo: 'https://github.com/acme/one',
        lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
      }),
      states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
      editableLabel: 'autobuild',
      cleanup: async () => {
        await database.close()
        await isolated.cleanup()
      },
    }
  })
}

import { expect } from 'bun:test'
if (testUrl)
  test('project sources isolate reused ids, creation keys, blockers, comments and lifecycle policy', async () => {
    const isolated = await isolatedDatabase()
    const database = await openPostgresTicketDatabase(isolated.url)
    const one = database.source({
      repo: 'https://github.com/acme/one',
      lifecycle: { triage: 'Inbox', ready: 'Open', doing: 'Open', done: 'Complete' },
      createState: 'Draft',
      proposalState: 'Proposed',
    })
    const two = database.source({
      repo: 'https://github.com/acme/two',
      lifecycle: { triage: 'Backlog', ready: 'Todo', doing: 'Active', done: 'Shipped' },
    })
    try {
      const a = await one.create({ title: 'One', body: 'Body' }, { idempotencyKey: 'same' })
      const b = await two.create({ title: 'Two', body: 'Body' }, { idempotencyKey: 'same' })
      expect(a.ref.id).not.toBe(b.ref.id)
      expect(a.state).toBe('Draft')
      expect(b.state).toBe('Backlog')
      expect((await one.get(a.ref.id))?.comments).toEqual([])
      expect(await one.get('missing')).toBeNull()
      expect(await two.get(a.ref.id)).toBeNull()
      expect(await two.claim(a.ref.id)).toBe(false)
      for (const operation of [
        () => two.comment(a.ref.id, 'foreign'),
        () => two.update(a.ref.id, { body: 'foreign' }),
        () => two.transition(a.ref.id, 'Todo'),
        () => two.addBlocker(b.ref.id, a.ref.id),
        () => two.removeBlocker(a.ref.id, b.ref.id),
        () => two.create({ title: 'Foreign blocker', body: 'Body', blockedBy: [a.ref.id] }),
      ])
        await expect(operation()).rejects.toThrow('unknown ticket')
      expect(await two.dependencyStates([a.ref.id])).toEqual([
        { id: a.ref.id, exists: false, resolved: false, blockedBy: [] },
      ])
      // Reused historical ids must stay independent as well.
      await database.sql`UPDATE ab_tickets SET id = ${a.ref.id} WHERE repo = 'https://github.com/acme/two' AND id = ${b.ref.id}`
      await one.comment(a.ref.id, 'one comment')
      await two.comment(a.ref.id, 'two comment')
      expect((await one.get(a.ref.id))?.comments?.map((c) => c.body)).toEqual(['one comment'])
      expect((await two.get(a.ref.id))?.comments?.map((c) => c.body)).toEqual(['two comment'])
      const exact = '  ☃\r\n\r\ntrailing  \n'
      await one.comment(a.ref.id, exact)
      await one.comment(a.ref.id, 'Attached asset: evidence/test.png\n')
      await database.sql`UPDATE ab_ticket_comments SET created_at = '2026-01-02T00:00:00Z'
        WHERE repo = 'https://github.com/acme/one' AND ticket_id = ${a.ref.id}`
      await database.sql`UPDATE ab_ticket_comments SET created_at = '2026-01-01T00:00:00Z'
        WHERE repo = 'https://github.com/acme/one' AND ticket_id = ${a.ref.id} AND seq = 3`
      expect((await one.get(a.ref.id))?.comments).toEqual([
        { body: 'Attached asset: evidence/test.png\n', createdAt: '2026-01-01T00:00:00.000Z' },
        { body: 'one comment', createdAt: '2026-01-02T00:00:00.000Z' },
        { body: exact, createdAt: '2026-01-02T00:00:00.000Z' },
      ])
      expect(
        (await one.listReady({ state: 'Draft' })).tickets.every((t) => t.comments === undefined),
      ).toBe(true)
      await one.transition(a.ref.id, 'Complete')
      await two.transition(a.ref.id, 'Shipped')
      expect((await one.get(a.ref.id))?.resolved).toBe(true)
      expect((await two.get(a.ref.id))?.resolved).toBe(true)
      expect((await one.get(a.ref.id))?.title).toBe('One')
      expect((await two.get(a.ref.id))?.title).toBe('Two')
      const comments =
        await database.sql`SELECT repo, seq, body FROM ab_ticket_comments WHERE seq = 1 ORDER BY repo`
      expect(comments.map((row: { body: string }) => row.body)).toEqual([
        'one comment',
        'two comment',
      ])
      expect(comments.map((row: { seq: number }) => Number(row.seq))).toEqual([1, 1])
      expect(
        (await one.create({ title: 'ignored', body: 'ignored' }, { idempotencyKey: 'same' })).title,
      ).toBe('One')
      expect(
        (await two.create({ title: 'ignored', body: 'ignored' }, { idempotencyKey: 'same' })).title,
      ).toBe('Two')
    } finally {
      await database.close()
      await isolated.cleanup()
    }
  })
