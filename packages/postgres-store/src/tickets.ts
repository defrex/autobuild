import { TicketRevisionConflict } from '@defrex/autobuild/hosted-tickets'
import { SQL } from 'bun'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
  TicketMutation,
} from '@defrex/autobuild/plugin-sdk'
import { validateTicketUpdate } from '@defrex/autobuild/ticket-update'
import { assertTicketSchema } from './schema'
import { PlanRetryRunner, type Exec } from './retry'

type Row = Record<string, unknown>

export interface PostgresTicketLifecycle {
  triage: string
  ready: string
  doing: string
  done: string
}

export interface PostgresTicketContext {
  repo: string
  teamKey: string
  lifecycle: PostgresTicketLifecycle
  proposalState?: string
  claimedState?: string
  createState?: string
}

function requiredState(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be nonblank`)
  return value
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

/** Shared database handle; request-specific source views never retain another
 * repository's identity or lifecycle policy. */
export class PostgresTicketDatabase {
  private readonly retry = new PlanRetryRunner()

  constructor(readonly sql: SQL) {}

  source(context: PostgresTicketContext): PostgresTicketSource {
    return new PostgresTicketSource(this.sql, context, context.lifecycle, this.retry)
  }

  close(): Promise<void> {
    return this.sql.close()
  }
}

export async function openPostgresTicketDatabase(url: string): Promise<PostgresTicketDatabase> {
  const sql = new SQL(url)
  try {
    await assertTicketSchema(sql)
    return new PostgresTicketDatabase(sql)
  } catch (error) {
    await sql.close()
    throw error
  }
}

export class PostgresTicketSource implements TicketSource {
  readonly name = 'database'
  private readonly teamKey: string
  private readonly repo: string
  private readonly claimedState: string
  private readonly createState: string
  private readonly allowed: Set<string>

  constructor(
    private readonly sql: SQL,
    context: PostgresTicketContext,
    private readonly lifecycle: PostgresTicketLifecycle,
    /** Optional trailing parameter so the exported constructor stays
     * signature-compatible; a fresh runner keeps the per-instance marker
     * namespace when no pool owner supplies one. */
    private readonly retry: PlanRetryRunner = new PlanRetryRunner(),
  ) {
    if (!context.repo.trim()) throw new Error('ticket repo must be nonblank')
    this.teamKey = context.teamKey
    this.repo = context.repo
    this.allowed = new Set(
      [
        ...Object.values(lifecycle),
        context.claimedState ?? lifecycle.doing,
        context.createState ?? lifecycle.triage,
        context.proposalState ?? lifecycle.triage,
      ].map((value) => requiredState(value, 'ticket state')),
    )
    this.claimedState = context.claimedState ?? lifecycle.doing
    this.createState = context.createState ?? lifecycle.triage
    this.assertState(this.claimedState)
    this.assertState(this.createState)
  }

  private assertState(state: string): void {
    if (!this.allowed.has(state)) {
      throw new Error(
        `database ticket state "${state}" is not configured; allowed states: ${[...this.allowed].join(', ')}`,
      )
    }
  }

  private async blockers(executor: Exec, id: string): Promise<string[]> {
    const rows: Row[] = await executor`SELECT t.readable_id AS blocker_id FROM ab_ticket_blockers b
      JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id
      WHERE b.repo = ${this.repo} AND b.ticket_id = ${id} ORDER BY t.readable_id`
    return rows.map((row) => String(row.blocker_id))
  }

  private async record(executor: Exec, row: Row): Promise<Ticket> {
    const id = String(row.id)
    const title = String(row.title)
    const blockedBy =
      row.blockers === undefined ? await this.blockers(executor, id) : strings(row.blockers)
    return {
      ref: { source: this.name, id: String(row.readable_id), title },
      revision: String(row.revision),
      ...(row.creation_key !== null && row.creation_key !== undefined
        ? { creationKey: String(row.creation_key) }
        : {}),
      title,
      body: String(row.body),
      state: String(row.state),
      resolved: String(row.state) === this.lifecycle.done,
      labels: strings(row.labels),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }

  private async lookup(executor: Exec, id: string, lock = false): Promise<Row | undefined> {
    const rows: Row[] = lock
      ? await executor`SELECT *, revision::text AS revision FROM ab_tickets WHERE repo = ${this.repo} AND (id = ${id} OR lower(readable_id) = lower(${id})) FOR UPDATE`
      : await executor`SELECT *, revision::text AS revision FROM ab_tickets WHERE repo = ${this.repo} AND (id = ${id} OR lower(readable_id) = lower(${id}))`
    return rows[0]
  }

  private async require(executor: Exec, id: string, operation: string, lock = false): Promise<Row> {
    const row = await this.lookup(executor, id, lock)
    if (!row) throw new Error(`database ticket source: ${operation} on unknown ticket "${id}"`)
    return row
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    return this.retry.run(this.sql, async (q) => {
      const rows: Row[] =
        await q`SELECT *, revision::text AS revision, ARRAY(SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id WHERE b.repo = ab_tickets.repo AND b.ticket_id = ab_tickets.id ORDER BY t.readable_id) AS blockers FROM ab_tickets
        WHERE repo = ${this.repo}
          AND (${criteria.state ?? null}::text IS NULL OR state = ${criteria.state ?? null})
          AND labels @> ${q.array(labels, 'text')}
        ORDER BY created_at, id`
      // Sequential, not `Promise.all`: every statement of a body runs on one
      // pinned connection, and failure attribution (`Attempt.inFlight` in
      // `./retry`) requires the statements to be ordered.
      const tickets: Ticket[] = []
      for (const row of rows) tickets.push(await this.record(q, row))
      return { tickets, diagnostics: [] }
    })
  }

  async get(id: string): Promise<Ticket | null> {
    return this.retry.run(this.sql, async (q) => {
      const rows: Row[] =
        await q`SELECT *, revision::text AS revision, ARRAY(SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id WHERE b.repo = ab_tickets.repo AND b.ticket_id = ab_tickets.id ORDER BY t.readable_id) AS blockers FROM ab_tickets WHERE repo = ${this.repo} AND (id = ${id} OR lower(readable_id) = lower(${id}))`
      if (!rows[0]) return null
      const ticket = await this.record(q, rows[0])
      const storageId = String(rows[0].id)
      const comments: Row[] = await q`SELECT body, created_at FROM ab_ticket_comments
        WHERE repo = ${this.repo} AND ticket_id = ${storageId}
        ORDER BY created_at ASC, seq ASC`
      return {
        ...ticket,
        comments: comments.map((row) => ({
          body: String(row.body),
          createdAt: new Date(row.created_at as string | Date).toISOString(),
        })),
      }
    })
  }

  async claim(id: string): Promise<boolean> {
    return this.retry.run(this.sql, async (q) => {
      const row = await this.lookup(q, id)
      if (!row) return false
      const storageId = String(row.id)
      const rows: Row[] =
        await q`UPDATE ab_tickets SET state = ${this.claimedState}, revision = revision + 1,
        updated_at = ${new Date().toISOString()}
        WHERE repo = ${this.repo} AND id = ${storageId}
          AND state <> ${this.claimedState} AND state <> ${this.lifecycle.done} RETURNING id`
      return rows.length === 1
    })
  }

  async comment(id: string, body: string): Promise<void> {
    await this.retry.tx(this.sql, async (q) => {
      const storageId = String((await this.require(q, id, 'comment', true)).id)
      const tails: Row[] = await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM ab_ticket_comments
        WHERE repo = ${this.repo} AND ticket_id = ${storageId}`
      await q`INSERT INTO ab_ticket_comments (repo, ticket_id, seq, body, created_at)
        VALUES (${this.repo}, ${storageId}, ${Number(tails[0]?.seq ?? 0) + 1}, ${body}, ${new Date().toISOString()})`
    })
  }

  async transition(id: string, state: string): Promise<void> {
    await this.mutate(id, { kind: 'transition', state })
  }

  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    if (!draft.title.trim()) throw new Error('database ticket create: title must be nonblank')
    if (!draft.body.trim()) throw new Error('database ticket create: body must be nonblank')
    requiredState(this.teamKey, 'ticket teamKey')
    const state = options.state ?? this.createState
    this.assertState(state)
    return this.retry.tx(this.sql, async (q) => {
      await q`INSERT INTO ab_ticket_counters (repo, last_number) VALUES (${this.repo}, 0) ON CONFLICT DO NOTHING`
      await q`SELECT last_number FROM ab_ticket_counters WHERE repo = ${this.repo} FOR UPDATE`
      if (options.idempotencyKey !== undefined) {
        const adopted: Row[] = await q`SELECT *, revision::text AS revision FROM ab_tickets
          WHERE repo = ${this.repo} AND creation_key = ${options.idempotencyKey} FOR UPDATE`
        if (adopted[0]) return this.record(q, adopted[0])
      }
      const blockers: string[] = []
      for (const blocker of draft.blockedBy ?? []) {
        blockers.push(String((await this.require(q, blocker, 'create blocker')).id))
      }
      const [allocation] =
        await q`UPDATE ab_ticket_counters SET last_number = last_number + 1 WHERE repo = ${this.repo} RETURNING last_number::text`
      const number = String(allocation!.last_number)
      const readable = `${this.teamKey}-${number}`
      const id = `ticket-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const inserted: Row[] = await q`INSERT INTO ab_tickets
        (repo, id, readable_id, ticket_number, creation_key, title, body, state, labels, created_at, updated_at)
        VALUES (${this.repo}, ${id}, ${readable}, ${number}::bigint, ${options.idempotencyKey ?? null}, ${draft.title}, ${draft.body},
          ${state}, ${q.array(draft.labels ?? [], 'text')}, ${now}, ${now})
        ON CONFLICT (repo, creation_key) DO NOTHING RETURNING *, revision::text AS revision`
      let row = inserted[0]
      if (!row && options.idempotencyKey !== undefined) {
        const adopted: Row[] = await q`SELECT *, revision::text AS revision FROM ab_tickets
          WHERE repo = ${this.repo} AND creation_key = ${options.idempotencyKey} FOR UPDATE`
        row = adopted[0]
      }
      if (!row) throw new Error('database ticket create failed')
      if (String(row.id) === id) {
        for (const blocker of [...new Set(blockers)]) {
          if (blocker === id)
            throw new Error(`database ticket source: ticket "${id}" cannot block itself`)
          await q`INSERT INTO ab_ticket_blockers (repo, ticket_id, blocker_id)
            VALUES (${this.repo}, ${id}, ${blocker}) ON CONFLICT DO NOTHING`
        }
      }
      return this.record(q, row)
    })
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    await this.mutate(id, { kind: 'update', patch })
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    await this.mutate(id, { kind: 'blockers', operation: 'block', ids: [blockerId] })
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    await this.mutate(id, { kind: 'blockers', operation: 'unblock', ids: [blockerId] })
  }

  async mutateIfRevision(id: string, expected: string, mutation: TicketMutation): Promise<void> {
    if (!expected.trim()) throw new Error('expected revision must be nonblank')
    await this.mutate(id, mutation, expected)
  }

  private async mutate(id: string, mutation: TicketMutation, expected?: string): Promise<void> {
    const patch = mutation.kind === 'update' ? validateTicketUpdate(mutation.patch) : undefined
    if (mutation.kind === 'transition') this.assertState(mutation.state)
    await this.retry.tx(this.sql, async (q) => {
      const row = await this.require(q, id, 'mutation', true)
      const storageId = String(row.id)
      const revision = String(row.revision)
      if (expected !== undefined && revision !== expected)
        throw new TicketRevisionConflict(id, expected, revision)
      let changed = false
      if (patch) {
        const title = patch.title ?? String(row.title)
        const body = patch.body ?? String(row.body)
        const labels = patch.labels ?? strings(row.labels)
        changed =
          title !== row.title ||
          body !== row.body ||
          JSON.stringify([...new Set(labels)].sort()) !==
            JSON.stringify([...new Set(strings(row.labels))].sort())
        if (changed)
          await q`UPDATE ab_tickets SET title = ${title}, body = ${body}, labels = ${q.array(labels, 'text')} WHERE repo = ${this.repo} AND id = ${storageId}`
      } else if (mutation.kind === 'transition') {
        changed = row.state !== mutation.state
        if (changed)
          await q`UPDATE ab_tickets SET state = ${mutation.state} WHERE repo = ${this.repo} AND id = ${storageId}`
      } else if (mutation.kind === 'blockers') {
        const keys = new Set<string>()
        for (const blocker of mutation.ids) {
          const target =
            mutation.operation === 'block' || expected !== undefined
              ? await this.require(q, blocker, 'blocker')
              : await this.lookup(q, blocker)
          if (!target) continue
          const key = String(target.id)
          if (mutation.operation === 'block' && key === storageId)
            throw new Error(`ticket "${id}" cannot block itself`)
          keys.add(key)
        }
        const ids = [...keys]
        for (const blocker of ids) {
          const rows: Row[] =
            mutation.operation === 'block'
              ? await q`INSERT INTO ab_ticket_blockers (repo, ticket_id, blocker_id) VALUES (${this.repo}, ${storageId}, ${blocker}) ON CONFLICT DO NOTHING RETURNING blocker_id`
              : await q`DELETE FROM ab_ticket_blockers WHERE repo = ${this.repo} AND ticket_id = ${storageId} AND blocker_id = ${blocker} RETURNING blocker_id`
          changed ||= rows.length > 0
        }
      }
      if (changed)
        await q`UPDATE ab_tickets SET revision = revision + 1, updated_at = ${new Date().toISOString()} WHERE repo = ${this.repo} AND id = ${storageId}`
    })
  }

  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    return Promise.all(
      ids.map((id) =>
        // One run per id keeps each id's state read + blockers query
        // sequential on one pinned connection; the ids stay concurrent.
        this.retry.run(this.sql, async (q) => {
          const row = await this.lookup(q, id)
          if (!row) return { id, exists: false, resolved: false, blockedBy: [] }
          return {
            id,
            exists: true,
            resolved: String(row.state) === this.lifecycle.done,
            blockedBy: await this.blockers(q, String(row.id)),
          }
        }),
      ),
    )
  }
}
