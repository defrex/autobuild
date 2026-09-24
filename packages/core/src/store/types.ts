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
import type {
  SessionEvent,
  SessionEventEnvelope,
  SessionEventType,
  SessionEventWrite,
} from '../events/sessions'
import type { TicketRef } from '../ontology'
import type {
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
} from './streams/types'
export type { StreamRecord, StreamScope }

/** Injectable time source — adapters take one so tests are deterministic. */
export type Clock = () => Date

export const systemClock: Clock = () => new Date()

export interface BuildRecord {
  slug: string
  repo: string
  /** Normalized git origin URL of the build's repository, absent when the
   * repo had no origin remote at dispatch time. A location-independent
   * secondary identity: ambient reads may accept a differently located
   * checkout of the same repository by origin equality (repo stays primary). */
  repoOrigin?: string
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
  /** See BuildRecord.repoOrigin. */
  repoOrigin?: string
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

/** The projection of one build's event log onto exactly the two facts an
 * operator dashboard needs from every build (AUT-487): the latest terminal
 * fact's kind — `done` for `build.completed`, `aborted` for `build.aborted`,
 * in-order overwrite, exactly `reduceBuild`'s terminal rule — and the seqs of
 * the log's `observation.recorded` occurrences. `terminal` is absent while
 * the log carries neither terminal fact (a queued, running, paused, blocked,
 * or mid-cleanup build). Everything else a dashboard shows comes from the
 * journal, the build records, and the full histories of just the builds that
 * render rows. Nothing is persisted: every adapter derives the digest from
 * the event log on each call, so the log stays the sole authority and the
 * digest can always be discarded and rebuilt. */
export interface BuildDigest {
  slug: string
  terminal?: 'done' | 'aborted'
  /** Ascending seqs of every `observation.recorded` in the build's log. */
  observations: number[]
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

/** An operator session: hosted-only durable orchestrator-conversation state
 * (SPEC §7.1.1). The record carries only identity and timestamps; everything
 * else — status, open turn, pending approval, wake settings — is a reduction
 * of the session's own event log (the hosted package's session-reducer.ts),
 * never a column. */
export interface SessionRecord {
  /** Store-assigned (`os_<uuid>`). */
  id: string
  repo: string
  /** The owning operator's normalized identity (trimmed nonblank — the same
   * normalization `OperatorTokenScope` applies). A session belongs to its
   * creating operator. */
  operator: string
  title?: string
  createdAt: string
  updatedAt: string
}

export interface NewSessionInput {
  repo: string
  operator: string
  title?: string
}

/** The operator identity's one normalization — trimmed, nonblank. The same
 * normalization `OperatorTokenScope` applies to its `user` claim, so a token's
 * user matches the session records it creates. */
export function normalizeOperator(operator: string): string {
  const trimmed = operator.trim()
  if (!trimmed) throw new Error('operator is required')
  return trimmed
}

export interface SessionArtifactMeta {
  session: string
  kind: string
  /** 0-based per kind, like build and repository artifacts (§6.3). */
  revision: number
  blobRef: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface SessionArtifact {
  meta: SessionArtifactMeta
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
  /** Poll interval for the v2.0 polling implementation (§7.2). In bounded-wait
   * mode (`waitSeconds` set) it is the floor between request *starts* —
   * elapsed request time counts toward the gap. */
  pollMs?: number
  /** Bounded-wait window in whole seconds. When set against a store whose
   * event reads honor the bound (an `http(s)` store's server holds the
   * request), each poll cycle issues one held request instead of polling
   * every `pollMs`; delivery latency drops to about one server-side poll.
   * The adapter clamps at its own ceiling; it never rejects. */
  waitSeconds?: number
}

export interface BuildStore {
  /** Return an interface-enforced handle with authority over exactly `slug`.
   * The handle retains this shape so foreign/admin calls fail loudly. */
  scopeBuild(slug: string): BuildScopedStore

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
   * Atomically append one validated event only when the build stream's
   * current sequence equals `expectedSeq` (0 for an empty stream). Returns
   * null when the stream has advanced. A comparison miss must not mutate the
   * stream or build timestamps. Invalid events and unknown builds reject just
   * as they do for `append`.
   */
  appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null>

  /**
   * Atomic deposit (D6): store artifacts, then append the event that
   * references them — one operation, no state where an artifact exists
   * without its event or vice versa. `makeEvent` receives the deposited
   * metas (with assigned revisions) so the payload can carry `{kind, rev}`
   * refs. If the event fails validation, the artifact deposit is rolled
   * back (orphaned blobs are harmless — they are content-addressed).
   *
   * Ordering invariant (AUT-322): the adapter must run `validateEventWrite`
   * on the batch event *before* any retention prune (store/retention.ts) of
   * artifacts in the same deposit batch, so a same-kind batch larger than
   * the retention bound never loses a sibling to a prune that outran
   * validation; on validation failure the batch — deposits and prunes —
   * must leave no trace. `revisionsToPrune` is a pure function of the full
   * post-batch revision set, so pruning once per distinct batch kind after
   * validation is equivalent to per-deposit pruning.
   */
  appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }>

