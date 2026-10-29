# Operator API v1

A conforming hosted instance implements this normative polling-oriented operator
contract at
`/operator/v1/repos/{repo}`. It is versioned with remote store protocol **7**.
Every request must send `X-Autobuild-Version`,
`X-Autobuild-Protocol-Version: 7`, and `Authorization: Bearer …`. Identity is
checked before authentication or resource lookup.

Project credentials are opaque `abp_1_<id>_<secret>` bearer values bound to one
registered normalized repository. The service stores only a SHA-256 digest of
the random secret, plus project, creator, creation time, last use, expiry and
revocation metadata. It checks credential status and project registration on
every request. Revocation takes effect on the next request without affecting
other credentials. Unknown, expired or revoked credentials receive `401 auth`;
removed projects receive `403 auth` with `project not registered`.

The hosted cron dispatcher issues a dispatcher-purpose credential per repository
tick, then deletes that exact row on completion or failure. Its crash-safety
expiry is capped at the invocation deadline plus 60 seconds and the configured
`AB_DISPATCHER_TOKEN_TTL_SECONDS` upper bound. Each served tick removes at most
100 expired or revoked dispatcher rows through indexed probes. Legacy unexpired
rows keep their recorded expiry and are pruned afterward. Owner lifetimes are
unchanged. Build and harvest grants are independent signed authority, governed
by durable lifecycle facts and the existing evidence grace, not parent credential
storage or TTL; agents never receive the cron credential.

Obtain a project credential with `ab connect <instance-url>` or from the
instance, and use `AB_TOKEN` on non-interactive clients. Interactive connection
saves the credential outside the repository. Retired credential formats are
refused with a credential-format-changed diagnostic; supported old protocol
shapes still require current credentials. Compatibility does not restore retired
authentication. Versioned, attributed owner-admin credentials are an explicit
cross-project exception and must never be supplied to build agents.

Owner-purpose project credentials attribute every write to their recorded creator.
Dispatcher-purpose credentials are refused. Internal operator credentials use short-lived internal signatures with an explicit version,
selected repository, signed user, expiry and MCP `via`. Only the service holds
the signing key. These signatures authorize operator routes only and require a
registered project; replay against another project is refused.

The path project is checked before registry lookup, body parsing and generic
tool execution. Body repositories and secondary build/session identifiers are
also checked inside that project. Explicit project mismatches return `403 auth:
wrong project`; removal returns `403 auth: project not registered`. Encode each
repository, build, session and artifact kind as a separate URL path segment.
Registration is instance-owned; project credentials cannot administer it.

## Operator sessions

Operator sessions are the signed-in user's durable orchestrator
conversations: a third store resource. A session
belongs to the user who created it; other members of the same repository
can read it and cannot write to it (`403 auth` on non-owner writes). Every
write is attributed to the token's signed user — never a client-supplied
identity — and carries no `via` marker: session events are the delegate's own
log. Writes of any kind to an archived session are `409 refusal`, and the
archived status is terminal.

| Method and path | Result |
|---|---|
| `GET …/sessions` | The repository's session records, newest update first. Readable by any member of the repository. |
| `POST …/sessions` | `{"title"?:"…"}` → `201` + the created `SessionRecord`; the signed-in user owns it. |
| `GET …/sessions/{sid}` | `{session, state, turns}` where `state` is the reducer's derived state (`status`, `openTurn`, `pendingApproval`, `wakeGlobs`, `wakeCursors`, `turns`) and `turns` the ordered turn list. Readable by any member of the repository. |
| `POST …/sessions/{sid}/messages` | `{"text":"…"}` → appends `message.posted`. Owner only. |
| `PUT …/sessions/{sid}/wake` | `{"globs":["…"]}` (possibly empty) → appends `session.wake-set`. Owner only. |
| `POST …/sessions/{sid}/approvals` | `{"turn":"…","toolCallId":"…","decision":"approve"\|"deny"}` → `approval.answered`. Owner only; `409 refusal` when the reduced state has no matching pending approval. |
| `POST …/sessions/{sid}/archive` | Empty body → `session.archived`. Owner only; `409 refusal` when already archived. |
| `GET …/sessions/{sid}/turns/{turn}/stream?since=N&wait=N` | The turn's stream read: `{chunks,status,outcome?,artifact?}` with `since` strictly greater-than and the same bounded-wait semantics as the stream protocol (whole seconds, clamped at 30). Unknown turn is `404 not-found`. Readable by any member of the repository. |

