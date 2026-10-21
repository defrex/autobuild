---
title: "Operating Autobuild"
group: "guides"
description: "Watch durable progress, answer escalations, pause work, and authorize landing through the CLI or an external operator agent."
label: "Operating"
order: 6
---

# Operating Autobuild

Your operator agent keeps work moving: it watches recorded progress, answers questions, and manages authorized landing consent. You make product decisions and provide guidance when needed. Autobuild does not start or host an orchestrator agent.


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

Any external agent with shell access can operate through the CLI. `bun ab mcp` serves the operator tools locally over stdio. The hosted service exposes its authenticated `/mcp` connector for agents running elsewhere, without requiring a repository checkout on your agent's machine.

Read the [operator API reference](operator-api.md) and [hosted MCP guide](mcp.md) for remote access. The [design specification](../SPEC.md) records the CLI and escalation contracts.
