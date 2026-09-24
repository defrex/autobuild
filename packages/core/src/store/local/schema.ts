/**
 * Drizzle schema for the local SQLite BuildStore (SPEC §7.1): simple,
 * normalized, boring. Lease + heartbeat are mutable liveness columns on
 * `builds`, never events (§15.2.6). Events and artifacts store JSON in text
 * columns; bulk content lives behind the BlobStore — the database stores
 * refs (sha256 blobRef), never blobs.
 *
 * `store.ts` bootstraps these tables with inline DDL at open; that DDL must
 * be kept in lockstep with this schema (this file is the drizzle-kit source
 * of truth).
 */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { Actor } from '../../events/envelope'
import type { TicketRef } from '../../ontology'
import type { StreamPart } from '../streams/types'

export const builds = sqliteTable('builds', {
  slug: text('slug').primaryKey(),
  repo: text('repo').notNull(),
  repoOrigin: text('repo_origin'),
  ticket: text('ticket', { mode: 'json' }).$type<TicketRef>(),
  branch: text('branch'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  leaseHolder: text('lease_holder'),
  leaseExpiresAt: text('lease_expires_at'),
  leaseTtlMs: integer('lease_ttl_ms'),
  heartbeatAt: text('heartbeat_at'),
})

export const events = sqliteTable(
  'events',
  {
    build: text('build').notNull(),
    /** Per-build, monotonic from 1, assigned in-transaction on append (§15.1). */
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    actor: text('actor', { mode: 'json' }).notNull().$type<Actor>(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
  },
  // Mirrors the BOOTSTRAP_DDL digest-scan index (AUT-487), type-leading so the
  // digest query's cost grows with digest-relevant events, not total history.
  (t) => [
    primaryKey({ columns: [t.build, t.seq] }),
    index('events_type_build_seq').on(t.type, t.build, t.seq),
  ],
)

export const repoStreams = sqliteTable('repo_streams', {
  repo: text('repo').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  leaseHolder: text('lease_holder'),
  leaseExpiresAt: text('lease_expires_at'),
  leaseTtlMs: integer('lease_ttl_ms'),
  heartbeatAt: text('heartbeat_at'),
})

export const repoEvents = sqliteTable(
  'repo_events',
  {
    repo: text('repo').notNull(),
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    actor: text('actor', { mode: 'json' }).notNull().$type<Actor>(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.seq] })],
)

export const repoArtifacts = sqliteTable(
  'repo_artifacts',
  {
    repo: text('repo').notNull(),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    blobRef: text('blob_ref').notNull(),
    metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.kind, t.revision] })],
)

/** Operator sessions (SPEC §7.1.1): hosted-only durable orchestrator
 * conversation state. Adapters implement the contract uniformly; nothing
 * local creates one. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  repo: text('repo').notNull(),
  operator: text('operator').notNull(),
  title: text('title'),
  /** Store-assigned monotonic creation sequence (assigned in-transaction at
   * `createSession`, never reused — sessions are never deleted). The
   * `listSessions` same-timestamp tiebreak; not part of `SessionRecord`. */
  creationSeq: integer('creation_seq').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const sessionEvents = sqliteTable(
  'session_events',
  {
    session: text('session')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Per-session, monotonic from 1, assigned in-transaction on append. */
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    actor: text('actor', { mode: 'json' }).notNull().$type<Actor>(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.session, t.seq] })],
)

export const sessionArtifacts = sqliteTable(
  'session_artifacts',
  {
    session: text('session')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    blobRef: text('blob_ref').notNull(),
    metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.session, t.kind, t.revision] })],
)

export const artifacts = sqliteTable(
  'artifacts',
  {
    build: text('build').notNull(),
    kind: text('kind').notNull(),
    /** 0-based per (build, kind) — the first deposit of a kind is rev 0 (§6.3). */
    revision: integer('revision').notNull(),
    /** sha256 content address into the BlobStore (§7.1). */
    blobRef: text('blob_ref').notNull(),
    metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.build, t.kind, t.revision] })],
)

/** Streams (SPEC §7.6): the third primitive. Scope is fixed at create; the
 * CHECKs guarantee exactly one of build/repo/session is set, matching the
 * scope kind. */
export const streams = sqliteTable('streams', {
  id: text('id').primaryKey(),
  scopeKind: text('scope_kind').notNull(),
  build: text('build'),
  repo: text('repo'),
  session: text('session'),
  label: text('label').notNull(),
  format: text('format').notNull(),
  status: text('status').notNull(),
  outcome: text('outcome'),
  artifactKind: text('artifact_kind'),
  artifactRevision: integer('artifact_revision'),
  artifactBlobRef: text('artifact_blob_ref'),
  createdAt: text('created_at').notNull(),
  closedAt: text('closed_at'),
  /** Store-assigned monotonic creation sequence (assigned in-transaction at
   * `createStream`, never reused — streams are never deleted; retention
   * prunes `stream_chunks` only). The `listStreams` same-timestamp tiebreak;
   * not part of `StreamRecord`. */
  creationSeq: integer('creation_seq').notNull(),
})

export const streamChunks = sqliteTable(
  'stream_chunks',
  {
    stream: text('stream')
      .notNull()
      .references(() => streams.id, { onDelete: 'cascade' }),
    /** Per-stream, monotonic from 1, assigned in-transaction on append. */
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    parts: text('parts', { mode: 'json' }).notNull().$type<StreamPart[]>(),
  },
  (t) => [primaryKey({ columns: [t.stream, t.seq] })],
)
