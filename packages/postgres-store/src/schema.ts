import { SQL } from 'bun'
import {
  AUTH_SCHEMA_CHECKSUM,
  AUTH_SCHEMA_DDL,
  AUTH_SCHEMA_VERSION,
  assertAuthSchema,
} from './auth-schema'

export const SCHEMA_VERSION = 3
export const MIGRATE_COMMAND = 'bun run postgres:migrate (from a pinned Autobuild release checkout)'

/** The frozen v2 DDL, kept verbatim so a deployed v2 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). */
export const SCHEMA_V2_DDL = `
CREATE TABLE IF NOT EXISTS ab_schema_migrations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  slug text PRIMARY KEY, repo text NOT NULL, ticket jsonb, branch text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS events (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (build, seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (build, kind, revision)
);
CREATE TABLE IF NOT EXISTS repo_streams (
  repo text PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS repo_events (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (repo, seq)
);
CREATE TABLE IF NOT EXISTS repo_artifacts (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (repo, kind, revision)
);
CREATE TABLE IF NOT EXISTS streams (
  id text PRIMARY KEY, scope_kind text NOT NULL,
  build text REFERENCES builds(slug) ON DELETE CASCADE,
  repo text REFERENCES repo_streams(repo) ON DELETE CASCADE,
  label text NOT NULL, format text NOT NULL, status text NOT NULL,
  outcome text, artifact_kind text, artifact_revision bigint,
  artifact_blob_ref text, created_at timestamptz NOT NULL, closed_at timestamptz,
  CONSTRAINT streams_scope_kind_check CHECK (scope_kind IN ('build','repo')),
  CONSTRAINT streams_status_check CHECK (status IN ('open','closed')),
  CONSTRAINT streams_scope_exactly_one_check CHECK (
    (scope_kind = 'build' AND build IS NOT NULL AND repo IS NULL)
    OR (scope_kind = 'repo' AND build IS NULL AND repo IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS stream_chunks (
  stream text NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, parts jsonb NOT NULL,
  PRIMARY KEY (stream, seq)
);`.trim()
export const SCHEMA_V2_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V2_DDL).digest('hex')

