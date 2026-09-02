# `@autobuild/postgres-store`

Serverless-safe Autobuild persistence using PostgreSQL and either an
S3-compatible object store or Vercel Blob. This is a separate package: installing
the `autobuild` CLI does not install its database/blob provider dependencies.

## Setup

Install this package alongside `autobuild`, configure the environment variables
in [`docs/configuration.md`](../../docs/configuration.md), then initialize a fresh
database exactly once (the command is idempotent):

```sh
AB_POSTGRES_URL=postgres://… bunx @autobuild/postgres-store migrate
```

The database identity needs permission to create tables for migration and to
select, insert, and update the resulting tables at runtime. Opening against a
missing, older/newer, or checksum-mismatched schema fails with a diagnostic that
names the migration command; schema creation is never implicit.

## Concurrency

Identity rows are created conflict-safely before being locked for subsequent
work. Concurrent repository ensures are idempotent and all return the single
stored record. Concurrent attempts to create the same build slug produce one
winner; every other caller receives `build "<slug>" already exists` rather than
a raw PostgreSQL uniqueness error.

```ts
import { openPostgresBuildStoreFromEnv } from '@autobuild/postgres-store'

const store = await openPostgresBuildStoreFromEnv(process.env)
```

S3 credentials need `GetObject` and `PutObject` on the configured bucket/prefix.
Only an object-store 404 is treated as absent; authorization and service errors
are propagated. Vercel supports either a Blob read-write token or a Vercel OIDC
token paired with its Blob store ID.
