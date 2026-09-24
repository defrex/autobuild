# `@defrex/autobuild-postgres-store`

Serverless-safe Autobuild persistence using PostgreSQL and either an
S3-compatible object store or Vercel Blob. This is a separate package: installing
the `@defrex/autobuild` CLI does not install its database/blob provider
dependencies. A project that embeds the adapter adds it directly:

```sh
bun add @defrex/autobuild-postgres-store
```

Only this package's `src/` tree and this README publish to npm: every
consumer of the published package imports through the manifest's `exports`
and `bin`, all of which live under `src/`. The manifest's `files` allowlist
pins the tarball to exactly that, and `bun tools/publish-contents-check.ts`
in the repository `check` gate fails when anything else would ship. The
deny-by-default allowlist is deliberate: a future top-level file in this
package (a scratch script, a live-test fixture, a dotenv file, an editor
artifact) stays out of the tarball unless the allowlist and the check are
updated together. The `src/testing/` helpers are test-only surface — their
sole consumer is the live test suite — and are excluded from the tarball by
the `!src/testing/**` negation (AUT-500), so a surface pass does not re-flag
them.

## Setup

To run the migration from the hosted deployment's own checkout, choose the
adapter-compatible tag shown in [GitHub Releases](https://github.com/defrex/autobuild/releases),
then obtain and install that exact repository revision in a dedicated checkout:

```sh
git clone --depth 1 --branch v0.6.0 --single-branch https://github.com/defrex/autobuild.git autobuild-v0.6.0
cd autobuild-v0.6.0
bun install --frozen-lockfile
DATABASE_URL=postgres://… bun run postgres:migrate
```

Replace `v0.6.0` with the selected release tag. The migration is idempotent.
The adapter reads the conventional `DATABASE_URL`, which Vercel's Neon and
Postgres storage integrations inject; set `AB_POSTGRES_URL` to override it
explicitly.
Schema diagnostics refer to the root `postgres:migrate` script in this pinned
release checkout. The database identity needs permission to create tables,
constraints, and migration markers during migration and to select, insert,
update, and delete the resulting tables at runtime. The ticket schema has its
own version/checksum marker, so migrating an existing BuildStore v1 database
adds team-scoped tickets, comments, and blockers without replacing the
established BuildStore marker. Opening against a missing, older/newer, or
checksum-mismatched schema fails; schema creation is never implicit.

The current DDL of every marker — build store, ticket, and auth — is immutable
once a database has deployed it: deployed databases carry that exact DDL's
checksum, and editing the DDL in place leaves them all incompatible. Every
schema change is therefore a new version: freeze the previous DDL verbatim with
its checksum, add an upgrade branch for it in `migratePostgres`, bump the
schema version, and update the committed pin in `schema-guard.test.ts`, which
fails the unit suite the moment any current DDL or version is edited without
following all four steps.

## Public entry points

The package exposes four subpaths, each named after the source module it
publishes:

- `@defrex/autobuild-postgres-store` — the full adapter surface: `openPostgresBuildStore`,
  `openPostgresBuildStoreFromEnv`, `migratePostgres`, ticket and blob stores.
- `@defrex/autobuild-postgres-store/env` — URL resolution helpers
  (`resolvePostgresUrl`, `describePostgresTarget`).
- `@defrex/autobuild-postgres-store/schema` — schema DDL, version and checksum
  constants, schema assertions, and `migratePostgres`.
- `@defrex/autobuild-postgres-store/store` — `openPostgresBuildStore`, the
  `PostgresBuildStore` class, `PostgresBuildStoreOptions`, and
  `EVENT_WAIT_POLL_MS`.

## Concurrency

Identity rows are created conflict-safely before being locked for subsequent
work. Concurrent repository ensures are idempotent and all return the single
stored record. Concurrent attempts to create the same build slug produce one
winner; every other caller receives `build "<slug>" already exists` rather than
a raw PostgreSQL uniqueness error.

```ts
import { openPostgresBuildStoreFromEnv } from '@defrex/autobuild-postgres-store'

const store = await openPostgresBuildStoreFromEnv(process.env)
```

S3 credentials need `GetObject` and `PutObject` on the configured bucket/prefix.
Only an object-store 404 is treated as absent; authorization and service errors
are propagated. Vercel supports either a Blob read-write token or a Vercel OIDC
token paired with its Blob store ID.

`PostgresTicketDatabase.source({ teamKey, claimedState?, createState? })` creates
a request-bound TicketSource view. The deployment supplies four distinct
lifecycle names; the defaults are Triage, Ready, Doing, and Done. Ticket bodies
are stored as PostgreSQL `text` and returned unchanged.

For an authenticated HTTP deployment of this adapter, see the
[`@defrex/autobuild-hosted-store-service` guide](../hosted-store-service/README.md).
