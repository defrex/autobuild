import type { SQL } from 'bun'

/** Better Auth 1.4.18 core + MCP/OIDC/JWT plugin PostgreSQL schema. Changes to
 * the pinned auth package must deliberately update this marker and DDL.
 *
 * v3 notes the plugin's declared-schema drift: the pinned 1.4.18 MCP plugin's
 * DCR endpoint writes `authenticationScheme`
 * (node_modules/better-auth/dist/plugins/mcp/index.mjs:595) but its declared
 * `oauthApplication` schema (dist/plugins/oidc-provider/schema.mjs) omits
 * the field, so the adapter factory's transformInput drops it before either
 * adapter persists it. Verified dropped, not rejected: the Postgres-gated
 * MCP e2e passed 9/9 pre-fix and a live memory-adapter DCR probe stored a
 * row with no `authenticationScheme`. The field declaration in
 * hosted-store-service's createWebAuth restores it; this column persists it.
 * Patching the plugin upstream is out of scope. */
export const AUTH_SCHEMA_VERSION = 3

/** The frozen v1 DDL, kept verbatim so a deployed v1 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). */
export const AUTH_SCHEMA_V1_DDL = `
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

export const AUTH_SCHEMA_V1_CHECKSUM = new Bun.CryptoHasher('sha256')
  .update(AUTH_SCHEMA_V1_DDL)
  .digest('hex')

/** The frozen v2 DDL, kept verbatim so a deployed v2 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). Byte-identical to
 * the v2 AUTH_SCHEMA_DDL via the shared v1 interpolation above. */
export const AUTH_SCHEMA_V2_DDL = `
${AUTH_SCHEMA_V1_DDL}
CREATE TABLE IF NOT EXISTS jwks (
  id text PRIMARY KEY, "publicKey" text NOT NULL, "privateKey" text NOT NULL,
  "createdAt" timestamp NOT NULL, "expiresAt" timestamp
);
CREATE TABLE IF NOT EXISTS "oauthApplication" (
  id text PRIMARY KEY, name text NOT NULL, icon text, metadata text,
  "clientId" text NOT NULL UNIQUE, "clientSecret" text,
  "redirectUrls" text NOT NULL, type text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS oauthApplication_user_id_idx ON "oauthApplication" ("userId");
CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  id text PRIMARY KEY, "accessToken" text NOT NULL UNIQUE,
  "refreshToken" text NOT NULL UNIQUE, "accessTokenExpiresAt" timestamp NOT NULL,
  "refreshTokenExpiresAt" timestamp NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  scopes text NOT NULL, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS oauthAccessToken_client_id_idx ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS oauthAccessToken_user_id_idx ON "oauthAccessToken" ("userId");
CREATE TABLE IF NOT EXISTS "oauthConsent" (
  id text PRIMARY KEY, "clientId" text NOT NULL
    REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scopes text NOT NULL, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "consentGiven" boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS oauthConsent_user_id_idx ON "oauthConsent" ("userId");`.trim()

export const AUTH_SCHEMA_V2_CHECKSUM = new Bun.CryptoHasher('sha256')
  .update(AUTH_SCHEMA_V2_DDL)
  .digest('hex')

/** v2 adds the four MCP-plugin tables (jwks from the jwt companion): column
 * names are exactly the camelCase quoted identifiers Better Auth's pg adapter
 * writes.
 *
 * v3 adds the nullable `authenticationScheme` column to `oauthApplication`
 * (see the header marker): legacy rows legitimately lack the field, so NULL
 * means "field absent" (the builds.repo_origin precedent) — NOT NULL DEFAULT
 * would invent scheme values for existing clients. The column rides last so
 * fresh databases assert identically to v2 databases upgraded by the guarded
 * ALTER in migratePostgres (the streams.creation_seq precedent). */
export const AUTH_SCHEMA_DDL = `
${AUTH_SCHEMA_V1_DDL}
CREATE TABLE IF NOT EXISTS jwks (
  id text PRIMARY KEY, "publicKey" text NOT NULL, "privateKey" text NOT NULL,
  "createdAt" timestamp NOT NULL, "expiresAt" timestamp
);
CREATE TABLE IF NOT EXISTS "oauthApplication" (
  id text PRIMARY KEY, name text NOT NULL, icon text, metadata text,
  "clientId" text NOT NULL UNIQUE, "clientSecret" text,
  "redirectUrls" text NOT NULL, type text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "authenticationScheme" text
);
CREATE INDEX IF NOT EXISTS oauthApplication_user_id_idx ON "oauthApplication" ("userId");
CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  id text PRIMARY KEY, "accessToken" text NOT NULL UNIQUE,
  "refreshToken" text NOT NULL UNIQUE, "accessTokenExpiresAt" timestamp NOT NULL,
  "refreshTokenExpiresAt" timestamp NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  scopes text NOT NULL, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL
);
CREATE INDEX IF NOT EXISTS oauthAccessToken_client_id_idx ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS oauthAccessToken_user_id_idx ON "oauthAccessToken" ("userId");
CREATE TABLE IF NOT EXISTS "oauthConsent" (
  id text PRIMARY KEY, "clientId" text NOT NULL
    REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scopes text NOT NULL, "createdAt" timestamp NOT NULL, "updatedAt" timestamp NOT NULL,
  "consentGiven" boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS oauthConsent_user_id_idx ON "oauthConsent" ("userId");`.trim()

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
  if (!marker) {
    throw new Error('PostgreSQL auth schema marker is missing; run the migration from this release')
  }
  if (Number(marker.version) !== AUTH_SCHEMA_VERSION) {
    throw new Error(
      `PostgreSQL auth schema marker is incompatible: version ${marker.version} does not match ` +
        `required version ${AUTH_SCHEMA_VERSION}; run the migration from this release`,
    )
  }
  if (marker.checksum !== AUTH_SCHEMA_CHECKSUM) {
    // The targeted diagnostic for a version-matched, checksum-mismatched
    // marker (AUT-548): the shape a checksum-only re-pin leaves deployed
    // databases in, and also the shape of a database built by a different
    // build of the same version, which a marker alone cannot distinguish.
    throw new Error(
      `PostgreSQL auth schema marker is incompatible: its version matches ` +
        `${AUTH_SCHEMA_VERSION}, but its checksum does not match this build's DDL — the current ` +
        `DDL was likely edited in place without bumping the version, or the database was built ` +
        `by a different build of this same version. Never edit deployed DDL; follow the ` +
        `four-step rule (freeze the previous DDL, add an upgrade branch in migratePostgres, ` +
        `bump the version, re-pin in schema-guard.test.ts) and redeploy; run the migration ` +
        `from this release`,
    )
  }
  const columns: { table_name: string; column_name: string }[] = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY(ARRAY['user', 'session', 'account', 'verification', 'jwks',
        'oauthApplication', 'oauthAccessToken', 'oauthConsent'])
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
    jwks: ['id', 'publicKey', 'privateKey', 'createdAt', 'expiresAt'],
    oauthApplication: [
      'id',
      'name',
      'icon',
      'metadata',
      'clientId',
      'clientSecret',
      'redirectUrls',
      'type',
      'disabled',
      'userId',
      'createdAt',
      'updatedAt',
      // Rides last: the guarded v2→v3 ALTER appends it at the end, so
      // migrated and fresh databases assert identically.
      'authenticationScheme',
    ],
    oauthAccessToken: [
      'id',
      'accessToken',
      'refreshToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
      'clientId',
      'userId',
      'scopes',
      'createdAt',
      'updatedAt',
    ],
    oauthConsent: ['id', 'clientId', 'userId', 'scopes', 'createdAt', 'updatedAt', 'consentGiven'],
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
