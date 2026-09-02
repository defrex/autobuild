import { SQL } from 'bun'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from 'autobuild/plugin-sdk'
import { validateTicketUpdate } from 'autobuild/plugin-sdk'
import { assertTicketSchema } from './schema'

type Row = Record<string, unknown>

export interface PostgresTicketLifecycle {
  triage: string
  ready: string
  doing: string
  done: string
}

export interface PostgresTicketContext {
  teamKey: string
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
 * repository's team or lifecycle overrides. */
export class PostgresTicketDatabase {
  readonly lifecycle: PostgresTicketLifecycle

  constructor(
    readonly sql: SQL,
    lifecycle: PostgresTicketLifecycle,
  ) {
    this.lifecycle = {
      triage: requiredState(lifecycle.triage, 'triage state'),
      ready: requiredState(lifecycle.ready, 'ready state'),
      doing: requiredState(lifecycle.doing, 'doing state'),
      done: requiredState(lifecycle.done, 'done state'),
    }
    if (new Set(Object.values(this.lifecycle)).size !== 4) {
      throw new Error('database ticket lifecycle states must be distinct')
    }
  }

  source(context: PostgresTicketContext): PostgresTicketSource {
    return new PostgresTicketSource(this.sql, context, this.lifecycle)
  }

  close(): Promise<void> {
    return this.sql.close()
  }
}

export async function openPostgresTicketDatabase(
  url: string,
  lifecycle: PostgresTicketLifecycle = {
    triage: 'Triage',
    ready: 'Ready',
    doing: 'Doing',
    done: 'Done',
  },
): Promise<PostgresTicketDatabase> {
  const sql = new SQL(url)
  try {
    await assertTicketSchema(sql)
    return new PostgresTicketDatabase(sql, lifecycle)
  } catch (error) {
    await sql.close()
    throw error
  }
}

export class PostgresTicketSource implements TicketSource {
  readonly name = 'database'
  private readonly team: string
  private readonly claimedState: string
  private readonly createState: string
  private readonly allowed: Set<string>

  constructor(
    private readonly sql: SQL,
    context: PostgresTicketContext,
    private readonly lifecycle: PostgresTicketLifecycle,
  ) {
    if (!context.teamKey.trim()) throw new Error('ticket teamKey must be nonblank')
    this.team = context.teamKey
    this.allowed = new Set(Object.values(lifecycle))
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

  private async blockers(executor: SQL, id: string): Promise<string[]> {
    const rows: Row[] = await executor`SELECT blocker_id FROM ab_ticket_blockers
      WHERE team = ${this.team} AND ticket_id = ${id} ORDER BY blocker_id`
    return rows.map((row) => String(row.blocker_id))
  }

  private async record(executor: SQL, row: Row): Promise<Ticket> {
    const id = String(row.id)
    const title = String(row.title)
    const blockedBy = await this.blockers(executor, id)
    return {
      ref: { source: this.name, id, title },
      ...(row.creation_key !== null && row.creation_key !== undefined
        ? { creationKey: String(row.creation_key) }
        : {}),
      title,
      body: String(row.body),
      state: String(row.state),
      labels: strings(row.labels),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }

  private async require(executor: SQL, id: string, operation: string, lock = false): Promise<Row> {
    const rows: Row[] = lock
      ? await executor`SELECT * FROM ab_tickets WHERE team = ${this.team} AND id = ${id} FOR UPDATE`
      : await executor`SELECT * FROM ab_tickets WHERE team = ${this.team} AND id = ${id}`
    const row = rows[0]
    if (!row) throw new Error(`database ticket source: ${operation} on unknown ticket "${id}"`)
    return row
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    const rows: Row[] = await this.sql`SELECT * FROM ab_tickets
      WHERE team = ${this.team}
        AND (${criteria.state ?? null}::text IS NULL OR state = ${criteria.state ?? null})
        AND labels @> ${this.sql.array(labels, 'text')}
      ORDER BY created_at, id`
    return {
      tickets: await Promise.all(rows.map((row) => this.record(this.sql, row))),
      diagnostics: [],
    }
  }

  async get(id: string): Promise<Ticket | null> {
    const rows: Row[] = await this
      .sql`SELECT * FROM ab_tickets WHERE team = ${this.team} AND id = ${id}`
    return rows[0] ? this.record(this.sql, rows[0]) : null
  }

  async claim(id: string): Promise<boolean> {
    const rows: Row[] = await this.sql`UPDATE ab_tickets SET state = ${this.claimedState},
      updated_at = ${new Date().toISOString()}
      WHERE team = ${this.team} AND id = ${id}
        AND state <> ${this.claimedState} AND state <> ${this.lifecycle.done} RETURNING id`
    return rows.length === 1
  }

  async comment(id: string, body: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.require(tx, id, 'comment', true)
      const tails: Row[] = await tx`SELECT COALESCE(MAX(seq), 0) AS seq FROM ab_ticket_comments
        WHERE team = ${this.team} AND ticket_id = ${id}`
      await tx`INSERT INTO ab_ticket_comments (team, ticket_id, seq, body, created_at)
        VALUES (${this.team}, ${id}, ${Number(tails[0]?.seq ?? 0) + 1}, ${body}, ${new Date().toISOString()})`
    })
  }

