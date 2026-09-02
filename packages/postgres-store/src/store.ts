import { SQL } from 'bun'
import {
  contentHash,
  createBuildScopedStore,
  pollingSubscribe,
  systemClock,
  toBytes,
  validateEventWrite,
  validateExpectedSeq,
  validateRepositoryEventWrite,
  type AbEvent,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildScopedStore,
  type BuildStore,
  type Clock,
  type EventEnvelope,
  type EventType,
  type EventWrite,
  type NewBuildInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryEvent,
  type RepositoryEventEnvelope,
  type RepositoryEventType,
  type RepositoryEventWrite,
  type RepositoryRecord,
  type SubscribeOptions,
  type Unsubscribe,
} from 'autobuild/plugin-sdk'
import { assertSchema } from './schema'

type Row = Record<string, unknown>
type Tx = SQL
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
}

export class PostgresBuildStore implements BuildStore {
  readonly blobs: BlobStore
  private readonly clock: Clock

  constructor(
    private readonly sql: SQL,
    options: Omit<PostgresBuildStoreOptions, 'sql'>,
  ) {
    this.blobs = options.blobs
    this.clock = options.clock ?? systemClock
  }

  scopeBuild(slug: string): BuildScopedStore {
    return createBuildScopedStore(this, slug)
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

  private async lockBuild(tx: Tx, slug: string): Promise<Row> {
    const rows: Row[] = await tx`SELECT * FROM builds WHERE slug = ${slug} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown build "${slug}"`)
    return row
  }

  private async lockRepo(tx: Tx, repo: string): Promise<Row> {
    const rows: Row[] = await tx`SELECT * FROM repo_streams WHERE repo = ${repo} FOR UPDATE`
    const row = rows[0]
    if (!row) throw new Error(`unknown repo "${repo}"`)
    return row
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    const ts = this.now()
    return this.sql.begin(async (tx) => {
      const inserted: Row[] = await tx`INSERT INTO builds
        (slug, repo, ticket, branch, created_at, updated_at)
        VALUES (${input.slug}, ${input.repo}, ${input.ticket ?? null}, ${input.branch ?? null}, ${ts}, ${ts})
        ON CONFLICT (slug) DO NOTHING RETURNING slug`
      const row = await this.lockBuild(tx, input.slug)
      if (!inserted[0]) throw new Error(`build "${input.slug}" already exists`)
      return this.record(row)
    })
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    const rows: Row[] = await this.sql`SELECT * FROM builds WHERE slug = ${slug}`
    return rows[0] ? this.record(rows[0]) : null
  }

  async listBuilds(): Promise<BuildRecord[]> {
    const rows: Row[] = await this.sql`SELECT * FROM builds ORDER BY created_at, slug`
    return rows.map((row) => this.record(row))
  }

