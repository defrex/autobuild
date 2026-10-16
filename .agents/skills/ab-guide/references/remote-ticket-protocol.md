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

Every request is `POST /tickets/<operation>`, has `Content-Type: application/json`,
and requires `Authorization: Bearer <project credential>`. Authentication and
registration checks precede body parsing and source construction. Owner admin
is the explicit cross-project exception; internal operator signatures have no
ticket authority.

Project credentials are opaque `abp_1_<id>_<secret>` bearer values bound to one
registered normalized repository. The service stores only a SHA-256 digest of
the random secret, plus project, creator, creation time, last use, expiry and
revocation metadata. It checks credential status and project registration on
every request. Revocation takes effect on the next request without affecting
other credentials. Unknown, expired or revoked credentials receive `401 auth`;
removed projects receive `403 auth` with `project not registered`.

The deployment owner runs these commands locally with database access:

```sh
ab-hosted-store credentials issue https://github.com/acme/app --user owner@example.com
ab-hosted-store credentials list https://github.com/acme/app
ab-hosted-store credentials revoke https://github.com/acme/app --id ID --user owner@example.com
```

Issue prints the secret once; list contains metadata only. Issue optionally
accepts `--ttl-seconds N` or `--expires-at ISO-8601`. For administrative/non-interactive issuance, set the returned token as
`AB_TOKEN`. Interactive project onboarding uses `ab connect <service-url>`;
it saves the credential outside the repository and commits no secret. Previous `AB_TOKEN` values and `mint operator` / `mint build` are
retired: the service responds that the credential format changed and points
to `credentials issue`. Supported old protocol shapes still work with a new
credential; protocol compatibility does not restore retired authentication.

`mint admin --ttl-seconds N` creates an explicit versioned, attributed owner
break-glass credential. It can cross project boundaries. Keep it owner-only:
never give it or `AB_STORE_SECRET` to a dispatcher or build agent.

Hosted tickets, comments, blockers, creation-key deduplication and assets belong
to exactly one registered project, even when projects use the same team key.
Project credentials select that repository. An optional `context.repo` selector
must match the credential's project; mismatches are 403. Owner admin requests
require this selector and registration is checked before configuration is read.
Internal operator credentials remain forbidden on machine ticket routes.

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

`teamKey` remains required for older client compatibility. It and the optional
`claimedState` / `createState` fields are ignored as policy inputs. The service
loads the project's latest effective configuration from its repository journal
and artifact bytes for every operation. Missing or invalid configuration returns
an actionable 409; run the project's dispatcher to publish its configuration.
There is no deployment-wide lifecycle fallback.

Hosted lifecycle defaults are triage `Backlog`, claimed `Doing`, done `Done`,
and create/proposal equal to triage. `readyState` is required. The allowed states
are the distinct union of these configured roles, including custom create and
proposal states; roles may overlap. Historical states remain readable unchanged.
`tickets.doneState` controls completion and the dispatcher's merged transition.

The service never contacts Linear or relays external trackers. If the project's
source is Linear, file or another non-hosted source, machine HTTP, operator and
MCP ticket surfaces refuse with a message naming that project and source: its
tickets live in its own source, accessed directly by its dispatcher. This is a
409 conflict, not an empty queue. The dispatcher's direct adapters are unchanged.

`AB_TICKET_BACKEND` and `LINEAR_API_KEY` are removed service settings. Their
presence (even blank or unknown values) is ignored and emits one startup removal
message. `AB_TICKET_TRIAGE_STATE`, `AB_TICKET_READY_STATE`,
`AB_TICKET_DOING_STATE` and `AB_TICKET_DONE_STATE` are removed and ignored,
including malformed values. These retired settings do not prevent startup.

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
the hosted client/server pair. PostgreSQL migration and isolation tests prove
project partitions. The direct Linear client retains its separate opt-in
GraphQL contract; no Linear adapter ships through the hosted ticket entry point.