  async transition(id: string, state: string): Promise<void> {
    this.assertState(state)
    const rows: Row[] = await this.sql`UPDATE ab_tickets SET state = ${state},
      updated_at = ${new Date().toISOString()} WHERE team = ${this.team} AND id = ${id} RETURNING id`
    if (!rows[0]) throw new Error(`database ticket source: transition on unknown ticket "${id}"`)
  }

  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    if (!draft.title.trim()) throw new Error('database ticket create: title must be nonblank')
    if (!draft.body.trim()) throw new Error('database ticket create: body must be nonblank')
    const state = options.state ?? this.createState
    this.assertState(state)
    return this.sql.begin(async (tx) => {
      if (options.idempotencyKey !== undefined) {
        const adopted: Row[] = await tx`SELECT * FROM ab_tickets
          WHERE team = ${this.team} AND creation_key = ${options.idempotencyKey} FOR UPDATE`
        if (adopted[0]) return this.record(tx, adopted[0])
      }
      for (const blocker of draft.blockedBy ?? []) {
        await this.require(tx, blocker, 'create blocker')
      }
      const id = `ticket-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const inserted: Row[] = await tx`INSERT INTO ab_tickets
        (team, id, creation_key, title, body, state, labels, created_at, updated_at)
        VALUES (${this.team}, ${id}, ${options.idempotencyKey ?? null}, ${draft.title}, ${draft.body},
          ${state}, ${tx.array(draft.labels ?? [], 'text')}, ${now}, ${now})
        ON CONFLICT (team, creation_key) DO NOTHING RETURNING *`
      let row = inserted[0]
      if (!row && options.idempotencyKey !== undefined) {
        const adopted: Row[] = await tx`SELECT * FROM ab_tickets
          WHERE team = ${this.team} AND creation_key = ${options.idempotencyKey} FOR UPDATE`
        row = adopted[0]
      }
      if (!row) throw new Error('database ticket create failed')
      if (String(row.id) === id) {
        for (const blocker of [...new Set(draft.blockedBy ?? [])]) {
          if (blocker === id)
            throw new Error(`database ticket source: ticket "${id}" cannot block itself`)
          await tx`INSERT INTO ab_ticket_blockers (team, ticket_id, blocker_id)
            VALUES (${this.team}, ${id}, ${blocker}) ON CONFLICT DO NOTHING`
        }
      }
      return this.record(tx, row)
    })
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    await this.sql.begin(async (tx) => {
      const row = await this.require(tx, id, 'update', true)
      await tx`UPDATE ab_tickets SET
        title = ${validated.title ?? String(row.title)},
        body = ${validated.body ?? String(row.body)},
        labels = ${tx.array(validated.labels ?? strings(row.labels), 'text')},
        updated_at = ${new Date().toISOString()}
        WHERE team = ${this.team} AND id = ${id}`
    })
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.require(tx, id, 'addBlocker', true)
      if (id === blockerId)
        throw new Error(`database ticket source: ticket "${id}" cannot block itself`)
      await this.require(tx, blockerId, 'addBlocker')
      await tx`INSERT INTO ab_ticket_blockers (team, ticket_id, blocker_id)
        VALUES (${this.team}, ${id}, ${blockerId}) ON CONFLICT DO NOTHING`
    })
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    await this.require(this.sql, id, 'removeBlocker')
    await this.sql`DELETE FROM ab_ticket_blockers
      WHERE team = ${this.team} AND ticket_id = ${id} AND blocker_id = ${blockerId}`
  }

  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    return Promise.all(
      ids.map(async (id) => {
        const rows: Row[] = await this.sql`SELECT state FROM ab_tickets
        WHERE team = ${this.team} AND id = ${id}`
        if (!rows[0]) return { id, exists: false, resolved: false, blockedBy: [] }
        return {
          id,
          exists: true,
          resolved: String(rows[0].state) === this.lifecycle.done,
          blockedBy: await this.blockers(this.sql, id),
        }
      }),
    )
  }
}
