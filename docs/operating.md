---
title: "Working with your operator agent"
group: "guides"
description: "Delegate specs, tickets, monitoring, and landing to your agent while keeping product decisions and authority with you."
label: "Working with your operator agent"
order: 6
---

# Working with your operator agent

Your operator agent keeps work moving through `ab` or MCP. You describe the change you want; under your instructions it writes specs, files and grooms tickets, watches builds, answers bounded escalations, pauses or aborts work, and authorizes landing.

- **You own** goals, scope, tradeoffs and authority. You run the dispatcher and perform upgrades.
- **The agent never** starts, stops or restarts dispatch. It reports dispatcher trouble to you.
- **Autobuild doesn't** host or start the agent. There's no orchestrator setup step.


## Choose a harness

Use either:

- **A local coding agent** opened at the repository root with the installed `ab-operate` skill loaded. With shell access it uses the CLI; `bun ab mcp` also serves the operator tools over stdio.
- **A remote agent** connected through the authenticated hosted MCP endpoint. See [Operator surfaces](operator-surfaces.md).

We recommend running the operator agent on the same model as your reviewer roles, since it interprets findings and escalation answers. Autobuild doesn't enforce this.


## Give the agent memory

Persistent goals, decisions, constraints and monitor cursors let a resumed agent keep direction without re-asking. Use your harness's memory or an agreed notes file in the repository:

- Load it at session start.
- Record decisions as you make them.
- On resume, reconcile the notes against current recorded state.

Autobuild ships no agent memory. Notes preserve your intent; build events and artifacts establish what actually happened.


## Give steering that sticks

Tell the agent your scope, priorities, acceptance boundaries, escalation thresholds and landing authority, and have it record them across sessions. For example:

> Keep this change API-compatible. Prioritize the retry budget over diagnostics. You may answer questions already settled by this spec, but ask me about scope changes and before granting landing consent.

Agree on boundaries before the agent acts. Moving a ticket to ready can start a build immediately, and granting consent can let it land once gates pass. Bounded delegation isn't blanket product authority.

The agent answers questions your instructions already settle. It escalates to you for:

- ambiguous goals
- scope or compatibility tradeoffs
- consequential or destructive choices
- missing authority or access
- dispatcher trouble

The commands below are what your agent runs on your behalf.


## Watch for attention


```
bun ab watch --json
```

`watch` is a standing monitor over active builds, new builds and the repository journal.

- **Default filter.** Actionable attention only, such as escalations and ready landings awaiting consent. Add `--event` globs for routine lifecycle events.
- **Starts now.** A fresh watch ignores history; check current status too, to catch attention that already exists.
- **Resumable.** Save the opaque cursor from the JSON output and pass it back with `--since` to receive events recorded while the monitor was away. The final JSON line carries a cursor even when nothing matched.
- **Duration.** 30 minutes by default; `--timeout 0` keeps it open.


```
bun ab wait my-build --for attention --json --timeout 5m
```

`wait` blocks once until a build condition holds, then exits:

| Exit | Meaning |
|---|---|
| 0 | A condition matched |
| 2 | Every named build ended without matching |
| 3 | Timed out |

Existing attention returns immediately, even with a cursor, so looping `wait` on the same condition doesn't consume events. Use `watch --since` for that.


## Answer and pause


```
bun ab answer my-build "Keep the public API compatible"
```

An open escalation parks work until an answer is recorded; guidance feeds the next round. `answer` also accepts a bare retry and spec-revision resolutions for when the contract itself must change. Check `bun ab help answer` before choosing one.


```
bun ab pause my-build
bun ab resume my-build
```

- **`pause`** stops a build at its supported boundary.
- **`resume`** releases a cleanly paused build. It doesn't answer an escalation.
- **`pause --all`** holds queued work, turns intake off and requests pauses on running builds.
- **`resume --all`** releases the hold, turns intake on and resumes cleanly paused builds.

Turning intake off only stops new ticket claims; a repository pause also holds queued builds. Neither withdraws landing consent. To stop a landing, use `hold`.


## Authorize landing

Ordered landing rules choose automatic authorization or explicit consent. With no matching rule, leaves default to auto and integration nodes to consent. Verification, checks, protection and merge gates always still apply.


```
bun ab land my-build
bun ab hold my-build
```

- **`land`** requires a ready build, clears its hold and grants consent to land into its destination.
- **`hold`** suppresses landing and revokes consent, even before the build is ready.
- **Persistence.** Consent survives head changes, restacks, verification and re-finalization until a hold or completion. Accepted node reparenting revokes it.


## Choose an operator surface

Every surface reads the same durable state.

| Surface | Progress, escalations, pause/resume | Landing consent and hold |
|---|---|---|
| Terminal dashboard (`bun ab dispatch`) | Yes | Keys `l` (land) and `o` (hold) |
| Hosted web app | Yes, plus sessions and transcripts | No |
| CLI and MCP operator tools | Yes | Yes |

- **CLI.** Any external agent with shell access.
- **`bun ab mcp`.** Serves the operator tools locally over stdio.
- **Hosted `/mcp` connector.** For agents running elsewhere, with no repository checkout on their machine.

Read [Operator surfaces](operator-surfaces.md) for remote access.


## An example session

1. You validate setup, start `bun ab dispatch`, and open your agent with `ab-operate` loaded.
2. You ask: “Add a small retry budget; keep the API compatible and ask before granting consent.” The agent asks whether exhausted retries should preserve the existing error. You say yes, and it records the decision.
3. With your agreement, the agent specifies, files and grooms the ticket, then watches the build. When the build asks about the error shape, the agent answers from your recorded compatibility instruction.
4. A later escalation proposes expanding the API. The agent brings that open decision to you; you keep it out of scope, and the agent records the answer.
5. When the build is ready, the agent asks for consent, grants it once you authorize, and watches the outcome. It reports whether the change merged, remains gated or closed, rather than treating green verification as a merge.
