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
| `GET …/dashboard` | `{generatedAt, model, settingsHeader}`. `model` is the dashboard's rows, steps, elapsed timing inputs, harvest row, triage (when the dispatcher published one)/queue/capacity and settings projection. `model.configuration` is `"no-dispatcher-run"` when the repository records no dispatcher run, and absent otherwise. Optional `rollback` contains `correlation`, `lineage`, full `failed` and `restored` runtime identities and rollback event `ts` for the authoritative dispatcher lineage’s unresolved hold. Both dashboards name failed, restored and held runtime plus timestamp. Matching durable different-target hold clearance removes it; a fresh operator lineage hides it only after a committed operational tick or accepted takeover. Run-started and yielded ticks alone cannot replace authority; same-lineage generations retain the notice. Historical rollback records are not fallback notices. Optional `handoffs` lists all accepted unfinished handoffs with predecessor `run`, optional `successor`, `correlation`, full `from`/`to` runtimes, `mode` and optional `deadline`. Outstanding drain-mode builds carry `draining: true`, also on build-detail `dashboardRow`; matching settlement removes it. Accepted completion removes the handoff; neither takeover nor the clock does. Missing historical mode means cutover and missing deadline displays unknown. |
| `GET …/status` | Repository intake, pause, and default-auto-merge projection, plus `ticketStarts` (`{pending, recent}`) when single-ticket start requests are pending or recently settled. Its `operator` is `{presence: "unavailable", reason}`: this route does not load presence registrations, so it is not evidence that no operator is present. |
| `GET …/harvest/status` | Harvest gate, runs, steps, recovery, and attention projection. |
| `GET …/builds/{slug}/artifacts/{kind}?rev=N` | Raw bytes (`application/octet-stream`) plus content-disposition and `X-Autobuild-Artifact-*` metadata headers. Omit `rev` for latest. |
| `GET …/tickets?state=S&label=L&limit=N&offset=K&order=O` | `{states,tickets,diagnostics,criteria,triageState,readyState,doneState,total}`. The three lifecycle names come from effective repository configuration (including provider fallback). With no `state`, `criteria.state` is `triageState`; repeated `label` parameters narrow that state with AND filters. An explicit `state` selects that exact backend workflow state. `limit` (0–200) returns one page, after skipping `offset`, in `order` `oldest` (the default: dispatch order, urgent tickets first, then the source order) or `newest` (newest filed first, regardless of urgency; see paging below); `total` counts every match before paging. |
| `GET …/tickets/states` | Full state metadata `{name,tickets,about?}[]`, including empty states (`tickets.states` in MCP). |
| `GET …/tickets/{id}` | `{ticket,blockers,build}`. Blockers include native `exists`/`resolved` status; `build` prefers an active matching repository build, otherwise the most recently updated one. |

For artifact reads, an absent `rev` selects the latest revision. A supplied value
must match `[0-9]+` (one or more ASCII base-10 digits) and represent an integer
from `0` through `Number.MAX_SAFE_INTEGER` (`9007199254740991`). All other
supplied forms return `400 validation`.

Dashboard reads use the latest durable, run-correlated `effectiveConfig`
repository artifact. A repository with no recorded dispatcher run answers the
dashboard with `200` and `model.configuration: "no-dispatcher-run"`: no rows,
repository controls from the journal, and an Active counter that is not
meaningful. Reads that need configuration (build detail, ticket context without
a published ticket policy) return a typed `409 no-dispatcher-run` there. When a
run is recorded, missing, corrupt, or invalid configuration returns a typed
`409 effective-config-unavailable`; the service never guesses from a checkout.
Clients poll these reads — the operator HTTP API exposes no push or long-poll
event transport. Streaming is provided by `ab watch`; unflagged watches are read-only.
Only CLI `--operator` watches write advisory liveness, never events or authority;
MCP presence registration is deferred. Repository status over this API and MCP
marks operator presence `unavailable` rather than reporting an empty registration
list; use `ab repository status --json` for presence. `ab watch`
streams build and repository events by polling the same event logs client-side
(the store protocol's `GET /builds/{slug}/events` and `GET /repos/{repo}/events`
reads), not as a transport on this API. `triageState`, `readyState`,
`doneState`, and every entry in `states` are backend state names and must be sent back verbatim
when used as the move control's `state`. A move may instead name a lifecycle `role`,
which the service resolves through the repository's `[tickets]` configuration.

