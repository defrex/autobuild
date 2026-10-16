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
loads the project's durable independent ticket policy. Project authority publishes
version 1 policy through `POST /tickets/policy`, using the usual context/input
envelope. The input contains only `version` and `tickets`: source, teamKey,
readyState, triageState, claimedState, doneState, createState, proposalState and
optional readyLabels. URL, secrets, and pipeline configuration are rejected.
Only project or owner authority can publish. This does not append BuildStore
history. Registration removal invalidates policy and grants from that registration.

For compatibility, projects without independent policy use their latest uploaded
dispatcher configuration with the old `Backlog`, `Doing`, `Done` defaults.
New policy defaults are `triage`, `ready`, `doing`, `done`; create/proposal follow
triage. Allowed states are the distinct union of configured roles. Existing rows
remain unchanged. Explicit settings preserve state spelling.

`[tickets] url` selects the ticket service independently of the build store;
otherwise the selected remote build store is used. A local build store requires
an explicit ticket URL. Credentials are resolved for that selected service.
`ab connect --tickets URL` registers and publishes policy before any dispatcher run.

`POST /tickets/grants` issues, renews or revokes short-lived, digest-stored ticket
grants. Project authority issues runner grants scoped to project and execution;
runners may issue only read-only phase children bound to themselves. Runner grants
allow read and create; phase grants allow read only. Policy, claim, moves, comments,
updates, blocker changes, BuildStore, and credential administration are denied.
AB_TICKET_URL and AB_TICKET_TOKEN carry this authority separately from AB_STORE and
AB_TOKEN. Revocation, expiry, parent revocation and registration changes invalidate
grants. Existing combined-service BuildStore delegation remains supported.

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
