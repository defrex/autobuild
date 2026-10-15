# Hosted ticket protocol

The hosted ticket protocol exposes the complete `TicketSource` port without
exposing backend credentials. It shares the Autobuild and remote protocol
version headers with the remote BuildStore. The version must be in the
published service window and the protocol must
match its known release-line identity (`3` for 0.9, 0.10, and 0.11).

A service accepts stable clients from its own `major.minor` release line and
the two preceding minor lines in the same major. A major starts a new family:
X.0 accepts only X.0, X.1 accepts X.0/X.1, and X.2 onward accepts three lines.
Patch versions are interchangeable in both directions and must never change
the protocol. Upgrade the service first, then projects independently within
its window. Supported release lines retain their wire handlers and known
protocol identities; an unknown protocol is refused independently of version.
Malformed, missing, and prerelease identities are refused with HTTP 409.
A newer client is told to upgrade the service; a client below the window is
told to upgrade the project's Autobuild. Diagnostics name the service version
and supported range.

Unauthenticated `GET /health` publishes `ok`, `autobuildVersion`,
`protocolVersion`, and `supportedClientRange: { minVersion, maxVersionExclusive }`.
The range is inclusive at the minimum and exclusive at the maximum; a 0.11.x
service publishes `>=0.9.0 <0.12.0`. Health needs no credentials, version
headers, or available backend.

## Authentication and context

Every request is `POST /tickets/<operation>`, has `Content-Type:
application/json`, and requires `Authorization: Bearer <token>`. Only a signed,
unexpired **deployment operator** token (`{ "operator": true, … }`) is accepted.
Attributed human-operator, legacy admin, build, repository, and session tokens
remain valid for their own routes but are denied on `/tickets`. Mint a deployment
operator token offline with:

```sh
AB_STORE_SECRET='…' ab-hosted-store mint operator --ttl-seconds 3600
```

The strict request envelope is:

```json
{
  "context": {
    "teamKey": "ENG",
    "claimedState": "Doing",
    "createState": "Triage"
  },
  "input": {}
}
```

`teamKey` is required. The state overrides are optional. They come from the
requesting repository's `[tickets]` configuration and are applied only to that
request; the service does not cache a team-bound adapter. `list-ready` also
receives that repository's exact ready state and label criteria in `input`.
Backend credentials, including `LINEAR_API_KEY`, are service environment only
and never occur in this envelope or any response.

## Operations

The operation names and `input` values are:

| Operation | Input | Successful response |
|---|---|---|
| `list-ready` | `{labels?: string[], state?: string}` | `TicketListing` |
| `get` | `{id}` | `Ticket \| null` |
| `claim` | `{id}` | `{claimed: boolean}` |
| `comment` | `{id, body}` | `{ok: true}` |
| `transition` | `{id, state}` | `{ok: true}` |
| `create` | `{draft, options?}` | `Ticket` |
| `update` | `{id, patch}` | `{ok: true}` |
| `add-blocker` | `{id, blockerId}` | `{ok: true}` |
| `remove-blocker` | `{id, blockerId}` | `{ok: true}` |
| `dependency-states` | `{ids}` | `DependencyState[]` in input order |

Requests and responses reject unknown fields. Tickets include `ref`, optional
`creationKey`, `title`, `body`, optional `state`, `labels`, and optional
`blockedBy`. The client projects every returned `ref.source` as `hosted` while
preserving backend ids, URLs, titles, lifecycle values, labels, creation keys,
and blockers.

Ticket body strings are opaque. Clients, JSON handling, the service, and the
database backend must not trim or normalize bytes, newlines, Unicode, blank
lines, or trailing whitespace.

## Errors and conformance

Errors are JSON `{ "error": string, "kind": "validation" | "not-found" |
"auth" | "conflict" | "internal" }`. Authentication runs before body parsing
or backend construction. Responses never include exception causes, stacks,
environment values, or credentials. Client 401/403 responses become
`AuthError`; other backend messages remain actionable.

The shared `TicketSource` contract is normative for the database adapter and
the hosted client/server pair. External pass-through is tested with a fake
source behind HTTP. The existing opt-in live Linear contract remains the proof
of Linear's GraphQL behavior; the hosted service uses that adapter unchanged.

Every ticket returned by list, get, or create requires a boolean `resolved`,
with the same source-native completion semantics as `DependencyState.resolved`.
The client preserves it when remapping ticket references. Missing or non-boolean
values fail wire validation. Client and service follow the published compatibility window.

Legacy 0.9.x and 0.10.x ticket responses omit `resolved` and `blockersResolved`
because those clients use strict decoders without these fields. This projection
applies to list-ready, get, and create responses. Current clients retain the
current required resolution fields; domain and storage types are unchanged.
