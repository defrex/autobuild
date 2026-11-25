---
title: "Working with your operator agent"
group: "guides"
description: "Delegate specs, tickets, monitoring, and merge to your agent while keeping product decisions and authority with you."
label: "Working with your operator agent"
order: 6
---

# Working with your operator agent

Your operator agent keeps work moving through `ab` or MCP. Under your instructions it writes specs, files and grooms tickets, operates the builds the repository's dispatcher dispatches, answers bounded escalations, pauses or aborts work, and authorizes merge.

- **You own** goals, scope, tradeoffs, authority and upgrades. Dispatcher ownership is a local preference, subject to repository instructions.
- **The agent checks** fresh running status before startup and follows your saved preference, or asks who should run the dispatcher and offers to save the answer. With agent ownership it starts `ab dispatch --web --plain --json` and gives you the URL. It cleanly stops only a dispatcher this session started, only on request; it never adopts, restarts, kills or manages another session's dispatcher. See [dispatcher ownership](dispatcher.md#dispatcher-ownership).
- **Autobuild doesn't** host or start the agent. There's no orchestrator setup step.

## Choose a harness

- **A local coding agent** at the repository root with the installed `ab-operate` skill, using the CLI or `bun ab mcp` (operator tools over stdio).
- **An API client** using the authenticated [Operator API contract](operator-api.md).

An agent connected over MCP has no checkout of its own. It calls `context.list` first, then loads `ab-operate` and the repository's agent instructions with `context.read` or the matching MCP prompt; see [agent context](operator-api.md#agent-context).

We recommend the same model as your reviewer roles, since the agent interprets findings and escalation answers.

## Give the agent memory

Autobuild ships no agent memory. Keep goals, decisions, constraints and monitor cursors in your harness's memory or an agreed notes file: load it at session start, record decisions as they're made, and on resume reconcile it against recorded state. Notes hold your intent; build events and artifacts hold what happened.

## Give steering that sticks

Give the agent your scope, priorities, acceptance boundaries, escalation thresholds and merge authority. For example:

> Keep this change API-compatible. Prioritize the retry budget over diagnostics. You may answer questions already settled by this spec, but ask me about scope changes and before granting merge consent.

Agree on boundaries before the agent acts: moving a ticket to ready can start a build immediately, and granting consent can let it merge once gates pass.

The agent answers questions your instructions settle and escalates ambiguous goals, scope or compatibility tradeoffs, consequential or destructive choices, missing authority or access, and dispatcher trouble.

## Watch for attention

```
bun ab repository status --json
bun ab watch --operator --json
```

Before registering, inspect `operator.registrations` in repository status. If
another live operator is present, the agent tells you and stops unless you direct
otherwise. Filing sessions preserve intent, rejected alternatives and out-of-scope
reasons in ticket bodies so that operator can answer escalations.

`watch --operator` monitors active builds, new builds and the repository journal.
It writes advisory mutable presence, never events or a lease. Multiple operators
may register; presence is no lock. Unflagged watches write nothing. Repository
status lists live registrations with host, PID, start time and heartbeat age.
Heartbeats run every 30 seconds; presence expires five minutes after the last
successful heartbeat, including a final best-effort heartbeat on orderly timeout
or count completion. SIGINT, SIGTERM, SIGHUP and stdout EPIPE attempt withdrawal
within about two seconds. Failures leave TTL expiry as the fallback; older services
without withdrawal support fall back silently. SIGKILL still relies on TTL expiry.

Re-arm with `bun ab watch --operator --json --since <watch-cursor>` using only
the standing watch's own cursor. This preserves one ID and original start time
across a presence re-arm gap of up to five minutes. This presence TTL is separate
from hosted event-window eligibility. After termination withdraws presence,
the same cursor re-registers the same ID and start time. Reconcile current and
newly dispatched builds after arming and on timeout. Keep operating after the initial work ends,
until you end or hand off the role. `wait` does not heartbeat or carry registration
identity: a separate unflagged diagnostic wait/watch must never replace the
standing monitor or supply its resume cursor. MCP presence is deferred.

