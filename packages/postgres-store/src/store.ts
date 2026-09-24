import { SQL } from 'bun'
import {
  contentHash,
  humanActor,
  createBuildScopedStore,
  createSessionScopedStore,
  EVENT_WAIT_POLL_MS,
  normalizeOperator,
  pollingSubscribe,
  systemClock,
  toBytes,
  validateEventWrite,
  validateExpectedSeq,
  validateRepositoryEventWrite,
  validateSessionEventWrite,
  type AbEvent,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildDigest,
  type BuildScopedStore,
  type BuildStore,
  type Clock,
  type EventEnvelope,
  type EventType,
  type EventWrite,
  type NewBuildInput,
  type NewSessionInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryEvent,
  type RepositoryEventEnvelope,
  type RepositoryEventType,
  type RepositoryEventWrite,
  type RepositoryRecord,
  type SessionArtifact,
  type SessionArtifactMeta,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionEventType,
  type SessionEventWrite,
  type SessionRecord,
  type SessionScopedStore,
  type SubscribeOptions,
  type Unsubscribe,
} from '@defrex/autobuild/store-adapter'
import type {
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
} from '@defrex/autobuild/store-adapter'
import {
  assembleUIMessageDocument,
  readEventsWithWait,
  readStreamWithWait,
  serializedBatchSize,
  STREAM_BATCH_MAX_BYTES,
  STREAM_FORMAT,
  StreamBatchTooLargeError,
  StreamClosedError,
  streamArtifactInput,
  validateStreamParts,
} from '@defrex/autobuild/store-adapter'
import {
  DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS,
  isRetentionManagedKind,
  revisionsToPrune,
} from '@defrex/autobuild/store-adapter'
import {
  DIGEST_EVENT_TYPES,
  REPOSITORY_STATE_EVENT_TYPES,
  reduceBuildDigest,
} from '@defrex/autobuild/store-adapter'
import { assertSchema } from './schema'
import { attemptExec, isPlanChangeError, PlanInvalidations, type Exec, type Row } from './retry'

// The held-read poll cadence for event waits — a re-export of the canonical
// core constant (AUT-388), not a second definition. See core
// `store/streams/wait.ts` for the budget's semantics and the AUT-334
// rationale for why the bound is nominal rather than hard.
export { EVENT_WAIT_POLL_MS }

// ── Cached-plan invalidation retry (AUT-396) ─────────────────────────
// After a migration adds a column, pooled connections hold cached plans for
// statements returning `*` from that table, and the next execution on each
// stale plan fails with SQLSTATE 0A000 ("cached plan must not change result
// type") — and keeps failing, because Bun reuses named prepared statements
// keyed by query text and never rebuilds a rejected plan. Every store read
// and write path therefore executes through the `run`/`tx` runners below,
// which pin one pooled connection and retry the whole operation exactly once
// on a plan-change error. The retry re-prepares every statement the body
// executes under freshly minted marked variants — a migration can have
// poisoned any `*`-returning plan the body touches, not only the statement
// that failed first — and the variants are memoized per statement text:
// after the first failure, later executions skip the poisoned plans
// entirely, so a migration costs one failed execution per connection per
// statement and a bounded number of extra prepared statements — not one per
// operation. Every
// `SELECT *` (and `RETURNING *` — none exist today) on the
// migration-extendable tables — `streams`, `sessions`, `builds`, and every
// other store table — is kept under that same-connection retry rather than
// replaced by explicit column lists, which would cover only the tables named
// today and drift with the schema. See `./retry` for the Bun/PostgreSQL
// mechanics.

interface PreparedArtifact {
  kind: string
  blobRef: string
  metadata: Record<string, unknown>
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
const num = (value: unknown): number => Number(value)
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T

export interface PostgresBuildStoreOptions {
  sql: SQL
  blobs: BlobStore
  clock?: Clock
  /** Artifact retention (store/retention.ts): how many newest revisions of
   * each retention-managed dispatcher kind survive. Default 200. */
  retention?: { maxRevisions?: number }
}

export class PostgresBuildStore implements BuildStore {
  readonly blobs: BlobStore
  private readonly clock: Clock
  private readonly maxRevisions: number

  constructor(
    private readonly sql: SQL,
    options: Omit<PostgresBuildStoreOptions, 'sql'>,
  ) {
    this.blobs = options.blobs
    this.clock = options.clock ?? systemClock
    this.maxRevisions = options.retention?.maxRevisions ?? DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS
  }

  /** Memoized poisoned-statement markers, unique to this store instance (see
   * `./retry` for why the memo and the per-instance namespace exist). */
  private readonly plans = new PlanInvalidations()

  /** Run a non-transactional operation on one pinned pooled connection,
   * retrying it exactly once — same connection, statements freshly prepared —
   * when a cached plan fails to revalidate (AUT-396). A run body must not
   * call a public store method: reserving inside a reservation yields a
   * brand-new connection instead of the pinned one. */
  private async run<T>(body: (q: Exec) => Promise<T>): Promise<T> {
    const conn = await this.sql.reserve()
    try {
      const attempt = attemptExec(conn, this.plans)
      try {
        return await body(attempt.exec)
      } catch (error) {
        if (!isPlanChangeError(error) || attempt.inFlight === null) throw error
        // The failing statement's plan was invalidated once more: memoize a
        // fresh marked variant for its text. The retry then re-prepares
        // *every* statement the body executes — a migration can have
        // poisoned any `*`-returning plan the body touches, not only the
        // one that failed first, and a memoized marker minted before the
        // migration is itself stale — so a body reading two
        // migration-extended tables recovers in the single retry.
        const failing = attempt.inFlight
        this.plans.invalidate(failing)
        return await body(attemptExec(conn, this.plans, true).exec)
      }
    } finally {
      conn.release()
    }
  }