  /** Events with seq strictly greater than `sinceSeq` (default 0), in order.
   * When nothing newer exists and `opts.waitSeconds` is given (whole
   * seconds; clamped at the adapter's ceiling, never rejected), the adapter
   * honors the bound: it returns no later than the bound and as soon as an
   * event with `seq > sinceSeq` is appended; when such events already exist
   * it returns immediately. Omitting `waitSeconds` (or 0) is the immediate
   * form.
   *
   * `opts.signal` lets a caller cancel the held read before its bound (a
   * watcher or a disconnected peer torn down mid-hold). When the signal
   * fires, the adapter resolves with its current result — the empty read it
   * would otherwise keep polling for — and stops polling; it MUST NOT wait
   * past the bound because of the signal, and a read that finds data before
   * the abort still returns it. */
  getEvents(
    slug: string,
    sinceSeq?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]>

  /** One entry for EVERY build whose record's repo is `repo` (completeness is
   * contractual: a freshly created build whose log holds none of the three
   * digest-relevant event types still gets its entry, with empty
   * `observations` and no `terminal`), keyed by slug. A read-only, repo-scoped
   * batch query shaped like `listBuilds`: it performs no `ensureRepo`, never
   * writes, and an unknown or build-less repo answers an empty map rather
   * than rejecting. Derived from the event log on every call — the log is the
   * sole authority, so there is nothing to refresh or invalidate. The
   * derivation is the shared `reduceBuildDigest` (store/digest.ts), so every
   * adapter answers identical results for identical logs. */
  getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>>

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
  /** Same atomic-deposit and ordering contracts as `appendWithArtifacts`:
   * the batch event is validated before any retention prune of artifacts in
   * the same deposit batch (AUT-322), and an invalid event leaves no trace.
   * The optional bounded wait mirrors `getEvents` exactly, including the
   * resolve-with-current-result abort contract of `opts.signal`. */
  getRepoEvents(
    repo: string,
    sinceSeq?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]>
  /** Bounded repository-journal read for stateless full-state readers
   * (AUT-489): every durable fact (REPOSITORY_STATE_EVENT_TYPES) plus — when
   * the journal has one — the tail from the latest `dispatcher.run-started`.
   * Reducing this subset with the state readers yields exactly what a full
   * replay yields (`projectRepositoryStateEvents` is the normative oracle).
   * Unknown repo rejects like `getRepoEvents`. */
  getRepoStateEvents(repo: string): Promise<RepositoryEvent[]>
  putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta>
  getRepoArtifact(repo: string, kind: string, rev?: number): Promise<RepositoryArtifact | null>
  listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]>
  claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean>
  heartbeatRepo(repo: string, holder: string): Promise<boolean>
  releaseRepoLease(repo: string, holder: string): Promise<void>

