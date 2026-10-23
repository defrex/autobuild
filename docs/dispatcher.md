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

It watches your ticket source, claims eligible tickets, establishes their specs, and starts isolated build-runners up to the repository's capacity.


## Ready work becomes a build

A ticket is claimed when it passes every gate:

- **Ready state.** It sits in the configured workflow state, with any required labels and source-specific filters.
- **Blockers.** Every ticket it depends on is done.
- **Destination.** Its target, `main` or an integration node, accepts new work.

Work that can't start yet stays queued. [Tickets and specs](tickets.md) explains grooming, and [Intake and harvest](intake.md) covers proposed work.

Each build runs in its own workspace, either a local git worktree or a remote sandbox, and its build-runner owns the pipeline from there. Capacity limits how many run at once:

- Work builds each hold a slot while they run.
- An integration node collecting children holds no slot. It takes one only while it verifies. See [the integration tree](integration-overview.md).


## The log is the source of truth

Everything a build does is recorded as typed events in an append-only log in the BuildStore:

- **Per-build log.** Phase transitions, verdicts, escalations and answers.
- **Repository journal.** Dispatcher runs, harvest and operator settings.
- **Artifacts.** Specs, plans, reports and evidence, stored with the record.

State is reduced from those events. A snapshot is only a cache, regenerated from the log.

Agents never decide outcomes through their output. They report through the typed `ab` CLI, for example `ab done` or `ab verdict`, and code validates the deposit, applies the gates and records the transition.


## Resume the work, not the chat

A restart loses nothing. The dispatcher reads each build's recorded phase, completed boundaries, artifacts and feedback, and continues; no process or chat has to survive. A replacement sandbox can resume the same build.

Recovery keeps authority boundaries:

- An unanswered escalation stays parked until your operator agent answers it.
- Pending operator commands and other actionable work proceed as normal.
- A restart never grants permission or resets an exhausted retry budget.


## The operator agent stays outside

Your operator agent is an external coding agent, such as Claude Code or Codex, running under your instructions. It:

- files and grooms tickets with you
- watches builds and answers bounded escalations
- manages landing consent

Locally it uses the `ab` CLI. Remotely it uses the same operator tools over MCP. You make the product calls.

Autobuild never hosts or starts that agent; it exposes state and controls for the agent to use. The agent's chat is separate from the build's paper trail.

Next: [operator surfaces](operator-surfaces.md) for the controls, and [one build end to end](builds.md) for the phases inside a runner.
