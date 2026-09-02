import { SQL } from 'bun'
import {
  AUTH_SCHEMA_CHECKSUM,
  AUTH_SCHEMA_DDL,
  AUTH_SCHEMA_VERSION,
  assertAuthSchema,
} from './auth-schema'

export const SCHEMA_VERSION = 1
export const MIGRATE_COMMAND = 'bun run postgres:migrate (from a pinned Autobuild release checkout)'
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
}

const EXPECTED_CONSTRAINTS = [
  'ab_schema_migrations|c|singleton||||singleton',
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
      [
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
        if (Number(marker.version) !== SCHEMA_VERSION || marker.checksum !== SCHEMA_CHECKSUM) {
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
