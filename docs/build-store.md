---
title: "Build store"
group: "reference"
description: "Select local SQLite or an HTTP service and understand the storage extension contract."
label: "Build store"
order: 10
---

# Build store

## Responsibility

The BuildStore persists typed append-only facts, repository journals, artifacts, blobs, session streams, and leases. Authoritative state is reduced from events; snapshots are disposable caches. Atomic sequence checks and transactions protect concurrent writes. Durable records let a replacement runner resume work without its predecessor's process or chat.

Ticket storage and dispatcher placement are separate choices. Selecting Postgres does not relocate execution.

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

The CLI stores local history beneath `.autobuild/`. Override its location with a filesystem Store reference, for example `bun ab builds --store /srv/autobuild/project-store`, or nonblank `AB_STORE`. Keep the database and blob directory durable together and writable by the dispatcher identity.

### Postgres with object storage

The separate server-side `@defrex/autobuild-postgres-store` package implements persistence with PostgreSQL and S3-compatible storage or Vercel Blob. It is not installed by the CLI, and there is no `[store] provider` selector or direct PostgreSQL CLI URL mode. A repository using this backend normally selects its HTTP service:

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

Run the matching release's idempotent migration before opening the service. Migration needs schema creation permissions; runtime needs access to the resulting tables. Configure the selected blob backend separately: S3 needs bucket/prefix configuration and GetObject/PutObject credentials; Vercel Blob needs a read-write token or OIDC identity plus store ID. Database and blob credentials stay on the server. For example, choose one backend in that service's environment:

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

The preceding `[store] url` selects the shipped HTTP client. From a checkout with the intended origin, connect once per host/user:

```sh
bun ab connect https://builds.example.com
bun ab builds
```

Browser approval registers the project and saves a project credential outside the repository. For CI, supply `AB_TOKEN` explicitly in the environment; it must authorize the registered project. A URL alone grants no authority.

Store selection precedence is explicit `--store`, nonblank `AB_STORE`, committed `[store] url`, then the local default. A configured remote service with missing credentials fails with connection guidance rather than silently creating local state.

## Writing your own

BuildStore is not an in-process plugin manifest registration: there is no `buildStores` map. [Writing a plugin](plugin-authoring.md) explains the distinction from the four registered adapter ports.

Implement `BuildStore` and `BlobStore` using the exported storage types, and run the unchanged `describeBuildStoreContract` and `describeBlobStoreContract` suites from `@defrex/autobuild/testing`. The types are available through `@defrex/autobuild/store-adapter`. Use isolated fixtures with real persistence semantics.

To serve a new backend to the shipped CLI, implement the normative remote store protocol. Its conformance section covers identity/version headers, validation and authentication ordering, registered-project scoping, atomic transactions, streams, leases, and persistence. Test the actual remote client against your server with isolated fixtures, in addition to the backend contracts. Do not substitute a second route catalog for that protocol.
