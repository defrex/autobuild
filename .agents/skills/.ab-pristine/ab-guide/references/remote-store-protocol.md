# Remote BuildStore protocol

A conforming hosted instance implements this complete normative HTTP contract
for Autobuild's remote
`BuildStore`. Implement this protocol to provide build storage on any database,
blob store, or service stack; Autobuild does not load in-process `BuildStore`
plugins. Compatibility means that an Autobuild remote client can use the server
and the implementation passes the shared `BuildStore` contract exported by
`@defrex/autobuild/plugin-sdk`.

The transport, wire shapes, validation order, atomicity, lease behavior,
persistence requirements, and conformance bar for the protocol shipped in this
distribution are all defined here. Protocol implementations must retain contracts for every supported client line;
protocol changes update this document and executable contracts together.

A service accepts stable and prerelease clients from its own `major.minor`
release line and the two preceding minor lines in the same major. A major starts a new family:
X.0 accepts only X.0, X.1 accepts X.0/X.1, and X.2 onward accepts three lines.
Patch versions are interchangeable in both directions and must never change
the protocol. Clients must remain within the instance’s published compatibility window. Supported release lines retain their wire handlers and known
protocol identities; an unknown protocol is refused independently of version.
Stable and prerelease service and client identities share their numeric major/minor
line. Malformed or missing identities, build metadata (`+…`), prefixes and
whitespace are refused with HTTP 409.
A newer client receives an instance-upgrade diagnostic; a client below the window is
told to upgrade the project's Autobuild. Diagnostics name the service version
and supported range.

Unauthenticated `GET /health` publishes `ok`, `autobuildVersion`,
`protocolVersion`, and `supportedClientRange: { minVersion, maxVersionExclusive }`.
Range endpoints remain stable versions. The range is inclusive at the minimum
and exclusive at the maximum; a 0.11.x
service publishes `>=0.9.0 <0.12.0`. Health needs no credentials, version
headers, or available backend.

## 1. Transport and conventions

- The transport is JSON over HTTP or HTTPS. There is no API version prefix.
  Point Autobuild at the server's base URL with `--store`, `AB_STORE`, or
  `[store] url` (in that precedence order, before the local default); the shipped client appends the routes below.
- Every `/builds`, `/repos`, and `/sessions` request sends
  `X-Autobuild-Version` with the exact client package version and
  `X-Autobuild-Protocol-Version` with the remote protocol version (`7` in this
  distribution). Before authentication,
  body parsing, or resource lookup, the server validates the release-line window and known protocol identity.
  Unsupported or missing values receive `409 {"kind":"conflict","error":"…"}`;
  the diagnostic names the client and server package and protocol versions.
- Clients send `Content-Type: application/json` for requests with bodies. Every
  response, including errors and `null` artifact results, has
  `Content-Type: application/json`.
- Build slugs, repository ids, artifact kinds, and holders are case-sensitive.
- A build slug or repository id in a path is one percent-encoded path segment.
  In particular, a repository id such as `acme/widgets` is sent as
  `acme%2Fwidgets`, not as two segments.
- Artifact bytes are represented by `contentBase64`, using strict, canonical,
  padded standard base64 (not base64url). A server may impose a documented
  decoded-byte ceiling. It decodes and checks every standalone or bundled
  artifact before any backing mutation; excess content receives `413
  {"kind":"validation","error":"…"}` naming the byte ceiling. An implementation-dependent example ceiling is 1,048,576 decoded bytes (1 MiB).
- Store-assigned times are ISO-8601 UTC strings in JavaScript
  `Date.toISOString()` form, for example `2026-07-15T12:00:00.000Z`.
- Event sequence numbers and artifact revisions are integers assigned by the
  server. Clients must not assign either except for the negative deposit
  placeholders described in [Atomic deposits](#8-atomic-deposits).
- Optional object members are omitted, not represented as `null`, unless a
  response below explicitly specifies JSON `null`.
- The server owns durability. Events and artifact metadata visible in a
  successful response must remain available across server restarts.

## 2. Common wire types

The examples in this section use TypeScript-like optional markers and JSON
comments for compactness. Actual messages are JSON.

### Ticket and records

```jsonc
// TicketRef
{
  "source": "linear",             // nonempty string
  "id": "AUT-123",                // nonempty string
  "url": "https://…",             // optional string
  "title": "Document the store"   // optional string
}

// BuildRecord
{
  "slug": "remote-store-protocol",
  "repo": "acme/autobuild",
  "repoOrigin": "https://github.com/acme/autobuild", // optional
  "ticket": { /* TicketRef */ },   // optional
  "branch": "ab/remote-store-protocol", // optional
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:01:00.000Z",
  "lease": {                       // optional
    "holder": "runner-1",
    "expiresAt": "2026-07-15T12:02:00.000Z"
  },
  "heartbeatAt": "2026-07-15T12:01:30.000Z" // optional
}

// RepositoryRecord
{
  "repo": "acme/autobuild",
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:01:00.000Z",
  "lease": {                       // optional
    "holder": "harvest-1",
    "expiresAt": "2026-07-15T12:02:00.000Z"
  },
  "heartbeatAt": "2026-07-15T12:01:30.000Z" // optional
}
```

Build records do not contain derived build status. Status is reduced from the
build event stream. `createdAt`, `updatedAt`, lease expiry, and heartbeat time
are server-owned.

`repoOrigin` is the build repository's normalized git origin URL (scp-like and
ssh remotes mapped to their `https://` spelling, host lowercased, trailing
`.git` and slashes stripped). It is a location-independent secondary identity:
clients may accept a differently located checkout of the same repository by
origin equality. It is optional on both create and record shapes, and the
field is simply absent when the repository has no origin remote. The field is
an additive, optional member: servers that predate it strip it from create
requests (clients fall back to path-only identity) and never return it, and
clients that predate it never send or expect it — so neither side requires a
protocol-version bump.

### Actors, event writes, and envelopes

An actor is exactly one of:

```jsonc
{ "kind": "kernel" }
{ "kind": "agent", "role": "implement", "session": "s_123" }
{ "kind": "human", "user": "alice" }
{ "kind": "human", "user": "alice", "via": { "kind": "session", "id": "os_123" } }
{ "kind": "human", "user": "alice", "via": { "kind": "mcp", "client": "claude-code" } }
{ "kind": "dispatcher" }
{ "kind": "ingester", "source": "sentry" }
```

`role`, `session`, `user`, and `source` are nonempty strings. A human actor may
carry an optional `via` marker naming the delegate that performed the write on
the person's behalf: `{ "kind": "session", "id": nonempty }` (a human account's
operator-agent session) or `{ "kind": "mcp", "client": nonempty }` (an MCP
client). `via` is valid only on `human` actors and only on build and
repository events — session events are the delegate's own log — and a `via`
key on any other actor variant is a validation failure. These are the
complete actor variants; unknown actor kinds or extra fields are invalid.

An event append request contains no resource id, sequence, or timestamp:

```jsonc
{
  "actor": { /* Actor */ },
  "type": "observation.recorded", // nonempty string at the wire boundary
  "payload": { /* type-specific JSON */ }
}
```

A successful build event response is:

```jsonc
{
  "build": "remote-store-protocol",
  "seq": 1,                        // positive integer
  "ts": "2026-07-15T12:00:00.000Z",
  "actor": { /* Actor */ },
  "type": "observation.recorded",
  "payload": { /* validated payload */ }
}
```

A repository event envelope has the same shape with `"repo"` in place of
`"build"`. Event-list responses are JSON arrays of the corresponding
envelopes.

A conditional build-stream append request wraps the same event write with the
currently observed sequence (`0` means an empty stream):

```jsonc
{
  "expectedSeq": 17,              // nonnegative integer
  "event": { /* event write */ }
}
```

Its response is either the appended build event envelope or JSON `null` when
the stream no longer has that sequence.

