/**
 * The local BuildStore (SPEC §7.2.1): SQLite + blob directory beneath an
 * explicitly resolved local state root. Repository/default selection belongs
 * to the CLI; this adapter only opens the path it is given.
 *
 * Every write goes through `validateEventWrite` (§8 — the enforced ontology).
 * Seq assignment and `appendWithArtifacts` are transactional: bun:sqlite
 * transactions are synchronous, so the atomic path (D6) runs inside one
 * `db.transaction` while blob writes happen *before* it — a rolled-back
 * deposit may orphan a blob, which is harmless because blobs are
 * content-addressed.
 */
import { Database } from 'bun:sqlite'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanActor } from '../../events/envelope'
import {
  validateEventWrite,
  type AbEvent,
  type EventEnvelope,
  type EventWrite,
} from '../../events/catalog'
import type { EventType } from '../../events/payloads'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
  type RepositoryEventEnvelope,
  type RepositoryEventType,
  type RepositoryEventWrite,
} from '../../events/repository'
import {
  validateSessionEventWrite,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionEventType,
  type SessionEventWrite,
} from '../../events/sessions'
import { createBuildScopedStore } from '../build-scope'
import { createSessionScopedStore } from '../session-handle'
import { DIGEST_EVENT_TYPES, reduceBuildDigest } from '../digest'
import {
  DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS,
  isRetentionManagedKind,
  revisionsToPrune,
} from '../retention'
import { pollingSubscribe } from '../subscribe'
import { StreamLocks } from '../streams/lock'
import { assembleUIMessageDocument } from '../streams/assemble'
import { readEventsWithWait, readStreamWithWait } from '../streams/wait'
import {
  serializedBatchSize,
  STREAM_BATCH_MAX_BYTES,
  STREAM_FORMAT,
  StreamBatchTooLargeError,
  StreamClosedError,
  streamArtifactInput,
  validateStreamParts,
  type StreamChunk,
  type StreamOutcome,
  type StreamPart,
  type StreamRead,
  type StreamRecord,
  type StreamScope,
} from '../streams/types'
import {
  contentHash,
  normalizeOperator,
  systemClock,
  toBytes,
  validateExpectedSeq,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildDigest,
  type BuildScopedStore,
  type BuildStore,
  type Clock,
  type NewBuildInput,
  type NewSessionInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
  type SessionArtifact,
  type SessionArtifactMeta,
  type SessionRecord,
  type SessionScopedStore,
  type SubscribeOptions,
  type Unsubscribe,
} from '../types'
import { DirBlobStore } from './blobs'
import {
  artifacts,
  builds,
  events,
  repoArtifacts,
  repoEvents,
  repoStreams,
  sessionArtifacts,
  sessionEvents,
  sessions,
  streamChunks,
  streams,
} from './schema'

/**
 * Bootstrap DDL, applied idempotently at open. MUST match `schema.ts` —
 * the drizzle schema is the source of truth; this is its inlined form so
 * opening a store never needs a migration step.
 */