Keep `--since` for normal re-arms. Hosted resume accepts cursors at or above
`max(0, head - 1000)` in each monitored stream: the inclusive window is 1,000
sequence positions behind its head. If a cursor is too old, re-arm without
`--since` and reconcile repository and build status. That fresh attachment cannot
recover the unavailable historical gap; status reconciliation does not restore
one-off events from that gap.

- **Default filter:** actionable attention only, such as escalations and ready merges awaiting consent. Add `--event` globs for routine lifecycle events. Ticket waits beginning and ending are routine: follow them with `--event 'wait.*' --event escalation.answered`. A build waiting only on tickets is not attention for `watch` or `wait --for attention`; `ab builds` shows it as waiting. A `wait-unresolvable` escalation, raised when a waited ticket is rejected or deleted, is ordinary attention.
- **Starts now:** a fresh watch ignores history, so check current status too.
- **Resumable:** pass the opaque cursor from the JSON output back with `--since` to receive events recorded while away within the hosted window described above. The final JSON line always carries one.
- **Identified:** every JSON record carries an `id` that stays the same when the record is seen again after a resume, so consumers can deduplicate by it.
- **Duration:** 30 minutes by default; `--timeout 0` keeps it open.

```
bun ab wait my-build --for attention --json --timeout 5m
```

`wait` blocks once until a build condition holds:

| Exit | Meaning |
|---|---|
| 0 | A condition matched |
| 2 | Every named build ended without matching |
| 3 | Timed out |

Existing attention returns immediately, even with a cursor, so looping `wait` doesn't consume events. Use `watch --since` for that. Hosted `wait --since` uses the same inclusive 1,000-position resume window and too-old recovery described above: re-arm without `--since`, reconcile repository and build status, and account for the unavailable historical gap.

### React to attention with a hook

Tooling that should react to attention, such as a notifier, does not need its
own long-running `ab watch`. Declare a hook and the dispatcher delivers each
matching record to it, one JSON line on stdin per invocation, at least once and
in order:

```toml
[hooks.notify]
command = "jq -r '.id + \"  \" + (.event.type // .observation.type)' >> attention.log"
```

A hook can instead target an HTTPS URL, which receives each record as a signed
JSON `POST` and also works from a hosted dispatcher.

A hook complements your operator's standing watch; it does not replace it.
Failing hooks surface as `hook.failing` attention, and `bun ab repository status`
shows each hook's progress. See [`[hooks]`](configuration.md#hooks) for filters,
the record format, webhook signing and the delivery guarantee.

## Answer and pause

```
bun ab answer my-build "Keep the public API compatible"
```

A phase or policy escalation parks work until answered; guidance feeds the next round. A janitor escalation keeps retrying across dispatcher restarts and closes unanswered when an attempt succeeds; a bare retry only brings the next attempt forward. `answer` also accepts a bare retry and spec-revision resolutions for when the contract must change; see `bun ab help answer`.

```
bun ab pause my-build
bun ab resume my-build
```

- **`pause`** stops a build at its supported boundary.
- **`resume`** releases a cleanly paused build. It doesn't answer an escalation.
- **`pause --all`** holds queued work, turns intake off and requests pauses on running builds.
- **`resume --all`** releases the hold, turns intake on and resumes cleanly paused builds.

Intake off only stops new ticket claims; a repository pause also holds queued builds. Neither withdraws merge consent; use `hold`.

```
bun ab priority my-build urgent
```

- **`priority`** sets an active build's slot-admission priority to `urgent` or `normal` without touching its ticket. An urgent build waiting to re-verify, reconcile or resume takes the next free slot ahead of normal work; see [slot admission order](dispatcher.md#slot-admission-order). It never interrupts running work.

```
bun ab start AUT-12
bun ab start AUT-13 --priority urgent
```

