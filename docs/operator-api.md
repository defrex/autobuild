# Operator API v1

The hosted service exposes the polling-oriented operator surface at
`/operator/v1/repos/{repo}`. It is versioned with remote store protocol **2**.
Every request must send `X-Autobuild-Version`,
`X-Autobuild-Protocol-Version: 2`, and `Authorization: Bearer …`. Identity is
checked before authentication or resource lookup.

Mint a token offline; the signed user is used as the human actor on every write:

```sh
AB_STORE_SECRET='…' bun packages/hosted-store-service/src/bin.ts mint operator \
  --user 'Ada Lovelace' --ttl-seconds 3600
```

Admin, build, repository, and deployment (`{ "operator": true, … }`) tokens
have no attributed operator authority. Human-operator tokens have no raw
`/builds`, `/repos`, `/sessions`, or `/tickets` authority. Encode repository,
build, session, and artifact kind as separate URL path segments.

## Operator sessions

Operator sessions are the signed-in operator's durable orchestrator
conversations: a hosted-only third store resource. A session
belongs to the operator who created it; other operators of the same repository
can read it and cannot write to it (`403 auth` on non-owner writes). Every
write is attributed to the token's signed user — never a client-supplied
identity — and carries no `via` marker: session events are the delegate's own
log. Writes of any kind to an archived session are `409 refusal`, and the
archived status is terminal.

| Method and path | Result |
|---|---|
| `GET …/sessions` | The repository's session records, newest update first. Readable by any operator of the repository. |
| `POST …/sessions` | `{"title"?:"…"}` → `201` + the created `SessionRecord`; the signed-in operator owns it. |
| `GET …/sessions/{sid}` | `{session, state, turns}` where `state` is the reducer's derived state (`status`, `openTurn`, `pendingApproval`, `wakeGlobs`, `wakeCursors`, `turns`) and `turns` the ordered turn list. Readable by any operator of the repository. |
| `POST …/sessions/{sid}/messages` | `{"text":"…"}` → appends `message.posted`. Owner only. |
| `PUT …/sessions/{sid}/wake` | `{"globs":["…"]}` (possibly empty) → appends `session.wake-set`. Owner only. |
| `POST …/sessions/{sid}/approvals` | `{"turn":"…","toolCallId":"…","decision":"approve"\|"deny"}` → `approval.answered`. Owner only; `409 refusal` when the reduced state has no matching pending approval. |
| `POST …/sessions/{sid}/archive` | Empty body → `session.archived`. Owner only; `409 refusal` when already archived. |
| `GET …/sessions/{sid}/turns/{turn}/stream?since=N&wait=N` | The turn's stream read: `{chunks,status,outcome?,artifact?}` with `since` strictly greater-than and the same bounded-wait semantics as the stream protocol (whole seconds, clamped at 30). Unknown turn is `404 not-found`. Readable by any operator of the repository. |

Session state is a reduction of the session's event log, never a stored
column; a `GET …/sessions/{sid}` response therefore always reflects the
session's full history. The API never exposes raw session-event append: the
turn runner (a later ticket) is the only producer of turn facts.

## Reads

| Method and path | Result |
|---|---|
| `GET …/builds?scope=active\|queued\|all` | Build summaries, newest update first. `queued` means active plus queued, matching `ab builds --queued`. |
| `GET …/builds/{slug}` | `{detail, dashboardRow}`; `dashboardRow` remains a `CLEANING` row after `build.aborted` and becomes `null` only when the dashboard stops listing it (after cleanup's `build.completed`). |
| `GET …/dashboard` | `{generatedAt, model, settingsHeader}`. `model` is the dashboard's rows, steps, elapsed timing inputs, harvest row, queue/capacity and settings projection. |
| `GET …/status` | Repository intake, pause, and default-auto-merge projection. |
| `GET …/harvest/status` | Harvest gate, runs, steps, recovery, and attention projection. |
| `GET …/builds/{slug}/artifacts/{kind}?rev=N` | Raw bytes (`application/octet-stream`) plus content-disposition and `X-Autobuild-Artifact-*` metadata headers. Omit `rev` for latest. |
| `GET …/tickets?state=S&label=L` | `{states,tickets,diagnostics,criteria,triageState,readyState}`. The two lifecycle names come from effective repository configuration (including provider fallback). With no `state`, `criteria.state` is `triageState`; repeated `label` parameters narrow that state with AND filters. An explicit `state` selects that exact backend workflow state. |
| `GET …/tickets/{id}` | `{ticket,blockers,build}`. Blockers include native `exists`/`resolved` status; `build` prefers an active matching repository build, otherwise the most recently updated one. |

For artifact reads, an absent `rev` selects the latest revision. A supplied value
must match `[0-9]+` (one or more ASCII base-10 digits) and represent an integer
from `0` through `Number.MAX_SAFE_INTEGER` (`9007199254740991`). All other
supplied forms return `400 validation`.

Dashboard reads use the latest durable, run-correlated `effectiveConfig`
repository artifact. Missing, corrupt, or invalid configuration returns a typed
`409 effective-config-unavailable`; the service never guesses from a checkout.
Clients poll these reads; streaming is not provided. `triageState`, `readyState`,
and every entry in `states` are backend state names and must be sent back verbatim
when used with the move control.

## Controls

JSON bodies are strict: unknown fields are rejected.

| Method and path | Body |
|---|---|
| `POST …/builds/{slug}/control` | `{"action":"pause"\|"cancel-pause"\|"resume"\|"abort"\|"discard"\|"auto-merge-on"\|"auto-merge-off"}` |
| `POST …/builds/{slug}/answer` | One answer variant described below. |
| `PUT …/settings/intake` | `{"enabled":boolean}` |
| `POST …/settings/intake/toggle` | Empty body. |
| `PUT …/settings/auto-merge-default` | `{"enabled":boolean}` |
| `POST …/settings/auto-merge-default/toggle` | Empty body. |
| `POST …/bulk-control` | `{"action":"pause"\|"resume"}`. The hold fact, intake fact, then eligible build events are written in that order. |
| `POST …/harvest/control` | `{"action":"toggle-gate"}` or `{"action":"run","run":"…"}`. A run action is bound to that concrete projected run. |
| `POST …/tickets` | `{"title":"…","body":"…","labels"?:[],"state"?:"…","blockedBy"?:[]}`; omitted state preserves the backend default. |
| `PATCH …/tickets/{id}` | Any nonempty subset of `title`, `body`, and complete-replacement `labels`. Body bytes are not normalized. |
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

The hosted service has no ticket-provider credentials. For ticket-origin
revision, a trusted caller fetches the current ticket body and supplies it; the
build must still have a recorded ticket. Revision conformance, lazy retry,
artifact metadata, event ordering, and refusal rules are the same as the CLI.

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

The same deployment serves the web dashboard through `/api/web/repos/{repo}/…`.
That route is not a second public bearer-token API: it requires a current
Better Auth HTTP-only cookie, rechecks the deployment email and repository
allowlists, rejects cross-origin JSON controls, and delegates only the dashboard,
build, settings, and harvest operator suffixes listed above. It replaces caller-supplied authorization/version
headers with a server-minted token that expires after 30 seconds and carries
the normalized signed-in email. Consequently every durable control event has
the browser user's human actor while no token or signing secret reaches client
code. Responses are private/no-store; a 401 sends the application back to sign
in. Browser clients poll the visible dashboard every two seconds; live transcript
streaming is not provided. Delegated bearer tokens remain server-side.

The API does not expose phase-session commands, runner startup, live streaming,
or a generic event-append operation.
