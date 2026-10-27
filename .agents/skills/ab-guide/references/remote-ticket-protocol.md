# Hosted ticket protocol

A conforming hosted instance implements this normative remote ticket contract
for the complete `TicketSource` port without
exposing backend credentials. It shares the Autobuild and remote protocol
version headers with the remote BuildStore. The version must be in the
published service window and the protocol must
match its known release-line identity (`3` for 0.9, 0.10, and 0.11).

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

Hosted tickets, comments, blockers, creation-key deduplication and assets belong
to exactly one registered project, even when projects use the same team key.
Project credentials select that repository. An optional `context.repo` selector
must match the credential's project; mismatches are 403. Owner admin requests
require this selector and registration is checked before configuration is read.
Internal operator credentials remain forbidden on machine ticket routes.

Hosted ticket attachments use the ticket service's existing repository-keyed
asset routes with the ticket connection's URL and credential, independently
of the build store. Names, revisions, tombstones and service limits are
unchanged. Existing service attachments need no migration; old local
attachments are not moved or used as a fallback. A claim or ticket spec re-pin
copies exact revisions into immutable chunked repository artifacts in the
destination build store. Build pins reference explicit snapshot manifests;
build-scoped asset reads need no ticket credentials. Old pins without snapshot
references keep their existing ticket-row lookup.

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
triage. States are persistent project data, including empty states and optional
one-line purposes. Configured role names always exist; removed roles remain as
custom states and keep their tickets. Explicit settings preserve state spelling.
State lookup prefers an exact match, then a unique case-insensitive match;
unknown or ambiguous names are refused. Lists order configured triage, ready,
doing, done first (deduplicated), then other names alphabetically.

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

## Operations

The operation names and `input` values are:

| Operation | Input | Successful response |
|---|---|---|
| `states` | `{}` | `{name, tickets, about?}[]`, including empty states |
| `add-state` | `{name, about?: string}` | `{state: {name,tickets,about?}, created: boolean}` |
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

## Readable ticket identity

New hosted tickets use `<teamKey>-<n>`, for example `ENG-1`. The effective
project configuration supplies the literal prefix; the request's `teamKey`
does not choose it. Numbers start at 1 in each project, increase atomically
across concurrent creates, and are never reused after individual ticket deletion. Permanent project deletion removes the counter; an approved reconnection starts at 1. Projects sharing
a team key have independent counters. Changing `teamKey` affects only future
ids and continues the same numbering; existing ids retain their captured prefix.

Every ticket operation, CLI command, MCP tool and blocker input accepts readable
ids in any letter case. Legacy storage ids (such as `ticket-<uuid>`) remain
aliases, including references in existing builds, harvest records and assets.
Current ticket and blocker output uses the canonical readable id. The exception
is `dependency-states`: each result's `id` echoes the requested id for correlation,
while its `blockedBy` edges are canonical. Raw historical events and artifacts
remain unchanged. These rules apply only to hosted tickets, not file or Linear ids.

## Errors and conformance

Errors are JSON `{ "error": string, "kind": "validation" | "not-found" |
"auth" | "conflict" | "internal" }`. Authentication runs before body parsing
or backend construction. Responses never include exception causes, stacks,
environment values, or credentials. Client 401/403 responses become
`AuthError`; other backend messages remain actionable.

The shared `TicketSource` contract is normative for protocol implementations.
Project partitions must be isolated. The direct Linear client retains its
separate opt-in GraphQL contract; this protocol does not proxy Linear.

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

Custom state creation uses `/^[a-z][a-z0-9-]{0,39}$/`; an optional purpose must
be one nonblank line. A duplicate in any letter case is refused without
changing purpose. `add-state` requires project or owner machine authority;
ticket grants and harvest delegations can read states but cannot create them.
Request context cannot supply lifecycle policy or insert another project's
states. These operations use the existing wire version and strict envelopes.

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
Direct file edits and state-directory moves change revisions. File revisions also
cover structured comments and portable attachments. Legacy file comments change
the body; structured comments preserve it. Separate hosted comments do not change
ticket revisions. Hosted revisions
are monotonic decimal bigint strings, and checks run under the same row lock
and transaction as all requested changes. Hosted reads return a coherent
snapshot of fields, blockers and revision.

### Guarded mutation transport

`POST /tickets/mutate-if-revision` accepts the usual authenticated context and
`input: { id, expectedRevision, mutation }`. Mutation is one of
`{ kind: "update", patch: { title?, body?, labels?, kind?, target? } }`,
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

## Requested ids for migration

Create options accept optional `requestedId: string` alongside `state` and
`idempotencyKey`. Older clients omit it and responses are unchanged. Unsupported
sources reject supplied ids; Linear is not an import target. File sources keep
filesystem-safe ids exactly and never overwrite an occupied id.

Hosted sources preserve only literal own-team `<teamKey>-<n>` ids, where `n` is a
positive canonical decimal within PostgreSQL bigint bounds. For example,
`AUT-706` in team `AUT` keeps 706; `OTHER-706`, `AUT-01` and `AUT-0` use ordinary
allocation. Overflow canonical numbers are rejected. A matching creation key is
adopted before occupancy checks. A kept number belonging to a different ticket
fails without replacing it. Creation and counter advancement share the existing
project transaction and counter lock. Later automatic numbers exceed both the
counter and highest occupied number; importing a lower number never lowers the
counter. Requested ids require project or owner authority. Ticket grants and
delegated credentials receive 403 for create options containing `requestedId`,
before source construction. Their ordinary create grants remain unchanged.

See the [migration procedure](ticket-migration.md) for preflight, state mapping,
resumption and portable file records.

## Integration tree metadata

Hosted tickets store `kind` (`work` or `node`, default `work`) and optional
`target`, the canonical readable id of a node in the same project. Create accepts
both fields; update and guarded update preserve omitted fields and accept
`target: null` to clear an edge. Targets must exist and be nodes. Self-targets,
ancestor cycles, and demoting a node with targeting tickets (including completed
work) are rejected before any part of a mixed patch is written. Graph mutations
serialize per project in the same transaction as validation and revision checks.
Effective metadata changes increment the revision; equivalent aliases are no-ops.

Ticket responses include these fields only with `x-autobuild-ticket-tree: 1`.
This capability is independent of revision and comment capabilities and of the
client version. Without it, both fields are projected away, preserving historical
strict decoders. Current hosted clients send all three capability headers and
default absent kind to `work`. Unfiltered listing includes all ticket states and
empty nodes for `ab ticket tree`; dispatch and merge behavior are unchanged.

Completed ticket imports record `tickets.migration-recorded` in the selected
BuildStore repository journal, with export identity, origin/destination adapter
names and the actual complete ID mapping. Requested-ID preservation alone does
not establish continuity for in-flight builds; see the migration procedure.