  // ── Operator sessions (SPEC §7.1.1 — a third resource kind) ────────────
  // Hosted-only durable orchestrator-conversation state: a record keyed by
  // repository and operator, its own small typed event catalog
  // (events/sessions.ts) with a per-session sequence, and session-scoped
  // streams. The record and its first fact (`session.created`) land together;
  // every later fact appends through the same validated gate as builds and
  // the repository journal. Nothing local creates sessions; adapters merely
  // implement the contract uniformly.
  /** Create the record and atomically append `session.created` (seq 1,
   * actor the operator). Unlike builds, nothing else ever creates sessions. */
  createSession(input: NewSessionInput): Promise<SessionRecord>
  getSession(id: string): Promise<SessionRecord | null>
  /** Every session of `repo` in creation order: `createdAt` ascending, with
   * same-millisecond ties broken by a store-assigned monotonic creation
   * sequence — never by the random `os_<uuid>` id. The counter is assigned at
   * `createSession`, is never reused (sessions are never deleted), and is not
   * part of `SessionRecord`. This makes the returned order a function of the
   * creation history alone, so every adapter (memory, SQLite, Postgres,
   * remote) returns the same order for the same creation history. */
  listSessions(repo: string): Promise<SessionRecord[]>
  /** Append one validated session event; the store assigns the per-session
   * `seq` (monotonic, from 1) and `ts`. Unknown sessions reject; invalid
   * events throw `EventValidationError` and append nothing. */
  appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>>
  /** Events with seq strictly greater than `sinceSeq` (default 0), in order.
   * When nothing newer exists, an adapter honors `waitSeconds` with the
   * same clamp/early-return rules as stream reads (§7.6): whole seconds,
   * above 30 clamped to 30, returning as soon as an event lands.
   * `opts.signal` carries the same resolve-with-current-result abort
   * contract as `getEvents`: on abort the adapter stops polling and resolves
   * with its current result, never waiting past the bound. */
  getSessionEvents(
    id: string,
    sinceSeq?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]>
  /** Same atomic-deposit and validation-before-prune contracts as
   * `appendWithArtifacts` (D6, AUT-322): the batch event is validated before
   * any retention prune of artifacts in the same deposit batch, and an
   * invalid event leaves no trace. */
  appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }>
  putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta>
  /** Latest revision when `rev` is omitted; null if kind (or rev) absent. */
  getSessionArtifact(id: string, kind: string, rev?: number): Promise<SessionArtifact | null>
  listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]>
  /** Return an interface-enforced handle with authority over exactly one
   * session: its record, events, artifacts, and session-scoped streams. */
  scopeSession(id: string): SessionScopedStore

  // ── Streams (SPEC §7.6 — the third primitive) ───────────────────────────
  // An append-only, per-stream sequenced log of protocol parts with an
  // open-then-closed lifecycle that finalizes into an artifact. Presentation,
  // never routing: no kernel, engine, reducer, or dispatcher decision reads
  // stream content; outcomes travel only the typed CLI. Chunk vocabulary:
  // the AI SDK UI Message Stream protocol (`ai-ui-message-stream/v1`).
  //
  // Stream ids are store-assigned (`st_<uuid>`); the scope is fixed at
  // create and every operation addresses the stream by id.

  /** Create an open stream under `scope`. Store-assigned id and
   * `createdAt`; `format` is the literal `ai-ui-message-stream/v1`. */
  createStream(scope: StreamScope, label: string): Promise<StreamRecord>

  /** Append one batch of parts. Each part must be a JSON object whose `type`
   * is a nonempty string; the store performs no further protocol validation
   * on append. The store assigns the per-stream sequence (from 1) and the
   * timestamp. A batch whose serialized size exceeds 1,048,576 bytes rejects
   * with `StreamBatchTooLargeError` without mutation; a closed or unknown
   * stream rejects (`StreamClosedError` / `Error`) and writes nothing. */
  appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk>

  /** Chunks with sequence strictly greater than `since` (default 0), in
   * order, plus the stream's current status and, when closed, its outcome
   * and artifact reference. When no newer chunk exists and the stream is
   * open, an adapter honors `waitSeconds` (whole seconds; above 30 clamped
   * to 30): it returns no later than the bound and as soon as a chunk is
   * appended or the stream closes. Closed streams never wait.
   * `opts.signal` carries the same resolve-with-current-result abort
   * contract as `getEvents`: on abort the adapter stops polling and resolves
   * with its current result, never waiting past the bound. */
  readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead>

  /** Close with an outcome. One atomic operation: assemble the chunks into
   * the protocol's `UIMessage[]` document, deposit it as an artifact
   * (`stream:<streamId>`, revision 0) on the owning scope, and mark the
   * stream closed. If the artifact deposit fails the stream stays open and
   * nothing is written. Closing an already-closed stream is a no-op
   * returning the record. */
  closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord>

  /** The stream record, or null when the id is unknown. */
  getStream(streamId: string): Promise<StreamRecord | null>

  /** Every stream in `scope` in creation order: `createdAt` ascending, with
   * same-millisecond ties broken by a store-assigned monotonic creation
   * sequence — never by the random `st_<uuid>` id. The counter is assigned at
   * `createStream`, is never reused (streams are never deleted — retention
   * prunes `stream_chunks` only), and is not part of `StreamRecord`. This
   * makes the returned order a function of the creation history alone, so
   * every adapter (memory, SQLite, Postgres, remote) returns the same order
   * for the same creation history. */
  listStreams(scope: StreamScope): Promise<StreamRecord[]>

  close(): Promise<void>
}

/** A BuildStore constrained to one build stream. `buildScope` is immutable;
 * attempting to re-scope to another slug is an authority error. */
export interface BuildScopedStore extends BuildStore {
  readonly buildScope: string
  scopeBuild(slug: string): BuildScopedStore
}

/** A BuildStore constrained to one operator session. `sessionScope` is
 * immutable; the handle may touch only its own session's events, artifacts,
 * and session-scoped streams, and rejects session create/list and every
 * build/repository operation. This is the (later turn runner's) authority
 * over exactly one session, mirroring `BuildScopedStore`. */
export interface SessionScopedStore extends BuildStore {
  readonly sessionScope: string
  scopeSession(id: string): SessionScopedStore
}

/** Shared runtime guard for in-process conditional append callers. */
export function validateExpectedSeq(expectedSeq: number): void {
  if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
    throw new Error(`expectedSeq must be a nonnegative integer, got ${expectedSeq}`)
  }
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