  /** Run a transactional operation on one pinned pooled connection, retrying
   * the whole body exactly once on a plan-change error: the failed attempt
   * rolls back, and the body re-runs in a fresh transaction on the same
   * connection with freshly prepared statements (AUT-396). */
  private async tx<T>(body: (q: Exec) => Promise<T>): Promise<T> {
    const conn = await this.sql.reserve()
    try {
      // Attribution lives outside `begin`: the transaction executor only
      // exists inside the callback, so each attempt builds its own exec and
      // reports the failing statement's text back here on rejection.
      let failing: string | null = null
      try {
        return await conn.begin((t) => {
          const attempt = attemptExec(t, this.plans)
          return body(attempt.exec).catch((error) => {
            failing = attempt.inFlight
            throw error
          })
        })
      } catch (error) {
        if (!isPlanChangeError(error) || failing === null) throw error
        this.plans.invalidate(failing)
        return await conn.begin((t) => body(attemptExec(t, this.plans, true).exec))
      }
    } finally {
      conn.release()
    }
  }

  scopeBuild(slug: string): BuildScopedStore {
    return createBuildScopedStore(this, slug)
  }

  scopeSession(id: string): SessionScopedStore {
    return createSessionScopedStore(this, id)
  }

  private now(): string {
    return this.clock().toISOString()
  }

  private record(row: Row): BuildRecord {
    return {
      slug: String(row.slug),
      repo: String(row.repo),
      ...(row.ticket ? { ticket: json(row.ticket) } : {}),
      ...(row.branch ? { branch: String(row.branch) } : {}),
      ...(row.repo_origin ? { repoOrigin: String(row.repo_origin) } : {}),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
      ...(row.lease_holder && row.lease_expires_at
        ? { lease: { holder: String(row.lease_holder), expiresAt: iso(row.lease_expires_at) } }
        : {}),
    }
  }

