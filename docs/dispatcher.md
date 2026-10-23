---
title: "The dispatcher and durable state"
group: "concepts"
description: "How Autobuild claims ready tickets, runs isolated builds within capacity, and resumes from its event log."
label: "Dispatcher"
order: 3
---

# The dispatcher and durable state

The dispatcher is the long-running process that turns ready tickets into builds. Agents supply judgment inside the pipeline; deterministic code decides what runs next.

```
bun ab dispatch
```

It watches your ticket source, claims eligible tickets, establishes their specs, and starts isolated build-runners up to capacity.


## Ready work becomes a build

A ticket is claimed when it passes every gate:

- **Ready state.** It's in the configured workflow state, with any required labels and source filters.
- **Blockers.** Every ticket it depends on is done.
- **Destination.** Its target, `main` or an integration node, accepts new work.

Anything else stays queued. See [Tickets and specs](tickets.md) for grooming and [Intake and harvest](intake.md) for proposed work.

Each build gets its own workspace (a local git worktree or remote sandbox) and a build-runner that owns its pipeline. Capacity caps concurrency:

- A work build holds a slot while it runs.
- An integration node holds one only while it verifies, not while collecting children. See [the integration tree](integration-overview.md).


## The log is the source of truth

Everything a build does is recorded as typed events in the BuildStore's append-only log:

- **Per-build log.** Phase transitions, verdicts, escalations and answers.
- **Repository journal.** Dispatcher runs, harvest and operator settings.
- **Artifacts.** Specs, plans, reports and evidence.

State is reduced from those events; a snapshot is only a cache.

Agents don't decide outcomes through their output. They report through the typed `ab` CLI (`ab done`, `ab verdict`), and code validates the deposit, applies the gates and records the transition.


## Resume the work, not the chat

A restart loses nothing. The dispatcher continues each build from its recorded phase, completed boundaries, artifacts and feedback, even in a replacement sandbox; no process or chat has to survive.

Recovery keeps authority boundaries:

- An unanswered escalation stays parked until your operator agent answers it.
- Pending operator commands and other actionable work proceed.
- A restart never grants permission or resets an exhausted retry budget.


## The operator agent stays outside

Your operator agent is an external coding agent you direct, such as Claude Code or Codex. It:

- files and grooms tickets with you
- watches builds and answers bounded escalations
- manages landing consent

It uses the `ab` CLI locally, or the same operator tools over MCP remotely, while you make the product calls. Autobuild never hosts or starts it, and its chat isn't part of the build's paper trail.

Next: [operator surfaces](operator-surfaces.md) for the controls, and [one build end to end](builds.md) for the phases inside a runner.
