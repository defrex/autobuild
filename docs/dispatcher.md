---
title: "The dispatcher and durable state"
group: "concepts"
description: "How Autobuild claims ready tickets, runs isolated builds within capacity, and resumes from its event log."
label: "Dispatcher"
order: 3
---

# The dispatcher and durable state

The dispatcher watches your configured ticket source for ready work. It claims eligible tickets, establishes their specs, and starts isolated build-runners up to the repository's capacity. Agents supply judgment inside the pipeline; deterministic code decides what runs next.


## Ready work becomes a build

The ready gate combines the configured workflow state with any required labels and source-specific filters. A ticket must also satisfy its blockers and destination checks before claim. Work that cannot yet start stays queued. The [tickets guide](tickets.md) explains grooming and intake.

Each work build runs in its own workspace: a local git worktree or a remote sandbox, depending on the selected workspace provider. Its build-runner owns the pipeline execution, keeping concurrent builds isolated. Capacity bounds concurrent execution; it does not make every queued ticket runnable at once.

An integration node can collect children without an active runner or workspace. Idle collecting nodes consume no runner capacity; node verification temporarily uses execution capacity. See [the integration tree](integration.md).


## The log is the source of truth

Build processes append typed facts to a per-build, append-only event log in the BuildStore. Repository-wide workflows and operator settings use a separate repository journal. Specs, plans, reports, and other artifacts live with that durable record.

State is reduced from events. A snapshot is only a cache that can be regenerated from the log. Agent stdout never determines a phase outcome: agents report through the typed `ab` CLI, and code validates deposits, applies gates, and records transitions.


## Resume the work, not the chat

Running dispatch again recovers actionable current work from durable state. The runner reads the recorded phase, completed boundaries, artifacts, and feedback rather than needing a process or conversation to have survived. A replacement sandbox can resume the same build.

Recovery does not erase a human gate. An unanswered escalation stays parked until an operator records an answer. Pending operator commands and other actionable work can still proceed; restarting the dispatcher does not grant permission or reset an exhausted budget.


## The operator stays outside

The operator can be a human or an external coding agent acting as orchestrator. It files and grooms tickets, watches builds, answers escalations, and manages landing consent. Locally it uses the CLI; an agent connected over MCP can use the corresponding operator tools.

Autobuild does not host or start that orchestrator agent. It runs the build pipeline and exposes durable state and controls for the operator to use. The operator's chat is separate from the build's paper trail.

Read the [architecture map](architecture.md), [operator API reference](operator-api.md), and [integration-tree reference](integration-tree.md) for the process and control boundaries. Follow [one build end to end](builds.md) for the phases inside a runner.