  private async appendLocked(
    tx: Tx,
    slug: string,
    event: EventWrite,
    alreadyLocked = false,
  ): Promise<EventEnvelope> {
    if (!alreadyLocked) await this.lockBuild(tx, slug)
    const tails: Row[] =
      await tx`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE build = ${slug}`
    const seq = num(tails[0]?.seq) + 1
    const ts = this.now()
    await tx`INSERT INTO events (build, seq, ts, actor, type, payload)
      VALUES (${slug}, ${seq}, ${ts}, ${event.actor}, ${event.type}, ${event.payload})`
    await tx`UPDATE builds SET updated_at = ${ts} WHERE slug = ${slug}`
    return { build: slug, seq, ts, actor: event.actor, type: event.type, payload: event.payload }
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const validated = validateEventWrite(event)
    return (await this.sql.begin((tx) =>
      this.appendLocked(tx, slug, validated),
    )) as EventEnvelope<T>
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateEventWrite(event)
    return this.sql.begin(async (tx) => {
      await this.lockBuild(tx, slug)
      const tails: Row[] =
        await tx`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE build = ${slug}`
      if (num(tails[0]?.seq) !== expectedSeq) return null
      return (await this.appendLocked(tx, slug, validated, true)) as EventEnvelope<T>
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
    tx: Tx,
    slug: string,
    artifact: PreparedArtifact,
    lockedKinds: Map<string, number>,
  ): Promise<ArtifactMeta> {
    let revision = lockedKinds.get(artifact.kind)
    if (revision === undefined) {
      const tails: Row[] = await tx`SELECT COALESCE(MAX(revision), -1) AS revision
        FROM artifacts WHERE build = ${slug} AND kind = ${artifact.kind}`
      revision = num(tails[0]?.revision) + 1
    }
    lockedKinds.set(artifact.kind, revision + 1)
    const createdAt = this.now()
    await tx`INSERT INTO artifacts (build, kind, revision, blob_ref, metadata, created_at)
      VALUES (${slug}, ${artifact.kind}, ${revision}, ${artifact.blobRef}, ${artifact.metadata}, ${createdAt})`
    await tx`UPDATE builds SET updated_at = ${createdAt} WHERE slug = ${slug}`
    return {
      build: slug,
      kind: artifact.kind,
      revision,
      blobRef: artifact.blobRef,
      metadata: artifact.metadata,
      createdAt,
    }
  }

  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const prepared: PreparedArtifact[] = []
    for (const artifact of artifacts) prepared.push(await this.prepare(artifact))
    return this.sql.begin(async (tx) => {
      await this.lockBuild(tx, slug)
      const revisions = new Map<string, number>()
      const deposited: ArtifactMeta[] = []
      for (const artifact of prepared) {
        deposited.push(await this.depositBuildLocked(tx, slug, artifact, revisions))
      }
      const validated = validateEventWrite(makeEvent(structuredClone(deposited)))
      const event = (await this.appendLocked(tx, slug, validated, true)) as EventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getEvents(slug: string, sinceSeq = 0): Promise<AbEvent[]> {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    const rows: Row[] = await this.sql`SELECT * FROM events WHERE build = ${slug}
      AND seq > ${sinceSeq} ORDER BY seq`
    return rows.map((row) => ({
      build: String(row.build),
      seq: num(row.seq),
      ts: iso(row.ts),
      actor: json(row.actor),
      type: String(row.type),
      payload: json(row.payload),
    })) as AbEvent[]
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    const prepared = await this.prepare(artifact)
    return this.sql.begin(async (tx) => {
      await this.lockBuild(tx, slug)
      return this.depositBuildLocked(tx, slug, prepared, new Map())
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
    const rows: Row[] =
      rev === undefined
        ? await this
            .sql`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} ORDER BY revision DESC LIMIT 1`
        : await this
            .sql`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} AND revision = ${rev}`
    const row = rows[0]
    if (!row) return null
    const content = await this.blobs.get(String(row.blob_ref))
    return content ? { meta: this.artifactMeta(row), content } : null
  }

  async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    if (!(await this.getBuild(slug))) throw new Error(`unknown build "${slug}"`)
    const rows: Row[] =
      kind === undefined
        ? await this.sql`SELECT * FROM artifacts WHERE build = ${slug} ORDER BY kind, revision`
        : await this
            .sql`SELECT * FROM artifacts WHERE build = ${slug} AND kind = ${kind} ORDER BY kind, revision`
    return rows.map((row) => this.artifactMeta(row))
  }

  private async claim(
    table: 'builds' | 'repo_streams',
    key: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const row = table === 'builds' ? await this.lockBuild(tx, key) : await this.lockRepo(tx, key)
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
        await tx`UPDATE builds SET lease_holder=${holder}, lease_expires_at=${expires}, lease_ttl_ms=${ttlMs}, updated_at=${nowIso} WHERE slug=${key}`
      else
        await tx`UPDATE repo_streams SET lease_holder=${holder}, lease_expires_at=${expires}, lease_ttl_ms=${ttlMs}, updated_at=${nowIso} WHERE repo=${key}`
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
    return this.sql.begin(async (tx) => {
      const row = table === 'builds' ? await this.lockBuild(tx, key) : await this.lockRepo(tx, key)
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
        await tx`UPDATE builds SET lease_expires_at=${expires}, heartbeat_at=${nowIso}, updated_at=${nowIso} WHERE slug=${key}`
      else
        await tx`UPDATE repo_streams SET lease_expires_at=${expires}, heartbeat_at=${nowIso}, updated_at=${nowIso} WHERE repo=${key}`
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
    await this.sql.begin(async (tx) => {
      const row = table === 'builds' ? await this.lockBuild(tx, key) : await this.lockRepo(tx, key)
      if (row.lease_holder !== holder) return
      const now = this.now()
      if (table === 'builds')
        await tx`UPDATE builds SET lease_holder=NULL, lease_expires_at=NULL, lease_ttl_ms=NULL, updated_at=${now} WHERE slug=${key}`
      else
        await tx`UPDATE repo_streams SET lease_holder=NULL, lease_expires_at=NULL, lease_ttl_ms=NULL, updated_at=${now} WHERE repo=${key}`
    })
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    return this.release('builds', slug, holder)
  }
  async releaseRepoLease(repo: string, holder: string): Promise<void> {
    return this.release('repo_streams', repo, holder)
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    if (!repo) throw new Error('repo is required')
    const ts = this.now()
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO repo_streams (repo, created_at, updated_at)
        VALUES (${repo}, ${ts}, ${ts}) ON CONFLICT (repo) DO NOTHING`
      return this.repoRecord(await this.lockRepo(tx, repo))
    })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const rows: Row[] = await this.sql`SELECT * FROM repo_streams WHERE repo=${repo}`
    return rows[0] ? this.repoRecord(rows[0]) : null
  }

  private async appendRepoLocked(
    tx: Tx,
    repo: string,
    event: RepositoryEventWrite,
    alreadyLocked = false,
  ): Promise<RepositoryEventEnvelope> {
    if (!alreadyLocked) await this.lockRepo(tx, repo)
    const tails: Row[] =
      await tx`SELECT COALESCE(MAX(seq), 0) AS seq FROM repo_events WHERE repo=${repo}`
    const seq = num(tails[0]?.seq) + 1
    const ts = this.now()
    await tx`INSERT INTO repo_events (repo, seq, ts, actor, type, payload) VALUES (${repo},${seq},${ts},${event.actor},${event.type},${event.payload})`
    await tx`UPDATE repo_streams SET updated_at=${ts} WHERE repo=${repo}`
    return { repo, seq, ts, actor: event.actor, type: event.type, payload: event.payload }
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const validated = validateRepositoryEventWrite(event)
    return (await this.sql.begin((tx) =>
      this.appendRepoLocked(tx, repo, validated),
    )) as RepositoryEventEnvelope<T>
  }

  private async depositRepoLocked(
    tx: Tx,
    repo: string,
    artifact: PreparedArtifact,
    revisions: Map<string, number>,
  ): Promise<RepositoryArtifactMeta> {
    let revision = revisions.get(artifact.kind)
    if (revision === undefined) {
      const tails: Row[] =
        await tx`SELECT COALESCE(MAX(revision), -1) AS revision FROM repo_artifacts WHERE repo=${repo} AND kind=${artifact.kind}`
      revision = num(tails[0]?.revision) + 1
    }
    revisions.set(artifact.kind, revision + 1)
    const createdAt = this.now()
    await tx`INSERT INTO repo_artifacts (repo,kind,revision,blob_ref,metadata,created_at) VALUES (${repo},${artifact.kind},${revision},${artifact.blobRef},${artifact.metadata},${createdAt})`
    await tx`UPDATE repo_streams SET updated_at=${createdAt} WHERE repo=${repo}`
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
    return this.sql.begin(async (tx) => {
      await this.lockRepo(tx, repo)
      const revisions = new Map<string, number>()
      const deposited: RepositoryArtifactMeta[] = []
      for (const artifact of prepared)
        deposited.push(await this.depositRepoLocked(tx, repo, artifact, revisions))
      const validated = validateRepositoryEventWrite(makeEvent(structuredClone(deposited)))
      const event = (await this.appendRepoLocked(
        tx,
        repo,
        validated,
        true,
      )) as RepositoryEventEnvelope<T>
      return { event, artifacts: deposited }
    })
  }

  async getRepoEvents(repo: string, sinceSeq = 0): Promise<RepositoryEvent[]> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const rows: Row[] = await this
      .sql`SELECT * FROM repo_events WHERE repo=${repo} AND seq>${sinceSeq} ORDER BY seq`
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
    return this.sql.begin(async (tx) => {
      await this.lockRepo(tx, repo)
      return this.depositRepoLocked(tx, repo, prepared, new Map())
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
    const rows: Row[] =
      rev === undefined
        ? await this
            .sql`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} ORDER BY revision DESC LIMIT 1`
        : await this
            .sql`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} AND revision=${rev}`
    const row = rows[0]
    if (!row) return null
    const content = await this.blobs.get(String(row.blob_ref))
    return content ? { meta: this.repoArtifactMeta(row), content } : null
  }

  async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    if (!(await this.getRepo(repo))) throw new Error(`unknown repo "${repo}"`)
    const rows: Row[] =
      kind === undefined
        ? await this.sql`SELECT * FROM repo_artifacts WHERE repo=${repo} ORDER BY kind,revision`
        : await this
            .sql`SELECT * FROM repo_artifacts WHERE repo=${repo} AND kind=${kind} ORDER BY kind,revision`
    return rows.map((row) => this.repoArtifactMeta(row))
  }

  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  async close(): Promise<void> {
    await this.sql.close()
  }
}

export async function openPostgresBuildStore(
  url: string,
  blobs: BlobStore,
  options: { clock?: Clock } = {},
): Promise<PostgresBuildStore> {
  const sql = new SQL(url)
  try {
    await assertSchema(sql)
    return new PostgresBuildStore(sql, {
      blobs,
      ...(options.clock ? { clock: options.clock } : {}),
    })
  } catch (error) {
    await sql.close()
    throw error
  }
}
