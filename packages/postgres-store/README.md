# `@autobuild/postgres-store`

Serverless-safe Autobuild persistence using PostgreSQL and either an
S3-compatible object store or Vercel Blob. This is a separate package: installing
the `autobuild` CLI does not install its database/blob provider dependencies.

## Setup

This adapter is distributed in Autobuild's GitHub releases, not on npm. Choose
the adapter-compatible tag shown in [GitHub Releases](https://github.com/defrex/autobuild/releases),
then obtain and install that exact repository revision in a dedicated checkout:

```sh
git clone --depth 1 --branch v0.6.0 --single-branch https://github.com/defrex/autobuild.git autobuild-v0.6.0
cd autobuild-v0.6.0
bun install --frozen-lockfile
AB_POSTGRES_URL=postgres://… bun run postgres:migrate
```

Replace `v0.6.0` with the selected release tag. The migration is idempotent.
Schema diagnostics refer to the root `postgres:migrate` script in this pinned
release checkout. The database identity needs permission to create tables for
migration and to select, insert, and update the resulting tables at runtime.
Opening against a missing, older/newer, or checksum-mismatched schema fails;
schema creation is never implicit.

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

For an authenticated HTTP deployment of this adapter, see the
[`@autobuild/hosted-store-service` guide](../hosted-store-service/README.md).