## Controls

JSON bodies are strict: unknown fields are rejected.

| Method and path | Body |
|---|---|
| `POST …/builds/{slug}/control` | `{"action":"pause"\|"cancel-pause"\|"resume"\|"abort"\|"discard"\|"land"\|"hold"\|"priority"}`; `priority` requires `"priority":"urgent"\|"normal"` and records `build.priority-set`, the build's slot-admission priority (urgent waiting work, urgent claims, normal waiting work, then normal claims), as `ab priority` does. `land` alone accepts an optional `"head":"<sha>"` (full or at least seven characters) that binds consent to that candidate head. Abort alone also accepts `"to":"triage"\|"ready"` (default triage) and a `"reason"` of 1–2000 characters after trimming, as `ab abort --to/--reason` does. `hold` also accepts an optional `"reason"` of 1–2000 characters after trimming, as `ab hold --reason` does; a blank reason is refused with `invalid-argument` and nothing is recorded. `"reason"` with any other action is a validation error. Ready requires the current ticket to meet the spec standard; otherwise cleanup returns it to triage and the hand-back comment and `ticket.handed-back` event carry the `requested` role and `missing` parts. Repeating an identical pending abort is idempotent; a repeat with a different destination or reason is refused. Aborting an [optimization attempt](optimization-nodes.md#landing-and-settlement) ignores `to`: it settles `aborted`, the node moves the ticket to rejected, and no hand-back is reported. |
| `POST …/builds/{slug}/restack` | Empty body; durable node restack demand. |
| `POST …/builds/{slug}/answer` | One answer variant described below. |
| `PUT …/settings/intake` | `{"enabled":boolean}` |
| `POST …/settings/intake/toggle` | Empty body. |
| `POST …/bulk-control` | `{"action":"pause"\|"resume"}`. The hold fact, intake fact, then eligible build events are written in that order. |
| `POST …/harvest/control` | `{"action":"toggle-gate"}` or `{"action":"run","run":"…"}`. A run action is bound to that concrete projected run. |
| `POST …/tickets/states` | `{name,about?}` → `{state,created}`; requires attributed operator identity (`tickets.state.create` in MCP). Hosted duplicate names are refused case-insensitively. |
| `POST …/tickets` | `{"title":"…","body":"…","labels"?:[],"state"?:"…","blockedBy"?:[],"issueLinks"?:[{"issue":N,"intent"?:"closes"|"refs"}],"priority"?:"urgent"|"normal","assignees"?:["login"|"me"],"kind"?:"work"|"node","target"?:"id"|null}`; omitted state preserves the backend default, omitted intent is `closes`, omitted priority is normal, and omitted assignees apply `[tickets].createAssignee` (`[]` creates an unassigned ticket). `assignees` takes at most ten entries, counted before duplicates collapse, and more is a validation error. A backend that cannot store issue links refuses with `code: "issue-links-unsupported"`; one that cannot store priority refuses `urgent` with `code: "priority-unsupported"` and accepts `normal` as a no-op; one that cannot store assignees refuses any `assignees` with `code: "assignees-unsupported"`. |
| `PATCH …/tickets/{id}` | Any nonempty subset of `title`, `body`, complete-replacement `labels`, complete-replacement `issueLinks` (`[]` clears), `priority` (`urgent` or `normal`; refusals as for create), complete-replacement `assignees` (`[]` clears; refusals as for create), `kind` (`work` or `node`), and nullable `target` (null clears). Body bytes are not normalized. |
| `POST …/tickets/{id}/move` | Exactly one of `{"state":"backend state name"}` or `{"role":"triage"\|"ready"\|"backlog"\|"rejected"}`; both or neither is `400 validation` (`tickets.move` in MCP takes the same target). A role resolves to the configured `triageState`, `readyState`, `backlogState`, or `rejectedState`. An unset `backlogState` or `rejectedState` refuses with a message naming the key to set, and never guesses a native state. A source that can create states creates a missing role state before moving. |
| `POST …/tickets/{id}/start` | Empty body. Records a durable request that the running dispatcher start this ticket on its next tick with a free slot, even while intake is off (`tickets.start` in MCP). The id resolves through the configured source; an unknown ticket is `404 not-found`. Returns `{status:"pending",existing,request,requestedAt,ticket}`; `existing` is true when an equivalent request was already pending and nothing was written. The outcome arrives later as `ticket.start-settled`. |
| `POST …/tickets/{id}/start/cancel` | Empty body. Cancels the pending start request: `{cancelled:true,request,ticket}`, or `{cancelled:false,id}` when none is pending (`tickets.start` with `cancel: true` in MCP). |
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
spec and its publication is confirmed. A settled, unmerged leaf awaiting merge
revises without an escalation through `ab reopen`.
A revision of an optimization node may change its `autobuild-objective` block
but cannot remove it, and a revision of a plain node or a leaf cannot add one;
both refusals record nothing.

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
- `{kind:"reopened",slug,route,event?,specRev?,completedEarlier?}` from the
  reopen tool; `route` is `implement` or `plan`.

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
A `land` control whose merge candidate is not ready is refused with code
`merge-not-ready`, and its reason names the unmet condition; a node that fails
the live completeness check is refused with code `node-incomplete`, naming any
open children. A `land` whose `head` is not the current candidate head is
refused with code `head-mismatch`, and its reason names the current head.
None of these records consent or starts a merge, so refresh the
build's status and retry once the reason is resolved.
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
A loss can be transient: a holder that stalled past
`policy.dispatchLeaseTimeoutSeconds` with no successor reclaims its lease on
waking and returns to `held`.
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
- `build.janitor-escalated`: a build's janitor failure episode outlasted `policy.janitorFailureEscalationSeconds` and raised one escalation naming the operation, last error, attempt count and episode start. The janitor keeps retrying; a successful attempt closes the escalation, and a bare retry answer attempts on the next tick.
- `dispatcher.forge-degraded`: the dispatcher's own rate-limit cooldown opened, with its reset; once per episode. Extensions marked `continued` are silent.
- `dispatcher.forge-persistent`: forge degradation remains after a completed post-reset retry opportunity; successful recovery clears it.