The wire accepts the generic event-write shape so that the backing server can
return a precise catalog validation error. A conforming server **must** validate
the complete actor, type, payload, and actor-per-type rule before mutation.
Build, repository, and session events have separate catalogs; each catalog
defines its allowed event names, exact payload shape, and allowed actor kinds.
Unknown types, missing or extra payload fields, malformed artifact references,
and an actor kind not authorized for that event are validation failures. A
`via` member on any non-human actor is a validation failure with an explicit
rule message (see [Operator-session operations](#5-operator-session-operations)
and section 7).

Those event catalogs evolve with Autobuild's build lifecycle rather than with
the storage transport. A server therefore must use or faithfully implement the
catalog behavior required by every supported client release line. The public
`BuildStore` type (including its typed write methods), representative valid
writes, and unchanged contract suite exported by `@defrex/autobuild/plugin-sdk` are the
package-versioned compatibility surface. Wire validation remains mandatory even
in a language that cannot consume those TypeScript types directly.

### Artifacts

A build artifact input is:

```jsonc
{
  "kind": "plan",                  // nonempty string
  "contentBase64": "IyBQbGFuCg==", // standard base64
  "metadata": { "round": 1 }      // optional JSON object; defaults to {}
}
```

A build artifact metadata response is:

```jsonc
{
  "build": "remote-store-protocol",
  "kind": "plan",
  "revision": 0,                   // nonnegative integer
  "blobRef": "64-lowercase-hex-sha256",
  "metadata": { "round": 1 },
  "createdAt": "2026-07-15T12:00:00.000Z"
}
```

Repository artifact metadata has `"repo"` instead of `"build"`. An artifact
read returns either JSON `null` or:

```jsonc
{
  "meta": { /* build or repository artifact metadata */ },
  "contentBase64": "IyBQbGFuCg=="
}
```

`blobRef` is the lowercase hexadecimal SHA-256 digest of the decoded bytes.
Revisions start at 0 independently for each artifact kind. Depositing identical
bytes again may reuse the blob but still creates the next metadata revision.

### Atomic deposit messages

Both resource families use this request shape:

```jsonc
{
  "artifacts": [
    { "kind": "plan", "contentBase64": "…", "metadata": { "round": 1 } }
  ],
  "event": {
    "actor": { /* Actor */ },
    "type": "plan.completed",
    "payload": {
      "artifact": { "kind": "plan", "rev": -1 }
    }
  }
}
```

The response is:

```jsonc
{
  "event": { /* build or repository event envelope */ },
  "artifacts": [ /* assigned metadata, in request order */ ]
}
```

Section 7 defines the placeholder and transaction semantics.

### Lease and error messages

```jsonc
// claim request
{ "holder": "runner-1", "ttlMs": 60000 }

// heartbeat or release request
{ "holder": "runner-1" }

// every lease response
{ "ok": true }

// every non-success response
{
  "error": "human-readable message",
  "kind": "validation" // validation | not-found | auth | conflict | internal
}
```

`holder` is nonempty. `ttlMs` is a nonnegative integer measured in
milliseconds. A zero TTL is valid on the wire and produces an immediately
expired lease.

## 3. Build-stream operations

`{slug}` means one percent-encoded build slug. Except for `POST /builds` and
`GET /builds`, all routes first authorize the addressed build and then require
it to exist. An unknown build returns `404 not-found`.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `createBuild` | `POST /builds` | `{slug: string, repo: string, repoOrigin?: string, ticket?: TicketRef, branch?: string, created?: event write}`; `slug`, `repo`, and a supplied `branch` are nonempty. `created`, when present, must be a valid `build.created` write; the server appends it as seq 1 atomically with the record (both exist or neither), and an invalid one is `422` with nothing created | `201` + authoritative `BuildRecord`; project credentials receive a fresh random-suffixed slug and matching branch. Owner admin/open mode keeps exact-slug semantics with `409 conflict` for duplicates |
| `listBuilds` | `GET /builds` | none | `200` + `BuildRecord[]`, filtered by the server to the credential project; owner admin may list all projects. List order is unspecified |
| `getBuild` | `GET /builds/{slug}` | none | `200` + `BuildRecord`; absent is `404` (the shipped client maps this to `null`) |
| `append` | `POST /builds/{slug}/events` | event write | `201` + build event envelope |
| `appendIfCurrent` | `POST /builds/{slug}/events/conditional` | `{"expectedSeq": nonnegative integer, "event": event write}` | appended: `201` + build event envelope; stream advanced: `200 null` |
| `getBuildEventPage` / `getEvents` | `GET /builds/{slug}/events?since={n}&wait={s}` | optional `since` query value, parsed below; absence defaults to `0`. Optional `wait` in whole seconds, parsed per the event-wait rules below | `200 {events, cursor, hasMore}`; at most 256 events with `seq > since`, in increasing sequence order; optional `through` freezes the upper boundary |
| `appendWithArtifactsIfCurrent` | `POST /builds/{slug}/deposits/conditional` | atomic deposit request plus `expectedSeq` | `201` + `{event, artifacts}`, or `200` + `null` on stale head |
| `appendWithArtifacts` | `POST /builds/{slug}/deposits` | atomic deposit request | `201` + `{event, artifacts}` |
| `getReducerSnapshot` | `GET /builds/{slug}/snapshots/{reducer}?version={n}` | required `version` query value, a positive integer; `reducer` is a registry name (`^[A-Za-z][A-Za-z0-9._-]{0,63}$`) | `200` + `{"version", "cursor", "state"}` or `200 null` when absent, written by another reducer version, or ahead of the build log's tail; an unknown build is `404`, which the shipped client also maps to `null` |
| `putReducerSnapshot` | `PUT /builds/{slug}/snapshots/{reducer}` | `{"version": int >= 1, "cursor": int >= 0, "state": JSON}`, at most 16 MiB (`413` above) | `200 {"written": boolean}`; the stored cursor never decreases, so a write at an equal or lower cursor (or an equal cursor at an equal or lower version) and one past the log's tail answer `written: false` |
| `putArtifact` | `POST /builds/{slug}/artifacts` | artifact input | `201` + build artifact metadata |
| `getArtifact` | `GET /builds/{slug}/artifacts?kind={kind}&rev={n}` | `kind` is required and nonempty; optional `rev` is parsed below | `200` + artifact read; an absent `rev` parameter selects the latest revision; a missing kind/revision is `200 null` |
| `getLatestArtifactMeta?` | `GET /builds/{slug}/artifact-meta?kind={kind}` | required nonblank `kind` | `200` + latest validated artifact metadata or `null`; no blob content |
| `listArtifacts` | `GET /builds/{slug}/artifact-list?kind={kind}` | optional `kind`; absence means all kinds | `200` + metadata ordered by kind and then increasing revision |
| `claimLease` | `POST /builds/{slug}/lease/claim` | claim request | `200 {"ok": boolean}` |
| `heartbeat` | `POST /builds/{slug}/lease/heartbeat` | holder request | `200 {"ok": boolean}` |
| `releaseLease` | `POST /builds/{slug}/lease/release` | holder request | `200 {"ok": true}`; a wrong holder is a successful no-op |

The event stream is append-only. The server assigns each build's sequences
independently, starting at 1, and assigns the envelope timestamp. Successful
appends preserve append order. Event and artifact writes update the record's
server-owned timestamps according to the backing `BuildStore` contract.

A conditional append validates the candidate exactly like an ordinary append,
including actor rules, even when its expected sequence is stale. The backing
store must compare the stream tail and append as one atomic operation. At most
one caller can succeed for a given current sequence. A comparison miss returns
`null` and must not append, consume a sequence, or update the build record's
timestamps. An unknown build remains `404 not-found`; malformed or negative
`expectedSeq` is `400 validation`.

Event cursors (`since`, `through`, `cursor`, and `before`) accept ASCII digits
only and must represent safe nonnegative integers. Missing `since` defaults
to zero. Invalid forms return `400 validation`. Artifact `rev` retains its
JavaScript `Number(rawValue)` integer parsing.
An absent `rev` selects the latest artifact, but a present empty `rev=`
selects revision `0`. Sequence filtering is always strict `>`, so a client can
pass the last sequence it has processed without receiving it again. Artifact
revisions are nonnegative; a requested revision that does not exist, including
a negative one, produces `null`. A missing or empty `kind` on the artifact-read
route is `400 validation`.

The optional `BuildStore.getLatestArtifactMeta(slug, kind)` returns
`Promise<ArtifactMeta | null>`, with the same unknown-build behavior as
`getArtifact`. Implement it as a constant-size latest-revision lookup, never
by listing revisions or loading blob content. Memory and PostgreSQL stores
support it; PostgreSQL uses the existing `(build, kind, revision)` primary key
in descending revision order with `LIMIT 1`. The route uses the same build
authorization and project scope as artifact reads. Unsupported backings return
`501 {kind: "unsupported-operation", error: "latest artifact metadata is unsupported"}`.

This additive route does not change the protocol identity. Older servers
answer `404 {kind: "not-found", error: "no route: GET /builds/:slug/artifact-meta"}`
from the store router, or the same envelope with the actual requested URL
pathname from the hosted service router. Only these explicit route-miss responses
(the literal route pattern or the exact requested metadata pathname) or the
explicit 501 operation response disable metadata probing for the lifetime of a
remote client. An unknown-build 404 remains a failure.
The dispatcher then uses ordinary full artifact reads. Authentication,
transport, malformed responses and other server errors remain failures; they
never trigger event downloads or reconstruction of server-reduced values.

The artifact-list `kind` is optional and is normally a nonempty stored kind.
No pagination, deletion, retention, range request, or streaming endpoint is
part of this protocol. Retention is enforced server-side inside the store at
deposit time (bounded pruning of dispatcher run/config artifact revisions),
not through any endpoint.

### Named reducer values

`POST /builds/{slug}/reducer-values` and
`POST /repos/{repo}/reducer-values` accept at most 4 KiB of JSON:

```json
{"reducer":"dispatchStatus","args":{"run":"run-a"}}
```

The response is `200 {"version":2,"cursor":123,"value":{...}}`. Only the
finished JSON answer is returned, with no accumulator or raw-log bundle. `cursor`
is the authoritative prefix included in the answer, not a guarantee to include
appends concurrent with the request. Every call checks durable progress and
persisted state; parallel instances may safely advance the same checkpoint.
Server-owned snapshots are disposable caches: deletion, corruption, wrong versions
and unreadable cache storage cause server-side replay. Log read failures remain errors.
The server answer is canonical for remote clients, regardless of missing, malformed
or different `x-autobuild-catalog-identity` headers. The strict body stays exactly
`{version, cursor, value}`. The reducer `version` is the server's cache identity, not
a compatibility gate. A client accepts any value its own finished shape can
represent and drops object properties that shape does not know. An invalid envelope
or a value the client cannot represent, such as a missing field or an unknown
variant, raises `ReducerValueIncompatibilityError`, naming the reducer,
client/server versions and validation detail. Clients send
`x-autobuild-reducer-value-projection: 1`. A 1.2.0 client predates that capability
and accepts only its own reducer version and shape. The service answers it with the
value projected onto the frozen 1.2.0 shape and the 1.2.0 reducer version, or with
the unprojected answer when that shape cannot represent it. Clients never reconstruct named
answers from raw events. Repository build-digest batches are likewise canonical:
one repo-scoped GET returns the batch without client build discovery or per-build
reducer requests. This does not change the explicit snapshot or event APIs.

The executable catalog is `kernel/reducer-registry.ts`. All requests reject
unknown names, excluded reducers, wrong scopes and invalid/extra arguments with
`400 validation`. A missing resource is `404`, project and delegated authority
checks are the same as other reads, and unsupported methods remain unavailable.
The operation is read-only authority even though its HTTP verb is POST and its
internal cache may advance. It does not accept caller-supplied state. This is an
additive protocol route: historical snapshot and event handlers and the supported
client version window are unchanged.

| Scope | Reducers with no arguments |
| --- | --- |
| Build | `executionNoProgress`, `summaryRequests`, `build`, `buildDigest`, `currentPrAttachments`, `pendingPrAttachmentReclaims`, `openExecution`, `lastExecutionOutcome`, `infrastructureFailureReset`, `openWorkspace`, `setupStreak`, `openBuildWorkspace`, `currentDeferralObservation`, `dashboardFacts`, `pinnedAssets`, `buildDelegation` |
| Repository | `ticketPreparation`, `harvest`, `dispatchSettings`, `sandboxStates`, `openHarvestExecutions`, `autoMergeDefault`, `effectiveConfig`, `harvestDelegation` |

| Reducer | Scope | Required arguments |
| --- | --- | --- |
| `dispatchStatus`, `openTick` | Repository | `run`: nonempty string |
| `dispatchFailureBudget` | Build | `infrastructureOwnsWorkspace`: boolean |
| `phaseFailures` | Build | `phase`: valid phase name; `round`: nonnegative integer |

Arguments are canonicalized into the cache identity; variants never reuse one
another's accumulator. `effectiveConfig` returns an object with optional `run`
and `reference: {kind, rev}`. Absence is distinct from an unreadable referenced
artifact. Delegation values contain semantic lifecycle facts indexed by prefixed
identifiers, not authorization decisions; request time and grace expiry are
always evaluated against those facts on the service.

Each remaining registered reducer is explicitly excluded:

| Reducers | Reason |
| --- | --- |
| `journalView`, `repositoryStateEvents`, `dispatchFrontend` | Raw repository event lists |
| `session` | Operator-session log scope |
| `publicationState` | Selector functions in finished value |
| `logIndex` | Maps and Sets in finished value |
| `hostedPrAttachments` | Map as finished value |
| `summaryBoundary`, `ticketSourceHealth`, `frozenPrImageHost`, `publishedBranchHead`, `verifyDiffBase`, `recordedBaseSha`, `baseBranch`, `provisionMarker`, `recoveryCheckpoint` | Existing finished contract can return top-level `undefined`, which is not JSON |

`GET /repos/{repo}/state-events` is **deprecated**. Its response remains unchanged
for supported clients, including the current dispatcher run's event tail. It is
the compatibility exception to flat event-row reads; new callers should request
named values. The current product no longer loads or writes raw-tail snapshots.

The `value.*` snapshot namespace is reserved for the adapter's private value
checkpoint hooks. Public snapshot GET and PUT requests for this prefix return
`400 validation`, including requests made with delegated or administrator
credentials. Adapter snapshot APIs reject the same names. Ordinary snapshot
names retain their existing behavior. The value cache key format is versioned;
checkpoints from the former publicly writable format are ignored and rebuilt
from the log after upgrading.

### Reducer snapshots

A reducer snapshot is one registered reducer's serialized state as of a log
cursor, kept per scope (one build log or one repository journal) and reducer
name. It is a cache the log regenerates, never an authority: a process with no
hot memory loads it, reads only the events newer than its cursor, advances the
reducer, and writes the advanced state back, and deleting every snapshot changes
no observable output. The routes above and in section 4 are additive and carry
no protocol-version bump. The store, not the client, enforces the invariants:

- the stored cursor never decreases, whatever the versions of the competing
  writers; a write succeeds only when no row exists, when its cursor is above the
  stored one, or when its cursor equals the stored one and its version is higher
  (an upgraded reducer replacing the old shape at an unchanged tail);
- a read answers `null` for a row whose version differs from the requested one,
  and for one whose cursor is beyond the scope's log tail; a write beyond the
  tail is refused;
- an unknown build or repository answers `null` (read) or `written: false`
  (write) and never creates the scope.

A client treats `404` and `405` from either route as "no snapshot", so a client
newer than its store replays the log with no error, and a client older than its
store never calls the routes. Authentication and transport failures still
surface normally. Snapshot authorization follows the owning project, exactly as for events.

### Hosted event bounds and exact resume

Protocol **7** introduces build pages with a fixed limit of **256**. Each
`GET /builds/{slug}/events?since=N` returns `{events, cursor, hasMore}`.
The cursor is the last returned sequence, or N for an empty page. Follow it
while `hasMore` is true to request explicit build history; optional `through`
freezes the head for absence checks. The remote array method `getEvents`
requests one page and returns its array only when `hasMore` is false. Otherwise
it throws `IncompleteEventReadError` with requested cursor, continuation cursor
and page limit. It never silently returns a prefix or concatenates history.
Legacy build-event clients must upgrade to protocol 7; the service refuses their build-event route instead of returning a different successful envelope.

Repository event reads retain their array response but enforce a **1,000**
sequence-position tail window. A cursor is eligible exactly when
`since >= max(0, head - 1000)`, inclusive. The service probes the indexed head
and refuses an expired cursor before selecting event envelopes, reading zero
event rows. It freezes that head as the query's upper boundary, so concurrent
appends cannot expand the response. Each held-read retry rechecks eligibility
at the existing one-second database cadence; disconnect cancellation and the
30-second wait ceiling are unchanged. Authorization and missing-resource checks
precede the head probe and error details.

The refusal is HTTP 409 with
`{kind: "cursor-too-old", error, scope, requestedCursor, head, oldestCursor}`.
`scope` is `{kind:"build", slug}` or `{kind:"repo", repo}`. Watch and wait
resume positions use the same 1,000-position window for both kinds. They exit
on this typed error, instructing the operator to re-arm without `--since` and
reconcile repository/build status. The expired historical gap is unavailable;
no client retries it from zero or silently baselines it.

`GET /builds/{slug}/stream-seed?cursor=N` and
`GET /repos/{repo}/stream-seed?cursor=N` return the exact finished seed at N as
`{version, cursor, value}`. The server owns the accumulator. It checks expiry
before canonical catch-up, then returns a checkpoint including event N; clients
read only events strictly after N. Missing historical positions or corrupt stored
state return typed `checkpoint-integrity` (HTTP 500).

During deployment overlap or rollback, a pre-checkpoint server may advance a
valid canonical row without checkpoint coverage. Under the seed lock, the new
server repairs it from the highest checkpoint at or below that row, reading only
the uncovered suffix and publishing the canonical value and checkpoints atomically.
Only when no checkpoint exists does legacy adoption refold from zero.

The PostgreSQL migration command performs one explicit resumable adoption fold
for existing scopes in batches of at most 256 events, storing progress durably.
Its global completion marker prevents subsequent migrations from enumerating
scopes. New scopes initialize lazily. Never bootstrap a production store as
part of agent verification. Later reducer/catalog identity changes may rebuild
once per scope/identity under a database lock with a post-lock cache recheck.
The current canonical value and its trailing 1,001 accumulator checkpoints
commit atomically; checkpoint capture reads no additional events. That first
canonical rebuild costs L rows for a length-L log. Later requests, including
fresh processes, reuse durable state and read only deltas. Ready-seed resume
costs O(G) for a G-event gap; unchanged reads select zero event rows. Appends
never acquire the checkpoint lock or depend on seed availability.

Two generations per scope remain live, ordered by durable first admission.
Admitting a third retires the oldest and deletes its checkpoints/cache. Permanent
indexed tombstones prevent that identity from being re-admitted, including
catalog-only changes within a release. Refusal is typed
`retired-seed-generation` (HTTP 409): upgrade or restart, re-arm without
`--since` and reconcile status. Immediate-previous-runtime rollback keeps its
live generation; older retired runtimes cannot evict newer generations.
Ordinary reducer upgrades preserve in-window cursors and exact episode suppression
without an upgrader, second replay, or fresh attachment.

`GET /repos/{repo}/harvest-history?before=N` is explicit filtered history:
it returns up to 256 matching `harvest.*` events in descending sequence order,
with exclusive `before`, `cursor`, and `hasMore`. It uses a reverse indexed
seek, independent of unrelated journal length. `ab harvest status --events N`
pages matching events and presents its last N in chronological order. There
is no arbitrary predicate or general repository-history bypass.

### The event-read bounded wait

Both event reads (`getEvents` and, symmetrically, the `getRepoEvents` read of
section 4) accept an optional `wait` parameter in whole seconds. When at least
one event with `seq` strictly greater than parsed `since` already exists, the
response is returned immediately, exactly as without `wait`. Otherwise the
server may hold the request until such an event is appended or the bound
elapses, whichever comes first. At the bound, repository reads answer `200 []`;
build reads answer `200 {"events": [], "cursor": N, "hasMore": false}`,
where N is the requested `since` cursor. Omitting
`wait` (or `wait=0`) is byte-identical behavior to the immediate form.

`wait` is parsed with a dedicated digits-only grammar — one or more ASCII
digits — deliberately stricter than the lenient `rev` conversion above:
empty, whitespace-padded, hexadecimal, signed, and non-integral values are `400
validation`, not coerced. Values above the server's documented ceiling are
clamped to it, never rejected; implementation-dependent examples are 30
seconds (the stream/session wait ceiling) and 25 seconds. A held request's authentication, token scope, and version-skew rules
are identical to the immediate form: a `401`, `403`, or `409` identity failure
is answered immediately, never held.

The parameter is purely additive in the version it merged in (protocol `2`,
where the event-wait rules were introduced): a server
that ignores `wait` remains conforming — its immediate empty answers only raise
the client's request rate — and a client that sends `wait` to such a server
observes no other difference. This is the same reasoning the stream and session
waits apply. There is no push transport; a held request is the whole mechanism.

## 4. Repository-journal operations

Repository journals are separate resources with independent event sequences,
artifacts, and leases. `{repo}` is one percent-encoded repository id; encode
embedded `/` characters. All resource routes authorize and require the
repository to exist. An unknown repository returns `404 not-found` — with one
carve-out: the build-digest batch read of this section is keyed to build
records, not the repository journal record, so it authorizes the project credential
but answers `200` (possibly empty) even for an unknown repository, a repository
without a journal record, or a repository without builds.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `ensureRepo` | `POST /repos` | `{"repo": string}` with a nonempty id | `200` + `RepositoryRecord`; idempotently returns the existing record |
| `getRepo` | `GET /repos/{repo}` | none | `200` + `RepositoryRecord`; absent is `404` (the shipped client maps this to `null`) |
| `appendRepo` | `POST /repos/{repo}/events` | event write | `201` + repository event envelope |
| `getRepoEvents` | `GET /repos/{repo}/events?since={n}&wait={s}` | optional `since` query value, parsed as in section 3; absence defaults to `0`. Optional `wait` in whole seconds, per the event-wait rules of section 3 | `200` + envelopes with `seq > since`, up to the frozen head; `409 cursor-too-old` below `max(0, head - 1000)` |
| `getRepoStateEvents` | `GET /repos/{repo}/state-events` | none | `200` + the bounded repository-journal subset (AUT-489): every durable event type (`ticket-preparation.*`, `harvest.*`, `orchestrator.sandbox.*`, the three dispatcher setting types, and cross-generation handoff correlation facts: target-prepared, yield-requested, upgrade-failed, handoff-started, terminal-released, takeover, drain-deadline, drain-settled and handoff-completed) plus, when the journal has one, the tail from the latest `dispatcher.run-started`, in increasing sequence order; served inside the repository-existence gate like `GET events`, so an unknown repository is `404` |
| `getReducerSnapshot` (repo scope) | `GET /repos/{repo}/snapshots/{reducer}?version={n}` | required `version` query value, a positive integer; `reducer` is a registry name (`^[A-Za-z][A-Za-z0-9._-]{0,63}$`) | `200` + `{"version", "cursor", "state"}` or `200 null` when absent, written by another reducer version, ahead of the journal's tail, or the repository has no journal record; an unknown repository is `404`, which the shipped client also maps to `null` |
| `putReducerSnapshot` (repo scope) | `PUT /repos/{repo}/snapshots/{reducer}` | `{"version": int >= 1, "cursor": int >= 0, "state": JSON}`, at most 16 MiB (`413` above) | `200 {"written": boolean}`; the stored cursor never decreases, so a write at an equal or lower cursor (or an equal cursor at an equal or lower version) and one past the journal's tail answer `written: false` |
| `appendRepoWithArtifacts` | `POST /repos/{repo}/deposits` | atomic deposit request | `201` + `{event, artifacts}` using repository shapes |
| `putRepoArtifact` | `POST /repos/{repo}/artifacts` | artifact input | `201` + repository artifact metadata |
| `getRepoArtifact` | `GET /repos/{repo}/artifacts?kind={kind}&rev={n}` | required nonempty `kind`; optional `rev` is parsed as in section 3 | `200` + artifact read; latest only when the `rev` parameter is absent; missing kind/revision is `200 null` |
| `listRepoArtifacts` | `GET /repos/{repo}/artifact-list?kind={kind}` | optional `kind`; absence means all kinds | `200` + metadata ordered by kind and then increasing revision |
| `getRepoBuildDigests` | `GET /repos/{repo}/build-digests` | none | `200` + `BuildDigest[]`, one entry per build record of the repository (possibly empty), ordered by slug; handled before the repository-existence gate, so an unknown or journal-less repository answers `200 []` |
| `claimRepoLease` | `POST /repos/{repo}/lease/claim` | claim request | `200 {"ok": boolean}` |
| `heartbeatRepo` | `POST /repos/{repo}/lease/heartbeat` | holder request | `200 {"ok": boolean}` |
| `releaseRepoLease` | `POST /repos/{repo}/lease/release` | holder request | `200 {"ok": true}`; a wrong holder is a successful no-op |

There is no repository-list operation. `ensureRepo` is the only repository
creation operation and must not reset timestamps, events, artifacts, or lease
state when the repository already exists. Event sequence numbering starts at 1
for each repository independently of every build and other repository.

A `BuildDigest` projects terminal, observation, and compact merge evidence
from one build's log:

```jsonc
// BuildDigest
{
  "integrationAuditPending": true, // optional: kernel merge audit requested, not yet settled
  "slug": "ab-fix-login-3",
  "terminal": "done",               // optional: "done" | "aborted", omitted while the log has neither
  "observations": [                 // ascending-seq pairs for the log's observation.recorded events
    { "seq": 1, "ts": "2026-07-15T12:00:01.000Z" },
    { "seq": 4, "ts": "2026-07-15T12:00:04.000Z" }
  ],
  "merged": "2026-07-15T12:00:06.000Z", // optional: ts of the log's latest pr.merged, omitted when none
  "mergedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // optional: that merge's actual merge SHA
  "nodeContribution": {              // optional: latest node.contribution-recorded payload
    "landing": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "base": "cccccccccccccccccccccccccccccccccccccccc",
    "identities": ["build:child"]
  }
}
```

The optional `mergedSha` and `nodeContribution` fields let admission index
confirmed merge evidence without fetching every historical build's full facts.
A node contribution is usable only when its `landing` matches `mergedSha`;
recording or recovering a contribution advances `readinessChangeSeq`. These
members are additive: older peers can omit them, leaving presence unproven rather
than substituting source completion. They do not change the protocol version.

The digest is derived from the event log on every call — the server persists
nothing and there is no refresh step. Protocol version `3` reshaped the
digest's `observations` from bare sequence numbers to `{seq, ts}` pairs and
added the optional `merged` fact, so the harvest pressure gate can evaluate
launch decisions from digests and the repository journal alone instead of
reading every build's full history per evaluation. That is a breaking wire
change, not an additive one: a server that predates it returns the old shape
and would fail the client's schema parse mid-request, which is why the version
moved — a stale peer is now rejected at the handshake (`409 conflict`) instead.
This is the same discipline the transport's supported-window rules promise:
wire shapes that independently implemented servers must reproduce update this
document and the protocol version together.

The build-stream query, artifact, ordering, timestamp, and validation rules
apply symmetrically to repository journals, including the event-read bounded
wait of section 3.

### Ticket assets

A ticket asset is a named, versioned bundle of files attached to
a ticket, keyed by `(repo, ticketId, kind, name)`. These routes live under the
repository but, unlike the journal routes, **do not require a repository
record**: assets can precede any journal row, so the repository-existence gate
does not apply. `{repo}` and `{id}` are percent-encoded path segments. Token
authorization requires a credential for that registered project, or owner admin.
The family is additive, so `REMOTE_STORE_PROTOCOL_VERSION` did not change.

Hosted ticket attachments use the ticket service's existing repository-keyed
asset routes with the ticket connection's URL and credential, independently
of the build store. Names, revisions, tombstones and service limits are
unchanged. Existing service attachments need no migration; old local
attachments are not moved or used as a fallback. A claim or ticket spec re-pin
copies exact revisions into immutable chunked repository artifacts in the
destination build store. Build pins reference explicit snapshot manifests;
build-scoped asset reads need no ticket credentials. Old pins without snapshot
references keep their existing ticket-row lookup.

A build also reads the assets it froze at its claim through its own build-scoped
routes, authorized against the build's actual project. The
server reduces the build's events to find the pinned revision, then returns that
exact revision, so a later replace or removal never changes the answer and a
finished build still answers:

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `getPinnedTicketAsset` (manifest) | `GET /builds/{slug}/ticket-assets?kind=&name=[&rev=]` | required `kind` and `name`; optional `rev` | `200` + `TicketAssetMeta` for the latest pinned revision (or the named pinned `rev`), or `200 null` when the build never pinned it |
| `getPinnedTicketAsset` (one file) | `GET /builds/{slug}/ticket-assets/file?kind=&name=&rev=&path=` | required `kind`, `name`, `path`; optional `rev` | `200` + `{"contentBase64": string}`, or `200 null` when not pinned; `404` when the revision has no such file |

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `ticketAssetLimits` | `GET /repos/{repo}/ticket-asset-limits` | none | `200` + `{maxBytes, maxEntries, maxRequestBytes?}` — the effective per-revision ceilings and, when the deployment has one, the largest request or response body it can carry. A server without this route answers `404`; clients treat that as the defaults |
| `putTicketAsset` | `POST /repos/{repo}/tickets/{id}/assets` | `{kind, name, layout, entries}` | `201` + `TicketAssetMeta` (with its manifest) |
| `getTicketAsset` (manifest) | `GET /repos/{repo}/tickets/{id}/assets?kind=&name=[&rev=]` | required `kind` and `name`; optional `rev` | `200` + `TicketAssetMeta` — **the manifest only, no bytes** — or `200 null` when the asset is absent or removed (latest) or the revision does not exist |
| `getTicketAsset` (one file) | `GET /repos/{repo}/tickets/{id}/assets/file?kind=&name=&rev=&path=` | required `kind`, `name`, `path`; optional `rev` | `200` + `{"contentBase64": string}`, or `200 null` when the asset is absent; `404` when the revision has no such file |
| `listTicketAssets` | `GET /repos/{repo}/tickets/{id}/assets/list[?revisions=1]` | optional `revisions=1` | `200` + `TicketAssetSummary[]` ordered by kind, name, revision: the latest live revision per kind and name, or with `revisions=1` every real revision (no tombstones). Summaries carry no manifest |
| `removeTicketAsset` | `POST /repos/{repo}/tickets/{id}/assets/remove` | `{kind, name}` | `200` + the removed `TicketAssetMeta`, or `200 null` when no live asset exists |

Wire types:

```jsonc
// put request: entries are files (content as base64) or explicit directories
{ "kind": "design", "name": "home", "layout": "tree",   // layout: "file" | "tree"
  "entries": [
    { "type": "file", "path": "index.html", "contentBase64": "PGgxPg==" },
    { "type": "dir",  "path": "img/empty" }
  ] }

// TicketAssetMeta: dir entries carry no size or blobRef
{ "repo": "…", "ticketId": "AUT-1", "kind": "design", "name": "home",
  "revision": 0, "layout": "tree", "size": 1234,         // size = total file bytes
  "entries": [
    { "type": "file", "path": "index.html", "size": 1234, "blobRef": "<sha256 hex>" },
    { "type": "dir",  "path": "img/empty" }
  ],
  "createdAt": "2026-10-01T12:00:00.000Z" }

// TicketAssetSummary (list): the same without entries
{ "repo": "…", "ticketId": "AUT-1", "kind": "design", "name": "home",
  "revision": 0, "layout": "tree", "size": 1234,
  "fileCount": 1, "dirCount": 1, "createdAt": "…" }
```

Semantics every server must reproduce:

- **Revisions** are 0-based per `(repo, ticketId, kind, name)`. Putting the same
  kind and name again creates the next revision; earlier revisions stay readable
  by explicit `rev`.
- **Removal is a tombstone** that takes the next revision number with an empty
  manifest. The latest row decides liveness: a read without `rev` and the
  default list skip a removed asset, while an explicit earlier `rev` keeps
  working (a build that pinned that revision still retrieves it). Re-attaching
  takes the next revision, so numbers may skip the tombstone. `revisions=1`
  lists real revisions only.
- **Validation** (`422 validation`, nothing stored). `kind` and `name` match
  `[A-Za-z0-9._-]+`, at most 64 characters. Paths are relative and
  `/`-separated, with no empty, `.`, or `..` segment and no NUL, at most 256
  UTF-8 bytes (128 per segment); paths are unique across files and directories
  and no file is the ancestor of another entry. `layout: "file"` has exactly one
  top-level `file` entry and no directory; `layout: "tree"` may hold any number
  of entries, including zero (an empty folder; its root is implicit). A revision
  holds at most 1000 entries (files plus directories) and **26214400 bytes (25
  MiB)** of file bytes; the error names the limit, for example `ticket asset
  exceeds the 26214400-byte (25 MiB) limit`.
- File bytes are content-addressed (`blobRef` is the sha256 hex) in the same
  blob store as artifacts; the database holds only the manifest.

**Deployment ceilings.** A platform may reject oversized request or response
bodies before any application code runs (Vercel's functions cap them at 4.5
MB), so validating on the server alone cannot enforce a limit. A server that
has such a ceiling advertises it as `maxRequestBytes` on the limits route
together with the effective `maxBytes`, computed from it as follows. Paths and
entry counts are bounded, so the worst-case wire overhead is a constant:
`overhead = 1024 + 1000 × 320 = 321024` bytes, and
`maxBytes = min(26214400, max(0, floor((maxRequestBytes − overhead) × 3 / 4)))`
(base64 inflates content by 4/3); `maxEntries` stays 1000. For example, an instance with `maxRequestBytes` of 4 MiB has an effective per-asset limit of 2904960
bytes (about 2.8 MiB). The formula is a safe lower bound, not the final
authority:

- The shipped **client** reads the limits once per store handle and, before any
  upload, validates against `maxBytes` and `maxEntries` and then compares the
  exact UTF-8 length of the serialized request with `maxRequestBytes`. A bundle
  that does not fit is refused locally with `ticket asset exceeds this store's
  N-byte limit (deployment request ceiling M bytes)` and **no upload request is
  made**.
- The **server** re-validates every put against its effective limits and checks
  every ticket-asset body against `maxRequestBytes` itself, answering `413` (a
  request) or `422` with a limit-naming message where the platform lets the
  request through.
- **Downloads never need a bundle-sized response**: the client reads the
  manifest and then each file by its own request. The manifest, file, and list
  routes check the exact serialized length of their response against
  `maxRequestBytes` and fail with a `413 validation` error naming the asset (or
  the file, its size, and the ceiling) rather than letting the platform reject
  it. This matters for a revision stored under an older or higher ceiling:
  its manifest and smaller files remain retrievable; a file that cannot fit can
  only be fetched from a store with a higher ceiling. Chunked or ranged transfer
  is not part of the protocol, so a deployment's effective per-asset limit is
  its advertised `maxBytes`.

## 5. Operator-session operations

Operator HTTP writes record facts only; they never start or resume an agent
turn. Historical turn events and streams retain their validation and read
contracts. External operator harnesses own execution and scheduling.

Operator sessions are a third resource kind: durable orchestrator-conversation
state keyed by repository and session owner (the human account in `operator`). Local CLI workflows do not create these resources; the resource
contract is uniform, and a conforming server implements it the same way it
implements the repository journal. A session record is:

```jsonc
// SessionRecord
{
  "id": "os_9f2c…",                  // server-assigned, `os_`-prefixed
  "repo": "acme/autobuild",
  "operator": "alice",               // trimmed nonblank session-owner identity
  "title": "fix the login flow",     // optional
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:03:00.000Z"
}
```

Creating a session makes the record and its first event visible together: the
record's creation atomically appends a `session.created` event as sequence 1
with the session owner as a `human` actor. The session event catalog is closed and
separate from the build and repository catalogs (`session.created`,
`message.posted`, `session.wake-set`, `turn.started`, `turn.suspended`,
`turn.resumed`, `approval.requested`, `approval.answered`, `turn.completed`,
`turn.failed`, `session.archived`), with its own per-session sequence starting
at 1 and its own actor-per-type rules. A `via` member is never valid on a
session event: session events are the delegate's own log, and the session owner's
identity is already the actor.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `createSession` | `POST /repos/{repo}/sessions` | `{"repo": string, "operator": string, "title"?: string}`; the body `repo` must equal the path repository | `201` + `SessionRecord` |
| `listSessions` | `GET /repos/{repo}/sessions` | none | `200` + `SessionRecord[]`, creation order (`createdAt`, then the store's creation counter for same-millisecond ties) |
| `getSession` | `GET /sessions/{id}` | none | `200` + `SessionRecord`; absent is `404` (the shipped client maps this to `null`) |
| `appendSessionEvent` | `POST /sessions/{id}/events` | event write | `201` + session event envelope (same envelope shape with `"session"` in place of `"build"`) |
| `appendSessionEventIfCurrent` | `POST /sessions/{id}/events/conditional` | `{"expectedSeq": nonnegative integer, "event": event write}` | appended: `201` + session event envelope; session advanced: `200 null` (mirroring section 3's build compare-and-append) |
| `getSessionEvents` | `GET /sessions/{id}/events?since={n}&wait={s}` | optional `since` query value, parsed as in section 3; absence defaults to `0`. Optional `wait` in whole seconds, per the event-wait rules of section 3 | `200` + session event envelopes with `seq >` parsed `since`, in increasing sequence order |
| `appendSessionWithArtifacts` | `POST /sessions/{id}/deposits` | atomic deposit request | `201` + `{event, artifacts}` using session shapes; the substitution algorithm of section 8 applies unchanged |
| `putSessionArtifact` | `POST /sessions/{id}/artifacts` | artifact input | `201` + session artifact metadata |
| `getSessionArtifact` | `GET /sessions/{id}/artifacts?kind={kind}&rev={n}` | required nonempty `kind`; optional `rev` | `200` + artifact read; missing kind/revision is `200 null` |
| `listSessionArtifacts` | `GET /sessions/{id}/artifact-list?kind={kind}` | optional `kind` | `200` + metadata ordered by kind and then increasing revision |

Session-scoped streams: the stream scope vocabulary gains
`{ "kind": "session", "session": "os_…" }`. `createStream` and `listStreams`
exist under the session family (`POST|GET /sessions/{id}/streams`), the
addressed chunk/close operations work unchanged, and a close deposits its
finalized artifact on the session's artifact table. All stream rules of
section 6 apply to session-scoped streams unchanged.

Event reads honor the bounded wait: when no newer event exists, the server may
hold the request up to the parsed `wait` bound in whole seconds, returning as
soon as an event is appended and no later than the bound; a `wait` above the
event-wait ceiling of section 3 — for example 30 or 25 seconds depending on the instance — is clamped to it. An implementation may poll at a
one-second budget (1000 ms) for session, build and repository event reads. The
clamp and early-return semantics are exactly the
stream read's, so a poll loop cannot drift between the two.

Deposits, artifacts, and per-session sequencing follow the same contracts as
the repository journal: the atomic-deposit guarantee of section 8, latest or
pinned artifact reads, and independent per-session sequence numbering. There
is no session lease family.

## 6. Stream operations

Streams are the BuildStore's third primitive: an append-only, per-stream
sequenced log of chunks with an open-then-closed lifecycle that finalizes into
an artifact. A chunk is a nonempty batch of protocol parts from the Vercel AI
SDK UI Message Stream protocol, version 1 of the current major (AI SDK 7):
each part is a JSON object with a nonempty-string `type`, and part types are
exactly that protocol's (`text-start`/`text-delta`/`text-end`,
`reasoning-start`/`-delta`/`-end`, `tool-input-*`, `tool-output-*`,
`tool-approval-*`, `start-step`, `finish-step`, `start`, `finish`, `abort`,
`error`, `message-metadata`, `source-url`, `source-document`, `file`,
`reasoning-file`, `custom`, and the open `data-*` namespace). The store
performs no protocol validation on append; validation happens once, at close,
when the chunks assemble into the protocol's `UIMessage[]` document. Streams
are presentation, never routing: no kernel, engine, reducer, or dispatcher
decision reads stream content.

Every stream record carries a server-assigned id (`st_`-prefixed), its scope,
a caller-supplied label, the literal format `ai-ui-message-stream/v1`, a
status of `open` or `closed`, `createdAt`, and, once closed, its outcome
(`completed` or `aborted`), `closedAt`, and the reference of its finalized
artifact:

```jsonc
// StreamRecord
{
  "id": "st_9f2c…",
  "scope": { "kind": "build", "build": "remote-store-protocol" },
  // or { "kind": "repo", "repo": "acme/autobuild" }
  "label": "implement round 1",
  "format": "ai-ui-message-stream/v1",
  "status": "closed",
  "createdAt": "2026-07-15T12:00:00.000Z",
  "closedAt": "2026-07-15T12:03:00.000Z",      // optional; closed only
  "outcome": "completed",                       // optional; closed only
  "artifact": {                                  // optional; closed only
    "kind": "stream:st_9f2c…",
    "revision": 0,
    "blobRef": "64-lowercase-hex-sha256"
  }
}
```

A chunk response is:

```jsonc
{
  "stream": "st_9f2c…",
  "seq": 1,                        // per-stream, assigned by the server from 1
  "ts": "2026-07-15T12:00:00.000Z",
  "parts": [ { "type": "text-delta", "id": "t1", "delta": "…" } ]
}
```

A read response carries the chunks plus the stream's current status and,
when closed, its outcome and artifact reference:

```jsonc
{
  "chunks": [ /* StreamChunk */ ],
  "status": "open",
  "outcome": "completed",          // optional; closed only
  "artifact": { /* StreamArtifactRef */ } // optional; closed only
}
```

`{slug}` and `{repo}` mean the same percent-encoded path segments as above.
All six operations exist under both resource families; the scope is fixed at
create and comes from the path. All stream routes authorize like the event
routes (section 7: resource scope gates everything) and carry no
session-attribution dimension — stream parts have no actor.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `createStream` | `POST /builds/{slug}/streams` and `POST /repos/{repo}/streams` | `{"label": string}` with a nonempty label | `201` + `StreamRecord` |
| `listStreams` | `GET /builds/{slug}/streams` and `GET /repos/{repo}/streams` | none | `200` + `StreamRecord[]`, creation order (`createdAt`, then the store's creation counter for same-millisecond ties) |
| `getStream` | `GET /builds/{slug}/streams/{id}` and `GET /repos/{repo}/streams/{id}` | none | `200` + `StreamRecord`; `404` when unknown **or** scoped to another resource |
| `appendStreamParts` | `POST /builds/{slug}/streams/{id}/chunks` and `POST /repos/{repo}/streams/{id}/chunks` | `{"parts": [ { "type": nonempty string, … } ]}`, nonempty | `201` + `StreamChunk` |
| `readStream` | `GET /builds/{slug}/streams/{id}/chunks?since={n}&wait={n}` and the `/repos/{repo}` form | optional `since` (default `0`) must be one or more ASCII digits representing a safe nonnegative integer; invalid values are `400 validation`; `wait` (whole seconds) parsed by the digits-only grammar of section 3's event-wait rules — one or more ASCII digits, anything else `400 validation` per section 9 — and clamped to the 30-second stream ceiling below | `200` + read response: chunks with `seq >` parsed `since`, in increasing order |
| `closeStream` | `POST /builds/{slug}/streams/{id}/close` and `POST /repos/{repo}/streams/{id}/close` | `{"outcome": "completed" \| "aborted"}` | `200` + the closed `StreamRecord` |

Because a stream id is globally unique but names no scope, a conforming server
and client additionally expose the four addressed operations as top-level
routes, which resolve the stream's own scope and then authorize against it:

| Operation | Top-level route | Notes |
|---|---|---|
| `getStream` | `GET /streams/{id}` | `404` maps to `null` in the shipped client |
| `appendStreamParts` | `POST /streams/{id}/chunks` | |
| `readStream` | `GET /streams/{id}/chunks?since={n}&wait={n}` | |
| `closeStream` | `POST /streams/{id}/close` | |

Both scoped and top-level chunk reads use the same `since` grammar: omission
defaults to zero; empty, whitespace-padded, hexadecimal, signed, fractional,
and unsafe-integer values receive `400 validation`.

On both route families, a stream that does not exist and one scoped to a
different resource are the same `404 not-found` (`unknown stream "…"`), so no
cross-scope existence leaks; a token that does not cover the resolved scope
receives `401`/`403` per section 7.

Append semantics, enforced before any mutation:

- Each part must be a JSON object whose `type` is a nonempty string; anything
  else is `400 validation`. Unknown part keys must survive the wire untouched.
- The server assigns each appended batch a per-stream sequence starting at 1
  and the timestamp; producers cannot fake ordering.
- A batch whose serialized JSON exceeds 1,048,576 bytes is `413 validation`
  naming the ceiling — the same bound and shape as the artifact ceiling.
- Appending to a closed stream is `409 conflict` (`stream "…" is closed`);
  appending to an unknown stream is `404 not-found`. Neither writes anything.
- The server resolves and authorizes the stream **before** parsing the append
  body, so a malformed or oversized batch on an unknown or foreign-scoped
  stream is `404 not-found`, not `400 validation` — and the `413` ceiling is
  likewise never reached, since the body is never evaluated. The `400` and
  `413` rejections apply only after the stream resolves.

Read wait semantics: when no newer chunk exists and the stream is open, the
server may hold the request up to the parsed `wait` bound in whole seconds,
returning as soon as a chunk is appended or the stream closes, and no later
than the bound. A `wait` above 30 seconds is clamped to 30. Reads of a closed
stream never wait. A server may return before the bound at any time. The
`wait` value follows the strict digits grammar of section 3's
event-wait rules (a value that is not one or more ASCII digits is `400`
`validation` per section 9), with the 30-second stream ceiling as its clamp.

Close semantics: one atomic operation that assembles the chunks into the
protocol's `UIMessage[]` document — following the protocol for its defined
part types and dropping parts of undefined types while counting them —
deposits that document as an artifact on the owning scope with kind
`stream:<streamId>` at revision 0 and metadata naming the stream id, label,
scope, outcome, chunk count, and dropped-part count, and marks the stream
closed. If the artifact deposit fails, the stream stays open and nothing is
written. Closing an already-closed stream is a no-op that returns the record
(regardless of the requested outcome).

Chunk retention is deposit-path and count-based, like artifact retention: a
closed stream's chunks remain readable until the next stream is created in
the same scope, at which point the chunks of every previously closed stream
in that scope except the most recently closed one are deleted in the same
transaction as the create. Finalized `stream:*` artifacts are never touched
by this rule (their retention belongs to the open archival thread), and open
streams are never pruned. A read of a stream whose chunks were pruned returns
no chunks, `status: "closed"`, and the artifact reference.

These additions were purely additive in the version they merged in (protocol
`2`, where the stream routes were introduced), and a
conforming server implements the stream routes together with this document's
rules exactly as it does for the event and artifact routes.

## 7. Authentication and project authority

Project credentials are opaque `abp_1_<id>_<secret>` bearer values bound to one
registered normalized repository. The service stores only a SHA-256 digest of
the random secret, plus project, creator, creation time, last use, expiry and
revocation metadata. It checks credential status and project registration on
every request. Within one HTTP invocation, registry, authentication and adapter
operations share at most one full registration/deletion admission per repository.
The next request always admits afresh. Reads use that admitted identity; each
mutation transaction locks and checks its generation before writing. Deletion
waits for an active mutation transaction, then invalidates the generation with
the initial purge. A later mutation in the same request may receive `403 project
not registered`; its transaction rolls back, while earlier committed operations
remain committed. No connection or transaction is held for the whole request.
Revocation takes effect on the next request without affecting
other credentials. Unknown, expired or revoked credentials receive `401 auth`;
removed projects receive `403 auth` with `project not registered` when the
repository is established independently. Permanent project deletion removes
credentials, so old credentials receive `401` unknown or revoked credential,
including on `/connect/v1/status`, and remain invalid after reconnection.
See [permanent project deletion](operator-api.md#permanent-project-deletion)
for purge, retry and generation-bound confirmation semantics.

Obtain a project credential with `ab connect <instance-url>` or from the
instance, and use `AB_TOKEN` on non-interactive clients. Interactive connection
saves the credential outside the repository. Retired credential formats are
refused with a credential-format-changed diagnostic; supported old protocol
shapes still require current credentials. Compatibility does not restore retired
authentication. Versioned, attributed owner-admin credentials are an explicit
cross-project exception and must never be supplied to build agents.

Service-owned signatures use `base64url(JSON scope) + "." +
base64url(HMAC-SHA256(instanceSigningKey, payloadSegment))`. Signatures are checked
in constant time. Current strict scope shapes are:

```jsonc
{ "version": 1, "ownerAdmin": { "user": "owner identity" }, "exp": 1800000000000 }
{ "version": 1, "internalOperator": { "user": "owner identity", "repo": "https://github.com/acme/app" }, "exp": 1800000000000 }
```

Internal operator scopes may also carry `via`, using the actor's existing
shape. Unknown fields are invalid. `exp` is epoch milliseconds and expiry is
inclusive (`exp <= now` is refused). These signatures are separate from opaque
project credentials and are never project onboarding credentials.

Every machine route requires Bearer authentication after version negotiation;
`GET /health` stays public. Explicitly unauthenticated local test servers may
remain open. Internal owner operator signatures cannot use raw store routes.

A project credential may read and write its repository journal, artifacts,
snapshots, leases, ticket assets, builds, sessions and streams. Explicit repo
paths and create bodies must match its project (`403 auth: wrong project`).
Indirect build/session/stream IDs are resolved internally and checked against
the resource's actual repository. Missing and foreign IDs both return the same
`404 not-found` error: `resource unavailable: unknown resource or wrong project`.
Remote clients continue mapping addressed GET 404 responses to null. Nested
streams must also belong to the addressed parent.

`GET /builds` is filtered by the server to the credential's project. Project
`POST /builds` always allocates a fresh random-suffixed slug from the requested
base and a matching `ab/<slug>` branch, even when the base is unused. The
returned BuildRecord slug and branch are authoritative for all subsequent
work. A foreign or missing base returns null on GET; it neither reveals
collisions nor blocks creation. Owner admin retains exact-slug creation and
all-project listing. Local BuildStore adapters retain exact-slug semantics.

Project credentials retain runner-style actor/session attribution within the
project; phase CLI scoped handles still constrain build and session access.
Authenticated raw writes cannot claim a delegated `via`. Owner-project
credentials also use their recorded creator for operator writes. Dispatcher
credentials have an immutable server-side purpose: raw store and tickets only,
never operator controls. Each hosted cron repository tick deletes its exact issued
dispatcher-purpose credential row on success or failure. Its crash-safety expiry
is the earlier of the configured token TTL and the invocation deadline plus
60 seconds. Spawned builds receive independent delegated grants whose authority
continues according to their durable lifecycle after the parent row is deleted
or expires. Shared content-addressed blobs remain deduplicated; this is resource
authorization, not blob partitioning.


### Delegated build and harvest credentials

`POST /credentials/delegate` uses the standard identity headers and Bearer
machine authentication. Its strict target is one of:

- `{kind: "build-runner", id}` for an existing build;
- `{kind: "build-phase", id, session}` after its `session.started` fact;
- `{kind: "harvest-runner", repo, id, execution, leaseHolder}` after trusted
  preparation has atomically claimed the scan and recorded
  `harvest.execution.authorized` for that run/execution and adopted holder;
- `{kind: "harvest-phase", repo, id, session}` from its runner, after the
  matching `harvest.session.started` fact.

The response is `{token}` only. Project credentials can issue only within their
registered project. A runner grant may issue only an exact phase grant within
its own lifecycle binding; phase grants cannot delegate. Unknown targets are
refused. Tokens and parent secrets never become artifacts, launch envelopes or
execution facts. Local-store execution requires no exchange; remote execution
fails closed when issuance fails.

The signed strict shape is `{version: 2, delegation: {repo, kind, id, anchor,
session?, execution?, leaseHolder?}}`. `anchor` is the authoritative event
sequence; harvest grants additionally bind the authorized execution. Session
claims exist only on phase grants. No fixed `exp` applies to this shape:
signature/schema verification precedes registered-project and lifecycle checks
on every request, with no authorization cache. Failure to read lifecycle state
fails closed. Parent credential expiry does not expire an already-issued grant.
Project removal refuses all its grants immediately.

Build grants live until 60 seconds after durable build termination. Phase grants
also retire 60 seconds after their own session ends, whichever comes first.
Harvest grants retire 60 seconds after their run stops or their authorized
execution ends/releases; harvest phases additionally retire on session end.
Durable harvest suspension immediately closes the phase grant, without a grace interval.
A resumed local harvest turn opens a new bracket and receives fresh credentials;
the predecessor grant stays closed.
The boundary is exclusive: at `end + 60_000ms` the credential is refused. This
window permits final transcripts, diagnostics, deposits and stream closure.
Pause/escalation of a build and lease expiry do not end authority. Active grants
survive hours-long turns, parent expiry and dispatcher/service reconstruction.
A durable ending never resurrects: recovered harvest work gets a new
`harvest.execution.authorized` identity and token.

Delegated same-project reads remain available, including journals, artifacts,
digests, bounded state, pinned assets and collections. Writes by a build grant
are confined to its build's events/deposits/artifacts, snapshots, leases and
streams. Phase grants also reject agent actors naming another session, while
preserving the CLI's trusted kernel terminals. Delegated credentials cannot
create builds/operator sessions, change ticket assets or repository controls,
or invoke operator APIs. Harvest writes require the exact run in event payloads
and artifact metadata; artifacts use the harvest kinds. Every artifact in an
atomic deposit is checked before writing. Harvest streams have an immutable
`harvest:<run>:<execution>:` label namespace. Addressed streams resolve their actual owner;
a guessed ID cannot bypass the boundary. Only the runner can heartbeat or re-acquire its exact
adopted repository lease holder; another current holder still fences it. Recovery acknowledgements remain dispatcher-side.

Hosted ticket access is gated by grant kind. Build-runner and build-phase grants
cannot call ticket routes. Harvest-phase grants may call only list-ready, get
and dependency-states; harvest-runner grants may additionally create proposals.
Other ticket mutations require project or admin authority. A denied operation
returns 403 naming the grant kind and operation before parsing or source construction.
Ticket admission and repository-keyed assets use the authenticated project;
delegated harvest grants retain that same project boundary.

Workspace plugin factories receive a host-only `delegateCredential` callback
instead of a project token; their environment excludes `AB_TOKEN`. Provisioning
and launch must obtain per-resource authority before running guest code and pass
launch tokens separately from durable execution identity. Remote providers must
not serialize parent credentials or fall back to forwarding them.

## 8. Atomic deposits

The in-process `appendWithArtifacts` APIs take a callback that receives
server-assigned artifact revisions. A callback cannot cross HTTP, so the wire
uses negative revision placeholders.

For request artifact at zero-based index `i`, the placeholder revision is:

```text
-(i + 1)
```

Thus the first artifact uses `-1`, the second `-2`, and so on. The client runs
its callback against sentinel metadata and sends the resulting event write.
The server must perform this algorithm:

1. Decode and prepare all request artifacts without publishing any artifact
   metadata or event.
2. Inside the backing store's atomic `appendWithArtifacts` operation, assign
   each artifact's real per-kind revision.
3. Recursively walk **the event payload**. Arrays and object values are walked.
4. Replace a value only when it is an object with exactly two own keys,
   `kind` and `rev`, where `kind` is a string and `rev` is a negative integer.
5. Convert `rev` to index `-rev - 1`. If that request artifact exists, replace
   the whole object with the assigned metadata's
   `{"kind": meta.kind, "rev": meta.revision}`. The placeholder's supplied
   `kind` does not override the deposited artifact's kind.
6. Leave an out-of-range placeholder unchanged. Catalog validation will reject
   a negative revision wherever that value is governed by an artifact-ref
   schema.
7. Validate the substituted event write, then make all artifact metadata and
   the event visible as one commit.

Substitution does not inspect actor, type, artifact metadata, or arbitrary
objects with extra keys. It supports exact `{kind, rev}` references only;
arithmetic or string computation over a future revision is not part of the
protocol.

The all-or-nothing guarantee covers artifact metadata and the event: no
failure may expose one without the other, and a failed bundle consumes no
artifact revision or event sequence. A backing implementation may leave an
unreferenced content-addressed blob after failure, because blobs are immutable
and metadata is the visibility boundary. Revision assignment, substitution,
event validation, and metadata/event commit must be serialized or
transactional so concurrent deposits receive distinct revisions and events.

Conditional build deposits use `POST /builds/{slug}/deposits/conditional` and
require nonnegative integer `expectedSeq`. The distinct endpoint fails closed
against an older server; the client never falls back to an unguarded deposit.
The backing store compares the head under the same transaction
or build lock as the deposit. A stale head returns `200 null` without artifact
metadata, revision allocation, timestamp updates, retention pruning or event
append. A matching head follows the normal validation/rollback contract and
returns `201 {event, artifacts}`. Immutable orphan blobs remain harmless.
Terminal and suspension writers re-read and revalidate after a comparison miss.

These rules apply identically to build, repository, and session deposits.

## 9. Errors and validation

Every non-success response is exactly the JSON error shape from section 2.
Conforming servers map failures as follows:

| Status | `kind` | Meaning |
|---:|---|---|
| `400` | `validation` | Invalid JSON, request body schema, malformed percent-encoding, missing/empty required `kind`, an event cursor that is not ASCII digits representing a safe nonnegative integer, a `rev` value whose JavaScript `Number` conversion is not an integer, or a `wait` value that is not one or more ASCII digits |
| `401` | `auth` | Missing bearer credentials or an invalid, malformed, badly signed, or expired token |
| `403` | `auth` | Wrong project, project not registered, or disallowed credential purpose |
| `404` | `not-found` | Unknown route, unsupported method, unknown build, unknown repository, unknown session, or an unknown or foreign-scoped stream |
| `409` | `conflict` | Missing/mismatched package or protocol identity, duplicate build creation, appending to a closed stream (`stream "…" is closed`), or a backing conflict reported as already existing |
| `409` | `cursor-too-old` | Requested event cursor precedes the retained resume window; includes `head` and `oldestCursor` |
| `409` | `retired-seed-generation` | Reducer generation was retired; upgrade or restart, re-arm and reconcile status |
| `500` | `checkpoint-integrity` | Required exact checkpoint is missing, corrupt or could not be published |
| `413` | `validation` | Decoded artifact or serialized stream batch exceeds the configured ceiling; a ticket-asset request or response exceeds the deployment's request ceiling; the message names the ceiling |
| `422` | `validation` | `EventValidationError` from build, repository, or session catalog validation, or a ticket-asset validation failure (including the 25 MiB limit); its message is preserved verbatim |
| `501` | `unsupported-operation` | Optional latest artifact metadata capability is unavailable on the backing adapter |
| `500` | `internal` | Any other unexpected backing or server failure; the thrown error message is returned |

Authentication runs before resource lookup, and session authorization runs
before event catalog validation. A request may therefore receive `401` or
`403` even if its resource or event body is also invalid.

Stream appends are evaluated in a fixed order — authentication, stream
resolution and scope authorization, body schema, backing-store validation and
batch ceiling, closed check — so each earlier rejection masks the later ones:
a request with both an unknown stream and an invalid body is `404`, and an
oversized batch addressed to an unknown stream is `404` too (the body, and
with it the ceiling, is never evaluated). Note this ordering differs from the
local store adapters, which validate the batch before resolving the stream —
the streams section of the store specification states both orders
authoritatively.

A `400` wire-schema rejection performs no backing mutation. A `422` event
rejection appends no event. For a deposit, either class of validation failure
also exposes no artifact metadata and consumes no revisions or sequences.
Unknown-resource writes are rejected and perform no mutation.

The generic wire event schema deliberately does not duplicate the event
catalog. Servers must call the matched validator — `validateEventWrite`,
`validateRepositoryEventWrite`, or `validateSessionEventWrite` — before every
ordinary append and inside every atomic deposit.

## 10. Lease and persistence requirements

A conforming backing server provides these behaviors for both build and
repository leases:

- A claim succeeds when the lease is absent, expired, or already belongs to
  the same holder. Success stores the holder, the claim's TTL, and expiry
  `now + ttlMs` and returns `{"ok":true}`.
- A different holder is rejected with `{"ok":false}` while the current lease
  is unexpired. Expiry is strict: at `expiresAt <= now`, the lease is expired
  and claimable.
- A same-holder claim renews the lease using the new claim TTL.
- A heartbeat succeeds only for the current holder while the lease is
  unexpired. It records `heartbeatAt` and extends expiry to
  `now +` the TTL from the successful claim. It does not accept a new TTL.
- A missing, expired, or wrong-holder heartbeat is a no-op returning
  `{"ok":false}`.
- Release removes the lease only for its current holder. A wrong-holder
  release is a no-op, but the HTTP response remains `{"ok":true}`.
- Claims, heartbeat checks, and release decisions are atomic under concurrent
  callers.

Beyond leases, the backing store must maintain:

- per-build and per-repository monotonically assigned event sequences starting
  at 1, preserving append order and continuity across server restarts;
- atomic build-stream conditional append, including a mutation-free stale
  comparison result;
- server-assigned event, record, artifact, lease, and heartbeat times;
- 0-based revisions independently per resource and artifact kind, including
  distinct concurrent assignments;
- SHA-256 content addresses and exact byte, metadata, and metadata-list round
  trips;
- artifact lists ordered by kind and revision;
- strict event payload and actor validation before mutation;
- atomic deposit visibility and rollback as described in section 8; and
- rejection of event, artifact, and lease writes to unknown resources.

For streams, the backing store must additionally maintain:

- per-stream monotonically assigned chunk sequences starting at 1, preserving
  append order and continuity across server restarts;
- append rejection (with no mutation) for closed and unknown streams and for
  batches above the serialized-byte ceiling;
- the bounded read wait exactly as specified in section 6, including the
  30-second clamp and no wait on closed streams;
- the bounded wait on the build, repository, and session event reads exactly
  as specified in section 3, with no per-request database poll faster than once
  per second (a 1000 ms polling implementation observes an append by another
  connection at the next poll, typically within about one second, with a worst
  case of one poll interval plus the query round-trip; the protocol does not
  promise a hard ≤1 s worst case);
- the atomic close — document assembly, artifact deposit, and the closed
  record visible together or not at all, with the stream left open and
  unwritten when the deposit fails;
- the chunk-retention prune at the next create in a scope, in the same
  transaction, keeping the most recently closed stream's chunks; and
- stream ids that are globally unique and `st_`-prefixed.

## 11. Client-only behavior and health

Four shipped behaviors do not add `BuildStore` routes:

- `RemoteBuildStore.scopeBuild(slug)` and `RemoteBuildStore.scopeSession(id)`
  return interface-enforced client handles for exactly that build or session.
  Own-resource record, event, artifact, and (for builds) lease calls use the
  existing routes below. Foreign-resource calls, collection/admin operations,
  nested foreign scope, `close`, and every other family's operations fail in
  the client before a request. This is required even with an open server or an
  admin token: HTTP token scope carries authority over the wire as defense in
  depth; it does not create Store scope.
- `RemoteBuildStore.subscribe(slug, options, onEvent)` polls
  `GET /builds/{slug}/events?since=<lastSeq>`. It starts with
  `options.fromSeq ?? 0`, delivers increasing sequence numbers exactly once
  within that subscription, does not overlap polls, and ignores a polling
  error, retrying on the next cycle. Calling the returned unsubscribe
  function stops future delivery and aborts an in-flight held request. There
  is no repository subscribe method.
  Its cadence follows `options.waitSeconds` (AUT-334), which defaults to the
  client's bounded window (25 s, `REMOTE_EVENT_WAIT_SECONDS`) when the caller
  omits it — so a plain `subscribe` holds one request per wait window on a
  quiet stream, and `waitSeconds: 0` restores the immediate interval loop
  (one read, then one read per `options.pollMs ?? 250`). With a positive
  `waitSeconds`, each cycle issues one held request (`wait=<waitSeconds>`, so
  the server honors the section 3 bound) and then gap-fills so request
  *starts* stay at least `options.pollMs ?? 250` apart, elapsed request time
  counting toward the gap — degrading to exactly the interval rate against a
  server that answers immediately. Delivery order and exactly-once semantics
  are identical in all modes.
- `RemoteBuildStore.close()` is a no-op. The remote server owns its backing
  store lifecycle; there is no close endpoint.
- `GET /health` is outside the `BuildStore` interface. It is always open and
  returns `200 {"ok":true,"autobuildVersion":"1.1.0",
  "protocolVersion":"7", "supportedClientRange":{"minVersion":"1.0.0",
  "maxVersionExclusive":"1.2.0"}}`. It reports HTTP-process availability and identity,
  not a deeper backing-store transaction or migration check. The example shows the 1.1 release identity.

There is no push/WebSocket subscription protocol, repository listing, artifact
deletion, or server deployment API. The one repo-scoped batch read is the
build-digest route of section 4; no other batch-read route exists.

## 12. Conformance

The compatibility bar is an HTTP-backed `BuildStore` client driving the
complete `describeBuildStoreContract` suite against a clean server. Both the
contract function and the `BuildStore` type are public exports from
`@defrex/autobuild/plugin-sdk`. A test registration has this shape:

```ts
import {
  describeBuildStoreContract,
  type BuildStore,
} from '@defrex/autobuild/plugin-sdk'

describeBuildStoreContract('my remote store', async (opts) => {
  // Start a fresh, isolated server and database for every factory call.
  // Pass opts?.clock to the server/backing store, or connect equivalent
  // deterministic clock control in the external test harness.
  const server = await startMyStore({ clock: opts?.clock })
  const store: BuildStore = createHttpBackedBuildStore({
    url: server.url,
    // Omit against an open test server, or supply an admin token.
    token: server.adminToken,
  })

  return {
    store,
    cleanup: async () => server.stopAndDeleteState(),
  }
})
```

The factory must isolate state between tests. It must also connect the suite's
injected clock—or an equivalent controllable server clock—because the contract
asserts exact store timestamps, lease expiry, renewal, and heartbeat behavior.
If authentication is enabled, the harness must mint a valid admin token for
the controlled server time.

Add protocol-specific tests alongside the shared contract for token encoding
and resource isolation, session-attributed writes, exact validation feedback,
atomic placeholder substitution, event paging, unauthenticated health, and
continuity across server restarts. The session family (section 5), the
project credential boundary, revocation, and delegated-write attribution are part of the contract suite and of the protocol-specific cases. Exercise all routes through HTTP, not by
calling the backing store directly.

Passing only route smoke tests is not conformance. The complete shared contract
driven through an HTTP-backed client, plus the protocol-specific cases above,
is the required compatibility test.

## 13. Project connection protocol

`ab connect <url>` uses `POST /connect/v1/requests` with the normalized origin,
a random credential id and SHA-256 digest of a CLI-held secret. The response
contains a ten-minute request id, separate private polling capability, short
browser code, verification URL and five-second interval. `POST /connect/v1/poll`
and `/cancel` require id and capability in JSON; the browser code cannot poll.
Poll returns pending, approved, denied or expired plus immutable repository
and credential id, never the secret. Cancel denies pending work or revokes
only that request's already approved credential. Polling and authenticated
browser code lookup have durable limits; 429 includes Retry-After.

The instance provides `/connect` and cookie-authenticated JSON
`POST /connect/v1/browser/lookup` and `/decide`. Decisions read the saved
proposal, require an allowed live Better Auth session and exact Origin, and
atomically register the project, install the digest and record the outcome.
GET cannot approve. `GET /connect/v1/status` and `POST /connect/v1/revoke`
require a project credential and operate only on its own identity; admin and
internal operator credentials cannot impersonate self-service. All protocol
responses are no-store/no-referrer. Connection commands are unavailable in
build/harvest sessions.

### Repository tick telemetry (protocol 4)

`POST /repos/:repo/tick/begin` accepts `{holder}` and returns the actual start
 timestamp, or null when the unexpired repository lease does not match.
`POST /repos/:repo/tick/finish` accepts `{holder, completion, events}`. Completion
is `{outcome:"completed", counters}` or `{outcome:"failed", error}`; events is
empty for a quiet success or a matching dispatcher start/terminal pair for that
holder. The validated batch and finished telemetry commit atomically. The reply
is `{observation, events}` with assigned envelopes, or null on fencing failure.
These operations never renew the lease. Repository records optionally expose
`tick: {run, open?: {startedAt}, finished?: {run, startedAt, completedAt, ...completion}}`.
They retain the previous completion while a new tick is open and after lease
release. Build and session credentials cannot mutate repository ticks.

The optional `integrationAuditPending` digest fact is introduced on the 0.14
release line without changing protocol identity 4. It survives build completion
and is cleared by audit settlement. Services omit it for historical 0.12/0.13
clients, retaining their decoders and the supported three-line window.

`tickets.migration-recorded` is a durable, decisive human-authored repository
fact: `{ identity, from, to, mapping }`, where mapping contains source ticket IDs
and destination IDs. All migration facts survive dispatcher-run turnover.
Conflicting identity reuse or source-qualified mappings fail replay closed.


Browser lookup returns `{connection,assignment,organizations,assignedOrganization}`.
`connection` may be null. `assignment` is `new` for any unassigned project,
regardless of registry history, and `fixed` for an assigned project.
`assignedOrganization` is its current `{id,name}`, or null for unassigned or
unknown projects. Organizations are eligible `{id,name,membershipRole}`
destinations for unassigned projects (all for super users, actual memberships
otherwise), empty for fixed reconnects or unknown codes. Context uses the same
lookup limits, expiry, admission and foreign-project masking; it assigns nothing.

Valid code links open approval directly, showing a checking status during lookup.
Signed-out users return from sign-in to that approval. Missing or malformed codes
retain manual entry. The approval screen always shows the organization: a
read-only name for assigned projects, or destination choices for unassigned ones.
A sole option is visibly selected and its ID explicitly submitted. Multiple
options require a choice; zero destinations prevent approval and explain that
a super user must create an organization.

Browser approval requires `organizationId` for every unassigned project,
including fresh, legacy active and removed projects, even for super users or
single-membership approvers. Members can select their own orgs; super users can
select any org. Missing IDs return 400; ineligible or nonexistent IDs return 403.
Registration, assignment, credential insertion and the approval decision commit
atomically; refusal changes none of them. Current access and assignment are
rechecked under the access lock. Assigned reconnects keep their organization;
a different supplied ID is refused, and moves use organization management.
Previously registered unassigned projects remain accessible only to super users
until management assignment or an authorized reconnect approval assigns them.
Denial requires no destination and changes no assignment.
Browser lookup and decisions hide foreign projects as unknown connections, even
after resolution. Machine request/poll/cancel/status/revoke contracts and existing
credentials are unchanged.

## Operator presence

The presence collection uses `POST /repos/:repo/operator-presence` and `GET` of that collection.
These require repository operator/admin authority; build, harvest and conversation
credentials are rejected before presence lookup or mutation. No MCP tools are added.

POST accepts a strict `{id, host, pid, startedAt}` object: ID and host are nonblank
strings of at most 256 characters, PID a positive safe integer, and startedAt a
valid ISO timestamp. It atomically upserts `(repo,id)`, preserving the original
start time, updating host/PID and stamping heartbeatAt from the adapter clock.
Heartbeat never moves backward. The response is `{repo,id,host,pid,startedAt,heartbeatAt}`.
GET returns those records ordered by ID, only where heartbeat age is less than
300,000ms; an unknown repository returns `[]` without creating anything. Neither
collection operation appends events, claims leases or requires a repository journal. Expired
rows can be renewed under the same ID. Multiple concurrent registrations coexist;
this is advisory liveness, with no election, lock or singleton semantics.

Protocol 6 adds `DELETE /repos/:repo/operator-presence/:id`, with the same
repository operator/admin authority and delegated credential refusal before lookup
or mutation. The ID is one encoded segment with the same validation as POST.
It returns `{ok:true}` even for an absent/expired ID or absent repository, removes
only that repository/ID, and creates no journal, event or lease. A later POST
re-registers the same ID. Watch withdrawal treats only 404/405 as an unsupported
route and silently retains TTL expiry; authorization, transport and malformed
success errors are diagnosed without failing the watch.

Release line 1.1 uses protocol 6. Published v1.0.0/v1.0.1 use protocol 4;
protocol 5 never shipped. The release identity table retains `1.0 -> 4`, and
a 1.1/protocol-6 instance admits those published clients. A 1.0 instance does
not admit 1.1 clients; route fallback never bypasses peer admission. Patches
within a published release line must keep its protocol identity.


## Project secrets (v1)

The web app's **Settings** tab also manages project secrets. Its separate
cookie-session routes are `GET /api/web/repos/<encoded repo>/secrets`,
`POST .../secrets/set` with strict `{name,value}`, and
`POST .../secrets/remove` with strict `{name}`. An unexpired signed-in session
and fresh project organization membership or super-user authority authorize each
request. Browser mutations require the configured same-origin Origin and JSON.
The normalized signed-in email is the owner and audit actor. Reads return only
allowlisted secret metadata and account name, kind, credentialEnv and readiness
from recorded effective configuration; absent or unavailable configuration does
not prevent secret management. Browser set/replace atomically refuses existing
non-static credentials. Renew ChatGPT credentials with
`ab accounts login <account> --project`. Values are write-only, cleared after
acknowledgment and never returned in responses. Removal confirms in the shared
dialog before writing. The machine routes below retain their project-owner
credential requirement and CLI replacement semantics.

Project secrets are separate from BuildStore artifacts and machine credentials.
They are write-only: no CLI, store method, operator tool, MCP tool or web route
returns a value, ciphertext, access token or refresh state. The only plaintext
consumer is the hosted dispatcher's internal resolver. Local dispatchers use
their own environment.

The machine routes below require the standard client/version headers and bearer authorization,
return JSON with `Cache-Control: no-store`, and require a saved `project-owner`
credential issued through `ab connect`. The project must match the credential,
remain registered, and its creator must still have project membership. Dispatcher,
build, delegated, internal and administrative credentials are refused.

| Route | Input | Response |
| --- | --- | --- |
| `GET /secrets/v1/list?repo=<encoded repository identity>` | Project identity | `{version: 1, secrets: [...]}` |
| `POST /secrets/v1/set` | `{version: 1, repo, name, value}` | `{version: 1, ok: true}` |
| `GET /secrets/v1/chatgpt-host?repo=<encoded repository identity>` | Project identity | `{version: 1, hostId}` (nonsecret destination identity) |
| `POST /secrets/v1/chatgpt` | `{version: 1, repo, name, state}` (validated ChatGPT registration) | `{version: 1, ok: true}` |
| `POST /secrets/v1/remove` | `{version: 1, repo, name}` | `{version: 1, ok: true}` |

The ChatGPT write accepts a strict versioned registration containing its destination
host ID, issued client ID, validated subject, granted scopes, access/refresh/ID
tokens and expiry/refresh window. It validates destination identity and stores
only an encrypted refreshing payload. No response exposes tokens or provider
state; browser authorization completes on the operator's machine.

Writes accept only the listed fields. Static values are nonempty strings, at most
64 KiB in UTF-8, without NUL. Names are case-sensitive environment identifiers
`[A-Z_][A-Z0-9_]*`, at most 128 characters. Dispatcher authority and process-control
names are reserved: store, forge, Vercel, cron, database, object-storage, loader,
proxy and runtime-control variables cannot be overridden. This includes `AB_*`,
`GITHUB_*`, `GH_*`, `VERCEL_*`, `CRON_*`, `DATABASE_*`, `POSTGRES_*`, `PG*`,
`AWS_*`, `BLOB_*`, `PATH`, `HOME`, `NODE_*` and `BUN_*`.
Subscription names such as `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and
`KIMI_API_KEY` are accepted.

Each metadata entry contains `name`, `kind`, `owner` (the member who set the
current value), `setAt` (ISO timestamp), `fingerprint` (16 hexadecimal characters,
keyed and non-reversible), `status` (`ready`, `refreshing`, `failed`), `failureCode`
(null, `refresh-failed` or `refresh-expired`) and `lastSuppliedAt` (ISO timestamp
or null). A refreshing secret may also include typed `warnings`, currently
`["refresh-window-too-short"]` when its permitted refresh window is shorter than
the five-minute tick interval plus a one-minute safety margin. This is advisory;
missing warnings do not establish a sufficient window when encrypted state is
unavailable for diagnosis. Set/replace resets delivery and failure metadata.
Every set/remove records actor and time without material. Supply means the environment was handed
to a kernel, not that a build completed.

On each hosted tick the complete current project set overrides the deployment
environment for that project only. Replacement/removal applies on the next tick.
Resolution failure suppresses intake and all new execution launches. When the
ready subset can be read, a revision-fenced observation-only pass repairs running
execution policies: unavailable names are withheld, their transforms are revoked,
and unrelated ready account transforms remain active. It performs no janitor,
resume, lease-sweep, or harvest launch work. If encryption or decryption prevents
reading that subset, the project is skipped. Resolution and handoff validate the
complete generation/revision set, including unavailable rows; a stale handoff
runs no observation or dispatch. Normal dispatch still requires the complete
usable secret set; other projects can continue. Projects without saved secrets resolve and supply an
empty set without encryption configuration, including when another project has
secrets. All secret mutations still require valid encryption configuration, even
on an empty project. An empty snapshot becomes stale if a secret is added before
handoff. Metadata remains available for diagnosis.

Refreshing kinds are internal provider integrations, not arbitrary endpoint URLs
or CLI write formats. The five-minute hosted cadence is unchanged. A token that
is valid now but not yet refreshable is supplied unchanged; a caller’s future
validity horizon cannot reject it. The first tick at or after both the ten-minute pre-expiry threshold and any
provider earliest-refresh floor rotates the credential and commits encrypted
replacement state before supply. Equality is eligible; an absent floor retains
the ten-minute margin, which tolerates a delayed five-minute tick. After downtime,
expired access state is refreshed before supply while its durable status remains
ready and both gates hold. Expired access behind a future floor is never supplied.
Failed or uncertain refresh attempts prevent supply and require replacement. A valid
credential is never revoked merely because its refresh window is short. A durable
attempt permits only one refresh caller across overlapping ticks. An abandoned attempt expires to failed without reusing the
possibly consumed refresh token; explicit replacement is required. Errors use
fixed safe codes and never reflect provider responses or submitted values.

Use `ab secrets list [--json]`, `ab secrets set NAME` or `ab secrets remove NAME`
from a connected checkout outside build/harvest sessions. Set reads hidden terminal
input or redirected stdin. There is no value argument and values are never printed.
The commands use the saved owner credential, even if an ambient build token exists.


### Forge cooldown admission and explicit recovery

Hosted repository event appends and atomic artifact deposits validate
`dispatcher.forge-degraded` before any durable mutation. The payload must match
its event schema, with a finite ISO `resetAt` at most 24 hours after server time
(inclusive). Already-expired deadlines are accepted. Invalid or out-of-horizon
writes return `400 validation` (the remote adapter exposes `EventValidationError`);
the server never clamps or invents a provider reset. Historical decoding has no clock-relative restriction.

Build-runner and build-phase grants may POST only the kernel-authored
`dispatcher.forge-degraded` repository fact through the events route. The
preceding `requireProject` check binds this exception to the exact repository
in the delegated claim. A hosted project identifies one repository. Delegates
cannot write recovery, deposits or other repository facts, regardless of the
actor claimed in an envelope.

An authorized operator can explicitly clear erroneous state through
`repository.forge_clear {repo, forge, reason}` or
`ab repository forge-clear --forge <name> --reason <text> [--json] [--store <ref>]`.
The reason is required and nonblank. The result contains the durable recovery
`event`, attributed to the authenticated human with normal `via` attribution.
Build and harvest delegates cannot invoke this operator mutation. CLI use
requires an operator outside build/harvest sessions. This is an override, not
proof of provider success. A clear appends once without reading history, even
when already healthy; later degradation wins by ordinary journal order.
Existing dispatcher/kernel automatic recovery and old payloads remain valid;
the recovered payload additionally accepts an optional nonblank `reason`.

## Ticket scan scheduling metadata

`GET /repos/:repo/scan-cadence` returns null or
`{ scanSeq, startedAt, mode, readinessFingerprint, criteriaFingerprint }`.
`scanSeq` is a positive integer acknowledging the last changed-outcome scan
fact; `startedAt` is an ISO timestamp, and mode is `admission` or `observation`.
`POST` to the same path accepts `{ cadence: <that record>, allowClockRollback?: boolean }`
and returns `{ ok: true }`. Reads are keyed and never materialize a repository.
Writes require an existing repository and atomically replace its one cache row;
within the same scan sequence an earlier timestamp is ignored unless an explicit
clock-rollback rescan is acknowledged. Repository deletion removes the row.

Both routes use ordinary repository authorization; delegated build/harvest
credentials cannot mutate this dispatcher metadata. A missing route or invalid
response fails explicitly; clients never reconstruct it from journal history.
This is disposable cadence coordination, distinct from reducer checkpoints;
counts and diagnostics remain exclusively in canonical repository read facts.
