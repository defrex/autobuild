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
      await database.sql`UPDATE ab_tickets SET id = ${a.ref.id} WHERE repo = 'https://github.com/acme/two' AND readable_id = ${b.ref.id}`
      await one.comment(a.ref.id, 'one comment')
      await two.comment(a.ref.id, 'two comment')
      expect((await one.get(a.ref.id))?.comments?.map((c) => c.body)).toEqual(['one comment'])
      expect((await two.get(a.ref.id))?.comments?.map((c) => c.body)).toEqual(['two comment'])
      const exact = '  ☃\r\n\r\ntrailing  \n'
      await one.comment(a.ref.id, exact)
      await one.comment(a.ref.id, 'Attached asset: evidence/test.png\n')
      await database.sql`UPDATE ab_ticket_comments SET created_at = '2026-01-02T00:00:00Z'
        WHERE repo = 'https://github.com/acme/one' AND ticket_id = (SELECT id FROM ab_tickets WHERE repo = 'https://github.com/acme/one' AND readable_id = ${a.ref.id})`
      await database.sql`UPDATE ab_ticket_comments SET created_at = '2026-01-01T00:00:00Z'
        WHERE repo = 'https://github.com/acme/one' AND ticket_id = (SELECT id FROM ab_tickets WHERE repo = 'https://github.com/acme/one' AND readable_id = ${a.ref.id}) AND seq = 3`
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
      for (const id of [legacy, 'ENG-1', 'eng-1']) {
        expect((await source.get(id))?.comments?.map((comment) => comment.body)).toEqual([
          'comment',
        ])
      }
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
if (testUrl)
  test('revision checks serialize independent clients, batches roll back, and bigint versions stay exact', async () => {
    const isolated = await isolatedDatabase()
    const first = await openPostgresTicketDatabase(isolated.url)
    const second = await openPostgresTicketDatabase(isolated.url)
    const context = {
      repo: 'https://github.com/acme/revisions',
      teamKey: 'ENG',
      lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
    }
    const a = first.source(context)
    const b = second.source(context)
    try {
      const ticket = await a.create({ title: 'Original', body: 'Body' }, { state: 'Ready' })
      const id = ticket.ref.id
      const [stored] =
        await first.sql`SELECT id FROM ab_tickets WHERE repo = ${context.repo} AND readable_id = ${id}`
      const legacy = String(stored.id)
      const writes = await Promise.allSettled([
        a.mutateIfRevision(id.toLowerCase(), ticket.revision, {
          kind: 'update',
          patch: { title: 'First' },
        }),
        b.mutateIfRevision(legacy, ticket.revision, { kind: 'update', patch: { title: 'Second' } }),
      ])
      expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const current = (await a.get(id))!
      const one = await a.create({ title: 'Blocker one', body: 'Body' })
      const two = await a.create({ title: 'Blocker two', body: 'Body' })
      await expect(
        a.mutateIfRevision(id, current.revision, {
          kind: 'blockers',
          operation: 'block',
          ids: [one.ref.id, 'missing'],
        }),
      ).rejects.toThrow('unknown ticket')
      expect(await a.get(id)).toEqual(current)
      await expect(
        a.mutateIfRevision(id.toLowerCase(), current.revision, {
          kind: 'blockers',
          operation: 'block',
          ids: [legacy],
        }),
      ).rejects.toThrow('cannot block itself')
      expect(await a.get(legacy)).toEqual(current)
      await a.mutateIfRevision(id, current.revision, {
        kind: 'blockers',
        operation: 'block',
        ids: [one.ref.id, one.ref.id.toLowerCase(), two.ref.id],
      })
      const blocked = (await a.get(id))!
      expect(BigInt(blocked.revision)).toBe(BigInt(current.revision) + 1n)
      expect(blocked.blockedBy?.sort()).toEqual([one.ref.id, two.ref.id].sort())
      await expect(
        a.mutateIfRevision(id, current.revision, { kind: 'transition', state: 'Done' }),
      ).rejects.toThrow('current revision')
      await expect(
        a.mutateIfRevision(id, current.revision, {
          kind: 'blockers',
          operation: 'unblock',
          ids: [one.ref.id],
        }),
      ).rejects.toThrow('current revision')
      await a.comment(id, 'Separate comment')
      expect((await a.get(id))?.revision).toBe(blocked.revision)
      expect(await a.claim(id)).toBe(true)
      expect((await a.get(id))?.revision).not.toBe(blocked.revision)
      await first.sql`UPDATE ab_tickets SET revision = 9007199254740993 WHERE repo = ${context.repo} AND readable_id = ${id}`
      expect((await a.get(id))?.revision).toBe('9007199254740993')
      await b.mutateIfRevision(id, '9007199254740993', {
        kind: 'update',
        patch: { body: 'Exact bigint' },
      })
      expect((await a.get(id))?.revision).toBe('9007199254740994')
      expect((await a.listReady({})).tickets.find((t) => t.ref.id === id)?.revision).toBe(
        '9007199254740994',
      )
    } finally {
      await first.close()
      await second.close()
      await isolated.cleanup()
    }
  })

