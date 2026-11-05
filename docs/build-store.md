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

### Remote HTTP client and protocol

A hosted instance must implement the remote BuildStore protocol.
The CLI connects over HTTP, never directly to a database.

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

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

## Hosted dispatch and local viewing

A plain `ab dispatch` reads dispatch placement once before starting local execution.
For a hosted project it opens the viewer automatically, displaying
`viewer · dispatched by <host>` from the placement origin (including a nondefault
port). `--once`, `--plain`, and `--interval` retain their viewer meanings.
The viewer reads its dashboard from the Store; its one ticket-source read is
the header's triage count, through the source's optional `countStates`.
`--takeover` explicitly dispatches locally, with a warning that it can displace
the hosted dispatcher; it cannot be combined with `--viewer`. Startup intake
flags require `--takeover` when placement selects viewer.

An unreadable placement fails closed with a typed error naming the cause:
use `--viewer` to watch or `--takeover` to dispatch locally. Both explicit modes
skip placement discovery. Older services without the capability and projects
with unknown or nonhosted placement retain local dispatch behavior. Local stores
need no placement request. Origin mode (`--repository` or `AB_REPOSITORY`) and
hosted cron dispatch bypass this check. Placement is a startup snapshot, not a
liveness probe or a polling input.

## Several dispatchers on one repository

One repository driven by several dispatchers, for example each engineer running
`ab dispatch` locally, should share one store: connect every dispatcher to the
same service with `ab connect`. Assignee gating (`tickets.readyAssignee`)
divides tickets between dispatchers, but not the state a store owns. Separate
local stores each see only their own builds:

- **Nodes are owned by one store.** A child ticket can target only a node built
  in its own store. Elsewhere it stays queued with `target node … is being built
  by another store`, shown in `ab repository status` and the dispatch
  diagnostics.
- **Harvest observations are split.** Each store harvests only its own builds'
  observations.
- **No shared build history.** `ab builds`, status, dashboards and the operator
  API show only the local store's builds.
- **Branch collisions are only partly guarded.** A dispatcher skips any slug
  whose `ab/` or `ab-node/` branch already exists on the remote (when its forge
  supports `remoteBranchExists`), but two stores that claim the same name before
  either pushes can still collide. The check is a safety step, not a best
  effort: if the branch lookup fails, or the base slug and its `-2` … `-100`
  suffixes are all taken, the claim fails at the naming stage. No build is
  created, the ticket is handed back to its ready state, and a later tick
  retries it.
