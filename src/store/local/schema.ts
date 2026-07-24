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
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { Actor } from '../../events/envelope'
import type { TicketRef } from '../../ontology'

export const builds = sqliteTable('builds', {
  slug: text('slug').primaryKey(),
  repo: text('repo').notNull(),
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
  (t) => [primaryKey({ columns: [t.build, t.seq] })],
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
