---
title: "Build store"
group: "reference"
description: "Select local SQLite or an HTTP service and understand the storage extension contract."
label: "Build store"
order: 10
---

# Build store

## Responsibility

The BuildStore persists everything a build records:

- typed append-only events and repository journals
- artifacts, blobs and session streams
- leases

Authoritative state is reduced from events; snapshots are disposable caches. Atomic sequence checks and transactions protect concurrent writes, and durable records let a replacement runner resume without its predecessor's process or chat.

The Store is chosen separately from ticket storage and dispatcher placement. Selecting Postgres doesn't relocate execution.

## Shipped adapters

### SQLite and filesystem blobs

The local default needs no service credential:

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

History lives beneath `.autobuild/`. To move it, pass a filesystem Store reference or set a nonblank `AB_STORE`:

```sh
bun ab builds --store /srv/autobuild/project-store
```

Keep the database and blob directory durable together and writable by the dispatcher identity.

### Postgres with object storage

The server-side `@defrex/autobuild-postgres-store` package persists to PostgreSQL plus S3-compatible storage or Vercel Blob. The CLI doesn't install it, and there's no `[store] provider` selector or direct PostgreSQL URL mode. A repository on this backend selects its HTTP service:

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Install the adapter in the service project and compose it server-side:

```sh
bun add @defrex/autobuild-postgres-store
export DATABASE_URL='<postgres connection URL>'
# AB_POSTGRES_URL overrides DATABASE_URL when nonblank.
```

```ts
import { openPostgresBuildStoreFromEnv } from '@defrex/autobuild-postgres-store'

const store = await openPostgresBuildStoreFromEnv(process.env)
```

- **Migrate first.** Run the matching release's idempotent migration before opening the service. Migration needs schema-creation permission; runtime needs access to the resulting tables.
- **Configure one blob backend.** S3 needs a bucket, prefix and GetObject/PutObject credentials. Vercel Blob needs a read-write token, or an OIDC identity plus store ID.
- **Keep credentials server-side.** Database and blob secrets never leave the service.

Choose one backend in the service's environment:

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

`[store] url`, as above, selects the shipped HTTP client. Connect once per host and user, from a checkout with the intended origin:

```sh
bun ab connect https://builds.example.com
bun ab builds
```

Browser approval registers the project and saves a project credential outside the repository. A URL alone grants no authority; in CI, set `AB_TOKEN`, which must authorize the registered project.

Store selection precedence:

1. `--store`
2. nonblank `AB_STORE`
3. committed `[store] url`
4. the local default

A configured remote service with missing credentials fails with connection guidance; it never silently creates local state.

## Writing your own

A BuildStore isn't a plugin manifest registration: there's no `buildStores` map. [Writing a plugin](plugin-authoring.md) explains how it differs from the four registered adapter ports.

To add a backend:

1. Implement `BuildStore` and `BlobStore` with the storage types from `@defrex/autobuild/store-adapter`.
2. Run the unchanged `describeBuildStoreContract` and `describeBlobStoreContract` suites from `@defrex/autobuild/testing`, against isolated fixtures with real persistence semantics.

To serve it to the shipped CLI, implement the normative remote store protocol; don't invent a second route catalog. Its conformance section covers identity and version headers, validation and authentication order, registered-project scoping, atomic transactions, streams, leases and persistence. Test the real remote client against your server with isolated fixtures, in addition to the backend contracts.
