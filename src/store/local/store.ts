/**
 * The local BuildStore (SPEC §7.2.1): SQLite + blob directory under
 * `~/.autobuild/`. Zero setup, offline, v1-parity for solo use — the repo
 * never sees build metadata.
 *
 * Every write goes through `validateEventWrite` (§8 — the enforced ontology).
 * Seq assignment and `appendWithArtifacts` are transactional: bun:sqlite
 * transactions are synchronous, so the atomic path (D6) runs inside one
 * `db.transaction` while blob writes happen *before* it — a rolled-back
 * deposit may orphan a blob, which is harmless because blobs are
 * content-addressed.
 */
import { Database } from 'bun:sqlite'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  validateEventWrite,
  type AbEvent,
  type EventEnvelope,
  type EventWrite,
} from '../../events/catalog'
import type { EventType } from '../../events/payloads'
import {
  validateHarvestEventWrite,
  type HarvestEvent,
  type HarvestEventEnvelope,
  type HarvestEventType,
  type HarvestEventWrite,
} from '../../events/harvest'
import { pollingSubscribe } from '../subscribe'
import {
  contentHash,
  systemClock,
  toBytes,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildStore,
  type Clock,
  type NewBuildInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
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
}

export class SqliteBuildStore implements BuildStore {
  private readonly sqlite: Database
  private readonly db: BunSQLiteDatabase
  private readonly clock: Clock
  readonly blobs: BlobStore