  private repoRecord(row: Row): RepositoryRecord {
    return {
      repo: String(row.repo),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}),
      ...(row.lease_holder && row.lease_expires_at
        ? { lease: { holder: String(row.lease_holder), expiresAt: iso(row.lease_expires_at) } }
        : {}),
    }
  }

  private async lockBuild(q: Exec, slug: string): Promise<Row> {
    const rows: Row[] = await q`SELECT * FROM builds WHERE slug = ${slug} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown build "${slug}"`)
    return row
  }

  private async lockRepo(q: Exec, repo: string): Promise<Row> {
    const rows: Row[] = await q`SELECT * FROM repo_streams WHERE repo = ${repo} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown repo "${repo}"`)
    return row
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    const ts = this.now()
    return this.tx(async (q) => {
      const inserted: Row[] = await q`INSERT INTO builds
        (slug, repo, ticket, branch, repo_origin, created_at, updated_at)
        VALUES (${input.slug}, ${input.repo}, ${input.ticket ?? null}, ${input.branch ?? null}, ${input.repoOrigin ?? null}, ${ts}, ${ts})
        ON CONFLICT (slug) DO NOTHING RETURNING slug`
      const row = await this.lockBuild(q, input.slug)
      if (!inserted[0]) throw new Error(`build "${input.slug}" already exists`)
      return this.record(row)
    })
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM builds WHERE slug = ${slug}`
      return rows[0] ? this.record(rows[0]) : null
    })
  }

  async listBuilds(): Promise<BuildRecord[]> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM builds ORDER BY created_at, slug`
      return rows.map((row) => this.record(row))
    })
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    // From the builds side (AUT-487), matching the SQLite adapter: the type
    // filter lives in the ON clause so a build whose log holds none of the
    // digest-relevant event types still yields its row, and only those
    // types are fetched. The `events_type_build_seq` index (schema.ts) makes
    // the join's per-build probes type-leading, so the cost grows with the
    // actual signal, not with total history.
    const rows: Row[] = await this.run((q) =>
      q.unsafe(
        `SELECT b.slug AS slug, e.seq AS seq, e.ts AS ts, e.type AS type
       FROM builds b
       LEFT JOIN events e
         ON e.build = b.slug AND e.type IN (${DIGEST_EVENT_TYPES.map((_, i) => `$${i + 2}`).join(', ')})
       WHERE b.repo = $1
       ORDER BY b.slug, e.seq`,
        [repo, ...DIGEST_EVENT_TYPES],
      ),
    )
    const eventsByBuild = new Map<string, Pick<AbEvent, 'type' | 'seq' | 'ts'>[]>()
    for (const row of rows) {
      if (row.seq === null || row.seq === undefined) continue
      const events = eventsByBuild.get(String(row.slug)) ?? []
      events.push({
        type: String(row.type) as AbEvent['type'],
        seq: num(row.seq),
        ts: iso(row.ts),
      })
      eventsByBuild.set(String(row.slug), events)
    }
    const digests = new Map<string, BuildDigest>()
    for (const row of rows) {
      const slug = String(row.slug)
      if (digests.has(slug)) continue
      digests.set(slug, { slug, ...reduceBuildDigest(eventsByBuild.get(slug) ?? []) })
    }
    return digests
  }

  private async appendLocked(
    q: Exec,
    slug: string,
    event: EventWrite,
    alreadyLocked = false,
  ): Promise<EventEnvelope> {
    if (!alreadyLocked) await this.lockBuild(q, slug)
    const tails: Row[] =
      await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE build = ${slug}`
    const seq = num(tails[0]?.seq) + 1
    const ts = this.now()
    await q`INSERT INTO events (build, seq, ts, actor, type, payload)
      VALUES (${slug}, ${seq}, ${ts}, ${event.actor}, ${event.type}, ${event.payload})`
    await q`UPDATE builds SET updated_at = ${ts} WHERE slug = ${slug}`
    return { build: slug, seq, ts, actor: event.actor, type: event.type, payload: event.payload }
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const validated = validateEventWrite(event)
    return (await this.tx((q) => this.appendLocked(q, slug, validated))) as EventEnvelope<T>
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateEventWrite(event)
    return this.tx(async (q) => {
      await this.lockBuild(q, slug)
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE build = ${slug}`
      if (num(tails[0]?.seq) !== expectedSeq) return null
      return (await this.appendLocked(q, slug, validated, true)) as EventEnvelope<T>
    })
  }

  private async prepare(artifact: ArtifactInput): Promise<PreparedArtifact> {
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    return { kind: artifact.kind, blobRef, metadata: structuredClone(artifact.metadata ?? {}) }
  }

  private async depositBuildLocked(
    q: Exec,
    slug: string,
    artifact: PreparedArtifact,
    lockedKinds: Map<string, number>,
    opts: { prune?: boolean } = { prune: true },
  ): Promise<ArtifactMeta> {
    let revision = lockedKinds.get(artifact.kind)
    if (revision === undefined) {
      const tails: Row[] = await q`SELECT COALESCE(MAX(revision), -1) AS revision
        FROM artifacts WHERE build = ${slug} AND kind = ${artifact.kind}`
      revision = num(tails[0]?.revision) + 1
    }
    lockedKinds.set(artifact.kind, revision + 1)
    const createdAt = this.now()
    await q`INSERT INTO artifacts (build, kind, revision, blob_ref, metadata, created_at)
      VALUES (${slug}, ${artifact.kind}, ${revision}, ${artifact.blobRef}, ${artifact.metadata}, ${createdAt})`
    if (opts.prune) await this.pruneBuildLocked(q, slug, artifact.kind)
    await q`UPDATE builds SET updated_at = ${createdAt} WHERE slug = ${slug}`
    return {
      build: slug,
      kind: artifact.kind,
      revision,
      blobRef: artifact.blobRef,
      metadata: artifact.metadata,
      createdAt,
    }
  }

  /** Deposit-time retention (store/retention.ts), inside the same locked
   * transaction as the deposit: drop revisions past the bound for
   * retention-managed kinds. The pruned values are store-assigned nonnegative
   * integers (re-checked by `revisionsToPrune`), so the IN list expands
   * safely. Non-family kinds are never touched. */
  private async pruneBuildLocked(q: Exec, slug: string, kind: string): Promise<void> {
    if (!isRetentionManagedKind(kind)) return
    const rows: Row[] =
      await q`SELECT revision FROM artifacts WHERE build = ${slug} AND kind = ${kind}`
    const pruned = revisionsToPrune(
      rows.map((row) => num(row.revision)),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    await q.unsafe(
      `DELETE FROM artifacts WHERE build = $1 AND kind = $2 AND revision IN (${pruned.join(', ')})`,
      [slug, kind],
    )
  }

  private async pruneRepoLocked(q: Exec, repo: string, kind: string): Promise<void> {
    if (!isRetentionManagedKind(kind)) return
    const rows: Row[] =
      await q`SELECT revision FROM repo_artifacts WHERE repo = ${repo} AND kind = ${kind}`
    const pruned = revisionsToPrune(
      rows.map((row) => num(row.revision)),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    await q.unsafe(
      `DELETE FROM repo_artifacts WHERE repo = $1 AND kind = $2 AND revision IN (${pruned.join(', ')})`,
      [repo, kind],
    )
  }

  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const artifact of artifacts) prepared.push(await this.prepare(artifact))
    return this.tx(async (q) => {
      await this.lockBuild(q, slug)
      // Ordering invariant (AUT-322): the batch event is validated BEFORE
      // any retention prune runs. Deposits land unpruned, validation gates
      // the whole batch, and only then does one prune per distinct batch
      // kind execute — still inside this locked transaction. A same-kind
      // batch whose prune scope covers a sibling therefore never deletes
      // that sibling before the batch's event is validated. Pruning once
      // per kind (not per deposit) is equivalent: `revisionsToPrune` is a
      // pure function of the full post-batch revision set.
      const revisions = new Map<string, number>()
      const deposited: ArtifactMeta[] = []
      for (const artifact of prepared) {
        deposited.push(
          await this.depositBuildLocked(q, slug, artifact, revisions, { prune: false }),
        )
      }
      const validated = validateEventWrite(makeEvent(structuredClone(deposited)))
      for (const kind of new Set(deposited.map((meta) => meta.kind))) {
        await this.pruneBuildLocked(q, slug, kind)
      }
      const event = (await this.appendLocked(q, slug, validated, true)) as EventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getEvents(
    slug: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]> {
    const read = async (): Promise<AbEvent[]> => {
      if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
      const rows: Row[] = await this.run(
        (q) =>
          q`SELECT * FROM events WHERE build = ${slug}
        AND seq > ${sinceSeq} ORDER BY seq`,
      )
      return rows.map((row) => ({
        build: String(row.build),
        seq: num(row.seq),
        ts: iso(row.ts),
        actor: json(row.actor),
        type: String(row.type),
        payload: json(row.payload),
      })) as AbEvent[]
    }
    return readEventsWithWait({
      read,
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      // Hosted budget: no held event request polls the database faster than
      // once per second (AUT-334), so append-to-wake is typically under one
      // second — worst case one poll interval plus the query round-trip.
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    const prepared = await this.prepare(artifact)
    return this.tx(async (q) => {
      await this.lockBuild(q, slug)
      return this.depositBuildLocked(q, slug, prepared, new Map())
    })
  }

  private artifactMeta(row: Row): ArtifactMeta {
    return {
      build: String(row.build),
      kind: String(row.kind),
      revision: num(row.revision),
      blobRef: String(row.blob_ref),
      metadata: json(row.metadata),
      createdAt: iso(row.created_at),
    }
  }

  async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    const rows: Row[] = await this.run((q) =>
      rev === undefined
        ? q`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} ORDER BY revision DESC LIMIT 1`
        : q`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} AND revision = ${rev}`,
    )
    const row = rows[0]
    if (!row) return null
    const content = await this.blobs.get(String(row.blob_ref))
    return content ? { meta: this.artifactMeta(row), content } : null
  }

  async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    const rows: Row[] = await this.run((q) =>
      kind === undefined
        ? q`SELECT * FROM artifacts WHERE build = ${slug} ORDER BY kind, revision`
        : q`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} ORDER BY kind, revision`,
    )
    return rows.map((row) => this.artifactMeta(row))
  }

  private async claim(
    table: 'builds' | 'repo_streams',
    key: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.tx(async (q) => {
      const row = table === 'builds' ? await this.lockBuild(q, key) : await this.lockRepo(q, key)
      const now = this.clock().getTime()
      const held =
        row.lease_holder &&
        row.lease_holder !== holder &&
        row.lease_expires_at &&
        Date.parse(iso(row.lease_expires_at)) > now
      if (held) return false
      const expires = new Date(now + ttlMs).toISOString()
      const nowIso = new Date(now).toISOString()
      if (table === 'builds')
        await q`UPDATE builds SET lease_holder=${holder}, lease_expires_at=${expires}, lease_ttl_ms=${ttlMs}, updated_at=${nowIso} WHERE slug=${key}`
      else
        await q`UPDATE repo_streams SET lease_holder=${holder}, lease_expires_at=${expires}, lease_ttl_ms=${ttlMs}, updated_at=${nowIso} WHERE repo=${key}`
      return true
    })
  }

  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.claim('builds', slug, holder, ttlMs)
  }
  async claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.claim('repo_streams', repo, holder, ttlMs)
  }

  private async beat(
    table: 'builds' | 'repo_streams',
    key: string,
    holder: string,
  ): Promise<boolean> {
    return this.tx(async (q) => {
      const row = table === 'builds' ? await this.lockBuild(q, key) : await this.lockRepo(q, key)
      const now = this.clock().getTime()
      if (
        row.lease_holder !== holder ||
        !row.lease_expires_at ||
        Date.parse(iso(row.lease_expires_at)) <= now
      )
        return false
      const expires = new Date(now + num(row.lease_ttl_ms)).toISOString()
      const nowIso = new Date(now).toISOString()
      if (table === 'builds')
        await q`UPDATE builds SET lease_expires_at=${expires}, heartbeat_at=${nowIso}, updated_at=${nowIso} WHERE slug=${key}`
      else
        await q`UPDATE repo_streams SET lease_expires_at=${expires}, heartbeat_at=${nowIso}, updated_at=${nowIso} WHERE repo=${key}`
      return true
    })
  }

  async heartbeat(slug: string, holder: string): Promise<boolean> {
    return this.beat('builds', slug, holder)
  }
  async heartbeatRepo(repo: string, holder: string): Promise<boolean> {
    return this.beat('repo_streams', repo, holder)
  }

  private async release(
    table: 'builds' | 'repo_streams',
    key: string,
    holder: string,
  ): Promise<void> {
    await this.tx(async (q) => {
      const row = table === 'builds' ? await this.lockBuild(q, key) : await this.lockRepo(q, key)
      if (row.lease_holder !== holder) return
      const now = this.now()
      if (table === 'builds')
        await q`UPDATE builds SET lease_holder=NULL, lease_expires_at=NULL, lease_ttl_ms=NULL, updated_at=${now} WHERE slug=${key}`
      else
        await q`UPDATE repo_streams SET lease_holder=NULL, lease_expires_at=NULL, lease_ttl_ms=NULL, updated_at=${now} WHERE repo=${key}`
    })
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    return this.release('builds', slug, holder)
  }
  async releaseRepoLease(repo: string, holder: string): Promise<void> {
    return this.release('repo_streams', repo, holder)
  }

  // ── Operator sessions (SPEC §7.1.1 — a third resource kind) ─────────

  private async lockSession(q: Exec, id: string): Promise<Row> {
    const rows: Row[] = await q`SELECT * FROM sessions WHERE id = ${id} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown session "${id}"`)
    return row
  }

  private sessionRecord(row: Row): SessionRecord {
    return {
      id: String(row.id),
      repo: String(row.repo),
      operator: String(row.operator),
      ...(row.title !== null && row.title !== undefined ? { title: String(row.title) } : {}),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }

  async createSession(input: NewSessionInput): Promise<SessionRecord> {
    const operator = normalizeOperator(input.operator)
    if (!input.repo) throw new Error('repo is required')
    const ts = this.now()
    const id = `os_${crypto.randomUUID()}`
    // The record and its first fact land together: `session.created` (seq 1,
    // actor the operator) commits in the same transaction as the insert (D6).
    const validated = validateSessionEventWrite({
      actor: humanActor(operator),
      type: 'session.created',
      payload: input.title !== undefined ? { title: input.title } : {},
    })
    return this.tx(async (q) => {
      // Store-assigned monotonic creation sequence (the listSessions
      // same-timestamp tiebreak): the sequence is concurrency-safe and never
      // repeats, so ties order by assignment. Sessions are never deleted, so
      // the counter is never reused.
      await q`INSERT INTO sessions (id, repo, operator, title, creation_seq, created_at, updated_at)
        VALUES (${id}, ${input.repo}, ${operator}, ${input.title ?? null}, nextval('sessions_creation_seq'), ${ts}, ${ts})`
      await q`INSERT INTO session_events (session, seq, ts, actor, type, payload)
        VALUES (${id}, 1, ${ts}, ${validated.actor}, ${validated.type}, ${validated.payload})`
      return this.sessionRecord(await this.lockSession(q, id))
    })
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM sessions WHERE id = ${id}`
      return rows[0] ? this.sessionRecord(rows[0]) : null
    })
  }

  async listSessions(repo: string): Promise<SessionRecord[]> {
    // Pinned tiebreak (store/types.ts): createdAt ascending, then the
    // store-assigned monotonic creation sequence — never the random id.
    return this.run(async (q) => {
      const rows: Row[] =
        await q`SELECT * FROM sessions WHERE repo = ${repo} ORDER BY created_at, creation_seq`
      return rows.map((row) => this.sessionRecord(row))
    })
  }

  private async appendSessionLocked(
    q: Exec,
    id: string,
    event: SessionEventWrite,
    alreadyLocked = false,
  ): Promise<SessionEventEnvelope> {
    if (!alreadyLocked) await this.lockSession(q, id)
    const tails: Row[] =
      await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session = ${id}`
    const seq = num(tails[0]?.seq) + 1
    const ts = this.now()
    await q`INSERT INTO session_events (session, seq, ts, actor, type, payload)
      VALUES (${id}, ${seq}, ${ts}, ${event.actor}, ${event.type}, ${event.payload})`
    await q`UPDATE sessions SET updated_at = ${ts} WHERE id = ${id}`
    return { session: id, seq, ts, actor: event.actor, type: event.type, payload: event.payload }
  }

  async appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>> {
    const validated = validateSessionEventWrite(event)
    return (await this.tx((q) =>
      this.appendSessionLocked(q, id, validated),
    )) as SessionEventEnvelope<T>
  }

  async getSessionEvents(
    id: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]> {
    const read = async (): Promise<SessionEvent[]> => {
      if (!(await this.getSession(id))) throw new Error(`unknown session "${id}"`)
      const rows: Row[] = await this.run(
        (q) =>
          q`SELECT * FROM session_events WHERE session = ${id} AND seq > ${sinceSeq} ORDER BY seq`,
      )
      return rows.map((row) => ({
        session: String(row.session),
        seq: num(row.seq),
        ts: iso(row.ts),
        actor: json(row.actor),
        type: String(row.type),
        payload: json(row.payload),
      })) as SessionEvent[]
    }
    return readEventsWithWait({
      read,
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      // Hosted budget: no held event request polls the database faster than
      // once per second (AUT-334, AUT-381), so append-to-wake is typically
      // under one second — worst case one poll interval plus the query
      // round-trip.
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  private async depositSessionLocked(
    q: Exec,
    id: string,
    artifact: PreparedArtifact,
    revisions: Map<string, number>,
  ): Promise<SessionArtifactMeta> {
    let revision = revisions.get(artifact.kind)
    if (revision === undefined) {
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(revision), -1) AS revision FROM session_artifacts WHERE session=${id} AND kind=${artifact.kind}`
      revision = num(tails[0]?.revision) + 1
    }
    revisions.set(artifact.kind, revision + 1)
    const createdAt = this.now()
    await q`INSERT INTO session_artifacts (session, kind, revision, blob_ref, metadata, created_at)
      VALUES (${id}, ${artifact.kind}, ${revision}, ${artifact.blobRef}, ${artifact.metadata}, ${createdAt})`
    await q`UPDATE sessions SET updated_at = ${createdAt} WHERE id = ${id}`
    return {
      session: id,
      kind: artifact.kind,
      revision,
      blobRef: artifact.blobRef,
      metadata: artifact.metadata,
      createdAt,
    }
  }

  async appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const artifact of artifacts) prepared.push(await this.prepare(artifact))
    // Same shape as `appendWithArtifacts`: deposits land unpruned inside one
    // locked transaction, the batch event is validated before any commit of
    // the caller-visible state, and an invalid event throws, rolling back
    // every deposit (D6). Session artifacts are not retention-managed.
    return this.tx(async (q) => {
      await this.lockSession(q, id)
      const revisions = new Map<string, number>()
      const deposited: SessionArtifactMeta[] = []
      for (const artifact of prepared) {
        deposited.push(await this.depositSessionLocked(q, id, artifact, revisions))
      }
      const validated = validateSessionEventWrite(makeEvent(structuredClone(deposited)))
      const event = (await this.appendSessionLocked(
        q,
        id,
        validated,
        true,
      )) as SessionEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
    const prepared = await this.prepare(artifact)
    return this.tx(async (q) => {
      await this.lockSession(q, id)
      return this.depositSessionLocked(q, id, prepared, new Map())
    })
  }

  private sessionArtifactMeta(row: Row): SessionArtifactMeta {
    return {
      session: String(row.session),
      kind: String(row.kind),
      revision: num(row.revision),
      blobRef: String(row.blob_ref),
      metadata: json(row.metadata),
      createdAt: iso(row.created_at),
    }
  }

  async getSessionArtifact(
    id: string,
    kind: string,
    rev?: number,
  ): Promise<SessionArtifact | null> {
    if (!(await this.getSession(id))) throw new Error(`unknown session "${id}"`)
    const rows: Row[] = await this.run((q) =>
      rev === undefined
        ? q`SELECT * FROM session_artifacts WHERE session = ${id} AND kind = ${kind} ORDER BY revision DESC LIMIT 1`
        : q`SELECT * FROM session_artifacts WHERE session = ${id} AND kind = ${kind} AND revision = ${rev}`,
    )
    const row = rows[0]
    if (!row) return null
    const content = await this.blobs.get(String(row.blob_ref))
    return content ? { meta: this.sessionArtifactMeta(row), content } : null
  }

  async listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
    if (!(await this.getSession(id))) throw new Error(`unknown session "${id}"`)
    const rows: Row[] = await this.run((q) =>
      kind === undefined
        ? q`SELECT * FROM session_artifacts WHERE session = ${id} ORDER BY kind, revision`
        : q`SELECT * FROM session_artifacts WHERE session = ${id} AND kind = ${kind} ORDER BY kind, revision`,
    )
    return rows.map((row) => this.sessionArtifactMeta(row))
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    if (!repo) throw new Error('repo is required')
    const ts = this.now()
    return this.tx(async (q) => {
      await q`INSERT INTO repo_streams (repo, created_at, updated_at)
        VALUES (${repo}, ${ts}, ${ts}) ON CONFLICT (repo) DO NOTHING`
      return this.repoRecord(await this.lockRepo(q, repo))
    })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM repo_streams WHERE repo=${repo}`
      return rows[0] ? this.repoRecord(rows[0]) : null
    })
  }

  private async appendRepoLocked(
    q: Exec,
    repo: string,
    event: RepositoryEventWrite,
    alreadyLocked = false,
  ): Promise<RepositoryEventEnvelope> {
    if (!alreadyLocked) await this.lockRepo(q, repo)
    const tails: Row[] =
      await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM repo_events WHERE repo=${repo}`
    const seq = num(tails[0]?.seq) + 1
    const ts = this.now()
    await q`INSERT INTO repo_events (repo, seq, ts, actor, type, payload) VALUES (${repo},${seq},${ts},${event.actor},${event.type},${event.payload})`
    await q`UPDATE repo_streams SET updated_at=${ts} WHERE repo=${repo}`
    return { repo, seq, ts, actor: event.actor, type: event.type, payload: event.payload }
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const validated = validateRepositoryEventWrite(event)
    return (await this.tx((q) =>
      this.appendRepoLocked(q, repo, validated),
    )) as RepositoryEventEnvelope<T>
  }

  private async depositRepoLocked(
    q: Exec,
    repo: string,
    artifact: PreparedArtifact,
    revisions: Map<string, number>,
    opts: { prune?: boolean } = { prune: true },
  ): Promise<RepositoryArtifactMeta> {
    let revision = revisions.get(artifact.kind)
    if (revision === undefined) {
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(revision), -1) AS revision FROM repo_artifacts WHERE repo=${repo} AND kind=${artifact.kind}`
      revision = num(tails[0]?.revision) + 1
    }
    revisions.set(artifact.kind, revision + 1)
    const createdAt = this.now()
    await q`INSERT INTO repo_artifacts (repo,kind,revision,blob_ref,metadata,created_at) VALUES (${repo},${artifact.kind},${revision},${artifact.blobRef},${artifact.metadata},${createdAt})`
    if (opts.prune) await this.pruneRepoLocked(q, repo, artifact.kind)
    await q`UPDATE repo_streams SET updated_at=${createdAt} WHERE repo=${repo}`
    return {
      repo,
      kind: artifact.kind,
      revision,
      blobRef: artifact.blobRef,
      metadata: artifact.metadata,
      createdAt,
    }
  }

  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{ event: RepositoryEventEnvelope<T>; artifacts: RepositoryArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const artifact of artifacts) prepared.push(await this.prepare(artifact))
    return this.tx(async (q) => {
      await this.lockRepo(q, repo)
      // Ordering invariant (AUT-322): same shape as `appendWithArtifacts` —
      // deposit unpruned, validate the batch event, then prune once per
      // distinct batch kind, all inside this locked transaction. Validation
      // provably precedes any retention deletion.
      const revisions = new Map<string, number>()
      const deposited: RepositoryArtifactMeta[] = []
      for (const artifact of prepared)
        deposited.push(await this.depositRepoLocked(q, repo, artifact, revisions, { prune: false }))
      const validated = validateRepositoryEventWrite(makeEvent(structuredClone(deposited)))
      for (const kind of new Set(deposited.map((meta) => meta.kind))) {
        await this.pruneRepoLocked(q, repo, kind)
      }
      const event = (await this.appendRepoLocked(
        q,
        repo,
        validated,
        true,
      )) as RepositoryEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getRepoEvents(
    repo: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]> {
    const read = async (): Promise<RepositoryEvent[]> => {
      if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
      const rows: Row[] = await this.run(
        (q) => q`SELECT * FROM repo_events WHERE repo=${repo} AND seq>${sinceSeq} ORDER BY seq`,
      )
      return rows.map((row) => ({
        repo: String(row.repo),
        seq: num(row.seq),
        ts: iso(row.ts),
        actor: json(row.actor),
        type: String(row.type),
        payload: json(row.payload),
      })) as RepositoryEvent[]
    }
    return readEventsWithWait({
      read,
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  async getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    // Two queries, mirroring the oracle's derivation: the latest run-started
    // anchor (indexed by repo_events_type_repo_seq, v8 — without it MAX(seq)
    // over the repo's run-started facts degrades to a scan of the repo's
    // whole PK range, exactly the cost being removed), then one select of
    // durable types plus the tail from that anchor.
    //
    const { rows } = await this.run(async (q) => {
      // The probe below is an aggregate: MAX() always returns exactly one row —
      // NULL when the journal has no run-started fact — so the empty-journal
      // signal is that NULL, tested explicitly here via `no_anchor`, never row
      // absence. The NULL/undefined anchor must never be bound into `seq >= $2`
      // (in either dialect the comparison is never true, so the durable-only
      // outcome would then survive only by accident), and the no-anchor case
      // must not degenerate into `seq >= 0`, which would select the whole
      // journal. The `anchor === undefined` branch below is the durable-only
      // path.
      const probe = (
        await q`SELECT MAX(seq) AS seq, MAX(seq) IS NULL AS no_anchor FROM repo_events WHERE repo=${repo} AND type='dispatcher.run-started'`
      )[0]
      const anchor = probe?.no_anchor ? undefined : num(probe?.seq)
      const durableList = [...REPOSITORY_STATE_EVENT_TYPES]
      // `repo` is $1; the anchored select also spends $2 on the anchor, so the
      // type list's placeholders start at the right offset per branch.
      const placeholders = (start: number) =>
        durableList.map((_, index) => `$${index + start}`).join(', ')
      const rows: Row[] =
        anchor === undefined
          ? await q.unsafe(
              `SELECT * FROM repo_events WHERE repo = $1 AND type IN (${placeholders(2)}) ORDER BY seq`,
              [repo, ...durableList],
            )
          : await q.unsafe(
              `SELECT * FROM repo_events WHERE repo = $1 AND (seq >= $2 OR type IN (${placeholders(3)})) ORDER BY seq`,
              [repo, anchor, ...durableList],
            )
      return { probe, rows }
    })
    return rows.map((row) => ({
      repo: String(row.repo),
      seq: num(row.seq),
      ts: iso(row.ts),
      actor: json(row.actor),
      type: String(row.type),
      payload: json(row.payload),
    })) as RepositoryEvent[]
  }

  async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    const prepared = await this.prepare(artifact)
    return this.tx(async (q) => {
      await this.lockRepo(q, repo)
      return this.depositRepoLocked(q, repo, prepared, new Map())
    })
  }

  private repoArtifactMeta(row: Row): RepositoryArtifactMeta {
    return {
      repo: String(row.repo),
      kind: String(row.kind),
      revision: num(row.revision),
      blobRef: String(row.blob_ref),
      metadata: json(row.metadata),
      createdAt: iso(row.created_at),
    }
  }

  async getRepoArtifact(
    repo: string,
    kind: string,
    rev?: number,
  ): Promise<RepositoryArtifact | null> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const rows: Row[] = await this.run((q) =>
      rev === undefined
        ? q`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} ORDER BY revision DESC LIMIT 1`
        : q`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} AND revision=${rev}`,
    )
    const row = rows[0]
    if (!row) return null
    const content = await this.blobs.get(String(row.blob_ref))
    return content ? { meta: this.repoArtifactMeta(row), content } : null
  }

  async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const rows: Row[] = await this.run((q) =>
      kind === undefined
        ? q`SELECT * FROM repo_artifacts WHERE repo=${repo} ORDER BY kind,revision`
        : q`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} ORDER BY kind,revision`,
    )
    return rows.map((row) => this.repoArtifactMeta(row))
  }

  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  // ── Streams (SPEC §7.6 — the third primitive) ───────────────────────────

  private async lockStream(q: Exec, streamId: string): Promise<Row> {
    const rows: Row[] = await q`SELECT * FROM streams WHERE id = ${streamId} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown stream "${streamId}"`)
    return row
  }

  private streamScopeOf(row: Row): StreamScope {
    if (row.scope_kind === 'build' && row.build !== null) {
      return { kind: 'build', build: String(row.build) }
    }
    if (row.scope_kind === 'repo' && row.repo !== null) {
      return { kind: 'repo', repo: String(row.repo) }
    }
    if (row.scope_kind === 'session' && row.session !== null) {
      return { kind: 'session', session: String(row.session) }
    }
    throw new Error(`stream "${String(row.id)}" has an unreadable scope`)
  }

  private streamRecord(row: Row): StreamRecord {
    const record: StreamRecord = {
      id: String(row.id),
      scope: this.streamScopeOf(row),
      label: String(row.label),
      format: String(row.format) as StreamRecord['format'],
      status: String(row.status) as StreamRecord['status'],
      createdAt: iso(row.created_at),
      ...(row.closed_at ? { closedAt: iso(row.closed_at) } : {}),
      ...(row.outcome ? { outcome: String(row.outcome) as StreamRecord['outcome'] } : {}),
      ...(row.artifact_kind && row.artifact_revision !== null && row.artifact_blob_ref
        ? {
            artifact: {
              kind: String(row.artifact_kind),
              revision: num(row.artifact_revision),
              blobRef: String(row.artifact_blob_ref),
            },
          }
        : {}),
    }
    return record
  }

  /** Deposit-path, count-based chunk retention (SPEC §7.6), inside the
   * create's locked transaction: keep every closed stream's chunks except
   * the most recently closed one in this scope (closedAt, then id).
   * Records, finalized artifacts, and open streams are never touched. */
  private async pruneStreamChunksLocked(q: Exec, scope: StreamScope): Promise<void> {
    const owner =
      scope.kind === 'build' ? scope.build : scope.kind === 'repo' ? scope.repo : scope.session
    const rows: Row[] = await q`
      SELECT id FROM streams
      WHERE status = 'closed' AND scope_kind = ${scope.kind}
        AND (
          (scope_kind = 'build' AND build = ${scope.kind === 'build' ? owner : null})
          OR (scope_kind = 'repo' AND repo = ${scope.kind === 'repo' ? owner : null})
          OR (scope_kind = 'session' AND session = ${scope.kind === 'session' ? owner : null})
        )
      ORDER BY closed_at DESC, id DESC OFFSET 1`
    for (const row of rows) {
      await q`DELETE FROM stream_chunks WHERE stream = ${String(row.id)}`
    }
  }

  async createStream(scope: StreamScope, label: string): Promise<StreamRecord> {
    if (!label) throw new Error('stream label is required')
    const id = `st_${crypto.randomUUID()}`
    const ts = this.now()
    return this.tx(async (q) => {
      if (scope.kind === 'build') await this.lockBuild(q, scope.build)
      else if (scope.kind === 'repo') await this.lockRepo(q, scope.repo)
      else await this.lockSession(q, scope.session)
      await this.pruneStreamChunksLocked(q, scope)
      // Store-assigned monotonic creation sequence (the listStreams
      // same-timestamp tiebreak): the sequence is concurrency-safe and never
      // repeats, so ties order by assignment. Streams are never deleted
      // (retention prunes stream_chunks only), so the counter is never reused.
      await q`INSERT INTO streams
        (id, scope_kind, build, repo, session, label, format, status, creation_seq, created_at)
        VALUES (${id}, ${scope.kind}, ${scope.kind === 'build' ? scope.build : null},
          ${scope.kind === 'repo' ? scope.repo : null},
          ${scope.kind === 'session' ? scope.session : null},
          ${label}, ${STREAM_FORMAT}, 'open', nextval('streams_creation_seq'), ${ts})`
      return this.streamRecord(await this.lockStream(q, id))
    })
  }

  async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
    validateStreamParts(parts)
    const bytes = serializedBatchSize(parts)
    if (bytes > STREAM_BATCH_MAX_BYTES) throw new StreamBatchTooLargeError(bytes)
    return this.tx(async (q) => {
      const row = await this.lockStream(q, streamId)
      if (String(row.status) === 'closed') throw new StreamClosedError(streamId)
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM stream_chunks WHERE stream = ${streamId}`
      const chunk: StreamChunk = {
        stream: streamId,
        seq: num(tails[0]?.seq) + 1,
        ts: this.now(),
        parts: structuredClone(parts),
      }
      await q`INSERT INTO stream_chunks (stream, seq, ts, parts)
        VALUES (${streamId}, ${chunk.seq}, ${chunk.ts}, ${JSON.stringify(chunk.parts)})`
      return chunk
    })
  }

  async readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead> {
    const read = async (): Promise<StreamRead> => {
      // Record and chunks are one coherent read: both statements run on the
      // same pinned connection, and the retry re-executes the pair together.
      const { row, chunks } = await this.run(async (q) => {
        const rows: Row[] = await q`SELECT * FROM streams WHERE id = ${streamId}`
        const row = rows[0]
        if (!row) throw new Error(`unknown stream "${streamId}"`)
        const chunks: Row[] = await q`SELECT * FROM stream_chunks
          WHERE stream = ${streamId} AND seq > ${opts?.since ?? 0} ORDER BY seq`
        return { row, chunks }
      })
      const record = this.streamRecord(row)
      return {
        chunks: chunks.map((chunk) => ({
          stream: String(chunk.stream),
          seq: num(chunk.seq),
          ts: iso(chunk.ts),
          parts: json<StreamPart[]>(chunk.parts),
        })),
        status: record.status,
        ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
        ...(record.artifact !== undefined ? { artifact: record.artifact } : {}),
      }
    }
    return readStreamWithWait({ read, waitSeconds: opts?.waitSeconds, signal: opts?.signal })
  }

  async closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
    // Prepare phase — lock-free read of record and chunks (one coherent read
    // on a pinned connection, retried together), assembly, and the blob write
    // all happen before the transaction (D6 shape: content-addressed orphan
    // blobs are harmless; a deposit failure leaves the stream open and
    // unwritten).
    const { row, chunkRows } = await this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM streams WHERE id = ${streamId}`
      const row = rows[0]
      if (!row) throw new Error(`unknown stream "${streamId}"`)
      const chunkRows: Row[] = await q`SELECT * FROM stream_chunks
        WHERE stream = ${streamId} ORDER BY seq`
      return { row, chunkRows }
    })
    if (String(row.status) === 'closed') return this.streamRecord(row)
    const { document, droppedPartCount } = await assembleUIMessageDocument(
      chunkRows.flatMap((chunk) => json<StreamPart[]>(chunk.parts)),
    )
    const scope = this.streamScopeOf(row)
    const input = streamArtifactInput(
      String(row.id),
      scope,
      String(row.label),
      outcome,
      document,
      chunkRows.length,
      droppedPartCount,
    )
    const blobRef = contentHash(toBytes(input.content))
    await this.blobs.put(blobRef, toBytes(input.content))
    // Commit phase — one locked transaction: the artifact deposit and the
    // close land together. A close that raced us through the prepare phase
    // wins; ours re-reads and returns its record.
    return this.tx(async (q) => {
      const fresh = await this.lockStream(q, streamId)
      if (String(fresh.status) === 'closed') return this.streamRecord(fresh)
      // Commit-time verification (AUT-348): the prepare-phase chunk snapshot
      // can go stale — an append from another connection may commit after the
      // snapshot and before this transaction takes the row lock. Re-read the
      // chunk rows under the lock; on a mismatch re-assemble and re-put the
      // blob so every acknowledged append is included in the finalized
      // artifact. An append that commits before the lock is taken lands here;
      // one that waits on the lock fails the closed check above instead.
      const lockedChunks: Row[] = await q`SELECT * FROM stream_chunks
        WHERE stream = ${streamId} ORDER BY seq`
      let closeInput = input
      let closeRef = blobRef
      if (lockedChunks.length !== chunkRows.length) {
        const reassembled = await assembleUIMessageDocument(
          lockedChunks.flatMap((chunk) => json<StreamPart[]>(chunk.parts)),
        )
        closeInput = streamArtifactInput(
          String(row.id),
          scope,
          String(row.label),
          outcome,
          reassembled.document,
          lockedChunks.length,
          reassembled.droppedPartCount,
        )
        closeRef = contentHash(toBytes(closeInput.content))
        await this.blobs.put(closeRef, toBytes(closeInput.content))
      }
      const meta =
        scope.kind === 'build'
          ? await this.depositBuildLocked(
              q,
              scope.build,
              {
                kind: closeInput.kind,
                blobRef: closeRef,
                metadata: structuredClone(closeInput.metadata),
              },
              new Map(),
            )
          : scope.kind === 'repo'
            ? await this.depositRepoLocked(
                q,
                scope.repo,
                {
                  kind: closeInput.kind,
                  blobRef: closeRef,
                  metadata: structuredClone(closeInput.metadata),
                },
                new Map(),
              )
            : await this.depositSessionLocked(
                q,
                scope.session,
                {
                  kind: closeInput.kind,
                  blobRef: closeRef,
                  metadata: structuredClone(closeInput.metadata),
                },
                new Map(),
              )
      await q`UPDATE streams
        SET status = 'closed', outcome = ${outcome}, closed_at = ${meta.createdAt},
          artifact_kind = ${meta.kind}, artifact_revision = ${meta.revision},
          artifact_blob_ref = ${meta.blobRef}
        WHERE id = ${streamId}`
      return this.streamRecord(await this.lockStream(q, streamId))
    })
  }

  async getStream(streamId: string): Promise<StreamRecord | null> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM streams WHERE id = ${streamId}`
      return rows[0] ? this.streamRecord(rows[0]) : null
    })
  }

  async listStreams(scope: StreamScope): Promise<StreamRecord[]> {
    const owner =
      scope.kind === 'build' ? scope.build : scope.kind === 'repo' ? scope.repo : scope.session
    // Pinned tiebreak (store/types.ts): createdAt ascending, then the
    // store-assigned monotonic creation sequence — never the random id.
    return this.run(async (q) => {
      const rows: Row[] = await q`
        SELECT * FROM streams
        WHERE scope_kind = ${scope.kind}
          AND (
            (scope_kind = 'build' AND build = ${scope.kind === 'build' ? owner : null})
            OR (scope_kind = 'repo' AND repo = ${scope.kind === 'repo' ? owner : null})
            OR (scope_kind = 'session' AND session = ${scope.kind === 'session' ? owner : null})
          )
        ORDER BY created_at, creation_seq`
      return rows.map((row) => this.streamRecord(row))
    })
  }

  async close(): Promise<void> {
    await this.sql.close()
  }
}

export async function openPostgresBuildStore(
  url: string,
  blobs: BlobStore,
  options: { clock?: Clock; retention?: { maxRevisions?: number } } = {},
): Promise<PostgresBuildStore> {
  const sql = new SQL(url)
  try {
    await assertSchema(sql)
    return new PostgresBuildStore(sql, {
      blobs,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.retention ? { retention: options.retention } : {}),
    })
  } catch (error) {
    await sql.close()
    throw error
  }
}