/** The v1 DDL, kept verbatim so a deployed v1 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). */
export const SCHEMA_V1_DDL = `
CREATE TABLE IF NOT EXISTS ab_schema_migrations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  slug text PRIMARY KEY, repo text NOT NULL, ticket jsonb, branch text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS events (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (build, seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (build, kind, revision)
);
CREATE TABLE IF NOT EXISTS repo_streams (
  repo text PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS repo_events (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (repo, seq)
);
CREATE TABLE IF NOT EXISTS repo_artifacts (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (repo, kind, revision)
);`.trim()
export const SCHEMA_V1_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V1_DDL).digest('hex')

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ab_schema_migrations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  slug text PRIMARY KEY, repo text NOT NULL, ticket jsonb, branch text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS events (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (build, seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
  build text NOT NULL REFERENCES builds(slug) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (build, kind, revision)
);
CREATE TABLE IF NOT EXISTS repo_streams (
  repo text PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  lease_holder text, lease_expires_at timestamptz, lease_ttl_ms bigint,
  heartbeat_at timestamptz
);
CREATE TABLE IF NOT EXISTS repo_events (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (repo, seq)
);
CREATE TABLE IF NOT EXISTS repo_artifacts (
  repo text NOT NULL REFERENCES repo_streams(repo) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (repo, kind, revision)
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS session_events (
  session text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, actor jsonb NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (session, seq)
);
CREATE TABLE IF NOT EXISTS session_artifacts (
  session text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL, revision bigint NOT NULL, blob_ref text NOT NULL,
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (session, kind, revision)
);
CREATE TABLE IF NOT EXISTS streams (
  id text PRIMARY KEY, scope_kind text NOT NULL,
  build text REFERENCES builds(slug) ON DELETE CASCADE,
  repo text REFERENCES repo_streams(repo) ON DELETE CASCADE,
  label text NOT NULL, format text NOT NULL, status text NOT NULL,
  outcome text, artifact_kind text, artifact_revision bigint,
  artifact_blob_ref text, created_at timestamptz NOT NULL, closed_at timestamptz,
  session text REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT streams_scope_kind_check CHECK (scope_kind IN ('build','repo','session')),
  CONSTRAINT streams_status_check CHECK (status IN ('open','closed')),
  CONSTRAINT streams_scope_exactly_one_check CHECK (
    (scope_kind = 'build' AND build IS NOT NULL AND repo IS NULL AND session IS NULL)
    OR (scope_kind = 'repo' AND build IS NULL AND repo IS NOT NULL AND session IS NULL)
    OR (scope_kind = 'session' AND build IS NULL AND repo IS NULL AND session IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS stream_chunks (
  stream text NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  seq bigint NOT NULL, ts timestamptz NOT NULL, parts jsonb NOT NULL,
  PRIMARY KEY (stream, seq)
);`.trim()

export const SCHEMA_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_DDL).digest('hex')

/** Ticket persistence evolves independently so deployed v1 BuildStore markers
 * remain valid while the hosted ticket tables are added. */
export const TICKET_SCHEMA_VERSION = 1
export const TICKET_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ab_ticket_schema_migrations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ab_tickets (
  team text NOT NULL, id text NOT NULL, creation_key text,
  title text NOT NULL, body text NOT NULL, state text NOT NULL,
  labels text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (team, id), UNIQUE (team, creation_key)
);
CREATE TABLE IF NOT EXISTS ab_ticket_comments (
  team text NOT NULL, ticket_id text NOT NULL, seq bigint NOT NULL,
  body text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (team, ticket_id, seq),
  FOREIGN KEY (team, ticket_id) REFERENCES ab_tickets(team, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ab_ticket_blockers (
  team text NOT NULL, ticket_id text NOT NULL, blocker_id text NOT NULL,
  PRIMARY KEY (team, ticket_id, blocker_id),
  FOREIGN KEY (team, ticket_id) REFERENCES ab_tickets(team, id) ON DELETE CASCADE,
  FOREIGN KEY (team, blocker_id) REFERENCES ab_tickets(team, id) ON DELETE CASCADE,
  CHECK (ticket_id <> blocker_id)
);`.trim()
export const TICKET_SCHEMA_CHECKSUM = new Bun.CryptoHasher('sha256')
  .update(TICKET_SCHEMA_DDL)
  .digest('hex')

type ExpectedColumn = readonly [name: string, type: string, notNull: boolean, defaultValue?: string]

const EXPECTED_COLUMNS: Record<string, readonly ExpectedColumn[]> = {
  ab_schema_migrations: [
    ['singleton', 'boolean', true, 'true'],
    ['version', 'integer', true],
    ['checksum', 'text', true],
    ['applied_at', 'timestamp with time zone', true],
  ],
  builds: [
    ['slug', 'text', true],
    ['repo', 'text', true],
    ['ticket', 'jsonb', false],
    ['branch', 'text', false],
    ['created_at', 'timestamp with time zone', true],
    ['updated_at', 'timestamp with time zone', true],
    ['lease_holder', 'text', false],
    ['lease_expires_at', 'timestamp with time zone', false],
    ['lease_ttl_ms', 'bigint', false],
    ['heartbeat_at', 'timestamp with time zone', false],
  ],
  events: [
    ['build', 'text', true],
    ['seq', 'bigint', true],
    ['ts', 'timestamp with time zone', true],
    ['actor', 'jsonb', true],
    ['type', 'text', true],
    ['payload', 'jsonb', true],
  ],
  artifacts: [
    ['build', 'text', true],
    ['kind', 'text', true],
    ['revision', 'bigint', true],
    ['blob_ref', 'text', true],
    ['metadata', 'jsonb', true],
    ['created_at', 'timestamp with time zone', true],
  ],
  repo_streams: [
    ['repo', 'text', true],
    ['created_at', 'timestamp with time zone', true],
    ['updated_at', 'timestamp with time zone', true],
    ['lease_holder', 'text', false],
    ['lease_expires_at', 'timestamp with time zone', false],
    ['lease_ttl_ms', 'bigint', false],
    ['heartbeat_at', 'timestamp with time zone', false],
  ],
  repo_events: [
    ['repo', 'text', true],
    ['seq', 'bigint', true],
    ['ts', 'timestamp with time zone', true],
    ['actor', 'jsonb', true],
    ['type', 'text', true],
    ['payload', 'jsonb', true],
  ],
  repo_artifacts: [
    ['repo', 'text', true],
    ['kind', 'text', true],
    ['revision', 'bigint', true],
    ['blob_ref', 'text', true],
    ['metadata', 'jsonb', true],
    ['created_at', 'timestamp with time zone', true],
  ],
  sessions: [
    ['id', 'text', true],
    ['repo', 'text', true],
    ['operator', 'text', true],
    ['title', 'text', false],
    ['created_at', 'timestamp with time zone', true],
    ['updated_at', 'timestamp with time zone', true],
  ],
  session_events: [
    ['session', 'text', true],
    ['seq', 'bigint', true],
    ['ts', 'timestamp with time zone', true],
    ['actor', 'jsonb', true],
    ['type', 'text', true],
    ['payload', 'jsonb', true],
  ],
  session_artifacts: [
    ['session', 'text', true],
    ['kind', 'text', true],
    ['revision', 'bigint', true],
    ['blob_ref', 'text', true],
    ['metadata', 'jsonb', true],
    ['created_at', 'timestamp with time zone', true],
  ],
  streams: [
    ['id', 'text', true],
    ['scope_kind', 'text', true],
    ['build', 'text', false],
    ['repo', 'text', false],
    ['label', 'text', true],
    ['format', 'text', true],
    ['status', 'text', true],
    ['outcome', 'text', false],
    ['artifact_kind', 'text', false],
    ['artifact_revision', 'bigint', false],
    ['artifact_blob_ref', 'text', false],
    ['created_at', 'timestamp with time zone', true],
    ['closed_at', 'timestamp with time zone', false],
    // The session column rides last: the guarded v2→v3 ALTER adds it at the
    // end, so migrated and fresh databases assert identically.
    ['session', 'text', false],
  ],
  stream_chunks: [
    ['stream', 'text', true],
    ['seq', 'bigint', true],
    ['ts', 'timestamp with time zone', true],
    ['parts', 'jsonb', true],
  ],
}

const EXPECTED_CONSTRAINTS = [
  // CHECK constraints are compared by presence only (their pg_get_expr text
  // is version-sensitive); PK/FK rows compare fully.
  'ab_schema_migrations|c|||||',
  'ab_schema_migrations|p|singleton||||',
  'artifacts|f|build|builds|slug|c|',
  'artifacts|p|build,kind,revision||||',
  'builds|p|slug||||',
  'events|f|build|builds|slug|c|',
  'events|p|build,seq||||',
  'repo_artifacts|f|repo|repo_streams|repo|c|',
  'repo_artifacts|p|repo,kind,revision||||',
  'repo_events|f|repo|repo_streams|repo|c|',
  'repo_events|p|repo,seq||||',
  'repo_streams|p|repo||||',
  'session_artifacts|f|session|sessions|id|c|',
  'session_artifacts|p|session,kind,revision||||',
  'session_events|f|session|sessions|id|c|',
  'session_events|p|session,seq||||',
  'sessions|p|id||||',
  'stream_chunks|f|stream|streams|id|c|',
  'stream_chunks|p|stream,seq||||',
  'streams|c|||||',
  'streams|c|||||',
  'streams|c|||||',
  'streams|f|build|builds|slug|c|',
  'streams|f|repo|repo_streams|repo|c|',
  'streams|f|session|sessions|id|c|',
  'streams|p|id||||',
] as const

export function schemaError(detail: string): Error {
  return new Error(`PostgreSQL BuildStore schema ${detail}; run: ${MIGRATE_COMMAND}`)
}

interface CatalogColumn {
  table_name: string
  column_name: string
  formatted_type: string
  not_null: boolean
  default_expression: string | null
}

interface CatalogConstraint {
  table_name: string
  constraint_type: string
  columns: unknown
  referenced_table: string | null
  referenced_columns: unknown
  delete_action: string
  check_expression: string | null
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  throw schemaError('catalog shape is unreadable')
}

async function assertCatalogShape(sql: SQL): Promise<void> {
  const columns: CatalogColumn[] = await sql`
    SELECT c.relname AS table_name, a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
      a.attnotnull AS not_null,
      CASE WHEN ad.oid IS NULL THEN NULL ELSE pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) END
        AS default_expression
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`

  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = columns
      .filter((column) => column.table_name === table)
      .map((column) => [
        column.column_name,
        column.formatted_type,
        column.not_null,
        column.default_expression ?? undefined,
      ])
    const normalizedExpected = expected.map(([name, type, notNull, defaultValue]) => [
      name,
      type,
      notNull,
      defaultValue,
    ])
    if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
      throw schemaError(`table ${table} is missing or mismatched`)
    }
  }

  const constraints: CatalogConstraint[] = await sql`
    SELECT owner.relname AS table_name, con.contype AS constraint_type,
      to_jsonb(ARRAY(
        SELECT attribute.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = con.conrelid AND attribute.attnum = key.attnum
        ORDER BY key.position
      )) AS columns,
      referenced.relname AS referenced_table,
      to_jsonb(ARRAY(
        SELECT attribute.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = con.confrelid AND attribute.attnum = key.attnum
        ORDER BY key.position
      )) AS referenced_columns,
      con.confdeltype AS delete_action,
      CASE WHEN con.contype = 'c' THEN pg_catalog.pg_get_expr(con.conbin, con.conrelid) ELSE NULL END
        AS check_expression
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class owner ON owner.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = owner.relnamespace
    LEFT JOIN pg_catalog.pg_class referenced ON referenced.oid = con.confrelid
    WHERE n.nspname = current_schema() AND con.contype IN ('p', 'f', 'c')`
  const expectedTables = new Set(Object.keys(EXPECTED_COLUMNS))
  const actualConstraints = constraints
    .filter((constraint) => expectedTables.has(constraint.table_name))
    .map((constraint) =>
      // CHECK constraints are asserted by presence; their pg_get_expr text
      // varies across PostgreSQL versions and is not design-critical.
      constraint.constraint_type === 'c'
        ? [constraint.table_name, 'c', '', '', '', '', ''].join('|')
        : [
            constraint.table_name,
            constraint.constraint_type,
            stringArray(constraint.columns).join(','),
            constraint.referenced_table ?? '',
            stringArray(constraint.referenced_columns).join(','),
            constraint.constraint_type === 'f' ? constraint.delete_action : '',
            constraint.check_expression ?? '',
          ].join('|'),
    )
    .sort()
  if (JSON.stringify(actualConstraints) !== JSON.stringify(EXPECTED_CONSTRAINTS)) {
    throw schemaError('constraints are missing or mismatched')
  }
}

export async function assertSchema(sql: SQL): Promise<void> {
  let rows: { version: number; checksum: string }[]
  try {
    rows = await sql`SELECT version, checksum FROM ab_schema_migrations WHERE singleton = true`
  } catch (error) {
    const code =
      (error as { code?: string; errno?: string }).errno ?? (error as { code?: string }).code
    if (code === '42P01') throw schemaError('is missing')
    throw error
  }
  const marker = rows[0]
  if (!marker) throw schemaError('marker is missing')
  if (Number(marker.version) !== SCHEMA_VERSION) {
    throw schemaError(`version ${marker.version} does not match required version ${SCHEMA_VERSION}`)
  }
  if (marker.checksum !== SCHEMA_CHECKSUM) throw schemaError('checksum is mismatched')
  await assertCatalogShape(sql)
}

export async function assertTicketSchema(sql: SQL): Promise<void> {
  let rows: { version: number; checksum: string }[]
  try {
    rows =
      await sql`SELECT version, checksum FROM ab_ticket_schema_migrations WHERE singleton = true`
  } catch (error) {
    const code =
      (error as { code?: string; errno?: string }).errno ?? (error as { code?: string }).code
    if (code === '42P01') throw schemaError('ticket tables are missing')
    throw error
  }
  const marker = rows[0]
  if (!marker) throw schemaError('ticket marker is missing')
  if (
    Number(marker.version) !== TICKET_SCHEMA_VERSION ||
    marker.checksum !== TICKET_SCHEMA_CHECKSUM
  ) {
    throw schemaError('ticket marker is incompatible')
  }
  const expected: Record<string, Array<[string, string, boolean]>> = {
    ab_ticket_schema_migrations: [
      ['singleton', 'boolean', true],
      ['version', 'integer', true],
      ['checksum', 'text', true],
      ['applied_at', 'timestamp with time zone', true],
    ],
    ab_tickets: [
      ['team', 'text', true],
      ['id', 'text', true],
      ['creation_key', 'text', false],
      ['title', 'text', true],
      ['body', 'text', true],
      ['state', 'text', true],
      ['labels', 'text[]', true],
      ['created_at', 'timestamp with time zone', true],
      ['updated_at', 'timestamp with time zone', true],
    ],
    ab_ticket_comments: [
      ['team', 'text', true],
      ['ticket_id', 'text', true],
      ['seq', 'bigint', true],
      ['body', 'text', true],
      ['created_at', 'timestamp with time zone', true],
    ],
    ab_ticket_blockers: [
      ['team', 'text', true],
      ['ticket_id', 'text', true],
      ['blocker_id', 'text', true],
    ],
  }
  const columns: CatalogColumn[] = await sql`
    SELECT c.relname AS table_name, a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
      a.attnotnull AS not_null, NULL::text AS default_expression
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relname = ANY(ARRAY['ab_ticket_schema_migrations', 'ab_tickets',
        'ab_ticket_comments', 'ab_ticket_blockers'])
    ORDER BY c.relname, a.attnum`
  for (const [table, shape] of Object.entries(expected)) {
    const actual = columns
      .filter((column) => column.table_name === table)
      .map((column) => [column.column_name, column.formatted_type, column.not_null])
    if (JSON.stringify(actual) !== JSON.stringify(shape)) {
      throw schemaError(`ticket table ${table} is missing or mismatched`)
    }
  }
}

export async function migratePostgres(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(470281941)`
      await tx.unsafe(SCHEMA_DDL)
      await tx.unsafe(TICKET_SCHEMA_DDL)
      await tx.unsafe(AUTH_SCHEMA_DDL)
      const rows: { version: number; checksum: string }[] =
        await tx`SELECT version, checksum FROM ab_schema_migrations WHERE singleton = true FOR UPDATE`
      const marker = rows[0]
      if (marker) {
        const version = Number(marker.version)
        if (version === SCHEMA_VERSION) {
          if (marker.checksum !== SCHEMA_CHECKSUM) throw schemaError('marker is incompatible')
        } else if (version === 1 && marker.checksum === SCHEMA_V1_CHECKSUM) {
          // v1 → v3: the idempotent full DDL above already applied the deltas
          // (the stream tables and the session tables); v1 databases never had
          // a streams table, so the full DDL created it with the session
          // column and widened CHECKs. Promote the marker in this transaction.
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 2 && marker.checksum === SCHEMA_V2_CHECKSUM) {
          // v2 → v3: the idempotent full DDL above created the session
          // tables; a v2 database's streams table needs the guarded session
          // column and the widened CHECK constraints.
          await tx.unsafe(`
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'streams'
                  AND column_name = 'session'
              ) THEN
                ALTER TABLE streams
                  ADD COLUMN session text REFERENCES sessions(id) ON DELETE CASCADE;
              END IF;
            END $$;
            ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_scope_kind_check;
            ALTER TABLE streams
              ADD CONSTRAINT streams_scope_kind_check
              CHECK (scope_kind IN ('build','repo','session'));
            ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_scope_exactly_one_check;
            ALTER TABLE streams
              ADD CONSTRAINT streams_scope_exactly_one_check CHECK (
                (scope_kind = 'build' AND build IS NOT NULL AND repo IS NULL AND session IS NULL)
                OR (scope_kind = 'repo' AND build IS NULL AND repo IS NOT NULL AND session IS NULL)
                OR (scope_kind = 'session' AND build IS NULL AND repo IS NULL AND session IS NOT NULL)
              );
          `)
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else {
          throw schemaError('marker is incompatible')
        }
      } else {
        await tx`INSERT INTO ab_schema_migrations (singleton, version, checksum, applied_at)
          VALUES (true, ${SCHEMA_VERSION}, ${SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
      }
      const ticketRows: { version: number; checksum: string }[] =
        await tx`SELECT version, checksum FROM ab_ticket_schema_migrations WHERE singleton = true FOR UPDATE`
      const ticketMarker = ticketRows[0]
      if (ticketMarker) {
        if (
          Number(ticketMarker.version) !== TICKET_SCHEMA_VERSION ||
          ticketMarker.checksum !== TICKET_SCHEMA_CHECKSUM
        ) {
          throw schemaError('ticket marker is incompatible')
        }
      } else {
        await tx`INSERT INTO ab_ticket_schema_migrations
          (singleton, version, checksum, applied_at)
          VALUES (true, ${TICKET_SCHEMA_VERSION}, ${TICKET_SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
      }
      const authRows: { version: number; checksum: string }[] =
        await tx`SELECT version, checksum FROM ab_auth_schema_migrations WHERE singleton = true FOR UPDATE`
      const authMarker = authRows[0]
      if (authMarker) {
        if (
          Number(authMarker.version) !== AUTH_SCHEMA_VERSION ||
          authMarker.checksum !== AUTH_SCHEMA_CHECKSUM
        ) {
          throw schemaError('auth marker is incompatible')
        }
      } else {
        await tx`INSERT INTO ab_auth_schema_migrations
          (singleton, version, checksum, applied_at)
          VALUES (true, ${AUTH_SCHEMA_VERSION}, ${AUTH_SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
      }
      await assertSchema(tx)
      await assertTicketSchema(tx)
      await assertAuthSchema(tx)
    })
  } finally {
    await sql.close()
  }
}
