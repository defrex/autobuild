import { hostedRequestedIds, MAX_TICKET_NUMBER } from '@defrex/autobuild/hosted-tickets'
import {
  orderStates,
  resolveState,
  validateStateName,
  validateStatePurpose,
} from '@defrex/autobuild/hosted-tickets'
import { seedTicketStates, lockTicketStates } from './ticket-states'
import { TicketRevisionConflict } from '@defrex/autobuild/hosted-tickets'
import { SQL } from 'bun'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketCriteria,
  TicketPage,
  TicketPageListing,
  TicketSource,
  TicketUpdate,
  TicketStateInfo,
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
  readonly integrationTree = true
  private readonly teamKey: string
  private readonly repo: string
  private readonly claimedState: string
  private readonly createState: string
  private readonly configured: string[]

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
    this.configured = Array.from(
      new Set(
        [
          ...Object.values(lifecycle),
          context.claimedState ?? lifecycle.doing,
          context.createState ?? lifecycle.triage,
          context.proposalState ?? lifecycle.triage,
        ].map((value) => requiredState(value, 'ticket state')),
      ),
    )
    this.claimedState = context.claimedState ?? lifecycle.doing
    this.createState = context.createState ?? lifecycle.triage
  }

  private async states(q: Exec): Promise<TicketStateInfo[]> {
    await seedTicketStates(q, this.repo, this.configured)
    const rows: Row[] = await q`SELECT s.name, s.about, count(t.id)::integer AS tickets
      FROM ab_ticket_states s LEFT JOIN ab_tickets t ON t.repo = s.repo AND t.state = s.name
      WHERE s.repo = ${this.repo} GROUP BY s.name, s.about`
    const infos = rows.map((row) => ({
      name: String(row.name),
      tickets: Number(row.tickets),
      ...(row.about === null ? {} : { about: String(row.about) }),
    }))
    return orderStates(
      infos.map((s) => s.name),
      [this.lifecycle.triage, this.lifecycle.ready, this.lifecycle.doing, this.lifecycle.done],
    ).map((name) => infos.find((s) => s.name === name)!)
  }

  async listStates(): Promise<TicketStateInfo[]> {
    return this.retry.tx(this.sql, (q) => this.states(q))
  }

  async addState(
    name: string,
    opts: { about?: string } = {},
  ): Promise<{ state: TicketStateInfo; created: boolean }> {
    validateStateName(name, 'database ticket source')
    const about = validateStatePurpose(opts.about, 'database ticket source')
    return this.retry.tx(this.sql, async (q) => {
      await lockTicketStates(q, this.repo)
      const states = await this.states(q)
      const clash = states.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (clash)
        throw new Error(
          `database ticket source: state "${name}" already exists as "${clash.name}"; state names are compared case-insensitively`,
        )
      await q`INSERT INTO ab_ticket_states (repo, name, about) VALUES (${this.repo}, ${name}, ${about ?? null})`
      return {
        state: { name, tickets: 0, ...(about === undefined ? {} : { about }) },
        created: true,
      }
    })
  }

  private async state(q: Exec, name: string): Promise<string> {
    return resolveState(
      name,
      (await this.states(q)).map((s) => s.name),
      'database ticket source',
    )
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
      kind: row.kind === 'node' ? 'node' : 'work',
      ...(row.target_id == null
        ? {}
        : {
            target: String(
              row.target_readable_id ??
                (await this.require(executor, String(row.target_id), 'target')).readable_id,
            ),
          }),
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

  listAll(): Promise<TicketListing> {
    return this.listReady({})
  }

  // Creates and metadata mutations take this project lock before any ticket row
  // lock, so ancestor validation cannot race reparenting or node demotion.
  private async graphLock(q: Exec): Promise<void> {
    await q`INSERT INTO ab_ticket_counters (repo, last_number) VALUES (${this.repo}, 0) ON CONFLICT DO NOTHING`
    await q`SELECT last_number FROM ab_ticket_counters WHERE repo = ${this.repo} FOR UPDATE`
  }

  private async tree(
    q: Exec,
    row: Row | undefined,
    patch: TicketDraft | TicketUpdate,
  ): Promise<string | null> {
    if (patch.kind !== undefined && patch.kind !== 'work' && patch.kind !== 'node')
      throw new Error('kind must be work or node')
    if (typeof patch.target === 'string' && !patch.target.trim())
      throw new Error('target must not be blank')
    if (row && row.kind === 'node' && patch.kind === 'work') {
      const children: Row[] =
        await q`SELECT readable_id FROM ab_tickets WHERE repo = ${this.repo} AND target_id = ${String(row.id)} LIMIT 1`
      if (children.length)
        throw new Error(`cannot demote node: ticket ${children[0]!.readable_id} targets it`)
    }
    if (patch.target === undefined) return row?.target_id == null ? null : String(row.target_id)
    if (patch.target === null) return null
    const seen = new Set(row ? [String(row.id)] : [])
    let next: string | null = patch.target
    let target: string | null = null
    while (next !== null) {
      const ancestor = await this.require(q, next, 'target')
      if (ancestor.kind !== 'node') throw new Error(`target ${next} is not a node`)
      const key = String(ancestor.id)
      if (seen.has(key)) throw new Error(`target ${next} would create a cycle`)
      seen.add(key)
      target ??= key
      next = ancestor.target_id == null ? null : String(ancestor.target_id)
    }
    return target
  }

  async listPage(criteria: TicketCriteria, page: TicketPage): Promise<TicketPageListing> {
    const offset = page.offset ?? 0
    if (!Number.isInteger(page.limit) || page.limit < 0 || !Number.isInteger(offset) || offset < 0)
      throw new Error('ticket page limit and offset must be nonnegative integers')
    const labels = criteria.labels ?? []
    return this.retry.tx(this.sql, async (q) => {
      if (criteria.state === undefined) await seedTicketStates(q, this.repo, this.configured)
      const state = criteria.state === undefined ? null : await this.state(q, criteria.state)
      const counts: Row[] = await q`SELECT count(*)::text AS total FROM ab_tickets
        WHERE repo = ${this.repo} AND (${state}::text IS NULL OR state = ${state})
          AND labels @> ${q.array(labels, 'text')}`
      const total = Number(counts[0]!.total)
      if (page.limit === 0) return { tickets: [], diagnostics: [], total }
      const rows: Row[] =
        page.order === 'newest'
          ? await q`SELECT ab_tickets.*, revision::text AS revision,
          (SELECT t.readable_id FROM ab_tickets t WHERE t.repo = ab_tickets.repo AND t.id = ab_tickets.target_id) AS target_readable_id,
          ARRAY(SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id WHERE b.repo = ab_tickets.repo AND b.ticket_id = ab_tickets.id ORDER BY t.readable_id) AS blockers
          FROM ab_tickets WHERE repo = ${this.repo}
          AND (${state}::text IS NULL OR state = ${state}) AND labels @> ${q.array(labels, 'text')}
          ORDER BY created_at DESC, id DESC LIMIT ${page.limit} OFFSET ${offset}`
          : await q`SELECT ab_tickets.*, revision::text AS revision,
          (SELECT t.readable_id FROM ab_tickets t WHERE t.repo = ab_tickets.repo AND t.id = ab_tickets.target_id) AS target_readable_id,
          ARRAY(SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id WHERE b.repo = ab_tickets.repo AND b.ticket_id = ab_tickets.id ORDER BY t.readable_id) AS blockers
          FROM ab_tickets WHERE repo = ${this.repo}
          AND (${state}::text IS NULL OR state = ${state}) AND labels @> ${q.array(labels, 'text')}
          ORDER BY created_at, id LIMIT ${page.limit} OFFSET ${offset}`
      const tickets: Ticket[] = []
      for (const row of rows) tickets.push(await this.record(q, row))
      return { tickets, diagnostics: [], total }
    })
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    return this.retry.tx(this.sql, async (q) => {
      if (criteria.state === undefined) await seedTicketStates(q, this.repo, this.configured)
      const state = criteria.state === undefined ? null : await this.state(q, criteria.state)
      // Project targets in the listing statement to avoid per-record lookups.
      const rows: Row[] = await q`SELECT *, revision::text AS revision,
        (SELECT t.readable_id FROM ab_tickets t WHERE t.repo = ab_tickets.repo AND t.id = ab_tickets.target_id) AS target_readable_id,
        ARRAY(SELECT t.readable_id FROM ab_ticket_blockers b JOIN ab_tickets t ON t.repo = b.repo AND t.id = b.blocker_id WHERE b.repo = ab_tickets.repo AND b.ticket_id = ab_tickets.id ORDER BY t.readable_id) AS blockers FROM ab_tickets
        WHERE repo = ${this.repo}
          AND (${state}::text IS NULL OR state = ${state})
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
    return this.retry.tx(this.sql, async (q) => {
      await seedTicketStates(q, this.repo, this.configured)
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
    return this.retry.tx(this.sql, async (q) => {
      await seedTicketStates(q, this.repo, this.configured)
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

  get requestedIds() {
    return hostedRequestedIds(this.teamKey)
  }

  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    if (!draft.title.trim()) throw new Error('database ticket create: title must be nonblank')
    if (!draft.body.trim() && options.requestedId === undefined)
      throw new Error('database ticket create: body must be nonblank')
    requiredState(this.teamKey, 'ticket teamKey')
    return this.retry.tx(this.sql, async (q) => {
      await this.graphLock(q)
      if (options.idempotencyKey !== undefined) {
        const adopted: Row[] = await q`SELECT *, revision::text AS revision FROM ab_tickets
          WHERE repo = ${this.repo} AND creation_key = ${options.idempotencyKey} FOR UPDATE`
        if (adopted[0]) return this.record(q, adopted[0])
      }
      const target = await this.tree(q, undefined, draft)
      const state = await this.state(q, options.state ?? this.createState)
      const blockers: string[] = []
      for (const blocker of draft.blockedBy ?? []) {
        blockers.push(String((await this.require(q, blocker, 'create blocker')).id))
      }
      const policy = hostedRequestedIds(this.teamKey)
      const kept =
        options.requestedId === undefined ? undefined : policy.preserve(options.requestedId)
      const rows: Row[] = await q`SELECT GREATEST(
        (SELECT last_number FROM ab_ticket_counters WHERE repo = ${this.repo}),
        COALESCE(MAX(ticket_number), 0))::text AS high FROM ab_tickets WHERE repo = ${this.repo}`
      const high = BigInt(String(rows[0]!.high))
      const chosen = kept === undefined ? high + 1n : BigInt(kept.slice(this.teamKey.length + 1))
      if (chosen > MAX_TICKET_NUMBER) throw new Error('ticket numbers exhausted')
      const clashes: Row[] =
        await q`SELECT id FROM ab_tickets WHERE repo = ${this.repo} AND ticket_number = ${String(chosen)}::bigint`
      if (clashes.length) throw new Error(`requested ticket id already occupied: ${kept}`)
      const number = String(chosen)
      await q`UPDATE ab_ticket_counters SET last_number = ${String(chosen > high ? chosen : high)}::bigint WHERE repo = ${this.repo}`
      const readable = `${this.teamKey}-${number}`
      const id = `ticket-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const inserted: Row[] = await q`INSERT INTO ab_tickets
        (repo, id, readable_id, ticket_number, creation_key, title, body, state, labels, created_at, updated_at, kind, target_id)
        VALUES (${this.repo}, ${id}, ${readable}, ${number}::bigint, ${options.idempotencyKey ?? null}, ${draft.title}, ${draft.body},
          ${state}, ${q.array(draft.labels ?? [], 'text')}, ${now}, ${now}, ${draft.kind ?? 'work'}, ${target})
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
    await this.retry.tx(this.sql, async (q) => {
      if (patch && (patch.kind !== undefined || patch.target !== undefined)) await this.graphLock(q)
      const state = mutation.kind === 'transition' ? await this.state(q, mutation.state) : undefined
      const row = await this.require(q, id, 'mutation', true)
      const storageId = String(row.id)
      const revision = String(row.revision)
      if (expected !== undefined && revision !== expected)
        throw new TicketRevisionConflict(id, expected, revision)
      let changed = false
      if (patch) {
        const target = await this.tree(q, row, patch)
        const kind = patch.kind ?? String(row.kind)
        const title = patch.title ?? String(row.title)
        const body = patch.body ?? String(row.body)
        const labels = patch.labels ?? strings(row.labels)
        changed =
          kind !== row.kind ||
          target !== row.target_id ||
          title !== row.title ||
          body !== row.body ||
          JSON.stringify([...new Set(labels)].sort()) !==
            JSON.stringify([...new Set(strings(row.labels))].sort())
        if (changed)
          await q`UPDATE ab_tickets SET kind = ${kind}, target_id = ${target}, title = ${title}, body = ${body}, labels = ${q.array(labels, 'text')} WHERE repo = ${this.repo} AND id = ${storageId}`
      } else if (mutation.kind === 'transition') {
        changed = row.state !== state
        if (changed)
          await q`UPDATE ab_tickets SET state = ${state} WHERE repo = ${this.repo} AND id = ${storageId}`
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
