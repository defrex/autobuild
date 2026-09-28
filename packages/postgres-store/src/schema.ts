import { SQL } from 'bun'
import {
  AUTH_SCHEMA_CHECKSUM,
  AUTH_SCHEMA_DDL,
  AUTH_SCHEMA_V1_CHECKSUM,
  AUTH_SCHEMA_V2_CHECKSUM,
  AUTH_SCHEMA_VERSION,
  assertAuthSchema,
} from './auth-schema'

export const SCHEMA_VERSION = 8
export const MIGRATE_COMMAND = 'bun run postgres:migrate (from a pinned Autobuild release checkout)'

/** The frozen v3 DDL, kept verbatim so a deployed v3 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). */
export const SCHEMA_V3_DDL = `
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
export const SCHEMA_V3_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V3_DDL).digest('hex')

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

/** The frozen v4 DDL, kept verbatim so a deployed v4 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). */
export const SCHEMA_V4_DDL = `
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
CREATE SEQUENCE IF NOT EXISTS sessions_creation_seq;
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_seq bigint NOT NULL
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
export const SCHEMA_V4_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V4_DDL).digest('hex')

/** The frozen v5 DDL, kept verbatim so a deployed v5 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). v5 is the shape the
 * hosted service ran when the streams.creation_seq tiebreak landed without a
 * version bump; every deploy after that failed the marker check until v6. */
export const SCHEMA_V5_DDL = `
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
  heartbeat_at timestamptz, repo_origin text
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
CREATE SEQUENCE IF NOT EXISTS sessions_creation_seq;
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_seq bigint NOT NULL
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
export const SCHEMA_V5_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V5_DDL).digest('hex')

/** The frozen v6 DDL, kept verbatim so a deployed v6 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). v6 is the shape the
 * hosted service ran immediately before the build-digest scan index (v7). */
export const SCHEMA_V6_DDL = `
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
  heartbeat_at timestamptz, repo_origin text
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
CREATE SEQUENCE IF NOT EXISTS sessions_creation_seq;
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_seq bigint NOT NULL
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
CREATE SEQUENCE IF NOT EXISTS streams_creation_seq;
CREATE TABLE IF NOT EXISTS streams (
  id text PRIMARY KEY, scope_kind text NOT NULL,
  build text REFERENCES builds(slug) ON DELETE CASCADE,
  repo text REFERENCES repo_streams(repo) ON DELETE CASCADE,
  label text NOT NULL, format text NOT NULL, status text NOT NULL,
  outcome text, artifact_kind text, artifact_revision bigint,
  artifact_blob_ref text, created_at timestamptz NOT NULL, closed_at timestamptz,
  session text REFERENCES sessions(id) ON DELETE CASCADE,
  creation_seq bigint NOT NULL,
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
export const SCHEMA_V6_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V6_DDL).digest('hex')

/** The frozen v7 DDL, kept verbatim so a deployed v7 marker's checksum can be
 * recognized and upgraded in place (see migratePostgres). v7 is the shape the
 * hosted service ran immediately before the repository-journal state-read
 * index (v8, AUT-489). Frozen pre-trimmed (the V1–V6 pattern): a deployed
 * marker's checksum is taken over the trimmed DDL, so an untrimmed constant
 * would hash surrounding whitespace no deployed database ever carried and the
 * promotion branch would never match. */
