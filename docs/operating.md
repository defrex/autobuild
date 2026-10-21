---
title: "Working with your operator agent"
group: "guides"
description: "Delegate specs, tickets, monitoring, and landing to your agent while keeping product decisions and authority with you."
label: "Working with your operator agent"
order: 6
---

# Working with your operator agent

Your operator agent keeps work moving through `ab` or MCP. You talk to it about the change you want; it writes specs, files and grooms tickets, watches builds, answers bounded escalations, pauses or aborts work, and authorizes landing under your instructions.

You own goals, scope, tradeoffs, and authority. You run the dispatcher and perform upgrades. The agent never starts, stops, or restarts dispatch; it reports dispatcher trouble to you. Autobuild does not host or start the operator agent, and there is no orchestrator setup step.


## Choose a harness

Use a local coding agent opened at the repository root with the installed `ab-operate` skill loaded, or an external remote agent connected through the authenticated hosted MCP endpoint. A local agent with shell access normally uses the CLI; `bun ab mcp` also serves the tools over stdio. Remote access is covered in the [hosted MCP guide](mcp.md) and [operator API reference](operator-api.md).

We recommend running the operator agent on the same model as your reviewer roles. It needs comparable judgment to interpret findings and escalation answers. This is a recommendation for your harness, not a model setting Autobuild enforces.


## Give the agent memory

Persistent goals, decisions, constraints, and monitor cursors let a resumed agent keep direction without asking the same questions again. Use your harness's memory or an agreed repository notes file. Have the agent load it at session start and record decisions as you make them.

Autobuild supplies no agent-memory implementation. Conversational memory preserves your intent; authoritative build events and artifacts establish what actually happened. The agent must reconcile its notes against current recorded state when it resumes.


## Give steering that sticks

Specify scope, priority, acceptance boundaries, escalation thresholds, and landing authority. Ask the agent to record and follow those decisions across sessions. For example:

> Keep this change API-compatible. Prioritize the retry budget over diagnostics. You may answer questions already settled by this spec, but ask me about scope changes and before granting landing consent.

Moving a ticket to ready can start a build immediately. Granting consent can allow it to land when gates pass. Bounded delegation does not grant blanket product authority; agree on these boundaries before the agent acts.

The agent should escalate to you for ambiguous goals, scope or compatibility tradeoffs, inadequate authority, consequential or destructive choices, missing access, and dispatcher trouble. It can answer questions already resolved by your instructions without asking again.

The following commands are examples of what your agent runs in response to your requests.


## Watch for attention


```
bun ab watch --json
```

This standing monitor follows active builds, newly created builds, and the repository journal. Its default filter reports actionable attention, including escalations and ready landings that need consent. Use event filters when you want routine lifecycle events too. A fresh watch starts from now; inspect current status as well to reconcile attention that already exists.

Save the opaque cursor from the JSON output and pass it back with `--since` to resume through events recorded while the monitor was away. The final JSON line carries a cursor even when no event matched. The default watch duration is 30 minutes; `--timeout 0` keeps it open.


```
bun ab wait my-build --for attention --json --timeout 5m
```

`wait` is a bounded, one-shot wait for a build condition. It exits 0 on a match, 2 if all named builds end without matching, and 3 on timeout. Existing attention returns immediately, even with a cursor, so repeatedly waiting for the same current condition is not an event-consumption loop. Use `watch --since` for that.


## Answer and pause


```
bun ab answer my-build "Keep the public API compatible"
```

An open escalation parks work until an answer is recorded. Guidance becomes input to the next round. The answer command also supports a bare retry and explicit revised-spec resolutions when the contract itself needs to change; consult CLI help and the [design specification](../SPEC.md) before choosing a resolution.


```
bun ab pause my-build
bun ab resume my-build
```

Pause requests stop a build at its supported boundary; resume releases a cleanly paused build. Resume does not answer an escalation. `bun ab pause --all` holds queued work, turns intake off, and requests pauses on running builds. `bun ab resume --all` releases that hold, enables intake, and resumes cleanly paused builds.

Turning intake off alone stops new ticket claims. Repository pause also holds queued builds. Neither action withdraws landing consent: use a hold when the intended action is to stop a landing.


## Authorize landing

Ordered landing rules select automatic authorization or explicit consent. Without a matching rule, leaves default to auto and integration nodes to consent. Authorization always remains subject to verification, checks, protection, and merge gates.


```
bun ab land my-build
bun ab hold my-build
```

`land` requires a ready build, clears its hold, and grants consent to land into its destination. `hold` suppresses landing and revokes consent, even before readiness. Consent survives head changes, restacking, verification, and re-finalization until hold or completion; accepted node reparenting revokes it. Review the [landing policy reference](landing-policy.md) for the exact readiness and forge requirements.


## Choose an operator surface

The live terminal dashboard shown by `bun ab dispatch` and the hosted web operator app both read durable state. They expose build progress, escalations, and pause/resume controls. The web app also lets you inspect sessions and transcripts. Landing consent and hold are available through the CLI, terminal keys `l`/`o`, and MCP/operator tools; the web app has no consent controls.

Any external agent with shell access can operate through the CLI. `bun ab mcp` serves the operator tools locally over stdio. The hosted service exposes its authenticated `/mcp` connector for agents running elsewhere, without requiring a repository checkout on the machine running your agent.

Read the [operator API reference](operator-api.md) and [hosted MCP guide](mcp.md) for remote access. The [design specification](../SPEC.md) records the CLI and escalation contracts.


## An example session

1. You validate setup and start `bun ab dispatch`, then open your agent with `ab-operate` loaded.
2. You ask: “Add a small retry budget; keep the API compatible and ask before granting consent.” The agent asks whether exhausted retries should preserve the existing error. You say yes, and it records that decision.
3. The agent specifies, files, and grooms the ticket with your agreement, then watches the build. When a build asks about the error shape, it answers from your recorded compatibility instruction.
4. A later escalation proposes expanding the API. The agent brings that unresolved decision to you; you keep it out of scope, and the agent records the answer.
5. When the build is ready, the agent asks for the required consent. After your authorization it grants consent and watches the actual outcome. It reports whether the change merged, remains gated, or closed under the configured policy, rather than treating green verification as a merge.
