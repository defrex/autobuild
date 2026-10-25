---
title: "Working with your operator agent"
group: "guides"
description: "Delegate specs, tickets, monitoring, and merge to your agent while keeping product decisions and authority with you."
label: "Working with your operator agent"
order: 6
---

# Working with your operator agent

Your operator agent keeps work moving through `ab` or MCP. Under your instructions it writes specs, files and grooms tickets, operates the builds the repository's dispatcher dispatches, answers bounded escalations, pauses or aborts work, and authorizes merge.

- **You own** goals, scope, tradeoffs and authority, and you run the dispatcher and upgrades.
- **The agent never** starts, stops or restarts dispatch; it reports dispatcher trouble to you.
- **Autobuild doesn't** host or start the agent. There's no orchestrator setup step.

## Choose a harness

- **A local coding agent** at the repository root with the installed `ab-operate` skill, using the CLI or `bun ab mcp` (operator tools over stdio).
- **A remote agent** with no checkout, on the authenticated hosted `/mcp` endpoint. See [Operator surfaces](operator-surfaces.md).

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
successful heartbeat, including a final best-effort heartbeat on orderly exit.

Re-arm with `bun ab watch --operator --json --since <watch-cursor>` using only
the standing watch's own cursor. This preserves one ID and original start time
across a re-arm gap of up to five minutes. Reconcile current and newly dispatched
builds after arming and on timeout. Keep operating after the initial work ends,
until you end or hand off the role. `wait` does not heartbeat or carry registration
identity: a separate unflagged diagnostic wait/watch must never replace the
standing monitor or supply its resume cursor. MCP presence is deferred.

- **Default filter:** actionable attention only, such as escalations and ready merges awaiting consent. Add `--event` globs for routine lifecycle events.
- **Starts now:** a fresh watch ignores history, so check current status too.
- **Resumable:** pass the opaque cursor from the JSON output back with `--since` to receive events recorded while away. The final JSON line always carries one.
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

Existing attention returns immediately, even with a cursor, so looping `wait` doesn't consume events. Use `watch --since` for that.

## Answer and pause

```
bun ab answer my-build "Keep the public API compatible"
```

An escalation parks work until answered; guidance feeds the next round. `answer` also accepts a bare retry and spec-revision resolutions for when the contract must change; see `bun ab help answer`.

```
bun ab pause my-build
bun ab resume my-build
```

- **`pause`** stops a build at its supported boundary.
- **`resume`** releases a cleanly paused build. It doesn't answer an escalation.
- **`pause --all`** holds queued work, turns intake off and requests pauses on running builds.
- **`resume --all`** releases the hold, turns intake on and resumes cleanly paused builds.

Intake off only stops new ticket claims; a repository pause also holds queued builds. Neither withdraws merge consent; use `hold`.

## Authorize merge

Ordered merge rules choose automatic authorization or explicit consent. With no matching rule, leaves default to auto and integration nodes to consent. Verification, checks, protection and merge gates still apply.

```
bun ab merge my-build
bun ab hold my-build
```

- **`merge`** requires a ready build, clears its hold and grants consent to merge into its destination.
- **`hold`** suppresses merge and revokes consent, even before the build is ready.
- **Persistence:** consent survives head changes, restacks, verification and re-finalization until a hold or completion. Accepted node reparenting revokes it.

## Choose an operator surface

Every surface reads the same durable state; [Operator surfaces](operator-surfaces.md) covers remote access.

| Surface | Progress, escalations, pause/resume | Merge consent and hold |
|---|---|---|
| Terminal dashboard (`bun ab dispatch`) | Yes | Keys `l` (merge) and `o` (hold) |
| Hosted web app | Yes, plus sessions and transcripts | Merge/Hold on a merge awaiting consent |
| CLI and MCP operator tools | Yes | Yes |

## An example session

1. You start `bun ab dispatch` and open your agent with `ab-operate` loaded.
2. You ask: “Add a small retry budget; keep the API compatible and ask before granting consent.” The agent asks whether exhausted retries should keep the existing error; you say yes, and it records that.
3. The agent specifies, files and grooms the ticket, then watches. When the build asks about the error shape, the agent answers from your instruction.
4. An escalation proposes expanding the API. The agent asks you; you keep it out of scope.
5. When the build is ready, the agent asks for consent, grants it once you authorize, and reports whether the change merged, stayed gated or closed. Green verification isn't a merge.
