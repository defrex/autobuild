import { assertResumeWindow, validateEventCursor, type EventReadOptions } from '../event-reads'
import { scanCadenceSchema, type ScanCadence } from '../scan-cadence'
import {
  operatorIdentitySchema,
  OPERATOR_PRESENCE_TTL_MS,
  type OperatorIdentity,
  type OperatorPresence,
} from '../operator-presence'
import { READ_CATALOG_IDENTITY } from '../../events/compatibility'
import { readPersistedBuildDigests } from '../reduced-reads'
import { assertPublicSnapshotReducer } from '../snapshots'
import {
  readReducerValue,
  resolveReducerValue,
  type ReducerValueRequest,
  type ReducerValue,
} from '../reducer-values'
import { validateTickFinish } from '../repo-tick'
import {
  buildPageOrder,
  decodeBuildPageCursor,
  encodeBuildPageCursor,
  hasBuildPageFilters,
  requireBuildPageCursorOrder,
  resolveBuildPageFilters,
  parseChangePosition,
  resolveBuildPageLimit,
  type BuildPage,
  type BuildPageCursor,
  type BuildPageFilters,
  type BuildPageOptions,
  type ChangedBuilds,
} from '../build-feed'
import type { RepoTickCompletion, RepoTickFinish, RepoTickObservation } from '../types'
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
import { and, asc, desc, eq, gt, gte, lte, inArray, or, sql } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanActor } from '../../events/envelope'
import {
  prepareEventWrite as validateEventWrite,
  type AbEvent,
  type EventEnvelope,
  type EventWrite,
} from '../../events/catalog'
import { eventPayloadSchemas, type EventType } from '../../events/payloads'
import {
  prepareRepositoryEventWrite as validateRepositoryEventWrite,
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
import type { ReducerSnapshot, ReducerValueScope, RollupScope, SnapshotScope } from '../snapshots'
import {
  KeyedMutex,
  ROLLUP_LEASE_MS,
  ROLLUP_LEASE_WAIT_MS,
  RollupLeaseLostError,
  RollupLeaseTimeoutError,
  readRollupValue,
  type RollupAdvance,
  type RollupStorage,
} from '../rollups'
import { validateCreatedEvent } from '../new-build'
import { createSessionScopedStore } from '../session-handle'
import {
  REPOSITORY_STATE_EVENT_TYPES,
  REPOSITORY_LATEST_EVENT_TYPES,
  readRepoStateEventsWithAnchorRecheck,
} from '../repo-state-events'
import {
  DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS,
  isRetentionManagedKind,
  revisionsToPrune,
} from '../retention'
import { pollingSubscribe } from '../subscribe'
import { StreamLocks } from '../streams/lock'
import { assembleUIMessageDocument } from '../streams/assemble'
import { EVENT_WAIT_POLL_MS, readEventsWithWait, readStreamWithWait } from '../streams/wait'
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
  type OpenBuild,
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
import {
  FIRST_NAME as ASSET_FIRST_NAME,
  FIRST_NAME_NEXT_KIND as ASSET_FIRST_NAME_NEXT_KIND,
  HEAD as ASSET_HEAD,
  NEXT_NAME_SAME_KIND as ASSET_NEXT_NAME_SAME_KIND,
} from './ticket-asset-heads'
import {
  DEFAULT_TICKET_ASSET_LIMITS,
  loadTicketAsset,
  storeTicketAssetBlobs,
  resolvePinnedAsset,
  summarizeTicketAsset,
  validateTicketAssetInput,
  type TicketAsset,
  type TicketAssetInput,
  type TicketAssetLimits,
  type TicketAssetMeta,
  type TicketAssetSummary,
} from '../ticket-assets'
import { DirBlobStore } from './blobs'
import {
  artifacts,
  builds,
  events,
  openBuilds,
  repoArtifacts,
  repoEvents,
  repoStreams,
  sessionArtifacts,
  sessionEvents,
  sessions,
  ticketAssets,
  streamChunks,
  streams,
} from './schema'

/**
 * Bootstrap DDL, applied idempotently at open. MUST match `schema.ts` —
 * the drizzle schema is the source of truth; this is its inlined form so
 * opening a store never needs a migration step.
 */
// Exported for the schema-parity test, which pins this DDL against the
// drizzle schema; schema.ts stays the source of truth, this is its inlined form.
export const REPO_CHANGE_DDL = `
CREATE TABLE IF NOT EXISTS repo_change_positions (repo TEXT PRIMARY KEY, position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS builds_repo_created_slug ON builds(repo, created_at, slug);
CREATE TRIGGER IF NOT EXISTS repo_events_repo_change AFTER INSERT ON repo_events
 BEGIN INSERT INTO repo_change_positions(repo, position) VALUES (NEW.repo, 1)
 ON CONFLICT(repo) DO UPDATE SET position = position + 1; END;
CREATE TRIGGER IF NOT EXISTS repo_holder_change AFTER UPDATE OF lease_holder ON repo_streams
 WHEN OLD.lease_holder IS NOT NEW.lease_holder
 BEGIN INSERT INTO repo_change_positions(repo, position) VALUES (NEW.repo, 1)
 ON CONFLICT(repo) DO UPDATE SET position = position + 1; END;
`

/** The open-build set and the triggers that maintain it. A build is open
 * while its latest terminal fact is not `build.completed`: inserting a build
 * adds it, `build.completed` removes it, and `build.aborted` or
 * `build.reopened` re-derive it. Triggers run inside the appending
 * statement's transaction, so every append path — and any older binary
 * writing the same file — keeps the set exact. */
export const OPEN_BUILDS_DDL = `
CREATE TABLE IF NOT EXISTS open_builds (
  slug TEXT PRIMARY KEY REFERENCES builds(slug) ON DELETE CASCADE,
  repo TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS open_builds_repo_slug ON open_builds (repo, slug);
CREATE TRIGGER IF NOT EXISTS builds_open_insert AFTER INSERT ON builds
 BEGIN INSERT OR IGNORE INTO open_builds(slug, repo) VALUES (NEW.slug, NEW.repo); END;
CREATE TRIGGER IF NOT EXISTS events_open_completed AFTER INSERT ON events
 WHEN NEW.type = 'build.completed'
 BEGIN DELETE FROM open_builds WHERE slug = NEW.build; END;
CREATE TRIGGER IF NOT EXISTS events_open_rederive AFTER INSERT ON events
 WHEN NEW.type IN ('build.aborted', 'build.reopened')
 BEGIN INSERT OR IGNORE INTO open_builds(slug, repo)
  SELECT b.slug, b.repo FROM builds b WHERE b.slug = NEW.build AND NOT EXISTS (
   SELECT 1 FROM events c WHERE c.type = 'build.completed' AND c.build = NEW.build
    AND c.seq > COALESCE((SELECT MAX(a.seq) FROM events a
     WHERE a.type = 'build.aborted' AND a.build = NEW.build), 0)); END;
`

/** The one-off backfill that runs only when `open_builds` is first created
 * on an existing file. No read path or later open ever runs it. */
const OPEN_BUILDS_BACKFILL = `INSERT OR IGNORE INTO open_builds(slug, repo)
 SELECT b.slug, b.repo FROM builds b WHERE NOT EXISTS (
  SELECT 1 FROM events c WHERE c.type = 'build.completed' AND c.build = b.slug
   AND c.seq > COALESCE((SELECT MAX(a.seq) FROM events a
    WHERE a.type = 'build.aborted' AND a.build = b.slug), 0))`

/**
 * Per-build latest change positions (the changed-builds feed). Each trigger
 * body advances the repository position and then records it as the build's
 * latest, in one statement list, so the two can never disagree in order and
 * share the writing transaction. Build creation and build events use these
 * triggers; they replace the older `builds_repo_change` and
 * `events_repo_change` (`ensureBuildChangePositions` drops those once). An
 * older runtime that recreates one only double-advances the counter, which
 * keeps positions strictly ordered.
 */
export const BUILD_CHANGE_DDL = `
CREATE TABLE IF NOT EXISTS build_change_positions (slug TEXT PRIMARY KEY, repo TEXT NOT NULL, position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS build_change_positions_repo_position ON build_change_positions(repo, position);
CREATE TRIGGER IF NOT EXISTS builds_change_recorded AFTER INSERT ON builds
 BEGIN
 INSERT INTO repo_change_positions(repo, position) VALUES (NEW.repo, 1)
 ON CONFLICT(repo) DO UPDATE SET position = position + 1;
 INSERT INTO build_change_positions(slug, repo, position)
 SELECT NEW.slug, NEW.repo, position FROM repo_change_positions WHERE repo = NEW.repo
 ON CONFLICT(slug) DO UPDATE SET position = MAX(position, excluded.position);
 END;
CREATE TRIGGER IF NOT EXISTS events_change_recorded AFTER INSERT ON events
 BEGIN
 INSERT INTO repo_change_positions(repo, position) SELECT repo, 1 FROM builds WHERE slug = NEW.build
 ON CONFLICT(repo) DO UPDATE SET position = position + 1;
 INSERT INTO build_change_positions(slug, repo, position)
 SELECT b.slug, b.repo, p.position FROM builds b JOIN repo_change_positions p ON p.repo = b.repo
 WHERE b.slug = NEW.build
 ON CONFLICT(slug) DO UPDATE SET position = MAX(position, excluded.position);
 END;
`

/** Runs once, when `build_change_positions` is first created: advance each
 * repository that has builds by one, and record every existing build at that
 * new head, so every pre-migration build is strictly newer than any position
 * a consumer could have saved before. */
const BUILD_CHANGE_BACKFILL = `
DROP TRIGGER IF EXISTS builds_repo_change;
DROP TRIGGER IF EXISTS events_repo_change;
${BUILD_CHANGE_DDL}
INSERT INTO repo_change_positions(repo, position) SELECT DISTINCT repo, 1 FROM builds WHERE true
 ON CONFLICT(repo) DO UPDATE SET position = position + 1;
INSERT INTO build_change_positions(slug, repo, position)
 SELECT b.slug, b.repo, p.position FROM builds b JOIN repo_change_positions p ON p.repo = b.repo WHERE true
 ON CONFLICT(slug) DO UPDATE SET position = excluded.position;
`

/**
 * Install the per-build change positions. Process start costs one
 * `sqlite_master` lookup once the table exists; only a database that lacks
 * it takes a write transaction, rechecked under BEGIN IMMEDIATE because two
 * processes can open the same file at once.
 */
export function ensureBuildChangePositions(sqlite: Database): void {
  const present = () =>
    sqlite
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'build_change_positions'",
      )
      .get() !== null
  if (present()) return
  sqlite
    .transaction(() => {
      if (!present()) sqlite.exec(BUILD_CHANGE_BACKFILL)
    })
    .immediate()
}