  constructor(opts: SqliteBuildStoreOptions) {
    this.sqlite = opts.database
    this.blobs = opts.blobs
    this.clock = opts.clock ?? systemClock
    // busy_timeout first so even the WAL switch below waits out a concurrent
    // opener instead of failing fast; WAL so connections on the same file see
    // each other's writes (§7.2.1). Cross-process write serialization comes
    // from `writeTx` (BEGIN IMMEDIATE), not from this timeout alone.
    this.sqlite.exec('PRAGMA busy_timeout = 5000')
    this.sqlite.exec('PRAGMA journal_mode = WAL')
    for (const ddl of BOOTSTRAP_DDL) this.sqlite.exec(ddl)
    this.db = drizzle(this.sqlite)
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
    return this.db
      .select()
      .from(repoStreams)
      .where(eq(repoStreams.repo, repo))
      .get()
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

  /**
   * Runs inside an open transaction. bun:sqlite is a single synchronous
   * connection, so statements issued through `this.db` inside a
   * `db.transaction` callback join that transaction.
   */
  private appendInTx(slug: string, validated: EventWrite): EventEnvelope {
    this.requireBuild(slug)
    const ts = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(eq(events.build, slug))
      .get()
    const seq = (row?.max ?? 0) + 1
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

  async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
    const validated = validateEventWrite(event)
    return this.writeTx(() => this.appendInTx(slug, validated)) as EventEnvelope<T>
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

  /** Runs inside an open transaction — see `appendInTx`. */
  private depositInTx(slug: string, prepared: PreparedArtifact): ArtifactMeta {
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
    this.db
      .update(builds)
      .set({ updatedAt: createdAt })
      .where(eq(builds.slug, slug))
      .run()
    return {
      build: slug,
      kind: prepared.kind,
      revision,
      blobRef: prepared.blobRef,
      metadata: prepared.metadata,
      createdAt,
    }
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
    return this.writeTx(() => {
      const deposited = prepared.map((p) => this.depositInTx(slug, p))
      const validated = validateEventWrite(makeEvent(deposited))
      const event = this.appendInTx(slug, validated) as EventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getEvents(slug: string, sinceSeq = 0): Promise<AbEvent[]> {
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

  async getArtifact(
    slug: string,
    kind: string,
    rev?: number,
  ): Promise<Artifact | null> {
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
      this.db
        .insert(repoStreams)
        .values({ repo, createdAt: ts, updatedAt: ts })
        .run()
      return this.toRepoRecord(this.requireRepo(repo))
    })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const row = this.repoRow(repo)
    return row ? this.toRepoRecord(row) : null
  }

  private appendRepoInTx(
    repo: string,
    validated: HarvestEventWrite,
  ): HarvestEventEnvelope {
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
    this.db
      .update(repoStreams)
      .set({ updatedAt: ts })
      .where(eq(repoStreams.repo, repo))
      .run()
    return {
      repo,
      seq,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    }
  }

  async appendRepo<T extends HarvestEventType>(
    repo: string,
    event: HarvestEventWrite<T>,
  ): Promise<HarvestEventEnvelope<T>> {
    const validated = validateHarvestEventWrite(event)
    return this.writeTx(
      () => this.appendRepoInTx(repo, validated),
    ) as HarvestEventEnvelope<T>
  }

  private depositRepoInTx(
    repo: string,
    prepared: PreparedArtifact,
  ): RepositoryArtifactMeta {
    this.requireRepo(repo)
    const createdAt = this.now()
    const row = this.db
      .select({ max: sql<number | null>`max(${repoArtifacts.revision})` })
      .from(repoArtifacts)
      .where(
        and(
          eq(repoArtifacts.repo, repo),
          eq(repoArtifacts.kind, prepared.kind),
        ),
      )
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

  async appendRepoWithArtifacts<T extends HarvestEventType>(
    repo: string,
    artifactInputs: ArtifactInput[],
    makeEvent: (
      deposited: RepositoryArtifactMeta[],
    ) => HarvestEventWrite<T>,
  ): Promise<{
    event: HarvestEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }> {
    const prepared: PreparedArtifact[] = []
    for (const input of artifactInputs) {
      prepared.push(await this.prepareArtifact(input))
    }
    return this.writeTx(() => {
      const deposited = prepared.map((item) =>
        this.depositRepoInTx(repo, item),
      )
      const validated = validateHarvestEventWrite(makeEvent(deposited))
      const event = this.appendRepoInTx(
        repo,
        validated,
      ) as HarvestEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getRepoEvents(repo: string, sinceSeq = 0): Promise<HarvestEvent[]> {
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
        }) as HarvestEvent,
    )
  }

  async putRepoArtifact(
    repo: string,
    artifact: ArtifactInput,
  ): Promise<RepositoryArtifactMeta> {
    const prepared = await this.prepareArtifact(artifact)
    return this.writeTx(() => this.depositRepoInTx(repo, prepared))
  }

  private toRepoMeta(
    row: typeof repoArtifacts.$inferSelect,
  ): RepositoryArtifactMeta {
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
    const scoped = and(
      eq(repoArtifacts.repo, repo),
      eq(repoArtifacts.kind, kind),
    )
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

  async listRepoArtifacts(
    repo: string,
    kind?: string,
  ): Promise<RepositoryArtifactMeta[]> {
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

  async claimRepoLease(
    repo: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
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

  subscribe(
    slug: string,
    opts: SubscribeOptions,
    onEvent: (event: AbEvent) => void,
  ): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  async close(): Promise<void> {
    this.sqlite.close()
  }
}

export const DEFAULT_LOCAL_ROOT = join(homedir(), '.autobuild')

/**
 * Open the local store (SPEC §7.2.1): `<root>/autobuild.sqlite` plus a
 * content-addressed blob dir at `<root>/blobs`, defaulting to `~/.autobuild/`.
 */
export function openLocalStore(
  rootDir: string = DEFAULT_LOCAL_ROOT,
  opts: { clock?: Clock } = {},
): SqliteBuildStore {
  mkdirSync(rootDir, { recursive: true })
  const database = new Database(join(rootDir, 'autobuild.sqlite'), { create: true })
  const blobs = new DirBlobStore(join(rootDir, 'blobs'))
  return new SqliteBuildStore({
    database,
    blobs,
    ...(opts.clock ? { clock: opts.clock } : {}),
  })
}