const BOOTSTRAP_DDL = [
  `CREATE TABLE IF NOT EXISTS builds (
    slug TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    repo_origin TEXT,
    ticket TEXT,
    branch TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lease_holder TEXT,
    lease_expires_at TEXT,
    lease_ttl_ms INTEGER,
    heartbeat_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    build TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (build, seq)
  )`,
  // The build-digest scan (AUT-487): type-leading so the digest query's cost
  // grows with the observation/terminal events themselves, not with total
  // history. Idempotent at open, so pre-existing databases gain it too.
  `CREATE INDEX IF NOT EXISTS events_type_build_seq ON events (type, build, seq)`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    build TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    blob_ref TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (build, kind, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS repo_streams (
    repo TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lease_holder TEXT,
    lease_expires_at TEXT,
    lease_ttl_ms INTEGER,
    heartbeat_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS repo_events (
    repo TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (repo, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS repo_artifacts (
    repo TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    blob_ref TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo, kind, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    operator TEXT NOT NULL,
    title TEXT,
    creation_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_events (
    session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (session, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS session_artifacts (
    session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    blob_ref TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session, kind, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('build','repo','session')),
    build TEXT,
    repo TEXT,
    session TEXT,
    label TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed')),
    outcome TEXT,
    artifact_kind TEXT,
    artifact_revision INTEGER,
    artifact_blob_ref TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    creation_seq INTEGER NOT NULL,
    CHECK (
      (scope_kind = 'build' AND build IS NOT NULL AND repo IS NULL AND session IS NULL)
      OR
      (scope_kind = 'repo' AND build IS NULL AND repo IS NOT NULL AND session IS NULL)
      OR
      (scope_kind = 'session' AND build IS NULL AND repo IS NULL AND session IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS stream_chunks (
    stream TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    parts TEXT NOT NULL,
    PRIMARY KEY (stream, seq)
  )`,
] as const

type BuildRow = typeof builds.$inferSelect
type RepoRow = typeof repoStreams.$inferSelect

interface PreparedArtifact {
  kind: string
  blobRef: string
  metadata: Record<string, unknown>
}

export interface SqliteBuildStoreOptions {
  database: Database
  blobs: BlobStore
  clock?: Clock
  /** Artifact retention (store/retention.ts): how many newest revisions of
   * each retention-managed dispatcher kind survive. Default 200. */
  retention?: { maxRevisions?: number }
}

export class SqliteBuildStore implements BuildStore {
  private readonly sqlite: Database
  private readonly db: BunSQLiteDatabase
  /** Per-stream in-process mutex (store/streams/lock.ts): serializes a
   * stream's close against same-process appends (AUT-348). Cross-connection
   * writers are arbitrated by the commit transaction's chunk re-verification. */
  private readonly streamLocks = new StreamLocks()
  private readonly clock: Clock
  private readonly maxRevisions: number
  readonly blobs: BlobStore

  constructor(opts: SqliteBuildStoreOptions) {
    this.sqlite = opts.database
    this.blobs = opts.blobs
    this.clock = opts.clock ?? systemClock
    this.maxRevisions = opts.retention?.maxRevisions ?? DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS
    // busy_timeout first so even the WAL switch below waits out a concurrent
    // opener instead of failing fast; WAL so connections on the same file see
    // each other's writes (§7.2.1). Cross-process write serialization comes
    // from `writeTx` (BEGIN IMMEDIATE), not from this timeout alone.
    this.sqlite.exec('PRAGMA busy_timeout = 5000')
    this.sqlite.exec('PRAGMA journal_mode = WAL')
    for (const ddl of BOOTSTRAP_DDL) this.sqlite.exec(ddl)
    // Stores created before `repo_origin` existed keep working: add the column
    // idempotently when a pre-existing table lacks it (the bootstrap DDL above
    // covers fresh stores). No migration framework — one guarded ALTER at open.
    const columns = this.sqlite.query("PRAGMA table_info('builds')").all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'repo_origin')) {
      this.sqlite.exec('ALTER TABLE builds ADD COLUMN repo_origin TEXT')
    }
    // Stores created before session-scoped streams existed keep working: add
    // the streams.session column idempotently when a pre-existing table lacks
    // it (the repo_origin precedent). A pre-existing local database also keeps
    // its old `scope_kind` CHECK, so it cannot host session-scoped streams —
    // unreachable in product terms because sessions are hosted-only and
    // nothing local creates one; fresh stores (and every contract-suite
    // database) get the widened DDL above. Rebuilding the table to widen a
    // CHECK would risk local data for an unreachable path and is deliberately
    // not attempted.
    const streamColumns = this.sqlite.query("PRAGMA table_info('streams')").all() as Array<{
      name: string
    }>
    if (!streamColumns.some((column) => column.name === 'session')) {
      this.sqlite.exec('ALTER TABLE streams ADD COLUMN session TEXT')
    }
    // Stores created before the listStreams creation-order tiebreak existed
    // keep working: add the streams.creation_seq column idempotently when a
    // pre-existing table lacks it (the sessions.creation_seq precedent), then
    // backfill by rowid — rowid equals insertion order because streams are
    // never deleted (retention prunes stream_chunks only), so the backfill is
    // consistent with the pinned creation-order contract. Legacy
    // same-millisecond ties are genuinely unorderable; the pinned guarantee
    // applies from the migrated store onward.
    if (!streamColumns.some((column) => column.name === 'creation_seq')) {
      this.sqlite.exec('ALTER TABLE streams ADD COLUMN creation_seq INTEGER NOT NULL DEFAULT 0')
      this.sqlite.exec('UPDATE streams SET creation_seq = rowid')
    }
    // Stores created before the listSessions creation-order tiebreak existed
    // keep working: add the sessions.creation_seq column idempotently when a
    // pre-existing table lacks it (the repo_origin precedent), then backfill
    // by rowid — rowid equals insertion order because sessions are never
    // deleted, so the backfill is consistent with the pinned creation-order
    // contract. Legacy same-millisecond ties are genuinely unorderable; the
    // pinned guarantee applies from the migrated store onward.
    const sessionColumns = this.sqlite.query("PRAGMA table_info('sessions')").all() as Array<{
      name: string
    }>
    if (!sessionColumns.some((column) => column.name === 'creation_seq')) {
      this.sqlite.exec('ALTER TABLE sessions ADD COLUMN creation_seq INTEGER NOT NULL DEFAULT 0')
      this.sqlite.exec('UPDATE sessions SET creation_seq = rowid')
    }
    this.db = drizzle(this.sqlite)
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

  /**
   * Every write runs BEGIN IMMEDIATE. The store is the only coordination
   * surface (§15.2.7 [D2]), so cross-process writers are the norm: the
   * dispatcher, per-build runners, and the agent's `ab` CLI all open this
   * file (§3.3). A deferred transaction opens on a WAL read snapshot; when
   * another process commits first, the read-to-write upgrade fails with
   * SQLITE_BUSY *without consulting the busy handler*, losing the write.
   * Taking the write lock at BEGIN makes contending writers queue on
   * `busy_timeout` instead.
   */
  private writeTx<T>(fn: () => T): T {
    return this.db.transaction(fn, { behavior: 'immediate' })
  }

  private buildRow(slug: string): BuildRow | undefined {
    return this.db.select().from(builds).where(eq(builds.slug, slug)).get()
  }

  private requireBuild(slug: string): BuildRow {
    const row = this.buildRow(slug)
    if (!row) throw new Error(`unknown build "${slug}"`)
    return row
  }

  private repoRow(repo: string): RepoRow | undefined {
    return this.db.select().from(repoStreams).where(eq(repoStreams.repo, repo)).get()
  }

  private requireRepo(repo: string): RepoRow {
    const row = this.repoRow(repo)
    if (!row) throw new Error(`unknown repo "${repo}"`)
    return row
  }

  private toRepoRecord(row: RepoRow): RepositoryRecord {
    return {
      repo: row.repo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
      ...(row.leaseHolder && row.leaseExpiresAt
        ? { lease: { holder: row.leaseHolder, expiresAt: row.leaseExpiresAt } }
        : {}),
    }
  }

  private toRecord(row: BuildRow): BuildRecord {
    return {
      slug: row.slug,
      repo: row.repo,
      ...(row.ticket ? { ticket: row.ticket } : {}),
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.repoOrigin ? { repoOrigin: row.repoOrigin } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
      ...(row.leaseHolder && row.leaseExpiresAt
        ? { lease: { holder: row.leaseHolder, expiresAt: row.leaseExpiresAt } }
        : {}),
    }
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    const ts = this.now()
    return this.writeTx(() => {
      if (this.buildRow(input.slug)) {
        throw new Error(`build "${input.slug}" already exists`)
      }
      this.db
        .insert(builds)
        .values({
          slug: input.slug,
          repo: input.repo,
          repoOrigin: input.repoOrigin ?? null,
          ticket: input.ticket ?? null,
          branch: input.branch ?? null,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      return this.toRecord(this.requireBuild(input.slug))
    })
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    const row = this.buildRow(slug)
    return row ? this.toRecord(row) : null
  }

  async listBuilds(): Promise<BuildRecord[]> {
    const rows = this.db.select().from(builds).orderBy(asc(builds.createdAt)).all()
    return rows.map((row) => this.toRecord(row))
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    // From the builds side (AUT-487): the type filter lives in the ON clause
    // so a build whose log holds none of the three digest-relevant event
    // types still yields its row — a join that starts from `events` would
    // silently drop such builds and break the operation's completeness
    // contract. Only the three types are fetched, then one shared derivation
    // per build, so the answer cannot drift from `reduceBuild`.
    const rows = this.sqlite
      .query(
        `SELECT b.slug AS slug, e.seq AS seq, e.type AS type
         FROM builds b
         LEFT JOIN events e
           ON e.build = b.slug AND e.type IN (${DIGEST_EVENT_TYPES.map(() => '?').join(', ')})
         WHERE b.repo = ?
         ORDER BY b.slug, e.seq`,
      )
      .all(...DIGEST_EVENT_TYPES, repo) as {
      slug: string
      seq: number | null
      type: string | null
    }[]
    const eventsByBuild = new Map<string, Pick<AbEvent, 'type' | 'seq'>[]>()
    for (const row of rows) {
      if (row.seq === null || row.type === null) continue
      const events = eventsByBuild.get(row.slug) ?? []
      events.push({ type: row.type as AbEvent['type'], seq: row.seq })
      eventsByBuild.set(row.slug, events)
    }
    const digests = new Map<string, BuildDigest>()
    for (const row of rows) {
      if (digests.has(row.slug)) continue
      digests.set(row.slug, {
        slug: row.slug,
        ...reduceBuildDigest(eventsByBuild.get(row.slug) ?? []),
      })
    }
    return digests
  }

  /** Current build-stream tail inside an open transaction. */
  private currentSeqInTx(slug: string): number {
    this.requireBuild(slug)
    const row = this.db
      .select({ max: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(eq(events.build, slug))
      .get()
    return row?.max ?? 0
  }

  /**
   * Runs inside an open transaction. bun:sqlite is a single synchronous
   * connection, so statements issued through `this.db` inside a
   * `db.transaction` callback join that transaction.
   */
  private appendInTx(slug: string, validated: EventWrite): EventEnvelope {
    const seq = this.currentSeqInTx(slug) + 1
    const ts = this.now()
    this.db
      .insert(events)
      .values({
        build: slug,
        seq,
        ts,
        actor: validated.actor,
        type: validated.type,
        payload: validated.payload,
      })
      .run()
    this.db.update(builds).set({ updatedAt: ts }).where(eq(builds.slug, slug)).run()
    return {
      build: slug,
      seq,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    }
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const validated = validateEventWrite(event)
    return this.writeTx(() => this.appendInTx(slug, validated)) as EventEnvelope<T>
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateEventWrite(event)
    return this.writeTx(() => {
      // BEGIN IMMEDIATE serializes this comparison and append across every
      // SQLite connection/process using the same store file.
      if (this.currentSeqInTx(slug) !== expectedSeq) return null
      return this.appendInTx(slug, validated) as EventEnvelope<T>
    })
  }

  /** Hash + blob write happen before any transaction (D6). */
  private async prepareArtifact(artifact: ArtifactInput): Promise<PreparedArtifact> {
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    return {
      kind: artifact.kind,
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
    }
  }

  /**
   * Runs inside an open transaction — see `appendInTx`.
   *
   * `prune: false` defers deposit-time retention to the batch caller (the
   * atomic `appendWithArtifacts` path), which prunes once per distinct kind
   * *after* the batch event is validated — see the invariant documented on
   * `appendWithArtifacts`. Single-deposit paths keep the default
   * `prune: true` (deposit and prune in one step; no event is appended, so
   * the validation-before-prune invariant does not apply).
   */
  private depositInTx(
    slug: string,
    prepared: PreparedArtifact,
    opts: { prune?: boolean } = { prune: true },
  ): ArtifactMeta {
    this.requireBuild(slug)
    const createdAt = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${artifacts.revision})` })
      .from(artifacts)
      .where(and(eq(artifacts.build, slug), eq(artifacts.kind, prepared.kind)))
      .get()
    const revision = (row?.max ?? -1) + 1
    this.db
      .insert(artifacts)
      .values({
        build: slug,
        kind: prepared.kind,
        revision,
        blobRef: prepared.blobRef,
        metadata: prepared.metadata,
        createdAt,
      })
      .run()
    if (opts.prune) this.pruneBuildInTx(slug, prepared.kind)
    this.db.update(builds).set({ updatedAt: createdAt }).where(eq(builds.slug, slug)).run()
    return {
      build: slug,
      kind: prepared.kind,
      revision,
      blobRef: prepared.blobRef,
      metadata: prepared.metadata,
      createdAt,
    }
  }

  /**
   * Deposit-time retention (store/retention.ts): inside the same transaction
   * as the deposit, drop revisions past the bound for retention-managed
   * kinds. Revision assignment reads MAX(revision)+1, so pruning never
   * collides with it. Non-family kinds are never touched.
   */
  private pruneBuildInTx(slug: string, kind: string): void {
    if (!isRetentionManagedKind(kind)) return
    const rows = this.db
      .select({ revision: artifacts.revision })
      .from(artifacts)
      .where(and(eq(artifacts.build, slug), eq(artifacts.kind, kind)))
      .all()
    const pruned = revisionsToPrune(
      rows.map((row) => row.revision),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    this.db
      .delete(artifacts)
      .where(
        and(
          eq(artifacts.build, slug),
          eq(artifacts.kind, kind),
          inArray(artifacts.revision, pruned),
        ),
      )
      .run()
  }

  private pruneRepoInTx(repo: string, kind: string): void {
    if (!isRetentionManagedKind(kind)) return
    const rows = this.db
      .select({ revision: repoArtifacts.revision })
      .from(repoArtifacts)
      .where(and(eq(repoArtifacts.repo, repo), eq(repoArtifacts.kind, kind)))
      .all()
    const pruned = revisionsToPrune(
      rows.map((row) => row.revision),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    this.db
      .delete(repoArtifacts)
      .where(
        and(
          eq(repoArtifacts.repo, repo),
          eq(repoArtifacts.kind, kind),
          inArray(repoArtifacts.revision, pruned),
        ),
      )
      .run()
  }

  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifactInputs: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const input of artifactInputs) {
      prepared.push(await this.prepareArtifact(input))
    }
    // One synchronous transaction: deposits + event append commit together;
    // an invalid event throws, rolling back every deposit (D6).
    //
    // Ordering invariant (AUT-322): the batch event is validated BEFORE any
    // retention prune runs. Deposits land unpruned, validation gates the
    // whole batch, and only then does one prune per distinct batch kind
    // execute — still inside this transaction. A same-kind batch whose prune
    // scope covers a sibling therefore never deletes that sibling before the
    // batch's event is validated. Pruning once per kind (not per deposit) is
    // equivalent: `revisionsToPrune` is a pure function of the full
    // post-batch revision set, and pruned revisions are always older than
    // the current MAX, so revision assignment is unaffected.
    return this.writeTx(() => {
      const deposited = prepared.map((p) => this.depositInTx(slug, p, { prune: false }))
      const validated = validateEventWrite(makeEvent(deposited))
      for (const kind of new Set(deposited.map((meta) => meta.kind))) {
        this.pruneBuildInTx(slug, kind)
      }
      const event = this.appendInTx(slug, validated) as EventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getEvents(
    slug: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]> {
    return readEventsWithWait({
      read: async () => {
        this.requireBuild(slug)
        const rows = this.db
          .select()
          .from(events)
          .where(and(eq(events.build, slug), gt(events.seq, sinceSeq)))
          .orderBy(asc(events.seq))
          .all()
        return rows.map(
          (row) =>
            ({
              build: row.build,
              seq: row.seq,
              ts: row.ts,
              actor: row.actor,
              type: row.type,
              payload: row.payload,
            }) as AbEvent,
        )
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
    })
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    const prepared = await this.prepareArtifact(artifact)
    return this.writeTx(() => this.depositInTx(slug, prepared))
  }

  private toMeta(row: typeof artifacts.$inferSelect): ArtifactMeta {
    return {
      build: row.build,
      kind: row.kind,
      revision: row.revision,
      blobRef: row.blobRef,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }
  }

  async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
    this.requireBuild(slug)
    const scoped = and(eq(artifacts.build, slug), eq(artifacts.kind, kind))
    const row =
      rev === undefined
        ? this.db
            .select()
            .from(artifacts)
            .where(scoped)
            .orderBy(desc(artifacts.revision))
            .limit(1)
            .get()
        : this.db
            .select()
            .from(artifacts)
            .where(and(scoped, eq(artifacts.revision, rev)))
            .get()
    if (!row) return null
    const content = await this.blobs.get(row.blobRef)
    if (!content) return null
    return { meta: this.toMeta(row), content }
  }

  async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    this.requireBuild(slug)
    const where = kind
      ? and(eq(artifacts.build, slug), eq(artifacts.kind, kind))
      : eq(artifacts.build, slug)
    const rows = this.db
      .select()
      .from(artifacts)
      .where(where)
      .orderBy(asc(artifacts.kind), asc(artifacts.revision))
      .all()
    return rows.map((row) => this.toMeta(row))
  }

  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireBuild(slug)
      const now = this.clock().getTime()
      const heldByOther =
        row.leaseHolder !== null &&
        row.leaseHolder !== holder &&
        row.leaseExpiresAt !== null &&
        Date.parse(row.leaseExpiresAt) > now
      if (heldByOther) return false
      this.db
        .update(builds)
        .set({
          leaseHolder: holder,
          leaseExpiresAt: new Date(now + ttlMs).toISOString(),
          leaseTtlMs: ttlMs,
          updatedAt: new Date(now).toISOString(),
        })
        .where(eq(builds.slug, slug))
        .run()
      return true
    })
  }

  async heartbeat(slug: string, holder: string): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireBuild(slug)
      const now = this.clock().getTime()
      const holds =
        row.leaseHolder === holder &&
        row.leaseExpiresAt !== null &&
        Date.parse(row.leaseExpiresAt) > now
      if (!holds) return false
      const nowIso = new Date(now).toISOString()
      this.db
        .update(builds)
        .set({
          leaseExpiresAt: new Date(now + (row.leaseTtlMs ?? 0)).toISOString(),
          heartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(builds.slug, slug))
        .run()
      return true
    })
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    this.writeTx(() => {
      const row = this.requireBuild(slug)
      if (row.leaseHolder !== holder) return
      this.db
        .update(builds)
        .set({
          leaseHolder: null,
          leaseExpiresAt: null,
          leaseTtlMs: null,
          updatedAt: this.now(),
        })
        .where(eq(builds.slug, slug))
        .run()
    })
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    if (!repo) throw new Error('repo is required')
    return this.writeTx(() => {
      const existing = this.repoRow(repo)
      if (existing) return this.toRepoRecord(existing)
      const ts = this.now()
      this.db.insert(repoStreams).values({ repo, createdAt: ts, updatedAt: ts }).run()
      return this.toRepoRecord(this.requireRepo(repo))
    })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const row = this.repoRow(repo)
    return row ? this.toRepoRecord(row) : null
  }

  private appendRepoInTx(repo: string, validated: RepositoryEventWrite): RepositoryEventEnvelope {
    this.requireRepo(repo)
    const ts = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${repoEvents.seq})` })
      .from(repoEvents)
      .where(eq(repoEvents.repo, repo))
      .get()
    const seq = (row?.max ?? 0) + 1
    this.db
      .insert(repoEvents)
      .values({
        repo,
        seq,
        ts,
        actor: validated.actor,
        type: validated.type,
        payload: validated.payload,
      })
      .run()
    this.db.update(repoStreams).set({ updatedAt: ts }).where(eq(repoStreams.repo, repo)).run()
    return {
      repo,
      seq,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    }
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const validated = validateRepositoryEventWrite(event)
    return this.writeTx(() => this.appendRepoInTx(repo, validated)) as RepositoryEventEnvelope<T>
  }

  /** See `depositInTx` for the `prune` option's meaning. */
  private depositRepoInTx(
    repo: string,
    prepared: PreparedArtifact,
    opts: { prune?: boolean } = { prune: true },
  ): RepositoryArtifactMeta {
    this.requireRepo(repo)
    const createdAt = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${repoArtifacts.revision})` })
      .from(repoArtifacts)
      .where(and(eq(repoArtifacts.repo, repo), eq(repoArtifacts.kind, prepared.kind)))
      .get()
    const revision = (row?.max ?? -1) + 1
    this.db
      .insert(repoArtifacts)
      .values({
        repo,
        kind: prepared.kind,
        revision,
        blobRef: prepared.blobRef,
        metadata: prepared.metadata,
        createdAt,
      })
      .run()
    if (opts.prune) this.pruneRepoInTx(repo, prepared.kind)
    this.db
      .update(repoStreams)
      .set({ updatedAt: createdAt })
      .where(eq(repoStreams.repo, repo))
      .run()
    return {
      repo,
      kind: prepared.kind,
      revision,
      blobRef: prepared.blobRef,
      metadata: prepared.metadata,
      createdAt,
    }
  }

  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifactInputs: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{
    event: RepositoryEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }> {
    const prepared: PreparedArtifact[] = []
    for (const input of artifactInputs) {
      prepared.push(await this.prepareArtifact(input))
    }
    // Ordering invariant (AUT-322): same shape as `appendWithArtifacts` —
    // deposit unpruned, validate the batch event, then prune once per
    // distinct batch kind, all inside this transaction. Validation
    // provably precedes any retention deletion.
    return this.writeTx(() => {
      const deposited = prepared.map((item) => this.depositRepoInTx(repo, item, { prune: false }))
      const validated = validateRepositoryEventWrite(makeEvent(deposited))
      for (const kind of new Set(deposited.map((meta) => meta.kind))) {
        this.pruneRepoInTx(repo, kind)
      }
      const event = this.appendRepoInTx(repo, validated) as RepositoryEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getRepoEvents(
    repo: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]> {
    return readEventsWithWait({
      read: async () => {
        this.requireRepo(repo)
        const rows = this.db
          .select()
          .from(repoEvents)
          .where(and(eq(repoEvents.repo, repo), gt(repoEvents.seq, sinceSeq)))
          .orderBy(asc(repoEvents.seq))
          .all()
        return rows.map(
          (row) =>
            ({
              repo: row.repo,
              seq: row.seq,
              ts: row.ts,
              actor: row.actor,
              type: row.type,
              payload: row.payload,
            }) as RepositoryEvent,
        )
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
    })
  }

  async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    const prepared = await this.prepareArtifact(artifact)
    return this.writeTx(() => this.depositRepoInTx(repo, prepared))
  }

  private toRepoMeta(row: typeof repoArtifacts.$inferSelect): RepositoryArtifactMeta {
    return {
      repo: row.repo,
      kind: row.kind,
      revision: row.revision,
      blobRef: row.blobRef,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }
  }

  async getRepoArtifact(
    repo: string,
    kind: string,
    rev?: number,
  ): Promise<RepositoryArtifact | null> {
    this.requireRepo(repo)
    const scoped = and(eq(repoArtifacts.repo, repo), eq(repoArtifacts.kind, kind))
    const row =
      rev === undefined
        ? this.db
            .select()
            .from(repoArtifacts)
            .where(scoped)
            .orderBy(desc(repoArtifacts.revision))
            .limit(1)
            .get()
        : this.db
            .select()
            .from(repoArtifacts)
            .where(and(scoped, eq(repoArtifacts.revision, rev)))
            .get()
    if (!row) return null
    const content = await this.blobs.get(row.blobRef)
    return content ? { meta: this.toRepoMeta(row), content } : null
  }

  async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    this.requireRepo(repo)
    const where = kind
      ? and(eq(repoArtifacts.repo, repo), eq(repoArtifacts.kind, kind))
      : eq(repoArtifacts.repo, repo)
    return this.db
      .select()
      .from(repoArtifacts)
      .where(where)
      .orderBy(asc(repoArtifacts.kind), asc(repoArtifacts.revision))
      .all()
      .map((row) => this.toRepoMeta(row))
  }

  async claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireRepo(repo)
      const now = this.clock().getTime()
      const heldByOther =
        row.leaseHolder !== null &&
        row.leaseHolder !== holder &&
        row.leaseExpiresAt !== null &&
        Date.parse(row.leaseExpiresAt) > now
      if (heldByOther) return false
      this.db
        .update(repoStreams)
        .set({
          leaseHolder: holder,
          leaseExpiresAt: new Date(now + ttlMs).toISOString(),
          leaseTtlMs: ttlMs,
          updatedAt: new Date(now).toISOString(),
        })
        .where(eq(repoStreams.repo, repo))
        .run()
      return true
    })
  }

  async heartbeatRepo(repo: string, holder: string): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireRepo(repo)
      const now = this.clock().getTime()
      const holds =
        row.leaseHolder === holder &&
        row.leaseExpiresAt !== null &&
        Date.parse(row.leaseExpiresAt) > now
      if (!holds) return false
      const nowIso = new Date(now).toISOString()
      this.db
        .update(repoStreams)
        .set({
          leaseExpiresAt: new Date(now + (row.leaseTtlMs ?? 0)).toISOString(),
          heartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(repoStreams.repo, repo))
        .run()
      return true
    })
  }

  async releaseRepoLease(repo: string, holder: string): Promise<void> {
    this.writeTx(() => {
      const row = this.requireRepo(repo)
      if (row.leaseHolder !== holder) return
      this.db
        .update(repoStreams)
        .set({
          leaseHolder: null,
          leaseExpiresAt: null,
          leaseTtlMs: null,
          updatedAt: this.now(),
        })
        .where(eq(repoStreams.repo, repo))
        .run()
    })
  }

  // ── Operator sessions (SPEC §7.1.1 — a third resource kind) ─────────

  private sessionRow(id: string): typeof sessions.$inferSelect | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get()
  }

  private requireSession(id: string): typeof sessions.$inferSelect {
    const row = this.sessionRow(id)
    if (!row) throw new Error(`unknown session "${id}"`)
    return row
  }

  private toSessionRecord(row: typeof sessions.$inferSelect): SessionRecord {
    return {
      id: row.id,
      repo: row.repo,
      operator: row.operator,
      ...(row.title !== null ? { title: row.title } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  /** Runs inside an open transaction — see `appendInTx`. */
  private appendSessionInTx(id: string, validated: SessionEventWrite): SessionEventEnvelope {
    this.requireSession(id)
    const ts = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${sessionEvents.seq})` })
      .from(sessionEvents)
      .where(eq(sessionEvents.session, id))
      .get()
    const seq = (row?.max ?? 0) + 1
    this.db
      .insert(sessionEvents)
      .values({
        session: id,
        seq,
        ts,
        actor: validated.actor,
        type: validated.type,
        payload: validated.payload,
      })
      .run()
    this.db.update(sessions).set({ updatedAt: ts }).where(eq(sessions.id, id)).run()
    return {
      session: id,
      seq,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    }
  }

  async createSession(input: NewSessionInput): Promise<SessionRecord> {
    const operator = normalizeOperator(input.operator)
    if (!input.repo) throw new Error('repo is required')
    const ts = this.now()
    const id = `os_${crypto.randomUUID()}`
    // The record and its first fact land together: `session.created` (seq 1,
    // actor the operator) commits in the same transaction as the insert —
    // there is no state where a session exists without its creation fact (D6).
    const validated = validateSessionEventWrite({
      actor: humanActor(operator),
      type: 'session.created',
      payload: input.title !== undefined ? { title: input.title } : {},
    })
    return this.writeTx(() => {
      // Store-assigned monotonic creation sequence: MAX+1 inside the write
      // transaction (every write runs BEGIN IMMEDIATE, so writers are
      // serialized) — the same pattern as the seq assignments in this file.
      // Sessions are never deleted, so the counter is never reused and the
      // listSessions same-millisecond tiebreak is stable over time.
      const tail = this.db
        .select({ max: sql<number | null>`max(${sessions.creationSeq})` })
        .from(sessions)
        .get()
      const creationSeq = (tail?.max ?? 0) + 1
      this.db
        .insert(sessions)
        .values({
          id,
          repo: input.repo,
          operator,
          title: input.title ?? null,
          creationSeq,
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      this.db
        .insert(sessionEvents)
        .values({
          session: id,
          seq: 1,
          ts,
          actor: validated.actor,
          type: validated.type,
          payload: validated.payload,
        })
        .run()
      return this.toSessionRecord(this.requireSession(id))
    })
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.sessionRow(id)
    return row ? this.toSessionRecord(row) : null
  }

  async listSessions(repo: string): Promise<SessionRecord[]> {
    // Pinned tiebreak (store/types.ts): createdAt ascending, then the
    // store-assigned monotonic creation sequence — never the random id.
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.repo, repo))
      .orderBy(asc(sessions.createdAt), asc(sessions.creationSeq))
      .all()
      .map((row) => this.toSessionRecord(row))
  }

  async appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>> {
    const validated = validateSessionEventWrite(event)
    return this.writeTx(() => this.appendSessionInTx(id, validated) as SessionEventEnvelope<T>)
  }

  async getSessionEvents(
    id: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]> {
    const read = async (): Promise<SessionEvent[]> => {
      this.requireSession(id)
      const rows = this.db
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.session, id), gt(sessionEvents.seq, sinceSeq)))
        .orderBy(asc(sessionEvents.seq))
        .all()
      return rows.map(
        (row) =>
          ({
            session: row.session,
            seq: row.seq,
            ts: row.ts,
            actor: row.actor,
            type: row.type,
            payload: row.payload,
          }) as SessionEvent,
      )
    }
    return readEventsWithWait({ read, waitSeconds: opts?.waitSeconds, signal: opts?.signal })
  }

  /** Runs inside an open transaction — see `depositInTx` for `prune`. */
  private depositSessionInTx(id: string, prepared: PreparedArtifact): SessionArtifactMeta {
    this.requireSession(id)
    const createdAt = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${sessionArtifacts.revision})` })
      .from(sessionArtifacts)
      .where(and(eq(sessionArtifacts.session, id), eq(sessionArtifacts.kind, prepared.kind)))
      .get()
    const revision = (row?.max ?? -1) + 1
    this.db
      .insert(sessionArtifacts)
      .values({
        session: id,
        kind: prepared.kind,
        revision,
        blobRef: prepared.blobRef,
        metadata: prepared.metadata,
        createdAt,
      })
      .run()
    this.db.update(sessions).set({ updatedAt: createdAt }).where(eq(sessions.id, id)).run()
    return {
      session: id,
      kind: prepared.kind,
      revision,
      blobRef: prepared.blobRef,
      metadata: prepared.metadata,
      createdAt,
    }
  }

  async appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifactInputs: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const input of artifactInputs) {
      prepared.push(await this.prepareArtifact(input))
    }
    // One synchronous transaction: deposits + event append commit together;
    // an invalid event throws, rolling back every deposit (D6). Session
    // artifacts are not retention-managed, so the AUT-322 ordering invariant
    // holds trivially — validation still precedes every deposit commit.
    return this.writeTx(() => {
      const deposited = prepared.map((p) => this.depositSessionInTx(id, p))
      const validated = validateSessionEventWrite(makeEvent(deposited))
      const event = this.appendSessionInTx(id, validated) as SessionEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
    const prepared = await this.prepareArtifact(artifact)
    return this.writeTx(() => this.depositSessionInTx(id, prepared))
  }

  private toSessionMeta(row: typeof sessionArtifacts.$inferSelect): SessionArtifactMeta {
    return {
      session: row.session,
      kind: row.kind,
      revision: row.revision,
      blobRef: row.blobRef,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }
  }

  async getSessionArtifact(
    id: string,
    kind: string,
    rev?: number,
  ): Promise<SessionArtifact | null> {
    this.requireSession(id)
    const scoped = and(eq(sessionArtifacts.session, id), eq(sessionArtifacts.kind, kind))
    const row =
      rev === undefined
        ? this.db
            .select()
            .from(sessionArtifacts)
            .where(scoped)
            .orderBy(desc(sessionArtifacts.revision))
            .limit(1)
            .get()
        : this.db
            .select()
            .from(sessionArtifacts)
            .where(and(scoped, eq(sessionArtifacts.revision, rev)))
            .get()
    if (!row) return null
    const content = await this.blobs.get(row.blobRef)
    return content ? { meta: this.toSessionMeta(row), content } : null
  }

  async listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
    this.requireSession(id)
    const where = kind
      ? and(eq(sessionArtifacts.session, id), eq(sessionArtifacts.kind, kind))
      : eq(sessionArtifacts.session, id)
    return this.db
      .select()
      .from(sessionArtifacts)
      .where(where)
      .orderBy(asc(sessionArtifacts.kind), asc(sessionArtifacts.revision))
      .all()
      .map((row) => this.toSessionMeta(row))
  }

  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  // ── Streams (SPEC §7.6 — the third primitive) ───────────────────────────

  private streamRow(id: string): typeof streams.$inferSelect | undefined {
    return this.db.select().from(streams).where(eq(streams.id, id)).get()
  }

  private requireStream(id: string): typeof streams.$inferSelect {
    const row = this.streamRow(id)
    if (!row) throw new Error(`unknown stream "${id}"`)
    return row
  }

  private streamScopeOf(row: typeof streams.$inferSelect): StreamScope {
    if (row.scopeKind === 'build' && row.build !== null) return { kind: 'build', build: row.build }
    if (row.scopeKind === 'repo' && row.repo !== null) return { kind: 'repo', repo: row.repo }
    if (row.scopeKind === 'session' && row.session !== null) {
      return { kind: 'session', session: row.session }
    }
    throw new Error(`stream "${row.id}" has an unreadable scope`)
  }

  private toStreamRecord(row: typeof streams.$inferSelect): StreamRecord {
    const record: StreamRecord = {
      id: row.id,
      scope: this.streamScopeOf(row),
      label: row.label,
      format: row.format as StreamRecord['format'],
      status: row.status as StreamRecord['status'],
      createdAt: row.createdAt,
      ...(row.closedAt ? { closedAt: row.closedAt } : {}),
      ...(row.outcome ? { outcome: row.outcome as StreamRecord['outcome'] } : {}),
      ...(row.artifactKind && row.artifactRevision !== null && row.artifactBlobRef
        ? {
            artifact: {
              kind: row.artifactKind,
              revision: row.artifactRevision,
              blobRef: row.artifactBlobRef,
            },
          }
        : {}),
    }
    return record
  }

  /** Runs inside an open transaction — see `appendInTx`. The retention rule
   * (deposit-path, count-based like artifact retention): keep every closed
   * stream's chunks except the most recently closed one in this scope,
   * ordering by closedAt with an id tie-break. Records, finalized artifacts,
   * and open streams are never touched. */
  private pruneStreamChunksInTx(scope: StreamScope): void {
    const owner =
      scope.kind === 'build' ? scope.build : scope.kind === 'repo' ? scope.repo : scope.session
    const closed = this.db
      .select()
      .from(streams)
      .where(and(eq(streams.status, 'closed'), eq(streams.scopeKind, scope.kind)))
      .all()
      .filter((row) =>
        scope.kind === 'build'
          ? row.build === owner
          : scope.kind === 'repo'
            ? row.repo === owner
            : row.session === owner,
      )
      .sort(
        (a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? '') || a.id.localeCompare(b.id),
      )
    for (const row of closed.slice(0, -1)) {
      this.db.delete(streamChunks).where(eq(streamChunks.stream, row.id)).run()
    }
  }

  async createStream(scope: StreamScope, label: string): Promise<StreamRecord> {
    if (!label) throw new Error('stream label is required')
    if (scope.kind === 'build') this.requireBuild(scope.build)
    else if (scope.kind === 'repo') this.requireRepo(scope.repo)
    else this.requireSession(scope.session)
    const id = `st_${crypto.randomUUID()}`
    return this.writeTx(() => {
      // Retention prune and the insert land in one transaction.
      this.pruneStreamChunksInTx(scope)
      // Store-assigned monotonic creation sequence: MAX+1 inside the write
      // transaction (every write runs BEGIN IMMEDIATE, so writers are
      // serialized) — the same pattern as the seq assignments in this file.
      // Streams are never deleted (retention prunes stream_chunks only), so
      // the counter is never reused and the listStreams same-millisecond
      // tiebreak is stable over time.
      const tail = this.db
        .select({ max: sql<number | null>`max(${streams.creationSeq})` })
        .from(streams)
        .get()
      const creationSeq = (tail?.max ?? 0) + 1
      this.db
        .insert(streams)
        .values({
          id,
          scopeKind: scope.kind,
          build: scope.kind === 'build' ? scope.build : null,
          repo: scope.kind === 'repo' ? scope.repo : null,
          session: scope.kind === 'session' ? scope.session : null,
          label,
          format: STREAM_FORMAT,
          status: 'open',
          createdAt: this.now(),
          creationSeq,
        })
        .run()
      return this.toStreamRecord(this.requireStream(id))
    })
  }

  async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
    // Validate and size-check before taking the per-stream lock, so invalid
    // input keeps its current error precedence (AUT-348).
    validateStreamParts(parts)
    const bytes = serializedBatchSize(parts)
    if (bytes > STREAM_BATCH_MAX_BYTES) throw new StreamBatchTooLargeError(bytes)
    // The per-stream lock covers the closed check and the transaction as one
    // critical section: an append issued during a same-process close waits
    // for the close to commit, then fails the status check with an explicit
    // StreamClosedError instead of being silently omitted from the artifact.
    return this.streamLocks.run(streamId, () =>
      this.writeTx(() => {
        const row = this.requireStream(streamId)
        if (row.status === 'closed') throw new StreamClosedError(streamId)
        const tails = this.db
          .select({ max: sql<number | null>`max(${streamChunks.seq})` })
          .from(streamChunks)
          .where(eq(streamChunks.stream, streamId))
          .get()
        const chunk: StreamChunk = {
          stream: streamId,
          seq: (tails?.max ?? 0) + 1,
          ts: this.now(),
          parts: structuredClone(parts),
        }
        this.db
          .insert(streamChunks)
          .values({ stream: streamId, seq: chunk.seq, ts: chunk.ts, parts: chunk.parts })
          .run()
        return chunk
      }),
    )
  }

  async readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead> {
    const read = async (): Promise<StreamRead> => {
      const row = this.requireStream(streamId)
      const chunks = this.db
        .select()
        .from(streamChunks)
        .where(and(eq(streamChunks.stream, streamId), gt(streamChunks.seq, opts?.since ?? 0)))
        .orderBy(asc(streamChunks.seq))
        .all()
      const record = this.toStreamRecord(row)
      return {
        chunks: chunks.map((chunk) => ({
          stream: chunk.stream,
          seq: chunk.seq,
          ts: chunk.ts,
          parts: chunk.parts,
        })),
        status: record.status,
        ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
        ...(record.artifact !== undefined ? { artifact: record.artifact } : {}),
      }
    }
    return readStreamWithWait({ read, waitSeconds: opts?.waitSeconds, signal: opts?.signal })
  }

  async closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
    // The per-stream mutex holds across the entire prepare→commit loop
    // (AUT-348): a same-process append issued during this close waits for it
    // to finish and then rejects on the closed check with StreamClosedError.
    // Cross-connection appends (a second instance on the same file) are
    // invisible to the mutex, so the commit transaction re-verifies the
    // chunk tail and a mismatch retries the whole loop from a newer snapshot.
    return this.streamLocks.run(streamId, async () => {
      for (;;) {
        const row = this.requireStream(streamId)
        if (row.status === 'closed') return this.toStreamRecord(row)
        // Prepare phase — assemble and store the blob before the transaction
        // (D6 shape: content-addressed orphan blobs are harmless; a deposit
        // failure leaves the stream open and unwritten).
        const chunkRows = this.db
          .select()
          .from(streamChunks)
          .where(eq(streamChunks.stream, streamId))
          .orderBy(asc(streamChunks.seq))
          .all()
        const { document, droppedPartCount } = await assembleUIMessageDocument(
          chunkRows.flatMap((chunk) => chunk.parts),
        )
        const scope = this.streamScopeOf(row)
        const input = streamArtifactInput(
          row.id,
          scope,
          row.label,
          outcome,
          document,
          chunkRows.length,
          droppedPartCount,
        )
        const prepared: PreparedArtifact = {
          kind: input.kind,
          blobRef: contentHash(toBytes(input.content)),
          metadata: structuredClone(input.metadata),
        }
        await this.blobs.put(prepared.blobRef, toBytes(input.content))
        // Commit phase — one synchronous transaction: the artifact deposit
        // and the close land together or not at all. A close that raced us
        // through the prepare phase wins; ours re-reads and returns its
        // record. The chunk tail is re-read under the same write lock:
        // chunk seqs are gapless 1..n (assigned as MAX+1, and retention
        // never deletes the closing stream's chunks), so a MAX other than
        // the prepared length means a foreign appender landed inside the
        // prepare window.
        const committed = this.writeTx(
          (): { stale: true } | { stale: false; record: StreamRecord } => {
            const fresh = this.requireStream(streamId)
            if (fresh.status === 'closed')
              return { stale: false, record: this.toStreamRecord(fresh) }
            const tail = this.db
              .select({ max: sql<number | null>`max(${streamChunks.seq})` })
              .from(streamChunks)
              .where(eq(streamChunks.stream, streamId))
              .get()
            if ((tail?.max ?? 0) !== chunkRows.length) return { stale: true }
            const meta =
              scope.kind === 'build'
                ? this.depositInTx(scope.build, prepared)
                : scope.kind === 'repo'
                  ? this.depositRepoInTx(scope.repo, prepared)
                  : this.depositSessionInTx(scope.session, prepared)
            this.db
              .update(streams)
              .set({
                status: 'closed',
                outcome,
                closedAt: meta.createdAt,
                artifactKind: meta.kind,
                artifactRevision: meta.revision,
                artifactBlobRef: meta.blobRef,
              })
              .where(eq(streams.id, streamId))
              .run()
            return { stale: false, record: this.toStreamRecord(this.requireStream(streamId)) }
          },
        )
        if (!committed.stale) return committed.record
        // A foreign appender landed inside the prepare window; loop and
        // re-prepare from the newer chunk set so its acknowledged chunk is
        // not omitted from the finalized artifact.
      }
    })
  }

  async getStream(streamId: string): Promise<StreamRecord | null> {
    const row = this.streamRow(streamId)
    return row ? this.toStreamRecord(row) : null
  }

  async listStreams(scope: StreamScope): Promise<StreamRecord[]> {
    const owner =
      scope.kind === 'build' ? scope.build : scope.kind === 'repo' ? scope.repo : scope.session
    // Pinned tiebreak (store/types.ts): createdAt ascending, then the
    // store-assigned monotonic creation sequence — never the random id.
    const rows = this.db
      .select()
      .from(streams)
      .where(eq(streams.scopeKind, scope.kind))
      .orderBy(asc(streams.createdAt), asc(streams.creationSeq))
      .all()
      .filter((row) =>
        scope.kind === 'build'
          ? row.scopeKind === 'build' && row.build === owner
          : scope.kind === 'repo'
            ? row.scopeKind === 'repo' && row.repo === owner
            : row.scopeKind === 'session' && row.session === owner,
      )
    return rows.map((row) => this.toStreamRecord(row))
  }

  async close(): Promise<void> {
    this.sqlite.close()
  }
}