/** The paged listing's per-build facts, one index per (filter class x order).
 * The partial indexes name `merged = 1` so a merged query reads only merged
 * builds. */
const BUILD_LISTING_INDEXES = [
  ['build_listing_kind_created', 'repo, node, created_at, slug', ''],
  ['build_listing_merged_created', 'repo, created_at, slug', ' WHERE merged = 1'],
  ['build_listing_merged_kind_created', 'repo, node, created_at, slug', ' WHERE merged = 1'],
  ['build_listing_updated', 'repo, updated_at, slug', ''],
  ['build_listing_kind_updated', 'repo, node, updated_at, slug', ''],
  ['build_listing_merged_updated', 'repo, updated_at, slug', ' WHERE merged = 1'],
  ['build_listing_merged_kind_updated', 'repo, node, updated_at, slug', ' WHERE merged = 1'],
] as const

/**
 * Per-build listing facts behind the paged listing's filters (`kind`,
 * `outcome: merged`, `activeSince`). Triggers keep them in the writing
 * transaction of every path, including an older runtime on the same file: a
 * build insert seeds the row, `build.created` sets `node`, the latest
 * `build.completed` sets `merged` and `build.reopened` clears it, and every
 * `updated_at` change on `builds` is mirrored. A side table leaves `builds`
 * and its catalog shape untouched.
 */
export const BUILD_LISTING_DDL = `
CREATE TABLE IF NOT EXISTS build_listing_facts (slug TEXT PRIMARY KEY, repo TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, node INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0);
${BUILD_LISTING_INDEXES.map(([name, columns, where]) => `CREATE INDEX IF NOT EXISTS ${name} ON build_listing_facts(${columns})${where};`).join('\n')}
CREATE TRIGGER IF NOT EXISTS builds_listing_seeded AFTER INSERT ON builds
 BEGIN INSERT INTO build_listing_facts(slug, repo, created_at, updated_at)
 VALUES (NEW.slug, NEW.repo, NEW.created_at, NEW.updated_at) ON CONFLICT(slug) DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS builds_listing_touched AFTER UPDATE OF updated_at ON builds
 WHEN OLD.updated_at IS NOT NEW.updated_at
 BEGIN UPDATE build_listing_facts SET updated_at = NEW.updated_at WHERE slug = NEW.slug; END;
CREATE TRIGGER IF NOT EXISTS events_listing_kind AFTER INSERT ON events
 WHEN NEW.type = 'build.created'
 BEGIN UPDATE build_listing_facts SET node = COALESCE(json_extract(NEW.payload, '$.kind') = 'node', 0)
 WHERE slug = NEW.build; END;
CREATE TRIGGER IF NOT EXISTS events_listing_completed AFTER INSERT ON events
 WHEN NEW.type = 'build.completed'
 BEGIN UPDATE build_listing_facts SET merged = COALESCE(json_extract(NEW.payload, '$.outcome') = 'merged', 0)
 WHERE slug = NEW.build; END;
CREATE TRIGGER IF NOT EXISTS events_listing_reopened AFTER INSERT ON events
 WHEN NEW.type = 'build.reopened'
 BEGIN UPDATE build_listing_facts SET merged = 0 WHERE slug = NEW.build; END;
`

/** Runs once, when `build_listing_facts` is first created: one row per
 * existing build from its record and its latest relevant events. */
const BUILD_LISTING_BACKFILL = `
${BUILD_LISTING_DDL}
INSERT INTO build_listing_facts(slug, repo, created_at, updated_at, node, merged)
 SELECT b.slug, b.repo, b.created_at, b.updated_at,
 COALESCE((SELECT json_extract(e.payload, '$.kind') = 'node' FROM events e
   WHERE e.type = 'build.created' AND e.build = b.slug ORDER BY e.seq DESC LIMIT 1), 0),
 COALESCE((SELECT e.type = 'build.completed' AND json_extract(e.payload, '$.outcome') = 'merged'
   FROM events e WHERE e.type IN ('build.completed', 'build.reopened') AND e.build = b.slug
   ORDER BY e.seq DESC LIMIT 1), 0)
 FROM builds b WHERE true
 ON CONFLICT(slug) DO NOTHING;
`

/**
 * Install the listing facts. Process start costs one `sqlite_master` lookup
 * once the table exists; only a database that lacks it takes a write
 * transaction, rechecked under BEGIN IMMEDIATE, and backfills once.
 */
export function ensureBuildListingFacts(sqlite: Database): void {
  const present = () =>
    sqlite
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'build_listing_facts'",
      )
      .get() !== null
  if (present()) return
  sqlite
    .transaction(() => {
      if (!present()) sqlite.exec(BUILD_LISTING_BACKFILL)
    })
    .immediate()
}

/**
 * A filtered build page: one backward range scan of the listing-facts index
 * for the filter class and order, at most `limit + 1` entries, joined to
 * `builds` by primary key. `INDEXED BY` makes a plan that cannot use the
 * index an error instead of a scan.
 */
