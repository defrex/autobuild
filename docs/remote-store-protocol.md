# Remote BuildStore protocol

This document is the normative HTTP contract for Autobuild's remote
`BuildStore`. Implement this protocol to provide build storage on any database,
blob store, or service stack; Autobuild does not load in-process `BuildStore`
plugins. Compatibility means that the shipped
[`RemoteBuildStore`](../src/store/remote/client.ts) can use the server and pass
the shared [`BuildStore` contract suite](../src/store/contract.ts).

This document describes the protocol shipped in this distribution. The shared
wire schemas in [`protocol.ts`](../src/store/remote/protocol.ts), routing in
[`server.ts`](../src/store/remote/server.ts), token implementation in
[`token.ts`](../src/store/remote/token.ts), and event catalogs linked below are
the matched executable references. A protocol change requires those sources,
the tests, and this document to change together.

## 1. Transport and conventions

- The transport is JSON over HTTP or HTTPS. There is no API version prefix.
  Point Autobuild at the server's base URL with `--store`, or set that URL in
  `AB_STORE`; the shipped client appends the routes below.
- Clients send `Content-Type: application/json` for requests with bodies. Every
  response, including errors and `null` artifact results, has
  `Content-Type: application/json`.
- Build slugs, repository ids, artifact kinds, and holders are case-sensitive.
- A build slug or repository id in a path is one percent-encoded path segment.
  In particular, a repository id such as `acme/widgets` is sent as
  `acme%2Fwidgets`, not as two segments.
- Artifact bytes are represented by `contentBase64`, using standard base64
  (not base64url). The shipped client emits canonical padded base64.
- Store-assigned times are ISO-8601 UTC strings in JavaScript
  `Date.toISOString()` form, for example `2026-07-15T12:00:00.000Z`.