export const SCHEMA_V7_DDL = `
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
  heartbeat_at timestamptz, repo_origin text
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
CREATE SEQUENCE IF NOT EXISTS sessions_creation_seq;
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_seq bigint NOT NULL
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
CREATE SEQUENCE IF NOT EXISTS streams_creation_seq;
CREATE TABLE IF NOT EXISTS streams (
  id text PRIMARY KEY, scope_kind text NOT NULL,
  build text REFERENCES builds(slug) ON DELETE CASCADE,
  repo text REFERENCES repo_streams(repo) ON DELETE CASCADE,
  label text NOT NULL, format text NOT NULL, status text NOT NULL,
  outcome text, artifact_kind text, artifact_revision bigint,
  artifact_blob_ref text, created_at timestamptz NOT NULL, closed_at timestamptz,
  session text REFERENCES sessions(id) ON DELETE CASCADE,
  creation_seq bigint NOT NULL,
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
);

-- The build-digest scan index (AUT-487): type-leading, so the digest query's
-- cost grows with the observation/terminal events themselves, not with total
-- history. Created idempotently so pre-v7 databases gain it on migrate.
CREATE INDEX IF NOT EXISTS events_type_build_seq ON events (type, build, seq);`.trim()
export const SCHEMA_V7_CHECKSUM = new Bun.CryptoHasher('sha256').update(SCHEMA_V7_DDL).digest('hex')

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
  heartbeat_at timestamptz, repo_origin text
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
CREATE SEQUENCE IF NOT EXISTS sessions_creation_seq;
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  operator text NOT NULL,
  title text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_seq bigint NOT NULL
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
CREATE SEQUENCE IF NOT EXISTS streams_creation_seq;
CREATE TABLE IF NOT EXISTS streams (
  id text PRIMARY KEY, scope_kind text NOT NULL,
  build text REFERENCES builds(slug) ON DELETE CASCADE,
  repo text REFERENCES repo_streams(repo) ON DELETE CASCADE,
  label text NOT NULL, format text NOT NULL, status text NOT NULL,
  outcome text, artifact_kind text, artifact_revision bigint,
  artifact_blob_ref text, created_at timestamptz NOT NULL, closed_at timestamptz,
  session text REFERENCES sessions(id) ON DELETE CASCADE,
  creation_seq bigint NOT NULL,
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
);

-- The build-digest scan index (AUT-487): type-leading, so the digest query's
-- cost grows with the observation/terminal events themselves, not with total
-- history. Created idempotently so pre-v7 databases gain it on migrate.
CREATE INDEX IF NOT EXISTS events_type_build_seq ON events (type, build, seq);

