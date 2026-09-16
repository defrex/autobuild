# Remote BuildStore protocol

This document is the complete normative HTTP contract for Autobuild's remote
`BuildStore`. Implement this protocol to provide build storage on any database,
blob store, or service stack; Autobuild does not load in-process `BuildStore`
plugins. Compatibility means that an Autobuild remote client can use the server
and the implementation passes the shared `BuildStore` contract exported by
`autobuild/plugin-sdk`.

The transport, wire shapes, validation order, atomicity, lease behavior,
persistence requirements, and conformance bar for the protocol shipped in this
distribution are all defined here. A protocol implementation must target the
same Autobuild package version used by its clients; protocol changes update this
document and the package's executable contracts together.

## 1. Transport and conventions

- The transport is JSON over HTTP or HTTPS. There is no API version prefix.
  Point Autobuild at the server's base URL with `--store`, or set that URL in
  `AB_STORE`; the shipped client appends the routes below.
- Every `/builds`, `/repos`, and `/sessions` request sends
  `X-Autobuild-Version` with the exact client package version and
  `X-Autobuild-Protocol-Version` with the remote protocol version (`2` in this
  distribution). Before authentication,
  body parsing, or resource lookup, the server compares both exact strings.
  Missing or different values receive `409 {"kind":"conflict","error":"…"}`;
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
  {"kind":"validation","error":"…"}` naming the byte ceiling. The shipped
  hosted service ceiling is 1,048,576 decoded bytes (1 MiB).
- Store-assigned times are ISO-8601 UTC strings in JavaScript
  `Date.toISOString()` form, for example `2026-07-15T12:00:00.000Z`.
- Event sequence numbers and artifact revisions are integers assigned by the
  server. Clients must not assign either except for the negative deposit
  placeholders described in [Atomic deposits](#7-atomic-deposits).
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
the person's behalf: `{ "kind": "session", "id": nonempty }` (an operator's
orchestrator session) or `{ "kind": "mcp", "client": nonempty }` (an MCP
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
catalog from the same Autobuild package version as its client. The public
`BuildStore` type (including its typed write methods), representative valid
writes, and unchanged contract suite exported by `autobuild/plugin-sdk` are the
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
| `createBuild` | `POST /builds` | `{slug: string, repo: string, repoOrigin?: string, ticket?: TicketRef, branch?: string}`; `slug`, `repo`, and a supplied `branch` are nonempty | `201` + `BuildRecord`; duplicate slug is `409 conflict` |
| `listBuilds` | `GET /builds` | none | `200` + `BuildRecord[]`; list order is unspecified |
| `getBuild` | `GET /builds/{slug}` | none | `200` + `BuildRecord`; absent is `404` (the shipped client maps this to `null`) |
| `append` | `POST /builds/{slug}/events` | event write | `201` + build event envelope |
| `appendIfCurrent` | `POST /builds/{slug}/events/conditional` | `{"expectedSeq": nonnegative integer, "event": event write}` | appended: `201` + build event envelope; stream advanced: `200 null` |
| `getEvents` | `GET /builds/{slug}/events?since={n}` | optional `since` query value, parsed below; absence defaults to `0` | `200` + envelopes whose `seq` is strictly greater than parsed `since`, in increasing sequence order |
| `appendWithArtifacts` | `POST /builds/{slug}/deposits` | atomic deposit request | `201` + `{event, artifacts}` |
| `putArtifact` | `POST /builds/{slug}/artifacts` | artifact input | `201` + build artifact metadata |
| `getArtifact` | `GET /builds/{slug}/artifacts?kind={kind}&rev={n}` | `kind` is required and nonempty; optional `rev` is parsed below | `200` + artifact read; an absent `rev` parameter selects the latest revision; a missing kind/revision is `200 null` |
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

For a present `since` or `rev`, the shipped server applies JavaScript
`Number(rawValue)` and accepts the result only when `Number.isInteger` is true.
Consequently hexadecimal and exponent forms such as `0x10` and `1e1`,
whitespace-padded values, and empty or whitespace-only values are accepted;
empty and whitespace-only values convert to `0`. Values converting to `NaN`, infinity, or a
non-integral number produce `400 validation`. An absent `since` defaults to
`0`. An absent `rev` selects the latest artifact, but a present empty `rev=`
selects revision `0`. Sequence filtering is always strict `>`, so a client can
pass the last sequence it has processed without receiving it again. Artifact
revisions are nonnegative; a requested revision that does not exist, including
a negative one, produces `null`. A missing or empty `kind` on the artifact-read
route is `400 validation`.

The artifact-list `kind` is optional and is normally a nonempty stored kind.
No pagination, deletion, retention, range request, or streaming endpoint is
part of this protocol. Retention is enforced server-side inside the store at
deposit time (bounded pruning of dispatcher run/config artifact revisions),
not through any endpoint.

## 4. Repository-journal operations

Repository journals are separate resources with independent event sequences,
artifacts, and leases. `{repo}` is one percent-encoded repository id; encode
embedded `/` characters. All resource routes authorize and require the
repository to exist. An unknown repository returns `404 not-found`.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `ensureRepo` | `POST /repos` | `{"repo": string}` with a nonempty id | `200` + `RepositoryRecord`; idempotently returns the existing record |
| `getRepo` | `GET /repos/{repo}` | none | `200` + `RepositoryRecord`; absent is `404` (the shipped client maps this to `null`) |
| `appendRepo` | `POST /repos/{repo}/events` | event write | `201` + repository event envelope |
| `getRepoEvents` | `GET /repos/{repo}/events?since={n}` | optional `since` query value, parsed as in section 3; absence defaults to `0` | `200` + envelopes with `seq >` parsed `since`, in increasing sequence order |
| `appendRepoWithArtifacts` | `POST /repos/{repo}/deposits` | atomic deposit request | `201` + `{event, artifacts}` using repository shapes |
| `putRepoArtifact` | `POST /repos/{repo}/artifacts` | artifact input | `201` + repository artifact metadata |
| `getRepoArtifact` | `GET /repos/{repo}/artifacts?kind={kind}&rev={n}` | required nonempty `kind`; optional `rev` is parsed as in section 3 | `200` + artifact read; latest only when the `rev` parameter is absent; missing kind/revision is `200 null` |
| `listRepoArtifacts` | `GET /repos/{repo}/artifact-list?kind={kind}` | optional `kind`; absence means all kinds | `200` + metadata ordered by kind and then increasing revision |
| `claimRepoLease` | `POST /repos/{repo}/lease/claim` | claim request | `200 {"ok": boolean}` |
| `heartbeatRepo` | `POST /repos/{repo}/lease/heartbeat` | holder request | `200 {"ok": boolean}` |
| `releaseRepoLease` | `POST /repos/{repo}/lease/release` | holder request | `200 {"ok": true}`; a wrong holder is a successful no-op |

There is no repository-list operation. `ensureRepo` is the only repository
creation operation and must not reset timestamps, events, artifacts, or lease
state when the repository already exists. Event sequence numbering starts at 1
for each repository independently of every build and other repository.

The build-stream query, artifact, ordering, timestamp, and validation rules
apply symmetrically to repository journals.

## 5. Operator-session operations

Operator sessions are a third resource kind: durable orchestrator-conversation
state keyed by repository and operator. They are hosted-only — local installs
interact through the CLI and dashboard and never create one — but the resource
contract is uniform, and a conforming server implements it the same way it
implements the repository journal. A session record is:

```jsonc
// SessionRecord
{
  "id": "os_9f2c…",                  // server-assigned, `os_`-prefixed
  "repo": "acme/autobuild",
  "operator": "alice",               // trimmed nonblank operator identity
  "title": "fix the login flow",     // optional
  "createdAt": "2026-07-15T12:00:00.000Z",
  "updatedAt": "2026-07-15T12:03:00.000Z"
}
```

Creating a session makes the record and its first event visible together: the
record's creation atomically appends a `session.created` event as sequence 1
with the operator as a human actor. The session event catalog is closed and
separate from the build and repository catalogs (`session.created`,
`message.posted`, `session.wake-set`, `turn.started`, `turn.suspended`,
`turn.resumed`, `approval.requested`, `approval.answered`, `turn.completed`,
`turn.failed`, `session.archived`), with its own per-session sequence starting
at 1 and its own actor-per-type rules. A `via` member is never valid on a
session event: session events are the delegate's own log, and the operator's
identity is already the actor.

| BuildStore operation | HTTP route | Request | Success |
|---|---|---|---|
| `createSession` | `POST /repos/{repo}/sessions` | `{"repo": string, "operator": string, "title"?: string}`; the body `repo` must equal the path repository | `201` + `SessionRecord` |
| `listSessions` | `GET /repos/{repo}/sessions` | none | `200` + `SessionRecord[]`, creation order (`createdAt`, then the store's creation counter for same-millisecond ties) |
| `getSession` | `GET /sessions/{id}` | none | `200` + `SessionRecord`; absent is `404` (the shipped client maps this to `null`) |
| `appendSessionEvent` | `POST /sessions/{id}/events` | event write | `201` + session event envelope (same envelope shape with `"session"` in place of `"build"`) |
| `getSessionEvents` | `GET /sessions/{id}/events?since={n}&wait={n}` | optional `since` (default `0`) and `wait` (whole seconds) query values, parsed exactly like the stream read's | `200` + session event envelopes with `seq >` parsed `since`, in increasing sequence order |
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
soon as an event is appended and no later than the bound; a `wait` above 30
seconds is clamped to 30. The clamp and early-return semantics are exactly the
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
| `readStream` | `GET /builds/{slug}/streams/{id}/chunks?since={n}&wait={n}` and the `/repos/{repo}` form | optional `since` (default `0`) and `wait` (whole seconds) query values, parsed exactly like the `since` of section 3 | `200` + read response: chunks with `seq >` parsed `since`, in increasing order |
| `closeStream` | `POST /builds/{slug}/streams/{id}/close` and `POST /repos/{repo}/streams/{id}/close` | `{"outcome": "completed" \| "aborted"}` | `200` + the closed `StreamRecord` |

Because a stream id is globally unique but names no scope, the shipped server
and client additionally expose the four addressed operations as top-level
routes, which resolve the stream's own scope and then authorize against it:

| Operation | Top-level route | Notes |
|---|---|---|
| `getStream` | `GET /streams/{id}` | `404` maps to `null` in the shipped client |
| `appendStreamParts` | `POST /streams/{id}/chunks` | |
| `readStream` | `GET /streams/{id}/chunks?since={n}&wait={n}` | |
| `closeStream` | `POST /streams/{id}/close` | |

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
stream never wait. A server may return before the bound at any time.

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

These additions are purely additive: the protocol version stays `2`, and a
conforming server implements the stream routes together with this document's
rules exactly as it does for the event and artifact routes.

## 7. Authentication and token scope

### Open and authenticated modes

A server configured without a signing secret is in open mode: no route checks
a token or event session attribution. This is intended for local development
and the open contract harness.

A server configured with a secret requires this header on every `/builds`,
`/repos`, and `/sessions` route:

```http
Authorization: Bearer <token>
```

`GET /health` is always unauthenticated. Package/protocol identity validation
occurs first on machine routes. Authorization then occurs before request body
processing on collection routes and before resource lookup on resource routes.
A caller with the wrong scope therefore cannot use existence or validation
differences to inspect another resource.

### Token encoding

A token has two dot-separated base64url segments:

```text
base64url(UTF-8 JSON scope) + "." + base64url(HMAC-SHA256(secret, payloadSegment))
```

The HMAC input is the first token segment exactly as encoded, not the decoded
JSON bytes. The signature is compared in constant time. The scope JSON must
match exactly one of these shapes; unknown keys are invalid:

```jsonc
// Legacy build scope, retained for wire compatibility
{ "build": "build-slug", "session": "s_123", "exp": 1784116800000 }

