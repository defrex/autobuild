import { scanCadenceSchema, type ScanCadence } from '@defrex/autobuild/store-adapter'
import { PROJECT_BLOB_LOCK, reserveProjectBlobs } from './project-lifecycle'
import { hostedProjectContext } from './request-context'
import {
  operatorIdentitySchema,
  operatorPresenceSchema,
  OPERATOR_PRESENCE_TTL_MS,
  type OperatorIdentity,
  type OperatorPresence,
} from '@defrex/autobuild/store-adapter'
import { READ_CATALOG_IDENTITY } from '@defrex/autobuild/store-adapter'
import {
  repositoryRead,
  hasRepositoryReadContext,
  knownRepositoryExists,
  recordRepositoryExistence,
} from './request-context'
import { readPersistedBuildDigests } from '@defrex/autobuild/store-adapter'
import { assertPublicSnapshotReducer } from '@defrex/autobuild/store-adapter'
import {
  readReducerValue,
  resolveReducerValue,
  type ReducerValueRequest,
  type ReducerValue,
} from '@defrex/autobuild/store-adapter'
import { validateTickFinish } from '@defrex/autobuild/store-adapter'
import type {
  RepoTickCompletion,
  RepoTickFinish,
  RepoTickObservation,
} from '@defrex/autobuild/store-adapter'
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
  resolvePinnedAsset,
  validateCreatedEvent,
  prepareEventWrite as validateEventWrite,
  validateExpectedSeq,
  prepareRepositoryEventWrite as validateRepositoryEventWrite,
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
  REPOSITORY_STATE_EVENT_TYPES,
  REPOSITORY_LATEST_EVENT_TYPES,
  readRepoStateEventsWithAnchorRecheck,
} from '@defrex/autobuild/store-adapter'
import {
  DEFAULT_TICKET_ASSET_LIMITS,
  loadTicketAsset,
  storeTicketAssetBlobs,
  summarizeTicketAsset,
  validateTicketAssetInput,
  type TicketAsset,
  type TicketAssetEntry,
  type TicketAssetInput,
  type TicketAssetLimits,
  type TicketAssetMeta,
  type TicketAssetSummary,
} from '@defrex/autobuild/store-adapter'
import type { ReducerSnapshot, SnapshotScope } from '@defrex/autobuild/store-adapter'
import { assertSchema } from './schema'
import { PlanRetryRunner, type Exec, type Row } from './retry'

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
  bytes?: Uint8Array
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
  readonly catalogIdentity = READ_CATALOG_IDENTITY
  readonly networkReads = true
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

  /** The shared plan-retry mechanics (`./retry`): one runner per pool owner,
   * so its memoized markers are namespaced to this store instance (see
   * `./retry` for why the memo and the per-instance namespace exist). */
  private readonly retry = new PlanRetryRunner()

  /** Run a non-transactional operation on one pinned pooled connection,
   * retrying it exactly once — same connection, statements freshly prepared —
   * when a cached plan fails to revalidate (AUT-396). A run body must not
   * call a public store method: reserving inside a reservation yields a
   * brand-new connection instead of the pinned one — and must execute its
   * statements sequentially, for failure attribution. See `./retry`. */
  private async run<T>(body: (q: Exec) => Promise<T>): Promise<T> {
    return this.retry.run(this.sql, body)
  }

  /** Run a transactional operation on one pinned pooled connection, retrying
   * the whole body exactly once on a plan-change error: the failed attempt
   * rolls back, and the body re-runs in a fresh transaction on the same
   * connection with freshly prepared statements (AUT-396). See `./retry`. */
  private async tx<T>(body: (q: Exec) => Promise<T>): Promise<T> {
    return this.retry.tx(this.sql, body)
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
      ...(row.tick ? { tick: structuredClone(row.tick) as RepoTickObservation } : {}),
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
    const created = validateCreatedEvent(input)
    const ts = this.now()
    return this.tx(async (q) => {
      const inserted: Row[] = await q`INSERT INTO builds
        (slug, repo, ticket, branch, repo_origin, created_at, updated_at)
        VALUES (${input.slug}, ${input.repo}, ${input.ticket ?? null}, ${input.branch ?? null}, ${input.repoOrigin ?? null}, ${ts}, ${ts})
        ON CONFLICT (slug) DO NOTHING RETURNING slug`
      const row = await this.lockBuild(q, input.slug)
      if (!inserted[0]) throw new Error(`build "${input.slug}" already exists`)
      if (created === undefined) return this.currentRecord(q, row)
      await this.appendLocked(q, input.slug, created, true)
      return this.currentRecord(q, await this.lockBuild(q, input.slug))
    })
  }

  /** Current ticket identity is a read projection; event/artifact bytes remain historical. */
  private async currentRecord(q: Exec, row: Row): Promise<BuildRecord> {
    const record = this.record(row)
    if (record.ticket?.source !== 'hosted') return record
    const ticket = await this.hostedTicketRow(q, record.repo, record.ticket.id)
    const id = ticket?.readable_id
    return id ? { ...record, ticket: { ...record.ticket, id: String(id) } } : record
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    return this.run(async (q) => {
      const rows: Row[] = await q`SELECT * FROM builds WHERE slug = ${slug}`
      return rows[0] ? this.currentRecord(q, rows[0]) : null
    })
  }

  async listBuilds(): Promise<BuildRecord[]> {
    return this.listBuildRecords()
  }

  async getRepoChangePosition(repo: string): Promise<string> {
    return this.run(async (q) => {
      const rows: Row[] =
        await q`SELECT position::text AS position FROM repo_change_positions WHERE repo = ${repo}`
      return rows[0] ? String(rows[0].position) : '0'
    })
  }

  async listBuildsForRepo(repo: string): Promise<BuildRecord[]> {
    return this.listBuildRecords(repo)
  }

  private async listBuildRecords(repo?: string): Promise<BuildRecord[]> {
    return this.run(async (q) => {
      if (!(await this.hasReadableTicketSchema(q))) {
        const rows: Row[] =
          repo === undefined
            ? await q`SELECT * FROM builds ORDER BY created_at, slug`
            : await q`SELECT * FROM builds WHERE repo = ${repo} ORDER BY created_at, slug`
        return rows.map((row) => this.record(row))
      }
      const rows: Row[] =
        repo === undefined
          ? await q`SELECT b.*, t.readable_id AS projected_ticket_id FROM builds b
        LEFT JOIN LATERAL (
          SELECT readable_id FROM ab_tickets
          WHERE b.ticket->>'source' = 'hosted' AND repo = b.repo
            AND (id = b.ticket->>'id' OR lower(readable_id) = lower(b.ticket->>'id'))
          LIMIT 1
        ) t ON true
        ORDER BY b.created_at, b.slug`
          : await q`SELECT b.*, t.readable_id AS projected_ticket_id
        FROM (SELECT * FROM builds WHERE repo = ${repo}) b
        LEFT JOIN LATERAL (
          SELECT readable_id FROM ab_tickets
          WHERE b.ticket->>'source' = 'hosted' AND repo = b.repo
            AND (id = b.ticket->>'id' OR lower(readable_id) = lower(b.ticket->>'id'))
          LIMIT 1
        ) t ON true
        ORDER BY b.created_at, b.slug`
      return rows.map((row) => {
        const record = this.record(row)
        return record.ticket && row.projected_ticket_id
          ? { ...record, ticket: { ...record.ticket, id: String(row.projected_ticket_id) } }
          : record
      })
    })
  }

  async getNodeRewrite(slug: string, previous?: string, beforePrevious?: string) {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    const rows: Row[] = await this.run((q) =>
      beforePrevious !== undefined
        ? q`SELECT payload FROM events WHERE type = 'node.rewritten'
          AND build = ${slug} AND seq < (
            SELECT seq FROM events WHERE type = 'node.rewritten' AND build = ${slug}
              AND payload->>'previous' = ${beforePrevious} ORDER BY seq DESC LIMIT 1
          ) ORDER BY seq DESC LIMIT 1`
        : previous === undefined
          ? q`SELECT payload FROM events WHERE type = 'node.rewritten'
          AND build = ${slug} ORDER BY seq DESC LIMIT 1`
          : q`SELECT payload FROM events WHERE type = 'node.rewritten'
          AND build = ${slug} AND payload->>'previous' = ${previous}
          ORDER BY seq DESC LIMIT 1`,
    )
    return rows[0]
      ? (json(rows[0].payload) as Extract<
          import('@defrex/autobuild/plugin-sdk').AbEvent,
          { type: 'node.rewritten' }
        >['payload'])
      : null
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    const records = await this.run(async (q) => {
      const rows: Row[] =
        await q`SELECT * FROM builds WHERE repo = ${repo} ORDER BY created_at, slug`
      return rows.map((row) => this.record(row))
    })
    return readPersistedBuildDigests(this, repo, records)
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
    await q`INSERT INTO events (build, seq, ts, actor, type, payload, compatibility)
      VALUES (${slug}, ${seq}, ${ts}, ${event.actor}, ${event.type}, ${event.payload}, ${event.compatibility ?? null})`
    await q`UPDATE builds SET updated_at = ${ts} WHERE slug = ${slug}`
    return {
      build: slug,
      seq,
      ts,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      compatibility: event.compatibility,
    }
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

  private async prepare(artifact: ArtifactInput, repo: string): Promise<PreparedArtifact> {
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.reserveBlobs(repo, [blobRef])
    return {
      bytes,
      kind: artifact.kind,
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
    }
  }

  private async reserveBlobs(repo: string, refs: readonly string[]): Promise<void> {
    const context = hostedProjectContext()
    if (context) {
      const generation = context.get(repo)
      if (!generation) throw new Error('project not registered')
      await reserveProjectBlobs(this.sql, { repo, generation }, refs)
    } else {
      await this.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
        for (const ref of new Set(refs))
          await tx`INSERT INTO project_blob_ownership (repo,blob_ref) VALUES (${repo},${ref}) ON CONFLICT DO NOTHING`
      })
    }
  }

  private async artifactRepo(kind: 'build' | 'session', id: string): Promise<string> {
    return this.run(async (q) => {
      const rows =
        kind === 'build'
          ? await q`SELECT repo FROM builds WHERE slug = ${id}`
          : await q`SELECT repo FROM sessions WHERE id = ${id}`
      if (!rows[0]) throw new Error(`unknown ${kind} "${id}"`)
      return String(rows[0].repo)
    })
  }

  private async uploadPrepared(q: Exec, artifact: PreparedArtifact): Promise<void> {
    if (!artifact.bytes) return
    await q`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
    await this.blobs.put(artifact.blobRef, artifact.bytes)
  }

  private async depositBuildLocked(
    q: Exec,
    slug: string,
    artifact: PreparedArtifact,
    lockedKinds: Map<string, number>,
    opts: { prune?: boolean } = { prune: true },
  ): Promise<ArtifactMeta> {
    await this.uploadPrepared(q, artifact)
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
    for (const artifact of artifacts)
      prepared.push(await this.prepare(artifact, await this.artifactRepo('build', slug)))
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

  async appendWithArtifactsIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] } | null> {
    validateExpectedSeq(expectedSeq)
    const prepared: PreparedArtifact[] = []
    for (const artifact of artifacts)
      prepared.push(await this.prepare(artifact, await this.artifactRepo('build', slug)))
    return this.tx(async (q) => {
      await this.lockBuild(q, slug)
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE build = ${slug}`
      if (num(tails[0]?.seq) !== expectedSeq) return null
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
        ...(row.compatibility ? { compatibility: json(row.compatibility) } : {}),
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
    const prepared = await this.prepare(artifact, await this.artifactRepo('build', slug))
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

  async getLatestArtifactMeta(slug: string, kind: string): Promise<ArtifactMeta | null> {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    // The (build, kind, revision) primary key supports this reverse LIMIT 1 scan.
    const rows: Row[] = await this.run(
      (q) =>
        q`SELECT build, kind, revision, blob_ref, metadata, created_at FROM artifacts
        WHERE build = ${slug} AND kind = ${kind} ORDER BY revision DESC LIMIT 1`,
    )
    return rows[0] ? this.artifactMeta(rows[0]) : null
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

  async claimNodeWriter(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.tx(async (q) => {
      const row = await this.lockBuild(q, slug)
      const now = this.clock().getTime()
      if (
        row.node_writer_holder &&
        row.node_writer_holder !== holder &&
        row.node_writer_expires_at &&
        Date.parse(iso(row.node_writer_expires_at)) > now
      )
        return false
      const expires = new Date(now + ttlMs).toISOString()
      await q`UPDATE builds SET node_writer_holder=${holder}, node_writer_expires_at=${expires}, node_writer_ttl_ms=${ttlMs}, updated_at=${new Date(now).toISOString()} WHERE slug=${slug}`
      return true
    })
  }
  async renewNodeWriter(slug: string, holder: string): Promise<boolean> {
    return this.tx(async (q) => {
      const row = await this.lockBuild(q, slug)
      const now = this.clock().getTime()
      if (
        row.node_writer_holder !== holder ||
        !row.node_writer_expires_at ||
        Date.parse(iso(row.node_writer_expires_at)) <= now
      )
        return false
      const expires = new Date(now + num(row.node_writer_ttl_ms)).toISOString()
      await q`UPDATE builds SET node_writer_expires_at=${expires}, updated_at=${new Date(now).toISOString()} WHERE slug=${slug}`
      return true
    })
  }
  async releaseNodeWriter(slug: string, holder: string): Promise<void> {
    await this.tx(async (q) => {
      await this.lockBuild(q, slug)
      await q`UPDATE builds SET node_writer_holder=NULL, node_writer_expires_at=NULL, node_writer_ttl_ms=NULL, updated_at=${this.now()} WHERE slug=${slug} AND node_writer_holder=${holder}`
    })
  }
  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.claim('builds', slug, holder, ttlMs)
  }
  async beginRepoTick(repo: string, holder: string): Promise<string | null> {
    return this.tx(async (q) => {
      const row = await this.lockRepo(q, repo)
      if (
        row.lease_holder !== holder ||
        !row.lease_expires_at ||
        Date.parse(iso(row.lease_expires_at)) <= this.clock().getTime()
      )
        return null
      const startedAt = this.now()
      const previous = row.tick as RepoTickObservation | undefined
      const tick: RepoTickObservation = {
        run: holder,
        open: { startedAt },
        ...(previous?.finished ? { finished: previous.finished } : {}),
      }
      await q`UPDATE repo_streams SET tick=${tick}, updated_at=${startedAt} WHERE repo=${repo}`
      return startedAt
    })
  }

  async finishRepoTick(
    repo: string,
    holder: string,
    completion: RepoTickCompletion,
    events: RepositoryEventWrite[],
  ): Promise<RepoTickFinish | null> {
    const validated = validateTickFinish(holder, completion, events)
    return this.tx(async (q) => {
      const row = await this.lockRepo(q, repo)
      if (
        row.lease_holder !== holder ||
        !row.lease_expires_at ||
        Date.parse(iso(row.lease_expires_at)) <= this.clock().getTime()
      )
        return null
      const previous = row.tick as RepoTickObservation | undefined
      if (previous?.run !== holder || !previous.open) throw new Error('no open repository tick')
      const completedAt = this.now()
      const envelopes: RepositoryEvent[] = []
      for (const event of validated)
        envelopes.push(
          (await this.appendRepoLocked(q, repo, event, true, completedAt)) as RepositoryEvent,
        )
      const observation: RepoTickObservation = {
        run: holder,
        finished: { ...completion, run: holder, startedAt: previous.open.startedAt, completedAt },
      }
      await q`UPDATE repo_streams SET tick=${observation}, updated_at=${completedAt} WHERE repo=${repo}`
      return { observation, events: envelopes }
    })
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

  async appendSessionEventIfCurrent<T extends SessionEventType>(
    id: string,
    expectedSeq: number,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateSessionEventWrite(event)
    return (await this.sql.begin(async (tx) => {
      // The session advisory lock serializes this comparison and append
      // against every concurrent writer of the session, exactly as
      // `appendSessionEvent` serializes two plain appends.
      await this.lockSession(tx, id)
      const tails: Row[] =
        await tx`SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session = ${id}`
      if (num(tails[0]?.seq) !== expectedSeq) return null
      return this.appendSessionLocked(tx, id, validated, true)
    })) as SessionEventEnvelope<T> | null
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
    await this.uploadPrepared(q, artifact)
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
    for (const artifact of artifacts)
      prepared.push(await this.prepare(artifact, await this.artifactRepo('session', id)))
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
    const prepared = await this.prepare(artifact, await this.artifactRepo('session', id))
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

  async getScanCadence(repo: string): Promise<ScanCadence | null> {
    return this.run(async (q) => {
      const [row] = await q`SELECT value FROM scan_cadence WHERE repo=${repo}`
      return row ? (scanCadenceSchema.safeParse(row.value).data ?? null) : null
    })
  }
  async putScanCadence(
    repo: string,
    input: ScanCadence,
    allowClockRollback = false,
  ): Promise<void> {
    const cadence = scanCadenceSchema.parse(input)
    await this.tx(async (q) => {
      await this.lockRepo(q, repo)
      await q`INSERT INTO scan_cadence (repo,value) VALUES (${repo},${cadence})
        ON CONFLICT(repo) DO UPDATE SET value=EXCLUDED.value
        WHERE COALESCE(scan_cadence.value->>'scanSeq' <> ${String(cadence.scanSeq)}
          OR ${allowClockRollback}
          OR scan_cadence.value->>'startedAt' <= ${cadence.startedAt}, true)`
    })
  }

  async upsertOperatorPresence(
    repo: string,
    input: OperatorIdentity,
    signal?: AbortSignal,
  ): Promise<OperatorPresence> {
    signal?.throwIfAborted()
    if (!repo) throw new Error('repo is required')
    const identity = operatorIdentitySchema.parse(input)
    return this.tx(async (q) => {
      signal?.throwIfAborted()
      const rows = await q`INSERT INTO operator_presence (repo,id,host,pid,started_at,heartbeat_at)
        VALUES (${repo},${identity.id},${identity.host},${identity.pid},${identity.startedAt},${this.now()})
        ON CONFLICT (repo,id) DO UPDATE SET host=EXCLUDED.host,pid=EXCLUDED.pid,
        heartbeat_at=GREATEST(operator_presence.heartbeat_at,EXCLUDED.heartbeat_at)
        RETURNING repo,id,host,pid,started_at,heartbeat_at`
      const row = rows[0]!
      return operatorPresenceSchema.parse({
        repo: row.repo,
        id: row.id,
        host: row.host,
        pid: row.pid,
        startedAt: iso(row.started_at),
        heartbeatAt: iso(row.heartbeat_at),
      })
    })
  }

  async removeOperatorPresence(repo: string, id: string): Promise<void> {
    id = operatorIdentitySchema.shape.id.parse(id)
    await this.tx(async (q) => {
      await q`DELETE FROM operator_presence WHERE repo=${repo} AND id=${id}`
    })
  }

  async listOperatorPresence(repo: string): Promise<OperatorPresence[]> {
    return this.run(async (q) => {
      const rows = await q`SELECT * FROM operator_presence WHERE repo=${repo}
        AND heartbeat_at>${new Date(this.clock().getTime() - OPERATOR_PRESENCE_TTL_MS).toISOString()} ORDER BY id`
      return rows.map((row) =>
        operatorPresenceSchema.parse({
          repo: row.repo,
          id: row.id,
          host: row.host,
          pid: row.pid,
          startedAt: iso(row.started_at),
          heartbeatAt: iso(row.heartbeat_at),
        }),
      )
    })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    return repositoryRead(this, repo, () =>
      this.run(async (q) => {
        const rows: Row[] = await q`SELECT * FROM repo_streams WHERE repo=${repo}`
        recordRepositoryExistence(this, repo, !!rows[0])
        return rows[0] ? this.repoRecord(rows[0]) : null
      }),
    )
  }

  private async appendRepoLocked(
    q: Exec,
    repo: string,
    event: RepositoryEventWrite,
    alreadyLocked = false,
    ts = this.now(),
  ): Promise<RepositoryEventEnvelope> {
    if (!alreadyLocked) await this.lockRepo(q, repo)
    const tails: Row[] =
      await q`SELECT COALESCE(MAX(seq), 0) AS seq FROM repo_events WHERE repo=${repo}`
    const seq = num(tails[0]?.seq) + 1
    await q`INSERT INTO repo_events (repo, seq, ts, actor, type, payload, compatibility) VALUES (${repo},${seq},${ts},${event.actor},${event.type},${event.payload},${event.compatibility ?? null})`
    await q`UPDATE repo_streams SET updated_at=${ts} WHERE repo=${repo}`
    return {
      repo,
      seq,
      ts,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      compatibility: event.compatibility,
    }
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
    await this.uploadPrepared(q, artifact)
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
    for (const artifact of artifacts) prepared.push(await this.prepare(artifact, repo))
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
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const read = async (): Promise<RepositoryEvent[]> => {
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
        ...(row.compatibility ? { compatibility: json(row.compatibility) } : {}),
      })) as RepositoryEvent[]
    }
    return readEventsWithWait({
      read,
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  async getRepoHighWater(repo: string): Promise<number> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const rows: Row[] = await this.run(
      (q) => q`SELECT COALESCE(MAX(seq), 0) AS seq FROM repo_events WHERE repo=${repo}`,
    )
    return num(rows[0]?.seq ?? 0)
  }

  /** SQLSTATE 42P01: a database that has not run the additive snapshot
   * migration. Never cached, so a later `postgres:migrate` starts working
   * without a restart. */
  private static missingSnapshotTable(error: unknown): boolean {
    const code =
      (error as { code?: string; errno?: string }).errno ?? (error as { code?: string }).code
    return code === '42P01'
  }

  async getReducerValue(scope: SnapshotScope, request: ReducerValueRequest): Promise<ReducerValue> {
    // Reject invalid requests before touching storage.
    resolveReducerValue(scope, request)
    return readReducerValue(scope, request, {
      highWater: async () => {
        const tail = await this.valueTail(scope)
        if (tail === undefined) throw new Error('unknown reducer scope')
        return tail
      },
      events: async (since, through) => {
        const key = scope.kind === 'build' ? scope.slug : scope.repo
        const rows: Row[] =
          scope.kind === 'build'
            ? await this.run(
                (q) =>
                  q`SELECT * FROM events WHERE build=${key} AND seq>${since} AND seq<=${through} ORDER BY seq`,
              )
            : await this.run(
                (q) =>
                  q`SELECT * FROM repo_events WHERE repo=${key} AND seq>${since} AND seq<=${through} ORDER BY seq`,
              )
        return rows.map((row) => ({
          ...(scope.kind === 'build' ? { build: key } : { repo: key }),
          seq: num(row.seq),
          ts: iso(row.ts),
          actor: json(row.actor),
          type: String(row.type),
          payload: json(row.payload),
          ...(row.compatibility ? { compatibility: json(row.compatibility) } : {}),
        })) as (AbEvent | RepositoryEvent)[]
      },
      put: (key, snapshot) => this.putSnapshot(scope, key, snapshot),
      read: async (key) => {
        const scopeKey = scope.kind === 'build' ? scope.slug : scope.repo
        const rows: Row[] = await this.run(
          (q) =>
            q`SELECT version, cursor, state, state::text AS raw FROM reducer_snapshots WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND reducer=${key}`,
        )
        const row = rows[0]
        if (!row) return null
        let state: unknown = null
        try {
          state = json(row.state)
        } catch {
          /* malformed JSON cache string */
        }
        return {
          snapshot: { version: num(row.version), cursor: num(row.cursor), state },
          token: String(row.raw),
        }
      },
      repair: async (key, observed, snapshot) => {
        const scopeKey = scope.kind === 'build' ? scope.slug : scope.repo
        const rows: Row[] = await this.tx(
          (q) =>
            q`UPDATE reducer_snapshots SET version=${snapshot.version}::integer, cursor=${snapshot.cursor}::bigint, state=${JSON.stringify(snapshot.state)}::jsonb, updated_at=${this.now()}::timestamptz WHERE scope_kind=${scope.kind} AND scope_key=${scopeKey} AND reducer=${key} AND version=${observed.snapshot.version}::integer AND cursor=${observed.snapshot.cursor}::bigint AND state::text=${observed.token}
          AND (${observed.snapshot.cursor}::bigint <= ${snapshot.cursor}::bigint OR ${observed.snapshot.cursor}::bigint > CASE WHEN ${scope.kind}='build' THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=${scopeKey}),0) ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=${scopeKey}),0) END)
          AND ${snapshot.cursor}::bigint <= CASE WHEN ${scope.kind}='build' THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=${scopeKey}),0) ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=${scopeKey}),0) END RETURNING 1`,
        )
        return rows.length > 0
      },
    })
  }

  private async valueTail(scope: SnapshotScope): Promise<number | undefined> {
    const key = scope.kind === 'build' ? scope.slug : scope.repo
    if (scope.kind === 'repo' && hasRepositoryReadContext()) {
      if (knownRepositoryExists(this, key) === false) return undefined
      const rows: Row[] = await this.run(
        (q) => q`SELECT COALESCE(MAX(seq),0) AS tail FROM repo_events WHERE repo=${key}`,
      )
      const tail = num(rows[0]?.tail ?? 0)
      // A nonempty journal proves its FK parent exists, without an unlocked
      // record read before a delegated harvest mutation takes its own lock.
      if (tail > 0) recordRepositoryExistence(this, key, true)
      else if (knownRepositoryExists(this, key) === undefined && !(await this.getRepo(key)))
        return undefined
      return tail
    }
    const rows: Row[] =
      scope.kind === 'build'
        ? await this.run(
            (q) =>
              q`SELECT (SELECT COALESCE(MAX(seq),0) FROM events WHERE build=${key}) AS tail FROM builds WHERE slug=${key}`,
          )
        : await this.run(
            (q) =>
              q`SELECT (SELECT COALESCE(MAX(seq),0) FROM repo_events WHERE repo=${key}) AS tail FROM repo_streams WHERE repo=${key}`,
          )
    return rows[0] ? num(rows[0].tail) : undefined
  }

  async getReducerSnapshot(
    scope: SnapshotScope,
    reducer: string,
    version: number,
  ): Promise<ReducerSnapshot | null> {
    assertPublicSnapshotReducer(reducer)
    const key = scope.kind === 'build' ? scope.slug : scope.repo
    const repoExists =
      scope.kind === 'repo' && hasRepositoryReadContext()
        ? (knownRepositoryExists(this, key) ?? (await this.getRepo(key)) !== null)
        : undefined
    try {
      const rows: Row[] = await this.run(
        (q) => q`SELECT s.version, s.cursor, s.state FROM reducer_snapshots s
          WHERE s.scope_kind=${scope.kind} AND s.scope_key=${key} AND s.reducer=${reducer}
            AND s.version=${version}
            AND s.cursor <= CASE WHEN ${scope.kind}='build'
              THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=${key}), 0)
              ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=${key}), 0) END
            AND CASE WHEN ${scope.kind}='build'
              THEN EXISTS (SELECT 1 FROM builds WHERE slug=${key})
              ELSE ${
                repoExists === undefined
                  ? this.sql`EXISTS (SELECT 1 FROM repo_streams WHERE repo=${key})`
                  : this.sql`${repoExists}::boolean`
              } END`,
      )
      const row = rows[0]
      if (row === undefined) return null
      return { version: num(row.version), cursor: num(row.cursor), state: json(row.state) }
    } catch (error) {
      if (PostgresBuildStore.missingSnapshotTable(error)) return null
      throw error
    }
  }

  async putReducerSnapshot(
    scope: SnapshotScope,
    reducer: string,
    snapshot: ReducerSnapshot,
  ): Promise<boolean> {
    assertPublicSnapshotReducer(reducer)
    return this.putSnapshot(scope, reducer, snapshot)
  }

  private async putSnapshot(
    scope: SnapshotScope,
    reducer: string,
    snapshot: ReducerSnapshot,
  ): Promise<boolean> {
    const key = scope.kind === 'build' ? scope.slug : scope.repo
    const state = JSON.stringify(snapshot.state ?? null)
    const repoExists =
      scope.kind === 'repo' && hasRepositoryReadContext()
        ? (knownRepositoryExists(this, key) ?? (await this.getRepo(key)) !== null)
        : undefined
    try {
      // Tail bounds and never-decrease guards remain atomic. Outside a request
      // the existence guard is atomic too; request-scoped reuse is safe because
      // repository journals have no deletion API.
      const rows: Row[] = await this.tx(
        (q) => q`INSERT INTO reducer_snapshots
            (scope_kind, scope_key, reducer, version, cursor, state, updated_at)
          SELECT ${scope.kind}, ${key}, ${reducer}, ${snapshot.version}::integer,
            ${snapshot.cursor}::bigint, ${state}::jsonb, ${this.now()}::timestamptz
          WHERE ${snapshot.cursor}::bigint <= CASE WHEN ${scope.kind}='build'
              THEN COALESCE((SELECT MAX(seq) FROM events WHERE build=${key}), 0)
              ELSE COALESCE((SELECT MAX(seq) FROM repo_events WHERE repo=${key}), 0) END
            AND CASE WHEN ${scope.kind}='build'
              THEN EXISTS (SELECT 1 FROM builds WHERE slug=${key})
              ELSE ${
                repoExists === undefined
                  ? this.sql`EXISTS (SELECT 1 FROM repo_streams WHERE repo=${key})`
                  : this.sql`${repoExists}::boolean`
              } END
          ON CONFLICT (scope_kind, scope_key, reducer) DO UPDATE SET
            version = EXCLUDED.version, cursor = EXCLUDED.cursor,
            state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
          WHERE EXCLUDED.version >= reducer_snapshots.version AND (EXCLUDED.cursor > reducer_snapshots.cursor
            OR (EXCLUDED.cursor = reducer_snapshots.cursor
              AND EXCLUDED.version > reducer_snapshots.version))
          RETURNING 1 AS written`,
      )
      return rows.length > 0
    } catch (error) {
      if (PostgresBuildStore.missingSnapshotTable(error)) return false
      throw error
    }
  }

  async getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    // Two queries, mirroring the oracle's derivation: the latest run-started
    // anchor (indexed by repo_events_type_repo_seq, v8 — without it MAX(seq)
    // over the repo's run-started facts degrades to a scan of the repo's
    // whole PK range, exactly the cost being removed), then one select of
    // durable types plus the tail from that anchor.
    //
    // `this.run` is deliberately non-transactional (a pinned pooled
    // connection, no BEGIN), so the probe and the select each get their own
    // READ COMMITTED snapshot — a concurrent append of the journal's first
    // `dispatcher.run-started` between them would be invisible to the probe,
    // absent from the durable-only selection, yet present in the journal by
    // the time this method returns (AUT-551). The shared helper below closes
    // that window with a one-shot anchor re-check on the durable-only
    // outcome: a durable-only result is returned only when the journal was
    // anchor-free as of the final probe. When the probe *does* find an
    // anchor, the anchored select's `seq >= anchor` arm is
    // monotone-inclusive, so any later run-started is picked up by that same
    // select; an append after the final re-probe is an ordinary post-read
    // concurrent append, not this race.
    const durableList = [...REPOSITORY_STATE_EVENT_TYPES]
    return readRepoStateEventsWithAnchorRecheck(
      async () => {
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
          await this.run(
            (q) =>
              q`SELECT MAX(seq) AS seq, MAX(seq) IS NULL AS no_anchor FROM repo_events WHERE repo=${repo} AND type='dispatcher.run-started'`,
          )
        )[0]
        return probe?.no_anchor ? undefined : num(probe?.seq)
      },
      async (anchor) => {
        const bindings: (string | number)[] = [repo]
        const bind = (value: string | number) => {
          bindings.push(value)
          return `$${bindings.length}`
        }
        const durable = `type IN (${durableList.map(bind).join(', ')})`
        const latestTypes = REPOSITORY_LATEST_EVENT_TYPES.map(bind)
        const latest = latestTypes.map(
          (type) =>
            `(type = ${type} AND seq = (SELECT seq FROM repo_events WHERE repo = $1 AND type = ${type} ORDER BY seq DESC LIMIT 1))`,
        )
        const tail =
          anchor === undefined
            ? []
            : [`(seq >= ${bind(anchor)} AND type NOT IN (${latestTypes.join(', ')}))`]
        const rows: Row[] = await this.run((q) =>
          q.unsafe(
            `SELECT * FROM repo_events WHERE repo = $1 AND (${[durable, ...tail, ...latest].join(' OR ')}) ORDER BY seq`,
            bindings,
          ),
        )
        return rows.map((row) => ({
          repo: String(row.repo),
          seq: num(row.seq),
          ts: iso(row.ts),
          actor: json(row.actor),
          type: String(row.type),
          payload: json(row.payload),
          ...(row.compatibility ? { compatibility: json(row.compatibility) } : {}),
        })) as RepositoryEvent[]
      },
    )
  }

  async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    const prepared = await this.prepare(artifact, repo)
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

  async ticketAssetLimits(_repo: string): Promise<TicketAssetLimits> {
    return { ...DEFAULT_TICKET_ASSET_LIMITS }
  }

  private ticketAssetMeta(row: Row): TicketAssetMeta {
    return {
      repo: String(row.repo),
      ticketId: String(row.ticket_id),
      kind: String(row.kind),
      name: String(row.name),
      revision: num(row.revision),
      layout: String(row.layout) as TicketAssetMeta['layout'],
      size: num(row.size),
      entries: json<TicketAssetEntry[]>(row.manifest),
      createdAt: iso(row.created_at),
    }
  }

  private readableTicketSchema = false

  /** Ticket tables are an independently migrated, optional store extension. */
  private async hasReadableTicketSchema(q: Exec): Promise<boolean> {
    if (!this.readableTicketSchema) {
      const tables: Row[] = await q`SELECT to_regclass('ab_ticket_schema_migrations') AS tickets`
      if (!tables[0]?.tickets) return false
      const markers: Row[] =
        await q`SELECT version FROM ab_ticket_schema_migrations WHERE singleton = true`
      if (Number(markers[0]?.version ?? 0) < 3) return false
      // Cache only presence: a store opened before migration must discover a later upgrade.
      this.readableTicketSchema = true
    }
    return true
  }

  private async hostedTicketRow(q: Exec, repo: string, id: string): Promise<Row | undefined> {
    if (!(await this.hasReadableTicketSchema(q))) return undefined
    const rows: Row[] = await q`SELECT id, readable_id FROM ab_tickets
      WHERE repo = ${repo} AND (id = ${id} OR lower(readable_id) = lower(${id}))`
    return rows[0]
  }

  private async currentAssetMeta(q: Exec, row: Row): Promise<TicketAssetMeta> {
    const meta = this.ticketAssetMeta(row)
    const ticket = await this.hostedTicketRow(q, meta.repo, meta.ticketId)
    return ticket?.readable_id ? { ...meta, ticketId: String(ticket.readable_id) } : meta
  }

  private async ticketStorageKey(q: Exec, repo: string, id: string): Promise<string> {
    return String((await this.hostedTicketRow(q, repo, id))?.id ?? id)
  }

  async putTicketAsset(
    repo: string,
    ticketId: string,
    asset: TicketAssetInput,
  ): Promise<TicketAssetMeta> {
    const size = validateTicketAssetInput(asset)
    await this.reserveBlobs(
      repo,
      asset.entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => contentHash(entry.content)),
    )
    return this.tx(async (q) => {
      await q`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
      const entries = await storeTicketAssetBlobs(this.blobs, asset.entries)
      const manifest = JSON.stringify(entries)
      const key = await this.ticketStorageKey(q, repo, ticketId)
      // Serialize revision assignment per (repo, ticket, kind, name).
      await q`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([repo, key, asset.kind, asset.name])}, 0))`
      const tails: Row[] =
        await q`SELECT COALESCE(MAX(revision), -1) AS revision FROM ticket_assets WHERE repo=${repo} AND ticket_id=${key} AND kind=${asset.kind} AND name=${asset.name}`
      const revision = num(tails[0]?.revision) + 1
      const createdAt = this.now()
      await q`INSERT INTO ticket_assets (repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES (${repo},${key},${asset.kind},${asset.name},${revision},${asset.layout},${manifest}::jsonb,${size},false,${createdAt})`
      const display = await this.currentAssetMeta(q, {
        repo,
        ticket_id: key,
        kind: asset.kind,
        name: asset.name,
        revision,
        layout: asset.layout,
        size,
        manifest: entries,
        created_at: createdAt,
      })
      return {
        repo,
        ticketId: display.ticketId,
        kind: asset.kind,
        name: asset.name,
        revision,
        layout: asset.layout,
        size,
        entries,
        createdAt,
      }
    })
  }

  async getTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
    rev?: number,
  ): Promise<TicketAsset | null> {
    const rows: Row[] = await this.run(async (q) => {
      const key = await this.ticketStorageKey(q, repo, ticketId)
      return rev === undefined
        ? q`SELECT * FROM ticket_assets WHERE repo=${repo} AND ticket_id=${key} AND kind=${kind} AND name=${name} ORDER BY revision DESC LIMIT 1`
        : q`SELECT * FROM ticket_assets WHERE repo=${repo} AND ticket_id=${key} AND kind=${kind} AND name=${name} AND revision=${rev}`
    })
    const row = rows[0]
    if (!row || row.removed === true) return null
    return loadTicketAsset(this.blobs, await this.run((q) => this.currentAssetMeta(q, row)))
  }

  async getPinnedTicketAsset(
    slug: string,
    kind: string,
    name: string,
    rev?: number,
  ): Promise<TicketAsset | null> {
    return resolvePinnedAsset(this, slug, kind, name, rev)
  }

  async listTicketAssets(
    repo: string,
    ticketId: string,
    opts?: { revisions?: boolean },
  ): Promise<TicketAssetSummary[]> {
    const rows: Row[] = await this.run(async (q) => {
      const key = await this.ticketStorageKey(q, repo, ticketId)
      const rows: Row[] =
        await q`SELECT * FROM ticket_assets WHERE repo=${repo} AND ticket_id=${key} ORDER BY kind, name, revision`
      const projected: Row[] = []
      for (const row of rows)
        projected.push({ ...row, ticket_id: (await this.currentAssetMeta(q, row)).ticketId })
      return projected
    })
    if (opts?.revisions) {
      return rows
        .filter((row) => row.removed !== true)
        .map((row) => summarizeTicketAsset(this.ticketAssetMeta(row)))
    }
    const latest = new Map<string, Row>()
    for (const row of rows) latest.set(JSON.stringify([row.kind, row.name]), row)
    return [...latest.values()]
      .filter((row) => row.removed !== true)
      .map((row) => summarizeTicketAsset(this.ticketAssetMeta(row)))
  }

  async removeTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
  ): Promise<TicketAssetMeta | null> {
    return this.tx(async (q) => {
      const key = await this.ticketStorageKey(q, repo, ticketId)
      await q`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([repo, key, kind, name])}, 0))`
      const rows: Row[] =
        await q`SELECT * FROM ticket_assets WHERE repo=${repo} AND ticket_id=${key} AND kind=${kind} AND name=${name} ORDER BY revision DESC LIMIT 1`
      const latest = rows[0]
      if (!latest || latest.removed === true) return null
      await q`INSERT INTO ticket_assets (repo,ticket_id,kind,name,revision,layout,manifest,size,removed,created_at) VALUES (${repo},${key},${kind},${name},${num(latest.revision) + 1},${String(latest.layout)},${'[]'}::jsonb,0,true,${this.now()})`
      return this.currentAssetMeta(q, latest)
    })
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const { row, chunkRows } = await this.run(async (q) => {
        const [row] = await q`SELECT * FROM streams WHERE id = ${streamId}`
        if (!row) throw new Error(`unknown stream "${streamId}"`)
        const chunkRows =
          await q`SELECT * FROM stream_chunks WHERE stream = ${streamId} ORDER BY seq`
        return { row, chunkRows }
      })
      if (String(row.status) === 'closed') return this.streamRecord(row)
      const scope = this.streamScopeOf(row)
      const assembled = await assembleUIMessageDocument(
        chunkRows.flatMap((chunk) => json<StreamPart[]>(chunk.parts)),
      )
      const closeInput = streamArtifactInput(
        String(row.id),
        scope,
        String(row.label),
        outcome,
        assembled.document,
        chunkRows.length,
        assembled.droppedPartCount,
      )
      const closeRef = contentHash(toBytes(closeInput.content))
      const repo =
        scope.kind === 'repo'
          ? scope.repo
          : scope.kind === 'build'
            ? await this.artifactRepo('build', scope.build)
            : await this.artifactRepo('session', scope.session)
      await this.reserveBlobs(repo, [closeRef])
      const result = await this.tx(async (q) => {
        await q`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
        await this.blobs.put(closeRef, toBytes(closeInput.content))
        const fresh = await this.lockStream(q, streamId)
        if (String(fresh.status) === 'closed') return this.streamRecord(fresh)
        const [count] = await q`SELECT count(*) AS n FROM stream_chunks WHERE stream = ${streamId}`
        if (Number(count?.n) !== chunkRows.length) return null
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
      if (result) return result
    }
    throw new Error('stream changed repeatedly during finalization; retry close')
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
