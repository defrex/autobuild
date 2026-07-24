/**
 * The BuildStore seam (SPEC §7): the durable home of everything a build
 * produces — events, artifacts, transcripts — one logical place whether
 * builds run locally or in ten remote sandboxes.
 *
 * Deliberately narrow (§7.2): runners need `append`, `putArtifact`,
 * `getArtifact`, `getEvents(since)`; operator UIs add `listBuilds` and
 * `subscribe`. Liveness (lease + heartbeat) is mutable columns, never events
 * (§15.2.6).
 *
 * Every adapter must satisfy the contract suite in `store/contract.ts`.
 */
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import type { EventType } from '../events/payloads'
import type {
  RepositoryEvent,
  RepositoryEventEnvelope,
  RepositoryEventType,
  RepositoryEventWrite,
} from '../events/repository'
import type { TicketRef } from '../ontology'

/** Injectable time source — adapters take one so tests are deterministic. */
export type Clock = () => Date

export const systemClock: Clock = () => new Date()

export interface BuildRecord {
  slug: string
  repo: string
  ticket?: TicketRef
  branch?: string
  createdAt: string
  updatedAt: string
  /** Runner lease — mutable liveness, never events (§15.2.6). */
  lease?: { holder: string; expiresAt: string }
  heartbeatAt?: string
}

export interface NewBuildInput {
  slug: string
  repo: string
  ticket?: TicketRef
  branch?: string
}

export interface ArtifactMeta {
  build: string
  kind: string
  /** 0-based per kind: first deposit of a kind is rev 0 (SPEC §6.3). */
  revision: number
  /** Content address: sha256 hex of the blob (SPEC §7.1). */
  blobRef: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface RepositoryRecord {
  repo: string
  createdAt: string
  updatedAt: string
  /** Repository workflow lease (harvest single-flight), separate from builds. */
  lease?: { holder: string; expiresAt: string }
  heartbeatAt?: string
}

export interface RepositoryArtifactMeta {
  repo: string
  kind: string
  revision: number
  blobRef: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface RepositoryArtifact {
  meta: RepositoryArtifactMeta
  content: Uint8Array
}

export interface ArtifactInput {
  kind: string
  content: string | Uint8Array
  metadata?: Record<string, unknown>
}

export interface Artifact {
  meta: ArtifactMeta
  content: Uint8Array
}

/**
 * Content-addressed blob storage (SPEC §7.1) — a plain directory locally,
 * any object store remotely. The database stores refs, never bulk content.
 * The interface is deliberately this narrow; do not widen it.
 */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array): Promise<void>
  get(hash: string): Promise<Uint8Array | null>
}

export type Unsubscribe = () => void

export interface SubscribeOptions {
  /** Deliver events with seq strictly greater than this (default 0 = all). */
  fromSeq?: number
  /** Poll interval for the v2.0 polling implementation (§7.2). */
  pollMs?: number
}

export interface BuildStore {
  createBuild(input: NewBuildInput): Promise<BuildRecord>
  getBuild(slug: string): Promise<BuildRecord | null>
  listBuilds(): Promise<BuildRecord[]>

  /**
   * Append one validated event; the store assigns `seq` (per-build,
   * monotonic, starting at 1) and `ts` (§15.1). Writes must pass
   * `validateEventWrite` — invalid events throw `EventValidationError`.
   */
  append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>>

  /**
   * Atomic deposit (D6): store artifacts, then append the event that
   * references them — one operation, no state where an artifact exists
   * without its event or vice versa. `makeEvent` receives the deposited
   * metas (with assigned revisions) so the payload can carry `{kind, rev}`
   * refs. If the event fails validation, the artifact deposit is rolled
   * back (orphaned blobs are harmless — they are content-addressed).
   */
  appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }>

  /** Events with seq strictly greater than `sinceSeq` (default 0), in order. */
  getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]>

  putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta>
  /** Latest revision when `rev` is omitted; null if kind (or rev) absent. */
  getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null>
  listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]>

  /**
   * Take or renew the runner lease. Succeeds when unheld, expired, or
   * already held by `holder` (renewal). Claiming is how a new sandbox takes
   * over a dead one's build (§7.4, §15.6-C).
   */
  claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean>
  /** Bump liveness; false (no-op) unless `holder` holds an unexpired lease. */
  heartbeat(slug: string, holder: string): Promise<boolean>
  releaseLease(slug: string, holder: string): Promise<void>

  /**
   * Push is the specced interface; the v2.0 implementation is polling
   * `getEvents(since)` (§7.2). Events are delivered in seq order, each
   * exactly once per subscription.
   */
  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe

  // ── Repository journal (outer-loop workflows and controls) ───────────────
  // Kept alongside, not inside, build streams: repository state is not a build.
  ensureRepo(repo: string): Promise<RepositoryRecord>
  getRepo(repo: string): Promise<RepositoryRecord | null>
  appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>>
  appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{
    event: RepositoryEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }>
  getRepoEvents(repo: string, sinceSeq?: number): Promise<RepositoryEvent[]>
  putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta>
  getRepoArtifact(repo: string, kind: string, rev?: number): Promise<RepositoryArtifact | null>
  listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]>
  claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean>
  heartbeatRepo(repo: string, holder: string): Promise<boolean>
  releaseRepoLease(repo: string, holder: string): Promise<void>

  close(): Promise<void>
}

/** sha256 hex — the content address for blobs (SPEC §7.1). */
export function contentHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

export function textContent(artifact: Artifact): string {
  return new TextDecoder().decode(artifact.content)
}