export type LocalStoreInspection =
  | { status: 'absent'; databasePath: string }
  | { status: 'present'; databasePath: string; buildCount: number }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Inspect a repository-local Store without asking SQLite to open its source
 * files. Bun can create WAL/SHM files even for a read-only connection, so the
 * database and any live sidecars are copied to a disposable directory first.
 */
export async function inspectLocalStoreSnapshot(rootDir: string): Promise<LocalStoreInspection> {
  const databasePath = join(rootDir, 'autobuild.sqlite')
  try {
    await access(databasePath)
  } catch (error) {
    if (isMissing(error)) return { status: 'absent', databasePath }
    throw error
  }

  const snapshotRoot = await mkdtemp(join(tmpdir(), 'ab-store-inspection-'))
  const snapshotPath = join(snapshotRoot, 'autobuild.sqlite')
  let database: Database | undefined
  let result: LocalStoreInspection | undefined
  let failure: unknown
  const cleanupFailures: unknown[] = []
  try {
    await copyFile(databasePath, snapshotPath)
    for (const suffix of ['-wal', '-shm']) {
      try {
        await copyFile(`${databasePath}${suffix}`, `${snapshotPath}${suffix}`)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    database = new Database(snapshotPath, { readonly: true })
    const row = database.query('SELECT count(*) AS count FROM builds').get() as {
      count: number
    } | null
    if (row === null) throw new Error('local Store builds count returned no row')
    result = { status: 'present', databasePath, buildCount: row.count }
  } catch (error) {
    failure = error
  } finally {
    try {
      database?.close()
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      await rm(snapshotRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupFailures.push(error)
    }
  }

  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures],
      'local Store snapshot inspection and cleanup both failed',
    )
  }
  if (failure !== undefined) throw failure
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, 'local Store snapshot cleanup failed')
  if (result === undefined) throw new Error('local Store snapshot inspection produced no result')
  return result
}

/**
 * Open the local store (SPEC §7.2.1): `<root>/autobuild.sqlite` plus a
 * content-addressed blob directory at `<root>/blobs`.
 */
export function openLocalStore(
  rootDir: string,
  opts: { clock?: Clock; retention?: { maxRevisions?: number } } = {},
): SqliteBuildStore {
  mkdirSync(rootDir, { recursive: true })
  const database = new Database(join(rootDir, 'autobuild.sqlite'), { create: true })
  const blobs = new DirBlobStore(join(rootDir, 'blobs'))
  return new SqliteBuildStore({
    database,
    blobs,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.retention ? { retention: opts.retention } : {}),
  })
}