- Build `escalation.raised`, `integration.landed`, `node.item-conflicted`, `target.rewritten`,
  `landing.consent-revoked` (protected merge consent revoked by a reconcile's
  edits, naming the matched files and both heads),
  `optimization.noise-exceeded` (an optimization node's ε is below its
  measured noise, naming both), or conflicted
  `restack.replayed` events. `build.consent-ready` is the single
  signal for a ready consent or held merge, including first repository-wide
  discovery. Its target has the queue entry shape `{kind, branch, ticket?, build?}`.
  Unready and stale candidates stay silent. `build.merge-decision` remains for
  current actionable merge-gate deferrals, landings awaiting a human merge, and
  unsafe forge outcomes, once per build/PR; it does not duplicate consent or
  hold attention.
- Repository `harvest.escalated`, `harvest.recovery-exhausted`,
  `dispatcher.config-rejected`, `dispatcher.config-reloaded` with nonempty
  `restartRequired`, `dispatcher.upgrade-failed`, `dispatcher.runtime-rolled-back`,
  `dispatcher.kernel-git-unavailable`, `forge.credential-limited`, abnormal
  `dispatcher.run-stopped`, and `dispatcher.lost`. A `forge.credential-limited`
  line names the process whose GitHub request was rate-limited outside the
  dispatcher's credential (unauthenticated, with why, or on that process's own
  credential) and its reset; dispatcher forge work continues.
- Repository `hook.failing`, `hook.recovered` and `hook.skipped`: a configured
  hook (`[hooks]`) has failed continuously for five minutes (once per episode,
  naming the latest error and the record `id` it is stuck on), has delivered
  again after a reported episode, or resumed past history it could no longer
  read (with the skipped stream ranges) or a build announcement it could not
  resolve. Inspect `ab repository status`, fix the hook's command, endpoint or
  configuration, and treat a skipped range as records the hook's consumer never
  received.
