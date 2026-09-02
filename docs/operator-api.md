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
`/builds`, `/repos`, or `/tickets` authority. Encode repository, build,
and artifact kind as separate URL path segments.

## Reads

| Method and path | Result |
|---|---|
| `GET …/builds?scope=active\|queued\|all` | Build summaries, newest update first. `queued` means active plus queued, matching `ab builds --queued`. |
| `GET …/builds/{slug}` | `{detail, dashboardRow}`; `dashboardRow` remains a `CLEANING` row after `build.aborted` and becomes `null` only when the dashboard stops listing it (after cleanup's `build.completed`). |
| `GET …/dashboard` | `{generatedAt, model, settingsHeader}`. `model` is the dashboard's rows, steps, elapsed timing inputs, harvest row, queue/capacity and settings projection. |
| `GET …/status` | Repository intake, pause, and default-auto-merge projection. |
| `GET …/harvest/status` | Harvest gate, runs, steps, recovery, and attention projection. |
| `GET …/builds/{slug}/artifacts/{kind}?rev=N` | Raw bytes (`application/octet-stream`) plus content-disposition and `X-Autobuild-Artifact-*` metadata headers. Omit `rev` for latest. |

Dashboard reads use the latest durable, run-correlated `effectiveConfig`
repository artifact. Missing, corrupt, or invalid configuration returns a typed
`409 effective-config-unavailable`; the service never guesses from a checkout.
Clients poll these reads; streaming is not provided.

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

The API does not expose phase-session commands, ticket intake, runner startup,
streaming, or a generic event-append operation.