- **`start`** asks the running dispatcher to claim one ticket on its next tick with a free slot, even while intake is off or open-PR backpressure is engaged, and nothing else. By default (`--priority manual`) the request goes ahead of all waiting work; `--priority urgent` waits for urgent parked work and makes the build urgent, and `--priority normal` waits for normal parked work and urgent claims. Repeating the command with another priority updates the pending request. The ticket must still be ready, meet the spec standard and have no unresolved blockers; a request that cannot start settles once with its reason. `ab watch` reports the outcome and `ab repository status` lists pending requests with their priority. `--cancel` withdraws a pending request.

## Authorize merge

Ordered merge rules choose automatic authorization or explicit consent. With no matching rule, leaves default to auto and integration nodes to consent. Verification, checks, protection and merge gates still apply.

```
bun ab merge my-build
bun ab hold my-build --reason "waiting on AUT-12 to merge"
```

- **`merge`** requires a ready build, clears its hold and grants consent to merge into its destination.
- **`hold`** suppresses merge and revokes consent, even before the build is ready. The optional `--reason` (1–2000 characters after trimming) is shown by `build status`, `builds`, `merges` and both dashboards while that hold stands; a later hold replaces it and `merge` clears it.
- **Reviewed head:** `merge --head <sha>` records consent only while `<sha>` is the current candidate head; otherwise it refuses with `head-mismatch` and records nothing.
- **Persistence:** consent survives head changes, clean restacks, verification and re-finalization until a hold or completion. Consent given under a `paths` or `within` rule is revoked, with `landing.consent-revoked` attention, when a reconcile's own edits, or a leaf restack's generated-file regeneration, touch a file the rule protects. Accepted node reparenting and a reopen also revoke it.
- **Red forge CI:** when CI fails at a finished leaf's live PR head, the dispatcher records `pr.checks-failed` once per head and failing set. It is default attention, and `build status`, `builds`, `merges` and both dashboards show it until a successful CI read finds no failing checks on that head (checks may still be pending, so clearing does not prove green) or the PR moves to another head. CI the forge won't report (missing permission, rate limit, outage) counts as unknown, never as green or red. Autobuild never re-runs CI or reopens the build itself: inspect the PR, re-run CI on the forge, or send the build back with feedback.

## Send a finished build back

When review of a finished, unmerged build asks for changes, reopen it instead of aborting it or opening a second PR:

```
bun ab reopen my-build --feedback "rename the flag and update the docs"
bun ab reopen my-build --revise-spec-from-ticket
```

- **Feedback alone** returns the build to `implement` with the feedback in `reopen.json`; code review, verification and finalize run again and the plan stays approved.
- **A spec revision** (`--revise-spec <file>`, or `--revise-spec-from-ticket` after amending the ticket, which re-pins its assets) restarts from `plan`, with any feedback alongside.
- The open PR and branch are kept and updated in place. Consent is revoked at once (a hold stays), and the build waits for a slot like other parked work. An armed native auto-merge is cancelled on a later dispatcher poll, not by `ab reopen` itself; a forge merge that lands first completes the build as merged.
- Only a leaf waiting for its merge decision can be reopened. Use `answer` for a blocked build; a merged or closed PR needs a new ticket.

## Choose an operator surface

Every surface reads the same durable state; [Operator surfaces](operator-surfaces.md) covers remote access.

| Surface | Progress, escalations, pause/resume | Merge consent and hold |
|---|---|---|
| Terminal dashboard (`bun ab dispatch`) | Yes | Keys `l` (merge) and `o` (hold) |
| CLI and MCP operator tools | Yes | Yes |

## An example session

1. You start `bun ab dispatch` and open your agent with `ab-operate` loaded.
2. You ask: “Add a small retry budget; keep the API compatible and ask before granting consent.” The agent asks whether exhausted retries should keep the existing error; you say yes, and it records that.
3. The agent specifies, files and grooms the ticket, then watches. When the build asks about the error shape, the agent answers from your instruction.
4. An escalation proposes expanding the API. The agent asks you; you keep it out of scope.
5. When the build is ready, the agent asks for consent, grants it once you authorize, and reports whether the change merged, stayed gated or closed. Green verification isn't a merge.
