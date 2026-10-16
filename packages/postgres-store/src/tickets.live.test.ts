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
        teamKey: 'AUT',
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
      teamKey: 'AUT',
      repo: 'https://github.com/acme/one',
      lifecycle: { triage: 'Inbox', ready: 'Open', doing: 'Open', done: 'Complete' },
      createState: 'Draft',
      proposalState: 'Proposed',
    })
    const two = database.source({
      teamKey: 'TWO',
      repo: 'https://github.com/acme/two',
      lifecycle: { triage: 'Backlog', ready: 'Todo', doing: 'Active', done: 'Shipped' },
    })
    try {
      const a = await one.create({ title: 'One', body: 'Body' }, { idempotencyKey: 'same' })
      const b = await two.create({ title: 'Two', body: 'Body' }, { idempotencyKey: 'same' })
      expect(a.ref.id).not.toBe(b.ref.id)
      expect(a.state).toBe('Draft')
      expect(b.state).toBe('Backlog')
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
      await database.sql`UPDATE ab_tickets SET id = ${a.ref.id} WHERE repo = 'https://github.com/acme/two' AND readable_id = ${b.ref.id}`
      await one.comment(a.ref.id, 'one comment')
      await two.comment(a.ref.id, 'two comment')
      await one.transition(a.ref.id, 'Complete')
      await two.transition(a.ref.id, 'Shipped')
      expect((await one.get(a.ref.id))?.resolved).toBe(true)
      expect((await two.get(a.ref.id))?.resolved).toBe(true)
      expect((await one.get(a.ref.id))?.title).toBe('One')
      expect((await two.get(a.ref.id))?.title).toBe('Two')
      const comments =
        await database.sql`SELECT repo, seq, body FROM ab_ticket_comments ORDER BY repo`
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

if (testUrl) {
  test('readable numbering serializes independent pools, adopts creation keys, and survives deletion and prefix changes', async () => {
    const isolated = await isolatedDatabase()
    const a = await openPostgresTicketDatabase(isolated.url)
    const b = await openPostgresTicketDatabase(isolated.url)
    const context = {
      repo: 'one',
      teamKey: 'Eng',
      lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
    }
    const one = a.source(context),
      otherPool = b.source(context)
    const draft = { title: 'Ticket', body: 'Body' }
    try {
      const adopted = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? one : otherPool).create(draft, { idempotencyKey: 'same' }),
        ),
      )
      expect(new Set(adopted.map((t) => t.ref.id))).toEqual(new Set(['Eng-1']))
      const created = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? one : otherPool).create(draft)),
      )
      expect(new Set(created.map((t) => t.ref.id)).size).toBe(12)
      expect(
        (await a.sql`SELECT last_number::text FROM ab_ticket_counters WHERE repo = 'one'`)[0]
          .last_number,
      ).toBe('13')
      await a.sql`DELETE FROM ab_tickets WHERE repo = 'one' AND ticket_number = 13`
      const changed = a.source({ ...context, teamKey: 'NEW' })
      expect((await changed.create(draft)).ref.id).toBe('NEW-14')
      expect((await one.create(draft)).ref.id).toBe('Eng-15')
      expect((await one.get('eng-1'))?.ref.id).toBe('Eng-1')
      expect((await a.source({ ...context, repo: 'two' }).create(draft)).ref.id).toBe('Eng-1')
      const [legacy] =
        await a.sql`SELECT id FROM ab_tickets WHERE repo = 'one' AND ticket_number = 1`
      expect(await b.source({ ...context, repo: 'two' }).get(String(legacy.id))).toBeNull()
      await expect(one.create({ ...draft, blockedBy: ['missing'] })).rejects.toThrow(
        'unknown ticket',
      )
      expect((await one.create(draft)).ref.id).toBe('Eng-16')
      await a.sql`ALTER TABLE ab_tickets ADD CONSTRAINT fail_insert CHECK (title <> 'rollback')`
      await expect(one.create({ title: 'rollback', body: 'Body' })).rejects.toThrow()
      expect((await one.create(draft)).ref.id).toBe('Eng-17')
      // bigint allocation never passes through a JS number.
      await a.sql`UPDATE ab_ticket_counters SET last_number = 9007199254740992 WHERE repo = 'one'`
      expect((await one.create(draft)).ref.id).toBe('Eng-9007199254740993')
    } finally {
      await a.close()
      await b.close()
      await isolated.cleanup()
    }
  })

  test('all operations accept legacy and mixed-case ids and normalize blocker identity', async () => {
    const isolated = await isolatedDatabase()
    const db = await openPostgresTicketDatabase(isolated.url)
    const source = db.source({
      repo: 'one',
      teamKey: 'ENG',
      lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
    })
    try {
      const first = await source.create({ title: 'One', body: 'Body' })
      const [row] =
        await db.sql`SELECT id FROM ab_tickets WHERE repo = 'one' AND readable_id = ${first.ref.id}`
      const legacy = String(row.id)
      expect((await source.get(legacy))?.ref.id).toBe('ENG-1')
      await source.comment('eng-1', 'comment')
      await source.update(legacy, { body: 'changed' })
      await source.transition('eNg-1', 'Ready')
      expect(await source.claim('eng-1')).toBe(true)
      expect(await source.claim(legacy)).toBe(false)
      const second = await source.create({
        title: 'Two',
        body: 'Body',
        blockedBy: [legacy, 'eng-1', 'ENG-1'],
      })
      expect(second.blockedBy).toEqual(['ENG-1'])
      await source.addBlocker('eng-2', legacy)
      await expect(source.addBlocker('eng-1', legacy)).rejects.toThrow('cannot block itself')
      expect(await source.dependencyStates([legacy, 'eNg-2'])).toEqual([
        { id: legacy, exists: true, resolved: false, blockedBy: [] },
        { id: 'eNg-2', exists: true, resolved: false, blockedBy: ['ENG-1'] },
      ])
      await source.removeBlocker('eNg-2', 'eng-1')
      expect((await source.get('eng-2'))?.blockedBy).toBeUndefined()
      await source.addBlocker('ENG-2', 'eng-1')
      await source.removeBlocker('eng-2', legacy)
      expect((await source.get('eng-2'))?.blockedBy).toBeUndefined()
      await source.transition(legacy, 'Done')
      expect((await source.get('eng-1'))?.resolved).toBe(true)
    } finally {
      await db.close()
      await isolated.cleanup()
    }
  })
}