if (testUrl)
  test('get and list pair blocker sets with their revision during concurrent writes', async () => {
    const isolated = await isolatedDatabase()
    const database = await openPostgresTicketDatabase(isolated.url)
    const source = database.source({
      repo: 'https://github.com/acme/snapshots',
      teamKey: 'ENG',
      lifecycle: { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' },
    })
    try {
      const blocker = await source.create({ title: 'Blocker', body: 'Body' })
      const target = await source.create({ title: 'Target', body: 'Body' })
      const writer = async () => {
        for (let i = 0; i < 30; i++) {
          await source.addBlocker(target.ref.id, blocker.ref.id)
          await source.removeBlocker(target.ref.id, blocker.ref.id)
        }
      }
      const reader = async () => {
        for (let i = 0; i < 60; i++) {
          const single = (await source.get(target.ref.id))!
          const listed = (await source.listReady({})).tickets.find(
            (t) => t.ref.id === target.ref.id,
          )!
          for (const ticket of [single, listed])
            expect(ticket.blockedBy ?? []).toEqual(
              BigInt(ticket.revision) % 2n === 0n ? [blocker.ref.id] : [],
            )
        }
      }
      await Promise.all([writer(), reader()])
    } finally {
      await database.close()
      await isolated.cleanup()
    }
  })

import { PostgresProjectRegistry } from './projects'
import { PostgresTicketPolicyStore } from './ticket-policy'
import { PostgresTicketGrantStore } from './ticket-grants'

if (testUrl)
  test('ticket policy and grants persist independently, expire, and cannot revive after registration removal', async () => {
    const isolated = await isolatedDatabase()
    const sql = new SQL(isolated.url)
    const projects = new PostgresProjectRegistry(sql)
    const policies = new PostgresTicketPolicyStore(sql)
    const grants = new PostgresTicketGrantStore(sql)
    const repo = 'https://github.com/acme/independent'
    const now = new Date('2026-10-16T12:00:00Z')
    const policy = {
      version: 1 as const,
      tickets: {
        source: 'hosted' as const,
        teamKey: 'ENG',
        triageState: 'triage',
        readyState: 'ready',
        claimedState: 'doing',
        doneState: 'done',
        createState: 'triage',
        proposalState: 'triage',
      },
    }
    try {
      await projects.add(repo, 'owner')
      await Promise.all([policies.put(repo, policy, 'one'), policies.put(repo, policy, 'two')])
      expect(await new PostgresTicketPolicyStore(sql).get(repo)).toEqual(policy)
      expect((await sql`SELECT * FROM builds`).length).toBe(0)
      expect((await sql`SELECT * FROM repo_events`).length).toBe(0)
      const runner = await grants.issue(repo, 'execution', 'runner', null, now)
      const phase = await grants.issue(repo, 'execution', 'phase', runner.grant, now)
      expect(await new PostgresTicketGrantStore(sql).authenticate(phase.token, now)).toEqual(
        phase.grant,
      )
      expect(await grants.authenticate(runner.token, new Date(now.getTime() + 300_001))).toBeNull()
      await grants.renew(runner.grant.id, repo, new Date(now.getTime() + 240_000))
      expect(
        await grants.authenticate(phase.token, new Date(now.getTime() + 360_000)),
      ).not.toBeNull()
      await grants.revoke(runner.grant.id, repo)
      expect(await grants.authenticate(phase.token, now)).toBeNull()
      const active = await grants.issue(repo, 'other', 'runner', null, now)
      await projects.remove(repo, 'owner')
      await projects.add(repo, 'owner')
      expect(await policies.get(repo)).toBeNull()
      expect(await grants.authenticate(active.token, now)).toBeNull()
      await policies.put(repo, policy, 'owner')
      expect(await policies.get(repo)).toEqual(policy)
    } finally {
      await sql.close()
      await isolated.cleanup()
    }
  })