- Event sequence numbers and artifact revisions are integers assigned by the
  server. Clients must not assign either except for the negative deposit
  placeholders described in [Atomic deposits](#6-atomic-deposits).
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

### Actors, event writes, and envelopes

An actor is exactly one of:

```jsonc
{ "kind": "kernel" }
{ "kind": "agent", "role": "implement", "session": "s_123" }
{ "kind": "human", "user": "alice" }
{ "kind": "dispatcher" }
{ "kind": "ingester", "source": "sentry" }
```

`role`, `session`, `user`, and `source` are nonempty strings. The complete
actor schema is [`src/events/envelope.ts`](../src/events/envelope.ts).

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

The wire accepts the generic event-write shape so that the backing server can
return the precise catalog validation error. A conforming server **must**
validate the complete actor, type, payload, and actor-per-type rule before
mutation:

- build payload schemas: [`src/events/payloads.ts`](../src/events/payloads.ts)
- build type and actor rules: [`src/events/catalog.ts`](../src/events/catalog.ts)
- repository payloads, types, and actor rules:
  [`src/events/repository.ts`](../src/events/repository.ts)
- shared actor schema: [`src/events/envelope.ts`](../src/events/envelope.ts)

These matched-distribution catalogs are normative references rather than a
copy of the large, evolving event unions here.

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

Section 6 defines the placeholder and transaction semantics.

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
| `createBuild` | `POST /builds` | `{"slug": string, "repo": string, "ticket"?: TicketRef, "branch"?: string}`; `slug`, `repo`, and a supplied `branch` are nonempty | `201` + `BuildRecord`; duplicate slug is `409 conflict` |
| `listBuilds` | `GET /builds` | none | `200` + `BuildRecord[]`; list order is unspecified |
| `getBuild` | `GET /builds/{slug}` | none | `200` + `BuildRecord`; absent is `404` (the shipped client maps this to `null`) |
| `append` | `POST /builds/{slug}/events` | event write | `201` + build event envelope |
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
part of this protocol.

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

## 5. Authentication and token scope

### Open and authenticated modes

A server configured without a signing secret is in open mode: no route checks
a token or event session attribution. This is intended for local development
and the open contract harness.

A server configured with a secret requires this header on every `/builds` and
`/repos` route:

```http
Authorization: Bearer <token>
```

`GET /health` is always unauthenticated. Authorization occurs before request
body processing on collection routes and before resource lookup on resource
routes. A caller with the wrong scope therefore cannot use existence or
validation differences to inspect another resource.

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
```

`build`, resource `id`, and `session` are nonempty strings. `exp` is an integer
Unix epoch in **milliseconds**. A token is expired when `exp <=` the server's
current epoch milliseconds. A malformed token, malformed scope, bad signature,
or expired token is invalid and receives `401 auth` without a more specific
verification diagnostic.

The legacy scope `{"build":"*", ...}` is the admin resource scope. The
normal runner/admin form also uses `"session":"*"`, allowing event writes on
behalf of any valid actor. Only the legacy `build: "*"` spelling grants admin
resource access; an explicit resource whose id is `"*"` is not admin.

### Resource authorization matrix

| Token resource | `/builds` create/list | one matching build | `/repos` ensure | one matching repo |
|---|---:|---:|---:|---:|
| admin (`build: "*"`) | yes | any | yes | any |
| build | no | exact id only | no | no |
| repo | no | no | no | exact id only |

A valid token used for the wrong resource receives `403 auth`. Resource scope
gates all operations, including reads, artifact operations, and leases.

The token's session dimension adds a second gate only to event-bearing writes:
`POST .../events` and `POST .../deposits`.

- `session: "*"` may submit any actor that the event catalog itself allows.
- Any other session may submit only an actor with `kind: "agent"` and a
  `session` exactly equal to the token session.
- Another agent session or a kernel, human, dispatcher, or ingester actor
  receives `403 auth` before catalog validation.
- Reads, standalone artifact puts, and lease operations do not apply session
  attribution beyond the resource-scope check.

Build and repository scopes never cross: a harvest repository token cannot
read a build stream, and a build token cannot read a repository journal.

## 6. Atomic deposits

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

These rules apply identically to build and repository deposits.

## 7. Errors and validation

Every non-success response is exactly the JSON error shape from section 2.
The shipped server maps failures as follows:

| Status | `kind` | Meaning |
|---:|---|---|
| `400` | `validation` | Invalid JSON, request body schema, malformed percent-encoding, missing/empty required `kind`, or a `since`/`rev` value whose JavaScript `Number` conversion is not an integer |
| `401` | `auth` | Missing bearer credentials or an invalid, malformed, badly signed, or expired token |
| `403` | `auth` | Valid token with the wrong resource scope or event-session attribution |
| `404` | `not-found` | Unknown route, unsupported method, unknown build, or unknown repository |
| `409` | `conflict` | Duplicate build creation or a backing conflict reported as already existing |
| `422` | `validation` | `EventValidationError` from build or repository catalog validation; its message is preserved verbatim |
| `500` | `internal` | Any other unexpected backing or server failure; the thrown error message is returned |

Authentication runs before resource lookup, and session authorization runs
before event catalog validation. A request may therefore receive `401` or
`403` even if its resource or event body is also invalid.

A `400` wire-schema rejection performs no backing mutation. A `422` event
rejection appends no event. For a deposit, either class of validation failure
also exposes no artifact metadata and consumes no revisions or sequences.
Unknown-resource writes are rejected and perform no mutation.

The generic wire event schema deliberately does not duplicate the event
catalog. Servers must call the matched build validator
`validateEventWrite` or repository validator `validateRepositoryEventWrite`
before every ordinary append and inside every atomic deposit.

## 8. Lease and persistence requirements

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
- server-assigned event, record, artifact, lease, and heartbeat times;
- 0-based revisions independently per resource and artifact kind, including
  distinct concurrent assignments;
- SHA-256 content addresses and exact byte, metadata, and metadata-list round
  trips;
- artifact lists ordered by kind and revision;
- strict event payload and actor validation before mutation;
- atomic deposit visibility and rollback as described in section 6; and
- rejection of event, artifact, and lease writes to unknown resources.

## 9. Client-only behavior and health

Three shipped behaviors do not add `BuildStore` routes:

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
  returns exactly `200 {"ok":true}`. It reports HTTP-process availability,
  not a deeper backing-store transaction or migration check.

There is no push/WebSocket subscription protocol, batch-read route,
repository listing, artifact deletion, or server deployment API.

## 10. Conformance

The compatibility bar is the shipped remote client driving the complete
[`describeBuildStoreContract`](../src/store/contract.ts) suite against a clean
server. A test registration has this shape:

```ts
import { describeBuildStoreContract } from '../src/store/contract'
import { RemoteBuildStore } from '../src/store/remote/client'

describeBuildStoreContract('my remote store', async (opts) => {
  // Start a fresh, isolated server and database for every factory call.
  // Pass opts?.clock to the server/backing store, or connect equivalent
  // deterministic clock control in the external test harness.
  const server = await startMyStore({ clock: opts?.clock })

  return {
    store: new RemoteBuildStore({
      url: server.url,
      // Omit against an open test server, or supply an admin token.
      token: server.adminToken,
    }),
    cleanup: async () => server.stopAndDeleteState(),
  }
})
```

The factory must isolate state between tests. It must also connect the suite's
injected clock—or an equivalent controllable server clock—because the contract
asserts exact store timestamps, lease expiry, renewal, and heartbeat behavior.
If authentication is enabled, the harness must mint a valid admin token for
the controlled server time.

The reference registration is
[`src/store/remote/remote.test.ts`](../src/store/remote/remote.test.ts). That
file also contains protocol-specific tests for token encoding and resource
isolation, session-attributed writes, validation feedback, atomic placeholder
substitution, event paging, health, and continuity across server restarts. Run
it with:

```sh
bun test src/store/remote/remote.test.ts
```

Passing only route smoke tests is not conformance. The full shared contract,
driven through `RemoteBuildStore`, is the required compatibility test.