Every ticket returned by list, get, or create requires a boolean `resolved`,
with the same source-native completion semantics as `DependencyState.resolved`.
The client preserves it when remapping ticket references. Missing or non-boolean
values fail wire validation. Client and service follow the published compatibility window.

Legacy 0.9.x and 0.10.x ticket responses omit `resolved` and `blockersResolved`
because those clients use strict decoders without these fields. This projection
applies to list-ready, get, and create responses. Current clients retain the
current required resolution fields; domain and storage types are unchanged.

## Delegated execution credentials

Build and harvest runners exchange project authority for signed, project-bound
execution and phase credentials through `/credentials/delegate` (see the remote
store protocol). Build-runner and build-phase credentials cannot call any ticket
operation. Harvest-phase credentials permit only list-ready, get and
dependency-states. Harvest-runner credentials permit those reads plus create
for filing proposals. Claim, comment, transition, update, add-blocker and
remove-blocker require project or admin authority; their access is unchanged.
Denied delegated calls return 403 with an error naming the grant kind and
operation before body parsing or source construction. Lifecycle retirement and
project removal are also checked before parsing or source construction.

Ticket admission and assets use the authenticated project, including for
delegated harvest grants.

## Revision-checked ticket writes

Every ticket read includes an opaque `revision`. Pass it as `expectedRevision`
(on MCP/operator requests) or `--expected-revision <opaque>` on `ab ticket update`,
`move`, `block` and `unblock`. A stale write fails without changing anything and
reports the current revision. Omission preserves unguarded behavior. Blocker
checks cover the entire batch. Dispatcher moves remain unguarded and change the
revision. Sources without guarded writes, including Linear, refuse supplied
revisions rather than ignoring them.

`ab ticket edit <id>` opens `$VISUAL`, falling back to `$EDITOR`, using TOML
frontmatter and a Markdown body. Only title, body and labels are editable;
id, blockers, creation key and reference comments are read-only. It saves only
changed fields with the opening revision. Unchanged or formatting-only edits
write nothing. On conflict, invalid input or editor failure, the error names an
absolute file path containing the edited text. Read the current ticket and
reapply the intended changes before retrying; conflicts are never merged.

File and Linear revisions fingerprint title, body, canonical label/blocker sets
and state; reverting identical content restores its fingerprint. File checks
re-read immediately before writing, with the existing no-lock race window.
Direct file edits and state-directory moves change revisions. File comments
change the body and revision; separate hosted comments do not. Hosted revisions
are monotonic decimal bigint strings, and checks run under the same row lock
and transaction as all requested changes. Hosted reads return a coherent
snapshot of fields, blockers and revision.

### Guarded mutation transport

`POST /tickets/mutate-if-revision` accepts the usual authenticated context and
`input: { id, expectedRevision, mutation }`. Mutation is one of
`{ kind: "update", patch: { title?, body?, labels? } }`,
`{ kind: "transition", state }`, or
`{ kind: "blockers", operation: "block" | "unblock", ids: string[] }`.
Unknown keys and empty patches are refused. Success returns `{ ok: true }`.
A revision conflict returns HTTP 409 with `kind: "conflict"`, `error`, `id`,
`expectedRevision` and `currentRevision`. Delegated credentials retain existing
permissions: none of the guarded mutation variants grants additional access.
Ticket responses include `revision` only when the request advertises
`x-autobuild-ticket-revisions: 1`. The current hosted client sends this header
on every request and requires revision-bearing responses. Released clients
through 0.12.x omit the header and retain their strict decoder's original
response shape on get, list-ready and create. This explicit capability also
supports new source checkouts that still report version 0.12.0; version alone
cannot distinguish them from released clients. Unknown capability values do
not opt in. Clients before 0.11 also omit the existing resolution projections.
The capability does not change authentication, authorization or the remote
BuildStore protocol version.