// Explicit resource scope
{
  "resource": { "kind": "build", "id": "build-slug" },
  "session": "s_123",
  "exp": 1784116800000
}

{
  "resource": { "kind": "repo", "id": "acme/autobuild" },
  "session": "hs_123",
  "exp": 1784116800000
}

{
  "resource": { "kind": "session", "id": "os_123" },
  "session": "*",
  "exp": 1784116800000
}
```

`build`, resource `id`, and `session` are nonempty strings. A resource or
operator scope may carry an optional `via` claim (the same shape as the
actor's `via` marker). `exp` is an integer
Unix epoch in **milliseconds**. A token is expired when `exp <=` the server's
current epoch milliseconds. A malformed token, malformed scope, bad signature,
or expired token is invalid and receives `401 auth` without a more specific
verification diagnostic.

The legacy scope `{"build":"*", ...}` is the admin resource scope. The
normal runner/admin form also uses `"session":"*"`, allowing event writes on
behalf of any valid actor. Only the legacy `build: "*"` spelling grants admin
resource access; an explicit resource whose id is `"*"` is not admin.

### Resource authorization matrix

| Token resource | `/builds` create/list | one matching build | `/repos` ensure | one matching repo | `/repos/{repo}/sessions` create/list | one matching session |
|---|---:|---:|---:|---:|---:|---:|
| admin (`build: "*"`) | yes | any | yes | any | yes | any |
| build | no | exact id only | no | no | no | no |
| repo | no | no | no | exact id only | yes | no |
| session | no | no | no | no | no | exact id only |

A valid token used for the wrong resource receives `403 auth`. Resource scope
gates all operations, including reads, artifact operations, and leases. A
session resource token's authority is exactly its one session — it cannot
create or list sessions, and it cannot touch another session's events,
artifacts, or streams. A repo token owns its repository's session collection
routes but not any session resource. Session resource and repo/build tokens
never cross.

The token's session dimension adds a second gate only to event-bearing writes:
`POST .../events`, `POST .../events/conditional`, and `POST .../deposits`.

- `session: "*"` may submit any actor that the event catalog itself allows.
- Any other session may submit only an actor with `kind: "agent"` and a
  `session` exactly equal to the token session.
- Another agent session or a kernel, human, dispatcher, or ingester actor
  receives `403 auth` before catalog validation.
- Reads, standalone artifact puts, and lease operations do not apply session
  attribution beyond the resource-scope check.

### Delegated-write attribution (`via`)

On every event-bearing write (`POST .../events`, `POST .../events/conditional`,
and `POST .../deposits` on build, repository, and session resources), a server
in authenticated mode enforces `via` attribution after token verification and
before catalog validation:

- A human actor claiming a `via` the token does not carry is `403 auth` — the
  caller must be able to distinguish "not your delegate" from "malformed
  event", which is why this is authority (403) and not validation (422).
- A token carrying a `via` claim stamps that `via` onto every human actor in
  the write: the token is authoritative, and a matching claim or no claim both
  end with the token's `via` on the stored event.
- A non-human actor carrying a `via` key is not an authority question; it falls
  through to catalog validation, which rejects it with the rule message.
- An unscoped operator token carries no `via` and never authorizes raw store
  routes at all.

In open mode there is no token to be authoritative and writes pass through
unchanged. Events without a `via` member are stored, replayed, and read
byte-identically to before.

Build and repository scopes never cross: a harvest repository token cannot
read a build stream, and a build token cannot read a repository journal.
Attributed human-operator scopes have
`{ "operator": { "user": "nonblank identity" }, "exp": … }`. They are accepted
only by the [operator API](operator-api.md), never by raw store or ticket routes;
conversely, deployment/admin/build/repository scopes are refused there.
Deployment scopes have `{ "operator": true, "session": "*", "exp": … }` and
cover raw store and [hosted ticket](remote-ticket-protocol.md) routes without
granting attributed operator controls.

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

These rules apply identically to build, repository, and session deposits.

## 9. Errors and validation

Every non-success response is exactly the JSON error shape from section 2.
The shipped server maps failures as follows:

| Status | `kind` | Meaning |
|---:|---|---|
| `400` | `validation` | Invalid JSON, request body schema, malformed percent-encoding, missing/empty required `kind`, or a `since`/`rev` value whose JavaScript `Number` conversion is not an integer |
| `401` | `auth` | Missing bearer credentials or an invalid, malformed, badly signed, or expired token |
| `403` | `auth` | Valid token with the wrong resource scope or event-session attribution |
| `404` | `not-found` | Unknown route, unsupported method, unknown build, unknown repository, unknown session, or an unknown or foreign-scoped stream |
| `409` | `conflict` | Missing/mismatched package or protocol identity, duplicate build creation, appending to a closed stream (`stream "…" is closed`), or a backing conflict reported as already existing |
| `413` | `validation` | Decoded artifact or serialized stream batch exceeds the configured ceiling; the message names the ceiling |
| `422` | `validation` | `EventValidationError` from build, repository, or session catalog validation; its message is preserved verbatim |
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
  `options.fromSeq ?? 0`, polls immediately and then every
  `options.pollMs ?? 250`, does not overlap polls, and delivers increasing
  sequence numbers exactly once within that subscription. A polling error is
  ignored and retried on the next tick. Calling the returned unsubscribe
  function stops future delivery. There is no repository subscribe method.
- `RemoteBuildStore.close()` is a no-op. The remote server owns its backing
  store lifecycle; there is no close endpoint.
- `GET /health` is outside the `BuildStore` interface. It is always open and
  returns exactly `200 {"ok":true,"autobuildVersion":"<package>",
  "protocolVersion":"2"}`. It reports HTTP-process availability and identity,
  not a deeper backing-store transaction or migration check.

There is no push/WebSocket subscription protocol, batch-read route,
repository listing, artifact deletion, or server deployment API.

## 12. Conformance

The compatibility bar is an HTTP-backed `BuildStore` client driving the
complete `describeBuildStoreContract` suite against a clean server. Both the
contract function and the `BuildStore` type are public exports from
`autobuild/plugin-sdk`. A test registration has this shape:

```ts
import {
  describeBuildStoreContract,
  type BuildStore,
} from 'autobuild/plugin-sdk'

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
session-scoped token's authority matrix, and the `via` stamp/reject order
(section 7) are part of the contract suite and of the protocol-specific cases. Exercise all routes through HTTP, not by
calling the backing store directly.

Passing only route smoke tests is not conformance. The complete shared contract
driven through an HTTP-backed client, plus the protocol-specific cases above,
is the required compatibility test.
