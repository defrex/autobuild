---
title: "Build store"
group: "reference"
description: "Select local SQLite or an HTTP service and understand the storage extension contract."
label: "Build store"
order: 10
---

# Build store

## Responsibility

The BuildStore persists typed append-only events and repository journals, artifacts, blobs, session streams and leases.

- State is reduced from events; snapshots are disposable caches.
- Atomic sequence checks and transactions guard concurrent writes.
- A replacement runner resumes from durable records, without its predecessor's process or chat.
- Chosen independently of tickets and dispatcher placement.

## Shipped adapters

### SQLite and filesystem blobs

The default; needs no service credential:

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

History lives in `.autobuild/`. To move it, pass a filesystem path or set a nonblank `AB_STORE`:

```sh
bun ab builds --store /srv/autobuild/project-store
```

Keep the database and blob directory together, durable and writable by the dispatcher identity.

### Postgres with object storage

The server-side `@defrex/autobuild-postgres-store` package persists to PostgreSQL plus S3-compatible storage or Vercel Blob. The CLI never connects to PostgreSQL directly (no `[store] provider`); a repository selects the HTTP service:

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

In the service project:

```sh
bun add @defrex/autobuild-postgres-store
export DATABASE_URL='<postgres connection URL>'
# AB_POSTGRES_URL overrides DATABASE_URL when nonblank.
```

```ts
import { openPostgresBuildStoreFromEnv } from '@defrex/autobuild-postgres-store'

const store = await openPostgresBuildStoreFromEnv(process.env)
```

- **Migrate first** with the matching release's idempotent migration. Migration needs schema-creation permission; runtime needs access to the resulting tables.
- **One blob backend.** S3 needs a bucket, prefix and GetObject/PutObject credentials; Vercel Blob needs a read-write token, or an OIDC identity plus store ID.
- **Database and blob secrets** never leave the service.

```sh
# S3-compatible storage
export AB_BLOB_BACKEND='s3'
export AB_S3_BUCKET='autobuild-artifacts'
export AB_S3_REGION='us-east-1'
export AB_S3_ACCESS_KEY_ID='<object-store identity>'
export AB_S3_SECRET_ACCESS_KEY='<object-store secret>'
# Optional: AB_S3_ENDPOINT, AB_S3_FORCE_PATH_STYLE, AB_S3_SESSION_TOKEN, AB_BLOB_PREFIX
```

```sh
# Alternatively, Vercel Blob
export AB_BLOB_BACKEND='vercel'
export AB_VERCEL_BLOB_ACCESS='private'
export BLOB_READ_WRITE_TOKEN='<blob read-write token>'
# Or supply VERCEL_OIDC_TOKEN and BLOB_STORE_ID together instead of the token.
```


### Remote HTTP client and service

`[store] url` selects the shipped HTTP client. Connect once per host and user, from a checkout with the intended origin:

```sh
bun ab connect https://builds.example.com
bun ab builds
```

Browser approval registers the project and saves its credential outside the repository. A URL alone grants no authority; in CI, set `AB_TOKEN` for the registered project.

Store selection precedence:

1. `--store`
2. nonblank `AB_STORE`
3. committed `[store] url`
4. the local default

A remote Store with missing credentials fails with connection guidance; it never falls back to local state.

## Writing your own

A BuildStore isn't a plugin registration (no `buildStores` map; see [Writing a plugin](plugin-authoring.md)).

To add a backend:

1. Implement `BuildStore` and `BlobStore` with the storage types from `@defrex/autobuild/store-adapter`.
2. Pass the unchanged `describeBuildStoreContract` and `describeBlobStoreContract` suites from `@defrex/autobuild/testing`, on isolated fixtures with real persistence.

To serve it to the shipped CLI, implement the normative remote store protocol, not a new route catalog. Meet its conformance section and test the real remote client against your server.