Session state is a reduction of the session's event log, never a stored
column; a `GET …/sessions/{sid}` response therefore always reflects the
session's full history. Message, explicit wake and approval writes return
`{ok:true}` without turn or stream ids. They record facts only: the service
never starts or resumes an agent, executes an approved call, or reaps a turn.
New sessions have no inherited wake settings. Historical turn events and
streams remain readable; an approval answer clears the matching pending
approval without changing its suspended turn or stream. The API never exposes
raw session-event append. External operator harnesses own agent execution.

## Reads

| Method and path | Result |
|---|---|
| `GET …/builds?scope=active\|queued\|all` | Build summaries, newest update first. `queued` means active plus queued, matching `ab builds --queued`. |
| `GET …/builds/{slug}` | `{detail, dashboardRow}`; `detail.runnerAttaches` records chronological attach boundaries and their runtime identity (version, commit, source kind/location), with null runtime for unrecorded historical attaches; `dashboardRow` remains a `CLEANING` row after `build.aborted` and becomes `null` only when the dashboard stops listing it (after cleanup's `build.completed`). |
| `GET …/dashboard` | `{generatedAt, model, settingsHeader}`. `model` is the dashboard's rows, steps, elapsed timing inputs, harvest row, queue/capacity and settings projection. Optional `rollback` contains `correlation`, `lineage`, full `failed` and `restored` runtime identities and rollback event `ts` for the authoritative dispatcher lineage’s unresolved hold. Both dashboards name failed, restored and held runtime plus timestamp. Matching durable different-target hold clearance removes it; a fresh operator lineage hides it only after a committed operational tick or accepted takeover. Run-started and yielded ticks alone cannot replace authority; same-lineage generations retain the notice. Historical rollback records are not fallback notices. Optional `handoffs` lists all accepted unfinished handoffs with predecessor `run`, optional `successor`, `correlation`, full `from`/`to` runtimes, `mode` and optional `deadline`. Outstanding drain-mode builds carry `draining: true`, also on build-detail `dashboardRow`; matching settlement removes it. Accepted completion removes the handoff; neither takeover nor the clock does. Missing historical mode means cutover and missing deadline displays unknown. |
| `GET …/status` | Repository intake, pause, and default-auto-merge projection. |
| `GET …/harvest/status` | Harvest gate, runs, steps, recovery, and attention projection. |
| `GET …/builds/{slug}/artifacts/{kind}?rev=N` | Raw bytes (`application/octet-stream`) plus content-disposition and `X-Autobuild-Artifact-*` metadata headers. Omit `rev` for latest. |
| `GET …/tickets?state=S&label=L&limit=N&offset=K&order=O` | `{states,tickets,diagnostics,criteria,triageState,readyState,doneState,total}`. The three lifecycle names come from effective repository configuration (including provider fallback). With no `state`, `criteria.state` is `triageState`; repeated `label` parameters narrow that state with AND filters. An explicit `state` selects that exact backend workflow state. `limit` (0–200) returns one page, after skipping `offset`, in `order` `oldest` (the source order, the default) or `newest`; `total` counts every match before paging. |
| `GET …/tickets/states` | Full state metadata `{name,tickets,about?}[]`, including empty states (`tickets.states` in MCP). |
| `GET …/tickets/{id}` | `{ticket,blockers,build}`. Blockers include native `exists`/`resolved` status; `build` prefers an active matching repository build, otherwise the most recently updated one. |

For artifact reads, an absent `rev` selects the latest revision. A supplied value
must match `[0-9]+` (one or more ASCII base-10 digits) and represent an integer
from `0` through `Number.MAX_SAFE_INTEGER` (`9007199254740991`). All other
supplied forms return `400 validation`.

Dashboard reads use the latest durable, run-correlated `effectiveConfig`
repository artifact. Missing, corrupt, or invalid configuration returns a typed
`409 effective-config-unavailable`; the service never guesses from a checkout.
Clients poll these reads — the operator HTTP API exposes no push or long-poll
event transport. Streaming is provided by `ab watch`; unflagged watches are read-only.
Only CLI `--operator` watches write advisory liveness, never events or authority;
MCP presence registration is deferred. `ab watch`
streams build and repository events by polling the same event logs client-side
(the store protocol's `GET /builds/{slug}/events` and `GET /repos/{repo}/events`
reads), not as a transport on this API. `triageState`, `readyState`,
`doneState`, and every entry in `states` are backend state names and must be sent back verbatim
when used with the move control.

## Controls

JSON bodies are strict: unknown fields are rejected.

| Method and path | Body |
|---|---|
| `POST …/builds/{slug}/control` | `{"action":"pause"\|"cancel-pause"\|"resume"\|"abort"\|"discard"\|"land"\|"hold"}` |
| `POST …/builds/{slug}/restack` | Empty body; durable node restack demand. |
| `POST …/builds/{slug}/answer` | One answer variant described below. |
| `PUT …/settings/intake` | `{"enabled":boolean}` |
| `POST …/settings/intake/toggle` | Empty body. |
| `POST …/bulk-control` | `{"action":"pause"\|"resume"}`. The hold fact, intake fact, then eligible build events are written in that order. |
| `POST …/harvest/control` | `{"action":"toggle-gate"}` or `{"action":"run","run":"…"}`. A run action is bound to that concrete projected run. |
| `POST …/tickets/states` | `{name,about?}` → `{state,created}`; requires attributed operator identity (`tickets.state.create` in MCP). Hosted duplicate names are refused case-insensitively. |
| `POST …/tickets` | `{"title":"…","body":"…","labels"?:[],"state"?:"…","blockedBy"?:[],"kind"?:"work"|"node","target"?:"id"|null}`; omitted state preserves the backend default. |
| `PATCH …/tickets/{id}` | Any nonempty subset of `title`, `body`, complete-replacement `labels`, `kind` (`work` or `node`), and nullable `target` (null clears). Body bytes are not normalized. |
| `POST …/tickets/{id}/move` | `{"state":"backend state name"}`. |
| `POST …/tickets/{id}/block` | `{"blockerIds":["…"]}`. |
| `POST …/tickets/{id}/unblock` | `{"blockerIds":["…"]}`. |

Answer variants:

```json
{"resolution":"guidance","text":"…"}
{"resolution":"retry"}
{"resolution":"dismiss","text":"optional audit text"}
{"resolution":"review-round-ceiling","ceiling":4,"text":"optional guidance"}
{"resolution":"revise-spec","origin":"body","body":"replacement spec","text":"optional guidance"}
{"resolution":"revise-spec","origin":"ticket","body":"current amended ticket body","text":"optional guidance"}
```

The retry object is deliberately bare: adding `text` is a `400 validation`
rather than silently changing the resolution to guidance. A revision object may
also carry `ceiling` only to receive the shared `incompatible-answer-options`
refusal; a ceiling and spec revision cannot be performed together.
The protocol does not supply ticket-provider credentials. For ticket-origin
revision, a trusted caller fetches the current ticket body and supplies it; the
build must still have a recorded ticket. Revision conformance, lazy retry,
artifact metadata, event ordering, and refusal rules are the same as the CLI.

Operators may explicitly revise an opened idle collecting node or a node blocked on failed
integration verification without an escalation. Use
`ab answer <node> --revise-spec replacement.md` or, after amending its ticket,
`ab answer <node> --revise-spec-from-ticket`. Ticket edits alone do not revise
the build. Both forms enforce the same spec standard as leaf revisions.
Each kernel `spec.revised` records the exact artifact and operator identity
(with optional transport provenance); earlier revisions remain readable.
Ticket-origin revisions re-pin assets; supplied bodies preserve asset pins.
The node recollects and verifies the new revision, including on the same head
and parent after a failed cycle. Earlier cycles remain historical evidence
and cannot block or authorize merge under the replacement. Children keep
their specs, claims and targets; contributions are not restarted.
Active verification/reconcile or writer work, restack/reparent work, pause,
pending controls, merge intent and ended PRs refuse the no-escalation path.
A concurrent state change refuses publication with a retry explanation;
uncited artifacts are inert. Leaves still require an open escalation and
restart from `plan` after any unfinished reconcile resumes under the revised
spec and its publication is confirmed.

## The registry's protocol face: `POST …/tools/{tool}`

One generic route executes any entry of the agent tool registry (the same
closed table `ab mcp` serves over stdio): the body is the tool's validated input — `repo`
included and required to equal the URL's repository — and the response is the
registry result verbatim. The verified operator token supplies the acting
identity and, when minted with one, the `via` attribution marker; the body
never does. Failures keep the shared `{kind,error,code?,progress?}` shape:
validation is `400`, auth `403`, not-found `404`, conflict and refusal `409`,
internal `500`. The route adds no authority of its own — it is the registry
behind the token check — so a tool available here is exactly the tool table,
and the table's contract suite is the single gate.

### Success results

Build control returns one of:

- `{kind:"command",slug,command,event}` after writing a pause, resume, abort,
  discard, or per-build auto-merge command. `command` is the durable command;
  successful cancel-pause therefore returns `command:"resume"`.
- `{kind:"answer-required",slug,escalationIds}` when `action:"resume"` targets
  a blocked build. This is a successful prompt transition but **does not append
  an event**; submit one of the answer requests next.
- `{kind:"answered",slug,count,resolution,resumed,...}` from the answer route.
  `resolution` is `guidance`, `retry`, `dismiss-finding`, or `revise-spec`.
  Depending on the operation, the result also includes `remainingOpen`,
  `reviewRoundCeiling:{loop,value}`, `specRev`, `authorizedEarlier`, or a
  `terminalSignal` describing a terminal status, pending abort, or ended PR.

Repository setting writes and toggles return `{enabled,event}`. Harvest gate
toggle returns `{command:"pause"|"resume",event}`; a concrete-run action
returns `{action:"resume"|"acknowledge",event}`. Bulk control returns
`{direction,slugs,paused,intake}`, where `slugs` is the write-ordered set of
builds that received a command. Every `event` is the complete durable envelope
including repository/build id, sequence, timestamp, actor, type, and payload.

## Errors

JSON errors have `{kind,error,code?,progress?}`. Malformed input is `400
validation`; missing resources/artifacts are `404 not-found`; missing/invalid
credentials are `401 auth`; a valid non-operator scope is `403 auth`; version
skew and unavailable projections are `409 conflict`. A build outside the URL's
repository is deliberately hidden as `404 not-found` with `unknown build`,
consistently for detail, control, answer, and artifact routes. Control refusals are `409
refusal` and preserve the shared `BuildControlError` code and exact reason text.
A partial bulk failure uses code `bulk-partial` and includes the durable write
progress and unattempted builds. Unexpected failures are `500 internal`.

## Browser gateway

The cookie-authenticated gateway contract uses `/api/web/repos/{repo}/…`.
That route is not a second public bearer-token API: it requires a current
Better Auth HTTP-only cookie, rechecks the instance’s current organization membership and project registration, rejects cross-origin JSON controls, and delegates only the dashboard,
build, settings, and harvest operator suffixes listed above. It replaces caller-supplied authorization/version
headers with a server-minted token that expires after 30 seconds and carries
the normalized signed-in email. Consequently every durable control event has
the browser user's human actor while no token or signing secret reaches client
code. Responses are private/no-store; 401 requires reauthentication.
Polling clients may use a two-second interval. The gateway provides no
streaming transport; `ab watch` polls store event reads client-side. Delegated bearer tokens remain
server-side.

The API does not expose phase-session commands, runner startup, a push or
long-poll streaming transport, or a generic event-append operation; event
streaming is composed client-side by `ab watch`, which polls the store's
event reads.


Dispatcher liveness is also visible through `ab repository status --json`:
`dispatcher.holder` identifies the unexpired repository lease owner, independently
of `latestRun`. Each run includes its recorded `runtime` (version, commit, and
source kind/location), or null for unrecorded historical starts. Heartbeat age measures attributable renewals; tick age measures
durable progress. Missing historical evidence is null. The liveness query uses
persisted repository and exact per-run reduced values, including when newer
invocations hide an older holder or stop. Missing facts never trigger a full-log
fallback.

Repository-following `ab watch` additionally emits a read-only `dispatcher.lost`
observation when an observed lease expires without a matching stop or validated
successor takeover. Any recorded stop, normal or abnormal, suppresses loss;
abnormal stops retain their own default attention event. A completed ownership transfer suppresses predecessor loss
even while its sessions drain; a handoff without takeover still reports loss on
expiry. Successor loss and upgrade-failure/rollback attention remain independent. JSON carries
`observation` instead of `event`, with run, observedAt, leaseExpiresAt and available
identity, plus the usual repo/build/state/cursor fields. It invents no durable
sequence or actor. Retain the cursor to avoid repeat reports across invocations.
A watch retains sampled owners after authoritative lease release. Once-run teardown
stops heartbeat and releases only its own lease; release is best effort because
expiry fences ambiguous ownership. A retained sample or failed release cannot
override a persisted stop.
No lease alone is not evidence of death. SIGINT, SIGHUP and SIGTERM drain dispatch,
record the first signal in the stop fact, and release its lease before exit.

### CLI attention monitoring

The default watch reports actionable conditions only:

- `integration.verification-failed`: failed node verification, once per prepared cycle, with failed steps, verified head and parent, and guidance to file a repair child targeting the node. Recovery reports only the latest prepared cycle while its head and parent remain current; superseded failures are not backfilled.

- `build.janitor-failing`: a build has reached the configured consecutive-failure threshold; a successful janitor attempt clears it.
- `dispatcher.forge-persistent`: forge degradation remains after a completed post-reset retry opportunity; successful recovery clears it.

- Build `escalation.raised`, `integration.landed`, `node.item-conflicted`, or
  conflicted `restack.replayed` events. `build.consent-ready` is the single
  signal for a ready consent or held merge, including first repository-wide
  discovery. Its target has the queue entry shape `{kind, branch, ticket?, build?}`.
  Unready and stale candidates stay silent. `build.merge-decision` remains for
  current actionable merge-gate deferrals and unsafe forge outcomes, once per
  build/PR; it does not duplicate consent or hold attention.
- Repository `harvest.escalated`, `harvest.recovery-exhausted`,
  `dispatcher.config-rejected`, `dispatcher.config-reloaded` with nonempty
  `restartRequired`, `dispatcher.upgrade-failed`, `dispatcher.runtime-rolled-back`, abnormal `dispatcher.run-stopped`, and `dispatcher.lost`.
- `dispatcher.ticket-source-persistent`: degradation past its advertised
  reset time, once a tick started at or after reset has completed or failed
  with the episode still open; crossing reset alone is silent. Without a reset,
  the deadline is 15 minutes after onset. Repeated evidence never postpones
  the deadline; recovery ends the episode.
- `dispatcher.tick-failure-persistent`: continuously failing completed ticks
  for five minutes in one run. A successful tick, new run, or matching stop
  ends the episode. Source grace and cooldown-driven failures do not start
  this clock; after grace, the first qualifying failure starts a new five-minute
  interval. Each persistence episode is reported once. Unavailable failure writes delay durable visibility:
  watch keeps running, warns locally and reports one bounded unreported window
  on recovery. These local warnings do not start the durable attention clock
  retroactively. Explicit stops still stop dispatch.

Repository conditions are included with no slugs or with `--repository`.
Routine outcomes and self-healing failures are silent. Repeatable
`--event <glob>` replaces the default and selects exactly matching catalog
events (plus the existing `dispatcher.lost` observation); use explicit globs
to opt into failures, finalize, merge, or completion events.

Derived records use `observation` instead of `event`, without inventing a
durable sequence or actor. Merge observations carry `type`, `pr`, `reason`,
and `observedAt`, plus the build slug and normal reduced state. Persistence
observations carry source/cause/message/resetAt when advertised (or
run/firstFailure/error), `episodeSeq`, and `observedAt`; repository records
have `repo` and null build/state. Source observations also report
`dependencyLimited`.

Every record carries a cursor, including timer-only records. Resuming suppresses
delivered merge decisions and persistence episodes even when stream positions
did not advance. Old v1 cursors remain valid inside the hosted 1,000-position resume window: historical eligible merge
decisions are treated as consumed; active overdue repository episodes may
report because old watches had no persistence notification. Fresh attachment
silently baselines historical direct events and merge decisions, but retains
active repository timers. Reconcile existing conditions through status after
arming the watch. Named watches still end when every named build is terminal;
learn their outcomes from status reconciliation at exit.

`ab wait --for attention` is build-only and uses the same build conditions:
current failed node verification, an open escalation, janitor failure attention,
consent readiness, merge/conflict attention or a merge decision. Current failed
verification satisfies attention even before its notification is written. Existing conditions return immediately,
even with `--since`; live and backlog matches ignore routine outcomes and
self-healing failures. A merge match uses the watch observation with
`condition: "attention"`. Explicit `--event` globs remain event-only.
Watch and wait preserve each other's cursor notification metadata.

Normal re-arms retain `--since`. Hosted watch/wait resume is gap-proportional
inside a 1,000-sequence-position window, inclusive at `head - 1000`. Expired
cursors fail with typed `cursor-too-old` and the oldest servable cursor; re-arm
without `--since` and reconcile repository/build status, acknowledging the lost
historical gap. An ordinary reducer upgrade preserves valid cursors. A retired
seed generation instead requires an upgrade/restart before fresh attachment;
checkpoint integrity errors are terminal and never trigger replay from zero.

The MCP `builds.events` tool returns `{events, cursor, hasMore}`, at most 256
events per call. Follow `cursor` while `hasMore` is true to traverse a build's
complete history without omission. Waiting remains bounded and applies only
when no events are available. Repository event reads have a 1,000-position
window; build history itself remains available through explicit pages.


Hosted ticket tools resolve independent project ticket policy before legacy uploaded
configuration. Queue, detail, state discovery and mutations work before any build
or dispatcher run; detail reports a null matching build. Ticket policy publication
never creates synthetic build or repository history.

Ticket detail and mutation results prefer exact normalized ticket ids when associating
a build. If no exact match exists, only legacy hosted `ticket-<uuid>` storage
references require optional alias resolution, once per distinct reference. Readable
historical ids require no ticket lookup. Failed optional alias resolution does not
fail ticket detail or a completed mutation; matches already resolved remain eligible.

Ticket results include kind (default work) and optional same-source node target.
Metadata-only patches are accepted. Target validation and demotion guards apply
to CLI, HTTP and MCP alike; unsupported sources refuse even explicit defaults
or clears before changing other fields. Dispatch routing is unchanged.

HTTP merge controls retain the wire actions `land` and `hold` with acknowledged durable state. Merge
requires readiness and survives restacks; hold persists until merge. Repository
auto-merge settings are retired; configure ordered `[[merge]]` rules.

Default attention includes `build.janitor-failing` and
`dispatcher.forge-persistent`. Raw `dispatcher.forge-degraded` and
`dispatcher.forge-recovered` facts are available through explicit event filters.
Active janitor attention clears on a successful attempt. Repository status
includes forge degradation/reset and available request counts; `dispatcher.forge-persistent` requires a completed retry opportunity past
the original reset, which later rate limits cannot postpone indefinitely.

### Node restack request

`builds.restack` accepts `{repo, slug}`. `POST /operator/v1/repos/:repo/builds/:slug/restack`
uses the same service as `ab restack <node>`. The receipt contains `slug`,
`request`, `coalesced` and `waiting`; execution is asynchronous. It refuses
non-node, unopened and terminal builds and enforces repository ownership.

Repository status includes `upgrades.runs`, keyed by originating dispatcher run,
with latest successful `resolved` target, detected target, failure, handoff and
completion evidence. `dispatcher.upgrade-target-resolved` carries strict
`{run, lineage, target}` data; the target has mode (`pinned`, `installed`, or
`source`), content key, source provenance and optional version/base/SHA. Source
mode names the authoritative base commit, which can advance without changing
packaged inputs or the running runtime. Status text renders the resolved mode,
base and SHA separately, so an older handoff cannot hide a newer target. Identical
observations append nothing; a successful resolution does not clear failures. Facts carry launcher
lineage, from/to runtimes, resolution mode and authoritative base SHA/ref or original
installation provenance, plus prepared cache identity. Completion names the successor
and records completed retirement separately from takeover. During a handoff the
projection includes both generations, chosen mode, outstanding draining builds
and deadline. The successor owns repository work after terminal release and lease
claim, while old local runners retain execution leases until settlement or deadline.
Remote guests retain independent leases, finish their phase and request neutral
relaunch; their separate handoff capture never holds retirement open. `dispatcher.upgrade-failed` is immediate repository
attention; the current generation remains active and identical failed inputs are
suppressed across native handoff until target or selected-store compatibility evidence changes or a fresh operator launch.

Repository status additionally exposes `upgrades.lastRollback` (historical, retained
when cleared), `upgrades.holds` keyed by launcher lineage, `upgrades.lineages` keyed
by generation run, optional `upgrades.authoritativeRun` from rollback, accepted takeover or committed operational tick (never startup/yield alone), `upgrades.rollbackIds` for idempotent rollback correlations, and `rollbackHold` for the effective dispatcher lineage.
`dispatcher.runtime-rolled-back` names failed/restored runtime identities and cache
roots, target, original handoff/takeover, three failed exits and reason. It is default
repository attention. `dispatcher.rollback-hold-cleared` records a different
successfully resolved target. The rollback hold survives store compatibility
changes, resolution errors and upgrade opt-out; a new operator-launch lineage
ignores old holds. Preflight failure suppression above remains separate.


## Organization management (browser)

These same-origin cookie-session routes are the management contract. Mutations
require the exact configured instance origin as Origin and `application/json`, accept at most
8192 characters of JSON, and reject unsupported fields. Responses are private,
no-store. No client-supplied actor or role is trusted. Raw Better Auth
`/api/auth/organization/*` routes are disabled, including invitations.

### Discovery and creation

`GET /api/web/orgs` returns
`{isSuperUser,organizations:[{id,name,slug,ownerEmail,membershipRole}]}`.
Every admitted operator can discover their own organizations. Super users see
all organizations; their membershipRole is null where they are not members.
Roles are `owner` and `member`; ownerEmail is null for an ownerless organization.
Results sort by slug then ID. Members may inspect and read rosters in their own
organizations, including member emails. Foreign organizations return 403 before
resource detail. A multi-org member uses these IDs for explicit connect selection.

Only super users may POST `{name,slug}` to `/api/web/orgs`.
The response is 201 `{organization}` in the discovery shape. Names are nonblank
and at most 100 characters; slugs are unique lowercase kebab strings of at most
100 characters. Creation grants no membership.

Super users and the organization’s members can GET `/api/web/orgs/:orgId` for
`{organization,projects:[repo]}` with active owned projects and the caller’s actual
membershipRole. Only super users can GET `/api/web/projects/unassigned` for `{projects:[repo]}`. The latter
contains every active registered project without an assignment, including legacy
registrations; removed entries are excluded. Projects sort lexically.

### Members and owner

Super users and the organization's members can GET
`/api/web/orgs/:orgId/members` for `{members:[{email,role,name,status}]}`.
`name` is a known persisted identity name or null; `status` is `joined` when a
normalized-email auth identity exists, otherwise `pending`. Grants are the roster
source; identities enrich them without duplicating rows. An existing identity
added to another organization is joined immediately.
Only super users and owners may POST `{email}` to that path for `{member}` or
DELETE `{email}` for `{removed:true}`.
Emails normalize before matching, grants work before first sign-in, and duplicate
adds preserve the existing role. An owner cannot remove themselves. Ordinary
members can read their own rosters but cannot mutate membership.

Only super users can PUT `{email:string|null}` to
`/api/web/orgs/:orgId/owner`, returning `{organization}`. A non-null owner must
already be a member. Transfer demotes the previous owner; null clears ownership.
Removing an owner as a super user also clears ownership. An org can have no owner.

### Project assignment and errors

Only super users can PUT `{repo}` to `/api/web/orgs/:orgId/projects`, returning
`{repo,organizationId}`. The repo must be actively registered. This atomically
assigns or moves it. Registry removal retains assignment and history, but hides
the inactive project; re-registration restores that assignment.

Status codes are 401 for absent, malformed or expired sessions; 403 for admission
or role refusal; 400 for invalid inputs; 404 for missing resources after role
checks; 409 for duplicate slugs; and sanitized 503 for store outages. Foreign
projects return the same unknown-repository result as absent projects. Machine credentials retain their separate authority.


### Permanent project deletion

Super users and the owner of a project's organization can delete it from the
Projects page. Owners see only projects in organizations they own; Move and
Assign remain super-user operations. The shared confirmation dialog names the project,
shows current build, hosted ticket, secret and subscription-account counts, and
requires a second, destructive action. Local files and configuration are unaffected.

Authenticated human sessions can use `GET /api/web/projects/deletion?repo=<encoded repository>`
for the authorized preview. It returns `repo`, an opaque `token`, `builds`,
`tickets`, `secrets`, and `subscriptionAccounts`. Send that token unchanged in
`If-Match` to `DELETE /api/web/projects/deletion`, with exactly `{repo}` as JSON.
The write requires the configured same origin. Missing tokens return 428;
a token for another live generation returns 412 without changing anything.
A token for an already-deleted generation is an idempotent no-op, including after
reconnection, for the initiating actor or a super user. Success returns
`{deleted:true}` only after cleanup completes. Unauthorized callers receive no counts.

Deletion cuts off access before purging builds, events, sessions, streams,
artifacts, hosted tickets and assets, secrets, subscription accounts, credentials,
connections, presence and organization assignment. Blobs another project references
or reserves survive. The only retained project record contains the repository,
initiating actor, deletion time and one opaque generation id. Provider failure
leaves access refused and durable cleanup pending. The Projects page lists
unfinished deletions with a **Finish deletion…** action, including after reloading,
opening another tab or restarting the service. Reopen its confirmation dialog to
retry cleanup with the original operation's preview token, even though the live
generation was invalidated at the initial purge. A pending preview returns that
same original token. Deletion waits only for mutation transactions already holding
the project generation row, never for an entire HTTP request. Subsequent mutation
transactions in an admitted request fail with `403 project not registered` and
roll back; operations committed before the purge remain permissible.
Cancel only closes the confirmation and does not undo the cutoff.
`GET /api/web/projects/deletions` returns `{projects: string[]}` for pending
cleanup authorized to the current owner or super user, including unassigned
projects for super users. Members and outsiders receive no pending project names.
This management-only list does not restore projects to builds selectors or normal
organization discovery. Cleanup commits progress in batches of at most 32 blobs,
using provider batch deletion where supported; a failed batch remains retryable. Registration is blocked until cleanup
finishes. Legacy untraceable orphan blobs with no ownership record or retained
project reference are excluded from deletion.

Old credentials return `401` as unknown or revoked, including repository-free
connection status calls; routes that otherwise establish the repository return
`403 project not registered`. No credential tombstones are retained. Browser
approval of a fresh `ab connect` registers an empty project; proposing a connection
alone does not register it. Old credentials and grants remain invalid. Hosted
ticket numbering starts again at 1.

`ab disconnect` only revokes the saved credential and retains project data.
The admin `projects remove` command only unregisters access and retains data;
it is a separate operation from permanent web project deletion.


S3 cleanup requires `s3:DeleteObject`, `s3:ListBucketVersions` and
`s3:DeleteObjectVersion` for the configured bucket and exact prefixed content
keys. It removes stored versions and delete markers as well as current objects;
permission or retention failures leave deletion pending. Vercel Blob cleanup uses
the same store identity, token and prefixed pathname as uploads. Missing objects
are successful cleanup; provider errors never count as completed deletion.

Paged ticket listings use the source's optional native `listPage(criteria, page)` capability when present, otherwise read the full listing and reverse/slice it. Native errors propagate. PostgreSQL counts matches without bodies and reads only the requested window. Zero limits and offsets past the end still report the full matching total. Unpaged listings remain exhaustive; the wire payload is the same for both paths.


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
