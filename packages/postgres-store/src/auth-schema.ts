import type { SQL } from 'bun'

/** Better Auth 1.4.18 core PostgreSQL schema. Changes to the pinned auth package
 * must deliberately update this marker and DDL. */
export const AUTH_SCHEMA_VERSION = 1
export const AUTH_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS ab_auth_schema_migrations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL, image text,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY, "expiresAt" timestamp NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL
    REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamp, "refreshTokenExpiresAt" timestamp,
  scope text, password text, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamp NOT NULL, "createdAt" timestamp, "updatedAt" timestamp
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session ("userId");
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account ("userId");
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);`.trim()

export const AUTH_SCHEMA_CHECKSUM = new Bun.CryptoHasher('sha256')
  .update(AUTH_SCHEMA_DDL)
  .digest('hex')

export async function assertAuthSchema(sql: SQL): Promise<void> {
  let rows: { version: number; checksum: string }[]
  try {
    rows = await sql`SELECT version, checksum FROM ab_auth_schema_migrations WHERE singleton = true`
  } catch (error) {
    const code =
      (error as { code?: string; errno?: string }).errno ?? (error as { code?: string }).code
    if (code === '42P01')
      throw new Error('PostgreSQL auth schema is missing; run: bun run postgres:migrate')
    throw error
  }
  const marker = rows[0]
  if (
    !marker ||
    Number(marker.version) !== AUTH_SCHEMA_VERSION ||
    marker.checksum !== AUTH_SCHEMA_CHECKSUM
  ) {
    throw new Error(
      'PostgreSQL auth schema marker is incompatible; run the migration from this release',
    )
  }
  const columns: { table_name: string; column_name: string }[] = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(ARRAY['user', 'session', 'account', 'verification'])
    ORDER BY table_name, ordinal_position`
  const expected = {
    account: [
      'id',
      'accountId',
      'providerId',
      'userId',
      'accessToken',
      'refreshToken',
      'idToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
      'scope',
      'password',
      'createdAt',
      'updatedAt',
    ],
    session: [
      'id',
      'expiresAt',
      'token',
      'createdAt',
      'updatedAt',
      'ipAddress',
      'userAgent',
      'userId',
    ],
    user: ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'],
    verification: ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
  }
  for (const [table, names] of Object.entries(expected)) {
    const actual = columns.filter((row) => row.table_name === table).map((row) => row.column_name)
    if (JSON.stringify(actual) !== JSON.stringify(names)) {
      throw new Error(`PostgreSQL auth schema table ${table} is missing or mismatched`)
    }
  }
}