export function filteredBuildPageQuery(
  repo: string,
  limit: number,
  filters: BuildPageFilters,
  cursor?: BuildPageCursor,
): { sql: string; params: (string | number)[] } {
  const updated = filters.activeSince !== undefined
  const column = updated ? 'updated_at' : 'created_at'
  const merged = filters.outcome === 'merged'
  const kind = filters.kind !== undefined
  const index = `build_listing${merged ? '_merged' : ''}${kind ? '_kind' : ''}_${updated ? 'updated' : 'created'}`
  const where = ['f.repo = ?']
  const params: (string | number)[] = [repo]
  if (kind) {
    where.push('f.node = ?')
    params.push(filters.kind === 'node' ? 1 : 0)
  }
  if (merged) where.push('f.merged = 1')
  if (updated) {
    where.push('f.updated_at >= ?')
    params.push(filters.activeSince!)
  }
  if (cursor) {
    where.push(`(f.${column}, f.slug) < (?, ?)`)
    params.push(cursor.at, cursor.slug)
  }
  params.push(limit)
  return {
    sql: `SELECT ${BUILD_PAGE_COLUMNS_B}, f.${column} AS cursorAt
FROM build_listing_facts f INDEXED BY ${index} JOIN builds b ON b.slug = f.slug
WHERE ${where.join(' AND ')}
ORDER BY f.${column} DESC, f.slug DESC LIMIT ?`,
    params,
  }
}

/** The changed-builds feed: the head plus an index range scan, one snapshot. */
export const CHANGED_BUILDS_SQL = `SELECT h.head AS head, c.slug AS slug, CAST(c.position AS TEXT) AS position
FROM (SELECT CAST(COALESCE((SELECT position FROM repo_change_positions WHERE repo = ?1), 0) AS TEXT) AS head) h
LEFT JOIN build_change_positions c ON c.repo = ?1 AND c.position > ?2
ORDER BY c.position`

const BUILD_PAGE_COLUMNS = `slug, repo, ticket, branch, repo_origin AS repoOrigin,
 created_at AS createdAt, updated_at AS updatedAt, heartbeat_at AS heartbeatAt,
 lease_holder AS leaseHolder, lease_expires_at AS leaseExpiresAt`

const BUILD_PAGE_COLUMNS_B = `b.slug AS slug, b.repo AS repo, b.ticket AS ticket, b.branch AS branch,
 b.repo_origin AS repoOrigin, b.created_at AS createdAt, b.updated_at AS updatedAt,
 b.heartbeat_at AS heartbeatAt, b.lease_holder AS leaseHolder, b.lease_expires_at AS leaseExpiresAt`

/** A build page, newest first: a backward scan of `builds_repo_created_slug`. */
export const BUILD_PAGE_SQL = `SELECT ${BUILD_PAGE_COLUMNS} FROM builds WHERE repo = ?1
ORDER BY created_at DESC, slug DESC LIMIT ?2`

/** A later build page: the same scan, starting below the cursor key. */
export const BUILD_PAGE_AFTER_SQL = `SELECT ${BUILD_PAGE_COLUMNS} FROM builds
WHERE repo = ?1 AND (created_at, slug) < (?3, ?4)
ORDER BY created_at DESC, slug DESC LIMIT ?2`