- Repository `ticket-preparation.resolved` with outcome `abandoned`: automatic
  preparation recovery stopped and left the ticket unchanged. The line names the
  ticket, attempt and recorded reason; the payload's `claimed` says whether the
  claim was confirmed. An unconfirmed claim's provider outcome is unknown, and
  events written before `claimed` existed report the certainty as not recorded.
  Each abandonment reports once as it lands; a fresh watch does not replay
  historical ones, and nothing clears or acknowledges it.
- Repository `ticket.handed-back`: a claimed or ready ticket was returned other
  than as completion (`cause` `abort`, `spec-bounce`, `preparation-failed`,
  `pr-closed` or `discard`), with its destination `state` and `role`, the build
  or preparation attempt, and any `requested` role, `missing` spec parts and
  `reason`. It is appended once, only after the move is committed, so moving
  the ticket on receipt is never overridden. An aborted or closed
  optimization attempt reports no hand-back; its node records
  `attempt.ticket-rejected` once the ticket is moved to rejected (see
  [landing and settlement](optimization-nodes.md#landing-and-settlement)).
- Repository `ticket.start-settled`: an operator's single-ticket start request
  (`ab start`, `tickets.start`) reached its outcome: `started` with the build
  `slug`, or a refusal — `already-building` (with the slug), `blocked`,
  `invalid` (bounced to triage, or a profile conflict), `missing`, `not-ready`,
  `terminal` or `claim-refused` — with a `detail`. Each request settles once.
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
did not advance. A merge decision still due at the cursor, because the watch
stopped on its event before observing it, is delivered once on resume, before
the later events. Old v1 cursors remain valid inside the hosted 1,000-position resume window: historical eligible merge
decisions are treated as consumed; active overdue repository episodes may
report because old watches had no persistence notification. Fresh attachment
silently baselines historical direct events and merge decisions, but retains
active repository timers. A no-slug watch follows each build announced in the
journal after its position from the build's first event; cursors carry
creations still in preparation, and a cursor from an earlier release, which
carries none, baselines a build whose creation was selected before it. Reconcile existing conditions through status after
arming the watch. Named watches still end when every named build is terminal;
learn their outcomes from status reconciliation at exit.

`ab wait --for attention` is build-only and uses the same build conditions:
current failed node verification, an open escalation other than a ticket wait's
own, janitor failure attention,
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

The MCP `repository.events` tool delivers the same repository attention to a
connected agent. It takes `{repo, cursor?, waitSeconds?, filter?}` and returns
`{events, cursor, hasMore}`: one bounded read of at most 256 journal positions
after `cursor`, filtered by default (`filter: "attention"`) to exactly the
repository records the CLI default watch reports, or every event with
`filter: "all"`. The returned cursor is the last scanned position, so it
advances past filtered events. Omitting `cursor` returns no events and a
baseline cursor; an expired cursor fails with `code: "cursor-too-old"`.


Hosted ticket tools resolve independent project ticket policy, including its
backlog and rejected roles for role moves, before legacy uploaded configuration. Queue, detail, state discovery and mutations work before any build
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
requires readiness and survives clean restacks, except that a reconcile editing
files protected by the consent rule's `paths` or `within` predicates revokes it;
hold persists until merge. Repository
auto-merge settings are retired; configure ordered `[[merge]]` rules.

Default attention includes `build.janitor-failing`, `build.janitor-escalated`,
the episode-opening `dispatcher.forge-degraded` and `dispatcher.forge-persistent`,
so a rate-limit episode wakes once when it opens and once more only if it
outlasts its reset. `continued` degradations, which only extend an open
episode's reset, and `dispatcher.forge-recovered` facts are available through
explicit event filters.
Active janitor attention and an open janitor escalation clear on a successful
attempt. Repository status
includes forge degradation/reset, available request counts and `forgeRateLimit`:
the last observed primary quota per resource with its observation time and
staleness, and whether forge landing/polling is paused until the cooldown's reset; `dispatcher.forge-persistent` requires a completed retry opportunity past
the original reset, which later rate limits cannot postpone indefinitely.
Only the dispatcher's own classified limits record that degradation. Status
also lists active `forgeCredentialLimits`: limits on unauthenticated requests or
seen by build runners and phase sessions, each naming the process, which never
pause repository forge work.

### Optimization objective revision

`optimization.revise` accepts `{repo, slug, threshold?, epsilon?, maxAttempts?,
maxHours?, plateau?, stopMode?, concurrency?}` with at least one change.
`epsilon` is `{absolute}` or `{relative}`, and `stopMode` is `abort` or `drain`.
It uses the same service as `ab objective <node>` with flags and records one
human `optimization.objective-revised` fact carrying the changes and the next
objective revision. The receipt contains `slug`, `revision` and `changes`.
It refuses non-node builds, nodes with no accepted objective and terminal
nodes, and changes that leave the effective objective invalid; it enforces
repository ownership. Running attempts are unaffected. The metric, harness and
purpose change only through a node spec revision. The dispatcher applies a
revised threshold, budget or plateau on its next tick. The tool has no HTTP
route.

### Optimization stop

`optimization.stop` accepts `{repo, slug, mode?}`, where `mode` is `abort` or
`drain`; without it the objective's stop mode applies, `abort` by default. It
uses the same service as `ab objective <node> --stop` and records one human
`optimization.stopped {cause: operator, mode}`. The receipt contains `slug`,
`cause` and `mode`. Abort cancels queued attempts and aborts running ones, and
those cancelled or aborted by the stop settle `stopped`. An earlier operator
abort remains `aborted`; abort cleanup uses the first request’s durable origin
and settles each build once. Drain cancels queued attempts and lets running
ones finish and face the landing gate. No new proposer session is admitted after
a stop; one that had already started may finish, but the attempts it proposes
are cancelled and settle `stopped`. A stop is final. It refuses non-node builds, nodes with no accepted objective, terminal
nodes and a node that has already stopped, and enforces repository ownership.
Stopping is not merge consent: once the node completes and verifies, land it
with `builds.control` merge. The tool has no HTTP route.

### Optimization unmeasured-merge settlement

`optimization.settle-unmeasured` accepts `{repo, slug, attempt, policy,
note?}`. `attempt` is the proposal id or build slug of an attempt that merged
without a landing measurement of its merged head, which `builds.get` lists
under the node's `unmeasuredMerges`. `policy` is required, and its one value
`release-unmeasured` releases the attempt's concurrency slot while recording
its measurement as absent. The tool uses the same service as `ab objective
<node> --settle-unmeasured … --policy …` and records one human `attempt.settled
{outcome: merged-unmeasured, policy, mergedSha?}`. The receipt contains `slug`,
`proposal`, `build`, `outcome` and `policy`. The settlement never counts as
accepted and moves no current, best or plateau value. An unknown policy is a
validation refusal. The tool refuses non-node builds, nodes with no accepted
objective, terminal nodes, and an attempt that is not in flight, has not merged
unmeasured, or whose merged head has a valid measurement. It works on a stopped
node and enforces repository ownership. The tool has no HTTP route.

### Reopen a settled leaf

`builds.reopen` accepts `{repo, slug, feedback?, revision?}`, where `revision`
is `{origin: "body", body}` or `{origin: "ticket", body}` as on `builds.answer`.
It uses the same service as `ab reopen` and needs feedback (1–20000 characters
after trimming), a revision, or both. It applies only to a leaf that finished
its pipeline and waits for its merge decision: feedback returns it to implement,
and a revision is recorded as the next spec revision and restarts it from plan.
The open PR and branch are kept and merge consent is revoked at once (a hold
stays). An armed native auto-merge is cancelled asynchronously on a later
dispatcher poll, and the receipt does not confirm it; a forge merge that lands
first completes the build as merged. The receipt is `{kind: "reopened", slug, route, event?, specRev?,
completedEarlier?}`; `completedEarlier` means the call completed a spec reopen
recorded earlier without using its own arguments. It refuses integration nodes
and optimization attempts and terminal or queued builds with `not-reopenable`
or `inactive`. Merged or closed PRs, leaves still running, conflicted or
blocked (use `builds.answer`) are refused with `not-reopenable`; a pending abort
or discard is refused with `abort-pending` or `discard-pending`. Ownership is
enforced. The tool has no HTTP route.

### Node restack request

`builds.restack` accepts `{repo, slug}`. `POST /operator/v1/repos/:repo/builds/:slug/restack`
uses the same service as `ab restack <node>`. The receipt contains `slug`,
`request`, `coalesced` and `waiting`; execution is asynchronous. It refuses
non-node, unopened and terminal builds and enforces repository ownership.

Repository status includes `upgrades.runs`, keyed by originating dispatcher run,
with latest successful `resolved` target, detected target, failure, handoff and
completion evidence. It retains at most 16 runs: the authoritative run, the run
holding the newest accepted handoff, the newest settled outcomes, then the most
recently active, keeping incomplete handoffs longest. Full upgrade history stays
in the repository journal for explicit history reads. `dispatcher.upgrade-target-resolved` carries strict
`{run, lineage, target}` data; the target has mode (`pinned`, `installed`, or
`source`), content key, source provenance and optional version/base/SHA. Source
mode names the authoritative base commit, which can advance without changing
packaged inputs or the running runtime. Status text renders the resolved mode,
base and SHA separately, so an older handoff cannot hide a newer target. Identical
observations append nothing. A failure fact stays on its run until a later
successful preparation or handoff clears it; status marks it superseded once a
later resolved target with a different key, or a later generation, exists.
Human status shows at most the live handoff, the current generation's resolved
target and latest outcome, and the latest settled outcome from an earlier
generation; JSON `upgradeStatus` (`handoff`, `current`, `previous`, with
`superseded` on a replaced failure) carries the same projection. Facts carry launcher
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

Repository status additionally exposes `upgrades.lastRollback` (the single latest
rollback, retained when cleared), `upgrades.holds` keyed by launcher lineage (up to
16 lineages, always including the authoritative lineage's hold), `upgrades.lineages`
keyed by generation run (the 16 most recent generation starts, always including the
authoritative run), optional `upgrades.authoritativeRun` from rollback, accepted takeover or committed operational tick (never startup/yield alone), `upgrades.rollbackIds` for idempotent rollback correlations (the 16 most recent), and `rollbackHold` for the effective dispatcher lineage.
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

The browser requires the exact full repository identity in a transient dialog field;
confirm stays disabled for empty or mismatched input and focus starts in the field.
The handler independently binds that identity to the selected repository and its
fresh validated preview. Only JSON `{deleted:true}` acknowledges completion.
After any failed or unrecognized deletion response, the browser shows
“Deletion outcome unknown; reload to check” and holds the row in its original slot
without actions, even after dismissal. Only a complete successful discovery begun
by Reload after the attempt settles it: absence removes the row, presence restores
its authorized actions, and pending cleanup restores Finish deletion with a fresh
preview and exact typing. An earlier or unsuccessful read cannot settle the outcome.
The server's `{repo}` body and generation-bound If-Match contract are unchanged.

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

Paged ticket listings use the source's optional native `listPage(criteria, page)` capability when present, otherwise read the full listing, order it, and slice it: by default urgent tickets first, then normal ones, each in source order; for `newest`, the reversed listing. `newest` means newest filed first, regardless of urgency, with a stable tie-break; it is not the reverse of dispatch order. A source that lists in filing order (file, GitHub, Linear) gets exactly that from the reversed listing. The remote `HostedTicketSource` pages natively through the service's `list-page` operation, and uses the fallback only against a service predating it. Native errors propagate. PostgreSQL counts matches without bodies and reads only the requested window. Zero limits and offsets past the end still report the full matching total. Unpaged listings remain exhaustive; the wire payload is the same for both paths.


### Forge cooldown admission and explicit recovery

Hosted repository event appends and atomic artifact deposits validate
`dispatcher.forge-degraded` and `forge.credential-limited` before any durable
mutation. The payload must match its event schema, with a finite ISO `resetAt` at most 24 hours after server time
(inclusive). Already-expired deadlines are accepted. Invalid or out-of-horizon
writes return `400 validation` (the remote adapter exposes `EventValidationError`);
the server never clamps or invents a provider reset. Historical decoding has no clock-relative restriction.

Build-runner and build-phase grants may POST only the kernel-authored
`forge.credential-limited` and `dispatcher.forge-degraded` repository facts
through the events route. Current runners and phase sessions record only
`forge.credential-limited` attention; the `dispatcher.forge-degraded` exception
remains for runners pinned to older releases. The
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