-- The repository-journal state read index (AUT-489): (repo, type, seq), so
-- the bounded state read's anchor query — MAX(seq) over the repo's
-- run-started facts — and its durable-type select both scan only their own
-- signal, never the repo's whole journal. Created idempotently so pre-v8
-- databases gain it on migrate.
CREATE INDEX IF NOT EXISTS repo_events_type_repo_seq ON repo_events (repo, type, seq);`.trim()

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
    // The repo_origin column rides last: the guarded v4→v5 ALTER adds it at
    // the end, so migrated and fresh databases assert identically (the
    // sessions.creation_seq and streams.session comments above).
    ['repo_origin', 'text', false],
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
    // The creation-order tiebreak column rides last: the guarded v3→v4 ALTER
    // adds it at the end, so migrated and fresh databases assert identically
    // (the streams.session precedent).
    ['creation_seq', 'bigint', true],
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
    // The session column rides last-but-one and the creation-order tiebreak
    // column rides last: the guarded v2→v3 ALTER adds session at the end and
    // the guarded tiebreak ALTERs append creation_seq after it, so migrated
    // and fresh databases assert identically.
    ['session', 'text', false],
    ['creation_seq', 'bigint', true],
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

/** The targeted cause text for a marker whose version matches the required
 * version but whose checksum does not: exactly the shape a checksum-only
 * re-pin leaves deployed databases in (AUT-548) — and also the shape of a
 * database built by a different build of the same version, which a marker
 * alone cannot distinguish, so both causes are named. The guard's failure
 * output teaches the four-step rule pre-ship; this diagnostic catches the
 * checksum-only shortcut after the fact. */
function checksumMismatchCause(version: number): string {
  return (
    `its version matches ${version}, but its checksum does not match this build's DDL — the ` +
    `current DDL was likely edited in place without bumping the version, or the database was ` +
    `built by a different build of this same version. Never edit deployed DDL; follow the ` +
    `four-step rule (freeze the previous DDL, add an upgrade branch in migratePostgres, bump ` +
    `the version, re-pin in schema-guard.test.ts) and redeploy`
  )
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
  if (marker.checksum !== SCHEMA_CHECKSUM) {
    throw schemaError(`checksum is mismatched: ${checksumMismatchCause(SCHEMA_VERSION)}`)
  }
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
  if (Number(marker.version) !== TICKET_SCHEMA_VERSION) {
    throw schemaError(
      `ticket marker is incompatible: version ${marker.version} does not match required version ` +
        `${TICKET_SCHEMA_VERSION}`,
    )
  }
  if (marker.checksum !== TICKET_SCHEMA_CHECKSUM) {
    throw schemaError(
      `ticket marker is incompatible: ${checksumMismatchCause(TICKET_SCHEMA_VERSION)}`,
    )
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

/** The guarded streams.creation_seq upgrade, shared by every pre-v7 marker
 * branch whose database carries a pre-existing streams table (v2, v3, v4, v5).
 * The idempotent full DDL above has already created the
 * streams_creation_seq sequence; the column is added only when missing, with
 * a (created_at, id)-ordered backfill — legacy same-millisecond ties are
 * genuinely unorderable, so any total order consistent with createdAt is
 * acceptable — SET NOT NULL, and the sequence positioned above the backfilled
 * values so the next nextval continues the counter without collision. */
const STREAMS_CREATION_SEQ_MIGRATION = `
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'streams'
        AND column_name = 'creation_seq'
    ) THEN
      ALTER TABLE streams ADD COLUMN creation_seq bigint;
      WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM streams
      )
      UPDATE streams SET creation_seq = numbered.rn
        FROM numbered WHERE streams.id = numbered.id;
      ALTER TABLE streams ALTER COLUMN creation_seq SET NOT NULL;
      PERFORM setval('streams_creation_seq',
        (SELECT COALESCE(MAX(creation_seq), 0) FROM streams) + 1, false);
    END IF;
  END $$;
`

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
        // v1–v7 → v8: the guarded builds.repo_origin column runs for EVERY
        // pre-v7 marker, before the version branches — not only in a v4
        // branch. `CREATE TABLE IF NOT EXISTS builds` does not alter an
        // existing builds table, so without this the internal assertSchema
        // below would fail on every upgraded legacy database. The ALTER is
        // guarded and idempotent, so re-running it on a v7 database (or a
        // marker that turns out to be rejected below, which rolls this
        // transaction back) is a no-op.
        await tx.unsafe(`
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'builds'
                AND column_name = 'repo_origin'
            ) THEN
              ALTER TABLE builds ADD COLUMN repo_origin text;
            END IF;
          END $$;
        `)
        // v6 → v7: the guarded build-digest scan index (AUT-487) likewise
        // runs for EVERY pre-v7 marker (and, with the state-read index below,
        // every pre-v8 marker) — the idempotent full DDL above only
        // creates an index on a database that lacks the events table, never
        // on a pre-existing one. Guarded and idempotent (the repo_origin
        // precedent), so it is a no-op on fresh installs, on v7 reruns, and
        // on markers rejected below (which roll the transaction back).
        await tx.unsafe(
          `CREATE INDEX IF NOT EXISTS events_type_build_seq ON events (type, build, seq)`,
        )
        // v7 → v8: the guarded repository-journal state-read index (AUT-489)
        // likewise runs for EVERY pre-v8 marker — same reasoning as the
        // digest-scan index above. Guarded and idempotent, so it is a no-op
        // on fresh installs, on v8 reruns, and on markers rejected below
        // (which roll the transaction back). Indexes are not catalog-asserted,
        // so no EXPECTED_* change.
        await tx.unsafe(
          `CREATE INDEX IF NOT EXISTS repo_events_type_repo_seq ON repo_events (repo, type, seq)`,
        )
        const version = Number(marker.version)
        if (version === SCHEMA_VERSION) {
          if (marker.checksum !== SCHEMA_CHECKSUM) {
            throw schemaError(`marker is incompatible: ${checksumMismatchCause(SCHEMA_VERSION)}`)
          }
        } else if (version === 1 && marker.checksum === SCHEMA_V1_CHECKSUM) {
          // v1 → v8: the idempotent full DDL above already applied the deltas
          // (the stream tables and the session tables); v1 databases never had
          // a streams or sessions table, so the full DDL created them with the
          // session column, the widened CHECKs, and both creation_seq columns.
          // The guarded repo_origin ALTER and the guarded digest-scan index
          // above covered the pre-existing tables. Promote the marker in this
          // transaction.
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 2 && marker.checksum === SCHEMA_V2_CHECKSUM) {
          // v2 → v8: the idempotent full DDL above created the session tables
          // (with the creation_seq column); a v2 database's streams table
          // needs the guarded session column, the widened CHECK constraints,
          // and the guarded creation_seq column (shared with v3 and v4). The
          // guarded repo_origin ALTER and the guarded digest-scan index above
          // covered the pre-existing builds and events tables.
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
          await tx.unsafe(STREAMS_CREATION_SEQ_MIGRATION)
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 3 && marker.checksum === SCHEMA_V3_CHECKSUM) {
          // v3 → v8: the listSessions and listStreams creation-order
          // tiebreaks (store/types.ts). The idempotent full DDL above created
          // the sessions_creation_seq and streams_creation_seq sequences; a
          // v3 database's sessions and streams tables need the guarded
          // creation_seq columns, each with a (created_at, id)-ordered
          // backfill — legacy same-millisecond ties are genuinely
          // unorderable, so any total order consistent with createdAt is
          // acceptable — SET NOT NULL, and the sequence positioned above the
          // backfilled values so the next nextval continues the counter
          // without collision. The guarded repo_origin ALTER and the guarded
          // digest-scan index above covered the pre-existing tables.
          await tx.unsafe(`
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'sessions'
                  AND column_name = 'creation_seq'
              ) THEN
                ALTER TABLE sessions ADD COLUMN creation_seq bigint;
                WITH numbered AS (
                  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM sessions
                )
                UPDATE sessions SET creation_seq = numbered.rn
                  FROM numbered WHERE sessions.id = numbered.id;
                ALTER TABLE sessions ALTER COLUMN creation_seq SET NOT NULL;
                PERFORM setval('sessions_creation_seq',
                  (SELECT COALESCE(MAX(creation_seq), 0) FROM sessions) + 1, false);
              END IF;
            END $$;
          `)
          await tx.unsafe(STREAMS_CREATION_SEQ_MIGRATION)
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 4 && marker.checksum === SCHEMA_V4_CHECKSUM) {
          // v4 → v8: the listStreams creation-order tiebreak
          // (store/types.ts), mirroring the v3→v4 sessions treatment. The
          // idempotent full DDL above created the streams_creation_seq
          // sequence; a v4 database's streams table needs the guarded
          // creation_seq column, backfill, NOT NULL, and sequence continuity
          // (the shared pre-v6 streams migration). The guarded repo_origin
          // ALTER and the guarded digest-scan index above covered the
          // pre-existing tables.
          await tx.unsafe(STREAMS_CREATION_SEQ_MIGRATION)
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 5 && marker.checksum === SCHEMA_V5_CHECKSUM) {
          // v5 → v8: the listStreams creation-order tiebreak (store/types.ts)
          // landed on the v5 DDL without a version bump, so the hosted
          // database carries the v5 marker with the pre-tiebreak checksum. The
          // idempotent full DDL above created the streams_creation_seq
          // sequence; a v5 database's streams table needs the guarded
          // creation_seq column, backfill, NOT NULL, and sequence continuity
          // (the shared pre-v6 streams migration). Every other pre-v7 table
          // and column already exists in a v5 database; the guarded
          // digest-scan index above covers events.
          await tx.unsafe(STREAMS_CREATION_SEQ_MIGRATION)
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 6 && marker.checksum === SCHEMA_V6_CHECKSUM) {
          // v6 → v8: the guarded digest-scan index above is the v6→v7 delta;
          // every v6 table and column already exists. Promote the marker in
          // this transaction.
          await tx`UPDATE ab_schema_migrations
            SET version = ${SCHEMA_VERSION}, checksum = ${SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (version === 7 && marker.checksum === SCHEMA_V7_CHECKSUM) {
          // v7 → v8: the guarded repository-journal state-read index above
          // is the entire delta; every v7 table and column already exists.
          // Promote the marker in this transaction.
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
        if (Number(ticketMarker.version) !== TICKET_SCHEMA_VERSION) {
          throw schemaError(
            `ticket marker is incompatible: version ${ticketMarker.version} does not match ` +
              `required version ${TICKET_SCHEMA_VERSION}`,
          )
        }
        if (ticketMarker.checksum !== TICKET_SCHEMA_CHECKSUM) {
          throw schemaError(
            `ticket marker is incompatible: ${checksumMismatchCause(TICKET_SCHEMA_VERSION)}`,
          )
        }
      } else {
        await tx`INSERT INTO ab_ticket_schema_migrations
          (singleton, version, checksum, applied_at)
          VALUES (true, ${TICKET_SCHEMA_VERSION}, ${TICKET_SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
      }
      const authRows: { version: number; checksum: string }[] =
        await tx`SELECT version, checksum FROM ab_auth_schema_migrations WHERE singleton = true FOR UPDATE`
      const authMarker = authRows[0]
      // v2 → v3: the guarded oauthApplication.authenticationScheme column
      // runs for EVERY pre-v3 auth marker, before the version branches —
      // `CREATE TABLE IF NOT EXISTS "oauthApplication"` does not alter an
      // existing table, so without this the internal assertAuthSchema below
      // would fail on every upgraded v1/v2 database. Guarded and idempotent
      // (the builds.repo_origin precedent), so a no-op on fresh installs,
      // v1 upgrades (full DDL already created the column), and current-v3
      // reruns. The column rides last in the v3 DDL so fresh and migrated
      // databases assert identically.
      await tx.unsafe(`
        ALTER TABLE "oauthApplication"
          ADD COLUMN IF NOT EXISTS "authenticationScheme" text;
      `)
      if (authMarker) {
        const authVersion = Number(authMarker.version)
        if (authVersion === AUTH_SCHEMA_VERSION) {
          if (authMarker.checksum !== AUTH_SCHEMA_CHECKSUM) {
            throw schemaError(
              `auth marker is incompatible: ${checksumMismatchCause(AUTH_SCHEMA_VERSION)}`,
            )
          }
        } else if (authVersion === 1 && authMarker.checksum === AUTH_SCHEMA_V1_CHECKSUM) {
          // v1 → v3: the idempotent full DDL above already created the four
          // MCP-plugin tables with the column (CREATE TABLE IF NOT EXISTS is
          // a no-op on the existing core tables); promote the marker in this
          // transaction.
          await tx`UPDATE ab_auth_schema_migrations
            SET version = ${AUTH_SCHEMA_VERSION}, checksum = ${AUTH_SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else if (authVersion === 2 && authMarker.checksum === AUTH_SCHEMA_V2_CHECKSUM) {
          // v2 → v3: the guarded ALTER above added the column to the
          // pre-existing oauthApplication table; promote the marker in this
          // transaction.
          await tx`UPDATE ab_auth_schema_migrations
            SET version = ${AUTH_SCHEMA_VERSION}, checksum = ${AUTH_SCHEMA_CHECKSUM},
              applied_at = ${new Date().toISOString()}
            WHERE singleton = true`
        } else {
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