export const BOOTSTRAP_DDL = [
  // Reducer snapshots: additive and idempotent, so databases that predate the
  // table gain it on open.
  `CREATE TABLE IF NOT EXISTS reducer_snapshots (
    scope_kind TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    reducer TEXT NOT NULL,
    version INTEGER NOT NULL,
    cursor INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_kind, scope_key, reducer)
  )`,
  `CREATE TABLE IF NOT EXISTS scan_cadence (
    repo TEXT PRIMARY KEY REFERENCES repo_streams(repo) ON DELETE CASCADE,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operator_presence (
  repo TEXT NOT NULL, id TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL,
  started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, PRIMARY KEY (repo, id)
);`,
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
    node_writer_holder TEXT,
    node_writer_expires_at TEXT,
    node_writer_ttl_ms INTEGER,
    heartbeat_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    build TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    compatibility TEXT,
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
    heartbeat_at TEXT,
    tick TEXT
  )`,
  // Injected SQLite connections may leave foreign-key enforcement disabled.
  `CREATE TRIGGER IF NOT EXISTS repo_scan_cadence_delete AFTER DELETE ON repo_streams
    BEGIN DELETE FROM scan_cadence WHERE repo=old.repo; END`,
  `CREATE TABLE IF NOT EXISTS repo_events (
    repo TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    compatibility TEXT,
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
  `CREATE TABLE IF NOT EXISTS ticket_assets (
    repo TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    layout TEXT NOT NULL,
    manifest TEXT NOT NULL,
    size INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo, ticket_id, kind, name, revision)
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
  `CREATE INDEX IF NOT EXISTS events_node_rewrite_previous ON events
    (build, json_extract(payload, '$.previous'), seq) WHERE type = 'node.rewritten'`,
  REPO_CHANGE_DDL,
  OPEN_BUILDS_DDL,
] as const

type BuildRow = typeof builds.$inferSelect
/** The columns a `BuildRecord` is projected from. */
type BuildRecordRow = Pick<
  BuildRow,
  | 'slug'
  | 'repo'
  | 'ticket'
  | 'branch'
  | 'repoOrigin'
  | 'createdAt'
  | 'updatedAt'
  | 'heartbeatAt'
  | 'leaseHolder'
  | 'leaseExpiresAt'
>
type RepoRow = typeof repoStreams.$inferSelect

interface PreparedArtifact {
  kind: string
  blobRef: string
  metadata: Record<string, unknown>
}

export interface SqliteBuildStoreOptions {
  /** Preflight opens the existing schema without running initialization DDL. */
  bootstrap?: boolean
  database: Database
  blobs: BlobStore
  clock?: Clock
  /** Artifact retention (store/retention.ts): how many newest revisions of
   * each retention-managed dispatcher kind survive. Default 200. */
  retention?: { maxRevisions?: number }
}

function ticketAssetKey(repo: string, ticketId: string, kind: string, name: string) {
  return and(
    eq(ticketAssets.repo, repo),
    eq(ticketAssets.ticketId, ticketId),
    eq(ticketAssets.kind, kind),
    eq(ticketAssets.name, name),
  )
}

export class SqliteBuildStore implements BuildStore {
  readonly catalogIdentity = READ_CATALOG_IDENTITY
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
    if (opts.bootstrap !== false) {
      this.sqlite.exec('PRAGMA journal_mode = WAL')
      // Creating `open_builds` and its backfill happen together under the
      // write lock, so no writer interleaves between them; a file that already
      // has the table never backfills again.
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        const openBuildsFresh =
          this.sqlite
            .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'open_builds'")
            .get() === null
        for (const ddl of BOOTSTRAP_DDL) this.sqlite.exec(ddl)
        if (openBuildsFresh) this.sqlite.exec(OPEN_BUILDS_BACKFILL)
        this.sqlite.exec('COMMIT')
      } catch (error) {
        this.sqlite.exec('ROLLBACK')
        throw error
      }
      ensureBuildChangePositions(this.sqlite)
      ensureBuildListingFacts(this.sqlite)
      for (const table of ['events', 'repo_events']) {
        const columns = this.sqlite.query(`PRAGMA table_info('${table}')`).all() as {
          name: string
        }[]
        if (!columns.some((column) => column.name === 'compatibility'))
          this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN compatibility TEXT`)
      }
      // Stores created before `repo_origin` existed keep working: add the column
      // idempotently when a pre-existing table lacks it (the bootstrap DDL above
      // covers fresh stores). No migration framework — one guarded ALTER at open.
      const repoColumns = this.sqlite.query("PRAGMA table_info('repo_streams')").all() as {
        name: string
      }[]
      if (!repoColumns.some((column) => column.name === 'tick'))
        this.sqlite.exec('ALTER TABLE repo_streams ADD COLUMN tick TEXT')
      const columns = this.sqlite.query("PRAGMA table_info('builds')").all() as Array<{
        name: string
      }>
      if (!columns.some((column) => column.name === 'repo_origin')) {
        this.sqlite.exec('ALTER TABLE builds ADD COLUMN repo_origin TEXT')
      }
      for (const [name, type] of [
        ['node_writer_holder', 'TEXT'],
        ['node_writer_expires_at', 'TEXT'],
        ['node_writer_ttl_ms', 'INTEGER'],
      ]) {
        if (!columns.some((column) => column.name === name))
          this.sqlite.exec(`ALTER TABLE builds ADD COLUMN ${name} ${type}`)
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
    }
    this.db = drizzle(this.sqlite)
  }

  async inspectDispatcherOverlap(signal: AbortSignal) {
    signal.throwIfAborted()
    // Compare the actual, untouched catalog with this provider's requirements.
    // No migrations are run against the live database during preflight.
    const expected = new Database(':memory:')
    try {
      for (const ddl of BOOTSTRAP_DDL) expected.exec(ddl)
      ensureBuildChangePositions(expected)
      ensureBuildListingFacts(expected)
      // ALTER appends columns, and legacy creation-order columns have a DEFAULT
      // used only for backfill. Neither changes the target's runtime requirements.
      const catalog = (database: Database) => {
        const quote = (name: string) => `'${name.replaceAll("'", "''")}'`
        const objects = database
          .query(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all() as Array<{ type: string; name: string; sql: string }>
        return objects.map((object) => {
          if (object.type !== 'table') return object
          const columns = database
            .query(`PRAGMA table_xinfo(${quote(object.name)})`)
            .all() as Array<{
            cid: number
            name: string
            type: string
            notnull: number
            dflt_value: string | null
            pk: number
            hidden: number
          }>
          const indexes = database
            .query(`PRAGMA index_list(${quote(object.name)})`)
            .all() as Array<{
            name: string
            unique: number
            origin: string
            partial: number
          }>
          // Keep key order, collation and uniqueness, but ignore physical column
          // offsets and the automatically assigned index sequence number.
          const indexShapes = indexes
            .map((index) => ({
              name: index.name,
              unique: index.unique,
              origin: index.origin,
              partial: index.partial,
              columns: (
                database.query(`PRAGMA index_xinfo(${quote(index.name)})`).all() as Array<
                  Record<string, unknown>
                >
              ).map(({ cid: _cid, ...column }) => column),
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
          // PRAGMAs expose keys and foreign keys, but not CHECK constraints.
          // Retain balanced CHECK expressions so an older, narrower streams
          // constraint still requires cutover rather than being called equivalent.
          const checks: string[] = []
          const matcher = /\bCHECK\s*\(/gi
          for (const match of object.sql.matchAll(matcher)) {
            const begin = match.index + match[0].length
            let depth = 1,
              quoted = false,
              end = begin
            for (; end < object.sql.length && depth; end++) {
              const char = object.sql[end]
              if (char === "'") {
                if (quoted && object.sql[end + 1] === "'") {
                  end++
                  continue
                }
                quoted = !quoted
              }
              if (!quoted) {
                if (char === '(') depth++
                if (char === ')') depth--
              }
            }
            checks.push(
              object.sql
                .slice(begin, end - 1)
                .replace(/\s+/g, ' ')
                .trim(),
            )
          }
          return {
            type: object.type,
            name: object.name,
            columns: columns
              .map(({ cid: _cid, ...column }) => ({
                ...column,
                dflt_value:
                  column.name === 'creation_seq' &&
                  (object.name === 'sessions' || object.name === 'streams') &&
                  column.dflt_value === '0'
                    ? null
                    : column.dflt_value,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            indexes: indexShapes,
            foreignKeys: database.query(`PRAGMA foreign_key_list(${quote(object.name)})`).all(),
            checks,
          }
        })
      }
      const compatible = JSON.stringify(catalog(this.sqlite)) === JSON.stringify(catalog(expected))
      return {
        compatible,
        evidence: compatible
          ? 'SQLite catalog matches target provider requirements without migration'
          : 'SQLite catalog differs from target provider requirements; cutover required before initialization',
      }
    } finally {
      expected.close()
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
      ...(row.tick ? { tick: structuredClone(row.tick) } : {}),
      repo: row.repo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
      ...(row.leaseHolder && row.leaseExpiresAt
        ? { lease: { holder: row.leaseHolder, expiresAt: row.leaseExpiresAt } }
        : {}),
    }
  }

  private toRecord(row: BuildRecordRow): BuildRecord {
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
    const created = validateCreatedEvent(input)
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
      if (created !== undefined) this.appendInTx(input.slug, created)
      return this.toRecord(this.requireBuild(input.slug))
    })
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    const row = this.buildRow(slug)
    return row ? this.toRecord(row) : null
  }

  async getRepoChangePosition(repo: string): Promise<string> {
    const row = this.sqlite
      .query<{ position: string }, [string]>(
        'SELECT CAST(position AS TEXT) AS position FROM repo_change_positions WHERE repo = ?',
      )
      .get(repo)
    return row?.position ?? '0'
  }

  async listBuildsChangedSince(repo: string, position: string): Promise<ChangedBuilds> {
    const since = parseChangePosition(position)
    const rows = this.sqlite
      .query<{ head: string; slug: string | null; position: string | null }, [string, bigint]>(
        CHANGED_BUILDS_SQL,
      )
      .all(repo, since)
    return {
      position: rows[0]?.head ?? '0',
      builds: rows.flatMap((row) =>
        row.slug !== null && row.position !== null
          ? [{ slug: row.slug, position: row.position }]
          : [],
      ),
    }
  }

  async listBuildsPage(repo: string, opts: BuildPageOptions = {}): Promise<BuildPage> {
    const limit = resolveBuildPageLimit(opts.limit)
    const filters = resolveBuildPageFilters(opts)
    const cursor =
      opts.cursor === undefined
        ? undefined
        : requireBuildPageCursorOrder(decodeBuildPageCursor(opts.cursor), filters)
    const order = buildPageOrder(filters)
    type PageRow = Omit<BuildRecordRow, 'ticket'> & { ticket: string | null; cursorAt?: string }
    let rows: PageRow[]
    if (hasBuildPageFilters(filters)) {
      const query = filteredBuildPageQuery(repo, limit + 1, filters, cursor)
      rows = this.sqlite.query<PageRow, (string | number)[]>(query.sql).all(...query.params)
    } else {
      rows = cursor
        ? this.sqlite
            .query<PageRow, [string, number, string, string]>(BUILD_PAGE_AFTER_SQL)
            .all(repo, limit + 1, cursor.at, cursor.slug)
        : this.sqlite.query<PageRow, [string, number]>(BUILD_PAGE_SQL).all(repo, limit + 1)
    }
    const page = rows.slice(0, limit)
    const builds = page.map(({ cursorAt: _, ...row }) =>
      this.toRecord({ ...row, ticket: row.ticket === null ? null : JSON.parse(row.ticket) }),
    )
    const last = page.at(-1)
    return {
      builds,
      next:
        rows.length > limit && last
          ? encodeBuildPageCursor({ order, at: last.cursorAt ?? last.createdAt, slug: last.slug })
          : null,
    }
  }

  async listBuildsForRepo(repo: string): Promise<BuildRecord[]> {
    return this.db
      .select()
      .from(builds)
      .where(eq(builds.repo, repo))
      .orderBy(asc(builds.createdAt), asc(builds.slug))
      .all()
      .map((row) => this.toRecord(row))
  }

  async listBuilds(): Promise<BuildRecord[]> {
    const rows = this.db
      .select()
      .from(builds)
      .orderBy(asc(builds.createdAt), asc(builds.slug))
      .all()
    return rows.map((row) => this.toRecord(row))
  }

  async getNodeRewrite(slug: string, previous?: string, beforePrevious?: string) {
    this.requireBuild(slug)
    const row = (
      beforePrevious !== undefined
        ? this.sqlite
            .query(`SELECT payload FROM events
          WHERE type = 'node.rewritten' AND build = ? AND seq < (
            SELECT seq FROM events WHERE type = 'node.rewritten' AND build = ?
              AND json_extract(payload, '$.previous') = ? ORDER BY seq DESC LIMIT 1
          ) ORDER BY seq DESC LIMIT 1`)
            .get(slug, slug, beforePrevious)
        : previous === undefined
          ? this.sqlite
              .query(`SELECT payload FROM events
          WHERE type = 'node.rewritten' AND build = ? ORDER BY seq DESC LIMIT 1`)
              .get(slug)
          : this.sqlite
              .query(`SELECT payload FROM events
          WHERE type = 'node.rewritten' AND build = ?
            AND json_extract(payload, '$.previous') = ?
          ORDER BY seq DESC LIMIT 1`)
              .get(slug, previous)
    ) as { payload: string } | null
    return row ? eventPayloadSchemas['node.rewritten'].parse(JSON.parse(row.payload)) : null
  }

  async listOpenBuilds(repo: string): Promise<OpenBuild[]> {
    const records = this.db
      .select({ build: builds })
      .from(openBuilds)
      .innerJoin(builds, eq(builds.slug, openBuilds.slug))
      .where(eq(openBuilds.repo, repo))
      .orderBy(asc(builds.createdAt), asc(builds.slug))
      .all()
      .map((row) => this.toRecord(row.build))
    const digests = await readPersistedBuildDigests(this, repo, records)
    return records.map((record) => ({ record, digest: digests.get(record.slug)! }))
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    return readPersistedBuildDigests(
      this,
      repo,
      this.db
        .select()
        .from(builds)
        .where(eq(builds.repo, repo))
        .all()
        .map((row) => this.toRecord(row)),
    )
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
        compatibility: validated.compatibility,
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
      compatibility: validated.compatibility,
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

  async appendWithArtifactsIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    artifactInputs: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] } | null> {
    validateExpectedSeq(expectedSeq)
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
      if (this.currentSeqInTx(slug) !== expectedSeq) return null
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
              ...(row.compatibility ? { compatibility: row.compatibility } : {}),
            }) as AbEvent,
        )
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      // Hosted budget: held build-event reads poll at most once per second
      // (AUT-394) — not the 25 ms stream default, which is presentation
      // content's cadence.
      pollMs: EVENT_WAIT_POLL_MS,
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

  async claimNodeWriter(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireBuild(slug)
      const now = this.clock().getTime()
      const heldByOther =
        row.nodeWriterHolder !== null &&
        row.nodeWriterHolder !== holder &&
        row.nodeWriterExpiresAt !== null &&
        Date.parse(row.nodeWriterExpiresAt) > now
      if (heldByOther) return false
      this.db
        .update(builds)
        .set({
          nodeWriterHolder: holder,
          nodeWriterExpiresAt: new Date(now + ttlMs).toISOString(),
          nodeWriterTtlMs: ttlMs,
          updatedAt: new Date(now).toISOString(),
        })
        .where(eq(builds.slug, slug))
        .run()
      return true
    })
  }

  async renewNodeWriter(slug: string, holder: string): Promise<boolean> {
    return this.writeTx(() => {
      const row = this.requireBuild(slug)
      const now = this.clock().getTime()
      const holds =
        row.nodeWriterHolder === holder &&
        row.nodeWriterExpiresAt !== null &&
        Date.parse(row.nodeWriterExpiresAt) > now
      if (!holds) return false
      const nowIso = new Date(now).toISOString()
      this.db
        .update(builds)
        .set({
          nodeWriterExpiresAt: new Date(now + (row.nodeWriterTtlMs ?? 0)).toISOString(),
          updatedAt: nowIso,
        })
        .where(eq(builds.slug, slug))
        .run()
      return true
    })
  }

  async releaseNodeWriter(slug: string, holder: string): Promise<void> {
    this.writeTx(() => {
      const row = this.requireBuild(slug)
      if (row.nodeWriterHolder !== holder) return
      this.db
        .update(builds)
        .set({
          nodeWriterHolder: null,
          nodeWriterExpiresAt: null,
          nodeWriterTtlMs: null,
          updatedAt: this.now(),
        })
        .where(eq(builds.slug, slug))
        .run()
    })
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

  async getScanCadence(repo: string): Promise<ScanCadence | null> {
    const row = this.sqlite.query('SELECT value FROM scan_cadence WHERE repo=?1').get(repo) as {
      value: string
    } | null
    if (!row) return null
    try {
      return scanCadenceSchema.safeParse(JSON.parse(row.value)).data ?? null
    } catch {
      return null
    }
  }
  async putScanCadence(
    repo: string,
    input: ScanCadence,
    allowClockRollback = false,
  ): Promise<void> {
    const cadence = scanCadenceSchema.parse(input)
    this.writeTx(() => {
      this.requireRepo(repo)
      this.sqlite
        .query(`INSERT INTO scan_cadence (repo,value) VALUES (?1,?2)
        ON CONFLICT(repo) DO UPDATE SET value=excluded.value
        WHERE CASE WHEN json_valid(scan_cadence.value) THEN COALESCE(
          json_extract(scan_cadence.value,'$.scanSeq') <> ?3 OR ?4
          OR json_extract(scan_cadence.value,'$.startedAt') <= ?5, 1) ELSE 1 END`)
        .run(
          repo,
          JSON.stringify(cadence),
          cadence.scanSeq,
          Number(allowClockRollback),
          cadence.startedAt,
        )
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
    const row = this.sqlite
      .query(`INSERT INTO operator_presence (repo,id,host,pid,started_at,heartbeat_at)
      VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(repo,id) DO UPDATE SET
      host=excluded.host, pid=excluded.pid, heartbeat_at=MAX(operator_presence.heartbeat_at,excluded.heartbeat_at)
      RETURNING repo,id,host,pid,started_at AS startedAt,heartbeat_at AS heartbeatAt`)
      .get(repo, identity.id, identity.host, identity.pid, identity.startedAt, this.now())
    return row as OperatorPresence
  }

  async removeOperatorPresence(repo: string, id: string): Promise<void> {
    id = operatorIdentitySchema.shape.id.parse(id)
    this.sqlite.query('DELETE FROM operator_presence WHERE repo=?1 AND id=?2').run(repo, id)
  }

  async listOperatorPresence(repo: string): Promise<OperatorPresence[]> {
    return this.sqlite
      .query(`SELECT repo,id,host,pid,started_at AS startedAt,heartbeat_at AS heartbeatAt
      FROM operator_presence WHERE repo=?1 AND heartbeat_at>?2 ORDER BY id`)
      .all(
        repo,
        new Date(this.clock().getTime() - OPERATOR_PRESENCE_TTL_MS).toISOString(),
      ) as OperatorPresence[]
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const row = this.repoRow(repo)
    return row ? this.toRepoRecord(row) : null
  }

  private appendRepoInTx(
    repo: string,
    validated: RepositoryEventWrite,
    ts = this.now(),
  ): RepositoryEventEnvelope {
    this.requireRepo(repo)
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
        compatibility: validated.compatibility,
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
      compatibility: validated.compatibility,
    }
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const validated = validateRepositoryEventWrite(event)
    return this.writeTx(() => this.appendRepoInTx(repo, validated)) as RepositoryEventEnvelope<T>
  }

  async appendRepoIfCurrent<T extends RepositoryEventType>(
    repo: string,
    expectedSeq: number,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateRepositoryEventWrite(event)
    return this.writeTx(() => {
      // BEGIN IMMEDIATE serializes this comparison and append across every
      // SQLite connection/process using the same store file.
      this.requireRepo(repo)
      const row = this.db
        .select({ max: sql<number | null>`max(${repoEvents.seq})` })
        .from(repoEvents)
        .where(eq(repoEvents.repo, repo))
        .get()
      if ((row?.max ?? 0) !== expectedSeq) return null
      return this.appendRepoInTx(repo, validated) as RepositoryEventEnvelope<T>
    })
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
              ...(row.compatibility ? { compatibility: row.compatibility } : {}),
            }) as RepositoryEvent,
        )
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      // Hosted budget: held repository-event reads poll at most once per
      // second (AUT-394) — not the 25 ms stream default, which is
      // presentation content's cadence.
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  async getRepositoryTail(
    repo: string,
    since = 0,
    opts?: EventReadOptions,
  ): Promise<RepositoryEvent[]> {
    validateEventCursor(since)
    if (opts?.through !== undefined) validateEventCursor(opts.through)
    return readEventsWithWait({
      read: async () => {
        this.requireRepo(repo)
        const head = this.snapshotTail({ kind: 'repo', repo })!
        assertResumeWindow({ kind: 'repo', repo }, since, head)
        const rows = this.db
          .select()
          .from(repoEvents)
          .where(
            and(
              eq(repoEvents.repo, repo),
              gt(repoEvents.seq, since),
              lte(repoEvents.seq, Math.min(head, opts?.through ?? head)),
            ),
          )
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
              ...(row.compatibility ? { compatibility: row.compatibility } : {}),
            }) as RepositoryEvent,
        )
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      pollMs: EVENT_WAIT_POLL_MS,
    })
  }

  async getRepoHighWater(repo: string): Promise<number> {
    this.requireRepo(repo)
    const row = this.db
      .select({ seq: sql<number | null>`max(${repoEvents.seq})` })
      .from(repoEvents)
      .where(eq(repoEvents.repo, repo))
      .get()
    return row?.seq ?? 0
  }

  /** The scope's log tail, or `undefined` for a scope that does not exist. */
  private snapshotTail(scope: SnapshotScope): number | undefined {
    if (scope.kind === 'build') {
      const row = this.sqlite
        .query(
          'SELECT (SELECT COALESCE(MAX(seq), 0) FROM events WHERE build = ?1) AS tail FROM builds WHERE slug = ?1',
        )
        .get(scope.slug) as { tail: number } | null
      return row?.tail
    }
    const row = this.sqlite
      .query(
        'SELECT (SELECT COALESCE(MAX(seq), 0) FROM repo_events WHERE repo = ?1) AS tail FROM repo_streams WHERE repo = ?1',
      )
      .get(scope.repo) as { tail: number } | null
    return row?.tail
  }

  async getReducerValue(
    scope: ReducerValueScope,
    request: ReducerValueRequest,
  ): Promise<ReducerValue> {
    if (scope.kind === 'rollup') return readRollupValue(scope, request, this.rollupStorage(scope))
    // Reject invalid requests before touching storage.
    resolveReducerValue(scope, request)
    return readReducerValue(scope, request, {
      highWater: async () => {
        const tail = this.snapshotTail(scope)
        if (tail === undefined) throw new Error('unknown reducer scope')
        return tail
      },
      events: async (since, through) => {
        const key = scope.kind === 'build' ? scope.slug : scope.repo
        const rows = this.sqlite
          .query(
            scope.kind === 'build'
              ? 'SELECT * FROM events WHERE build=?1 AND seq>?2 AND seq<=?3 ORDER BY seq'
              : 'SELECT * FROM repo_events WHERE repo=?1 AND seq>?2 AND seq<=?3 ORDER BY seq',
          )
          .all(key, since, through) as {
          build?: string
          repo?: string
          seq: number
          ts: string
          actor: string
          type: string
          payload: string
          compatibility?: string | null
        }[]
        return rows.map((row) => ({
          ...row,
          actor: JSON.parse(row.actor),
          payload: JSON.parse(row.payload),
          compatibility: row.compatibility ? JSON.parse(row.compatibility) : undefined,
        })) as (AbEvent | RepositoryEvent)[]
      },
      put: (key, snapshot) => this.putSnapshot(scope, key, snapshot),
      read: async (key) => {
        const row = this.sqlite
          .query(
            'SELECT version, cursor, state FROM reducer_snapshots WHERE scope_kind=?1 AND scope_key=?2 AND reducer=?3',
          )
          .get(scope.kind, scope.kind === 'build' ? scope.slug : scope.repo, key) as {
          version: number
          cursor: number
          state: string
        } | null
        if (!row) return null
        let state: unknown = null
        try {
          state = JSON.parse(row.state)
        } catch {
          /* malformed cache */
        }
        return { snapshot: { version: row.version, cursor: row.cursor, state }, token: row.state }
      },
      repair: async (key, observed, snapshot) => {
        return this.sqlite.transaction(() => {
          const tail = this.snapshotTail(scope)
          if (tail === undefined || snapshot.cursor > tail) return false
          return (
            this.sqlite
              .query(
                `UPDATE reducer_snapshots SET version=?1, cursor=?2, state=?3, updated_at=?4 WHERE scope_kind=?5 AND scope_key=?6 AND reducer=?7 AND version=?8 AND cursor=?9 AND state=?10`,
              )
              .run(
                snapshot.version,
                snapshot.cursor,
                JSON.stringify(snapshot.state),
                this.clock().toISOString(),
                scope.kind,
                scope.kind === 'build' ? scope.slug : scope.repo,
                key,
                observed.snapshot.version,
                observed.snapshot.cursor,
                observed.token,
              ).changes > 0
          )
        })()
      },
    })
  }

  /** Same-instance readers queue here before contending on the lease row. */
  private readonly rollupLocks = new KeyedMutex()

  /** The rollup engine's port over `reducer_snapshots` (SPEC §7.7). The
   * per-key serialization is a lease row `('rollup-lease', repo, key)` that
   * every instance and process sharing the database contends on: its scope
   * kind is neither `build` nor `repo`, so the public snapshot API cannot
   * address it. A crashed holder's lease expires by the store clock; its
   * uncommitted work is lost, never half-applied. */
  private rollupStorage(scope: RollupScope): RollupStorage {
    const repo = scope.repo
    const head = () => this.getRepoChangePosition(repo)
    const read = async (key: string) => {
      const row = this.sqlite
        .query<{ version: number; state: string }, [string, string]>(
          "SELECT version, state FROM reducer_snapshots WHERE scope_kind='rollup' AND scope_key=?1 AND reducer=?2",
        )
        .get(repo, key)
      if (row === null) return null
      let state: unknown = null
      try {
        state = JSON.parse(row.state)
      } catch {
        /* malformed row: a miss */
      }
      return { version: row.version, state, token: row.state }
    }
    const leaseRow = (key: string) =>
      this.sqlite
        .query<{ state: string }, [string, string]>(
          "SELECT state FROM reducer_snapshots WHERE scope_kind='rollup-lease' AND scope_key=?1 AND reducer=?2",
        )
        .get(repo, key)
    const leaseHolder = (state: string | undefined): { holder?: string; expiresAt?: number } => {
      try {
        return state === undefined ? {} : JSON.parse(state)
      } catch {
        return {}
      }
    }
    const writeLease = (key: string, holder: string, observed: string | null): boolean => {
      const state = JSON.stringify({ holder, expiresAt: this.clock().getTime() + ROLLUP_LEASE_MS })
      const now = this.clock().toISOString()
      if (observed === null)
        return (
          this.sqlite
            .query(
              `INSERT INTO reducer_snapshots (scope_kind, scope_key, reducer, version, cursor, state, updated_at)
               VALUES ('rollup-lease', ?1, ?2, 1, 0, ?3, ?4) ON CONFLICT DO NOTHING`,
            )
            .run(repo, key, state, now).changes > 0
        )
      return (
        this.sqlite
          .query(
            "UPDATE reducer_snapshots SET state=?3, updated_at=?4 WHERE scope_kind='rollup-lease' AND scope_key=?1 AND reducer=?2 AND state=?5",
          )
          .run(repo, key, state, now, observed).changes > 0
      )
    }
    /** Take the lease when free or expired by the store clock. */
    const tryAcquire = (key: string, holder: string): boolean =>
      this.writeTx(() => {
        const row = leaseRow(key)
        if (row === null) return writeLease(key, holder, null)
        const { expiresAt } = leaseHolder(row.state)
        if (typeof expiresAt === 'number' && expiresAt > this.clock().getTime()) return false
        return writeLease(key, holder, row.state)
      })
    const holds = (key: string, holder: string): string | null => {
      const row = leaseRow(key)
      return row !== null && leaseHolder(row.state).holder === holder ? row.state : null
    }
    const advanceFor = (holder: string, renew: () => Promise<void>): RollupAdvance => ({
      head,
      read,
      changed: (since) => this.listBuildsChangedSince(repo, since),
      buildValue: async (slug, request) =>
        this.snapshotTail({ kind: 'build', slug }) === undefined
          ? null
          : this.getReducerValue({ kind: 'build', slug }, request),
      contributions: async (key, slugs) => {
        const found = new Map<string, unknown>()
        for (let i = 0; i < slugs.length; i += 500) {
          const chunk = slugs.slice(i, i + 500)
          const rows = this.sqlite
            .query<{ scope_key: string; state: string }, string[]>(
              `SELECT scope_key, state FROM reducer_snapshots WHERE scope_kind='build' AND reducer=?1 AND scope_key IN (${chunk.map((_, j) => `?${j + 2}`).join(',')})`,
            )
            .all(key, ...chunk)
          for (const row of rows) {
            try {
              found.set(row.scope_key, JSON.parse(row.state))
            } catch {
              found.set(row.scope_key, null) // malformed: the engine recomputes
            }
          }
        }
        return found
      },
      commit: async (key, observed, row, contributionKey, writes) =>
        this.writeTx(() => {
          if (holds(key, holder) === null) return false
          const stored = this.sqlite
            .query<{ state: string }, [string, string]>(
              "SELECT state FROM reducer_snapshots WHERE scope_kind='rollup' AND scope_key=?1 AND reducer=?2",
            )
            .get(repo, key)
          if ((stored?.state ?? null) !== observed) return false
          const now = this.clock().toISOString()
          this.sqlite
            .query(
              `INSERT INTO reducer_snapshots (scope_kind, scope_key, reducer, version, cursor, state, updated_at)
               VALUES ('rollup', ?1, ?2, ?3, 0, ?4, ?5)
               ON CONFLICT (scope_kind, scope_key, reducer) DO UPDATE SET
                 version = excluded.version, cursor = 0, state = excluded.state, updated_at = excluded.updated_at`,
            )
            .run(repo, key, row.version, JSON.stringify(row.state), now)
          const upsert = this.sqlite.query(
            `INSERT INTO reducer_snapshots (scope_kind, scope_key, reducer, version, cursor, state, updated_at)
             VALUES ('build', ?1, ?2, ?3, 0, ?4, ?5)
             ON CONFLICT (scope_kind, scope_key, reducer) DO UPDATE SET
               version = excluded.version, cursor = 0, state = excluded.state, updated_at = excluded.updated_at`,
          )
          const remove = this.sqlite.query(
            "DELETE FROM reducer_snapshots WHERE scope_kind='build' AND scope_key=?1 AND reducer=?2",
          )
          for (const [slug, contribution] of writes) {
            if (contribution === null) remove.run(slug, contributionKey)
            else upsert.run(slug, contributionKey, row.version, JSON.stringify(contribution), now)
          }
          return true
        }),
      renew,
    })
    return {
      now: () => this.clock(),
      buildReadConcurrency: 16,
      head,
      read,
      serialize: (key, run) =>
        this.rollupLocks.run(key, async () => {
          const holder = crypto.randomUUID()
          const started = performance.now()
          let delay = 25
          while (!tryAcquire(key, holder)) {
            if (performance.now() - started > ROLLUP_LEASE_WAIT_MS)
              throw new RollupLeaseTimeoutError(key)
            await Bun.sleep(delay)
            delay = Math.min(250, delay * 2)
          }
          try {
            return await run(
              advanceFor(holder, async () => {
                const renewed = this.writeTx(() => {
                  const observed = holds(key, holder)
                  return observed !== null && writeLease(key, holder, observed)
                })
                if (!renewed) throw new RollupLeaseLostError(key)
              }),
            )
          } finally {
            this.writeTx(() =>
              this.sqlite
                .query(
                  "DELETE FROM reducer_snapshots WHERE scope_kind='rollup-lease' AND scope_key=?1 AND reducer=?2 AND state=?3",
                )
                .run(repo, key, holds(key, holder) ?? ''),
            )
          }
        }),
    }
  }

  async getReducerSnapshot(
    scope: SnapshotScope,
    reducer: string,
    version: number,
  ): Promise<ReducerSnapshot | null> {
    assertPublicSnapshotReducer(reducer)
    const tail = this.snapshotTail(scope)
    if (tail === undefined) return null
    const row = this.sqlite
      .query(
        'SELECT version, cursor, state FROM reducer_snapshots WHERE scope_kind = ?1 AND scope_key = ?2 AND reducer = ?3',
      )
      .get(scope.kind, scope.kind === 'build' ? scope.slug : scope.repo, reducer) as {
      version: number
      cursor: number
      state: string
    } | null
    if (row === null || row.version !== version || row.cursor > tail) return null
    try {
      return { version: row.version, cursor: row.cursor, state: JSON.parse(row.state) }
    } catch {
      return null
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
    const tail = this.snapshotTail(scope)
    if (tail === undefined || snapshot.cursor > tail) return false
    // One statement: the stored cursor never decreases, whatever interleaves.
    const result = this.sqlite
      .query(
        `INSERT INTO reducer_snapshots (scope_kind, scope_key, reducer, version, cursor, state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (scope_kind, scope_key, reducer) DO UPDATE SET
           version = excluded.version, cursor = excluded.cursor,
           state = excluded.state, updated_at = excluded.updated_at
         WHERE excluded.version >= reducer_snapshots.version AND (excluded.cursor > reducer_snapshots.cursor
            OR (excluded.cursor = reducer_snapshots.cursor AND excluded.version > reducer_snapshots.version))`,
      )
      .run(
        scope.kind,
        scope.kind === 'build' ? scope.slug : scope.repo,
        reducer,
        snapshot.version,
        snapshot.cursor,
        JSON.stringify(snapshot.state ?? null),
        this.clock().toISOString(),
      )
    return result.changes > 0
  }

  async getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    this.requireRepo(repo)
    // Two queries, mirroring the oracle's derivation: the latest
    // run-started anchor, then one select of durable types plus the tail
    // from that anchor. No new index: local journals are small and the
    // existing (repo, seq) PK index keeps the anchor scan acceptable.
    //
    // The two drizzle reads are synchronous, so there is no in-process await
    // point between them — but a concurrent writer from another process can
    // still land between the two statements in real time (AUT-551): a
    // first-ever `dispatcher.run-started` appended between them would be
    // invisible to the probe, absent from the durable-only selection, yet
    // present in the journal by the time this method returns. The shared
    // helper below closes that window with a one-shot anchor re-check on the
    // durable-only outcome: a durable-only result is returned only when the
    // journal was anchor-free as of the final probe. When the probe *does*
    // find an anchor, the anchored select's `gte(seq, anchor)` arm is
    // monotone-inclusive, so any later run-started is picked up by that same
    // select; an append after the final re-probe is an ordinary post-read
    // concurrent append, not this race.
    return readRepoStateEventsWithAnchorRecheck(
      async () => {
        // This probe is a LIMIT 1 select, not an aggregate: it returns zero or
        // one rows, so row absence is the deliberate empty-journal signal — no
        // MAX() NULL semantics involved (contrast the Postgres adapter's
        // MAX(seq) probe, which always returns one row and must test the NULL
        // explicitly). The `anchor === undefined` branch in the select below is
        // the explicit durable-only path; a null anchor must never reach the
        // gte(repoEvents.seq, anchor) arm (in either dialect the comparison is
        // never true, so the durable-only outcome would then survive only by
        // accident), and the no-anchor case must not degenerate into
        // gte(repoEvents.seq, 0), which would select the whole journal.
        const anchorRows = this.db
          .select({ seq: repoEvents.seq })
          .from(repoEvents)
          .where(and(eq(repoEvents.repo, repo), eq(repoEvents.type, 'dispatcher.run-started')))
          .orderBy(desc(repoEvents.seq))
          .limit(1)
          .all()
        return anchorRows[0]?.seq
      },
      async (anchor) => {
        const durable = inArray(repoEvents.type, [...REPOSITORY_STATE_EVENT_TYPES])
        const latest = REPOSITORY_LATEST_EVENT_TYPES.map((type) =>
          and(
            eq(repoEvents.type, type),
            sql`${repoEvents.seq} = (SELECT seq FROM repo_events WHERE repo = ${repo} AND type = ${type} ORDER BY seq DESC LIMIT 1)`,
          ),
        )
        const tail =
          anchor === undefined
            ? undefined
            : and(
                gte(repoEvents.seq, anchor),
                sql`${repoEvents.type} NOT IN (${sql.join(
                  REPOSITORY_LATEST_EVENT_TYPES.map((type) => sql`${type}`),
                  sql`, `,
                )})`,
              )
        const rows = this.db
          .select()
          .from(repoEvents)
          .where(and(eq(repoEvents.repo, repo), or(durable, tail, ...latest)))
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
              ...(row.compatibility ? { compatibility: row.compatibility } : {}),
            }) as RepositoryEvent,
        )
      },
    )
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

  async ticketAssetLimits(_repo: string): Promise<TicketAssetLimits> {
    return { ...DEFAULT_TICKET_ASSET_LIMITS }
  }

  private toTicketAssetMeta(row: typeof ticketAssets.$inferSelect): TicketAssetMeta {
    return {
      repo: row.repo,
      ticketId: row.ticketId,
      kind: row.kind,
      name: row.name,
      revision: row.revision,
      layout: row.layout,
      size: row.size,
      entries: row.manifest,
      createdAt: row.createdAt,
    }
  }

  async putTicketAsset(
    repo: string,
    ticketId: string,
    asset: TicketAssetInput,
  ): Promise<TicketAssetMeta> {
    const size = validateTicketAssetInput(asset)
    const entries = await storeTicketAssetBlobs(this.blobs, asset.entries)
    return this.writeTx(() => {
      const latest = this.db
        .select({ revision: ticketAssets.revision })
        .from(ticketAssets)
        .where(ticketAssetKey(repo, ticketId, asset.kind, asset.name))
        .orderBy(desc(ticketAssets.revision))
        .limit(1)
        .get()
      const row: typeof ticketAssets.$inferInsert = {
        repo,
        ticketId,
        kind: asset.kind,
        name: asset.name,
        revision: (latest?.revision ?? -1) + 1,
        layout: asset.layout,
        manifest: entries,
        size,
        removed: 0,
        createdAt: this.clock().toISOString(),
      }
      this.db.insert(ticketAssets).values(row).run()
      return this.toTicketAssetMeta(row as typeof ticketAssets.$inferSelect)
    })
  }

  async getTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
    rev?: number,
  ): Promise<TicketAsset | null> {
    const scoped = ticketAssetKey(repo, ticketId, kind, name)
    const row =
      rev === undefined
        ? this.db
            .select()
            .from(ticketAssets)
            .where(scoped)
            .orderBy(desc(ticketAssets.revision))
            .limit(1)
            .get()
        : this.db
            .select()
            .from(ticketAssets)
            .where(and(scoped, eq(ticketAssets.revision, rev)))
            .get()
    if (!row || row.removed) return null
    return loadTicketAsset(this.blobs, this.toTicketAssetMeta(row))
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
    if (opts?.revisions) {
      return this.db
        .select()
        .from(ticketAssets)
        .where(and(eq(ticketAssets.repo, repo), eq(ticketAssets.ticketId, ticketId)))
        .orderBy(asc(ticketAssets.kind), asc(ticketAssets.name), asc(ticketAssets.revision))
        .all()
        .filter((row) => !row.removed)
        .map((row) => summarizeTicketAsset(this.toTicketAssetMeta(row)))
    }
    // Current assets: seek from head to head (see ticket-asset-heads.ts), so
    // only head rows are read, however many revisions each name retains.
    type NameRow = { kind: string; name: string }
    type HeadRow = {
      repo: string
      ticket_id: string
      kind: string
      name: string
      revision: number
      layout: 'file' | 'tree'
      manifest: string
      size: number
      removed: number
      created_at: string
    }
    const out: TicketAssetSummary[] = []
    let at = this.sqlite.query(ASSET_FIRST_NAME).get(repo, ticketId) as NameRow | null
    while (at) {
      const head = this.sqlite.query(ASSET_HEAD).get(repo, ticketId, at.kind, at.name) as HeadRow
      if (!head.removed)
        out.push(
          summarizeTicketAsset({
            repo: head.repo,
            ticketId: head.ticket_id,
            kind: head.kind,
            name: head.name,
            revision: head.revision,
            layout: head.layout,
            size: head.size,
            entries: JSON.parse(head.manifest) as TicketAssetMeta['entries'],
            createdAt: head.created_at,
          }),
        )
      at =
        (this.sqlite
          .query(ASSET_NEXT_NAME_SAME_KIND)
          .get(repo, ticketId, at.kind, at.name) as NameRow | null) ??
        (this.sqlite
          .query(ASSET_FIRST_NAME_NEXT_KIND)
          .get(repo, ticketId, at.kind) as NameRow | null)
    }
    return out
  }

  async removeTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
  ): Promise<TicketAssetMeta | null> {
    return this.writeTx(() => {
      const latest = this.db
        .select()
        .from(ticketAssets)
        .where(ticketAssetKey(repo, ticketId, kind, name))
        .orderBy(desc(ticketAssets.revision))
        .limit(1)
        .get()
      if (!latest || latest.removed) return null
      this.db
        .insert(ticketAssets)
        .values({
          ...latest,
          revision: latest.revision + 1,
          manifest: [],
          size: 0,
          removed: 1,
          createdAt: this.clock().toISOString(),
        })
        .run()
      return this.toTicketAssetMeta(latest)
    })
  }

  async beginRepoTick(repo: string, holder: string): Promise<string | null> {
    return this.writeTx(() => {
      const row = this.requireRepo(repo)
      if (
        row.leaseHolder !== holder ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) <= this.clock().getTime()
      )
        return null
      const startedAt = this.now()
      const tick: RepoTickObservation = {
        run: holder,
        open: { startedAt },
        ...(row.tick?.finished ? { finished: row.tick.finished } : {}),
      }
      this.db
        .update(repoStreams)
        .set({ tick, updatedAt: startedAt })
        .where(eq(repoStreams.repo, repo))
        .run()
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
    return this.writeTx(() => {
      const row = this.requireRepo(repo)
      if (
        row.leaseHolder !== holder ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) <= this.clock().getTime()
      )
        return null
      if (row.tick?.run !== holder || !row.tick.open) throw new Error('no open repository tick')
      const completedAt = this.now()
      const envelopes = validated.map((event) =>
        this.appendRepoInTx(repo, event, completedAt),
      ) as RepositoryEvent[]
      const observation: RepoTickObservation = {
        run: holder,
        finished: { ...completion, run: holder, startedAt: row.tick.open.startedAt, completedAt },
      }
      this.db
        .update(repoStreams)
        .set({ tick: observation, updatedAt: completedAt })
        .where(eq(repoStreams.repo, repo))
        .run()
      return { observation, events: envelopes }
    })
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

  async appendSessionEventIfCurrent<T extends SessionEventType>(
    id: string,
    expectedSeq: number,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T> | null> {
    validateExpectedSeq(expectedSeq)
    const validated = validateSessionEventWrite(event)
    return this.writeTx(() => {
      // BEGIN IMMEDIATE serializes this comparison and append across every
      // SQLite connection/process using the same store file.
      const row = this.db
        .select({ count: sql<number>`count(*)` })
        .from(sessionEvents)
        .where(eq(sessionEvents.session, id))
        .get()
      if ((row?.count ?? 0) !== expectedSeq) return null
      return this.appendSessionInTx(id, validated) as SessionEventEnvelope<T>
    })
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
    return readEventsWithWait({
      read,
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
      // Hosted budget: held session-event reads poll at most once per second
      // (AUT-394), matching the build and repository event reads — not the
      // 25 ms stream default, which is presentation content's cadence.
      pollMs: EVENT_WAIT_POLL_MS,
    })
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
        if (committed.stale === false) return committed.record
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
  opts: { clock?: Clock; retention?: { maxRevisions?: number }; bootstrap?: boolean } = {},
): SqliteBuildStore {
  if (opts.bootstrap !== false) mkdirSync(rootDir, { recursive: true })
  const database = new Database(join(rootDir, 'autobuild.sqlite'), {
    readwrite: true,
    create: opts.bootstrap !== false,
  })
  const blobs = new DirBlobStore(join(rootDir, 'blobs'))
  return new SqliteBuildStore({
    database,
    blobs,
    bootstrap: opts.bootstrap,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.retention ? { retention: opts.retention } : {}),
  })
}
