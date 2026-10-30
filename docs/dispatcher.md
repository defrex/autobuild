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

It watches your ticket source, claims eligible tickets, pins their specs, and starts isolated build-runners up to capacity.


## Watch a dispatcher running elsewhere

A human can open the terminal dashboard from a local checkout without dispatching:

```sh
bun ab dispatch --viewer --dispatched-by app.autobuild.run
```

The optional label is descriptive input. Every frame says `viewer · dispatched by
<label>`, or simply `viewer` when omitted. Plain/non-TTY output states the mode
at startup and prints state changes. `--once` reads one snapshot; `--interval <s>`
sets the polling cadence. Without a recorded configuration it waits for the dispatcher.

The viewer takes no repository lease and starts no build, harvest, scan, janitor,
or dispatcher process. Ctrl-C closes only the viewer. Shared-store controls
remain available: merge consent, hold, pause/resume, blocked feedback/retry,
intake and harvest gates, harvest resume/acknowledgement, queued discard and
confirmed abort. Navigation and session inspection work as usual. These record
operator intent for the dispatcher to execute. No current control needs a local
dispatcher. Startup intake flags and `--repository` are rejected; use a local
checkout with its configured Store or `--store`. Operator agents still must not
run `ab dispatch`, including `--viewer`.

## Ready work becomes a build

A ticket is claimed when it passes every gate:

- **Ready state.** The configured workflow state, required labels and source filters.
- **Blockers.** Every dependency is done.
- **Destination.** Its target (`main` or an integration node) accepts new work.

Others stay queued. See [Tickets and specs](tickets.md) for grooming and [Intake and harvest](intake.md) for proposed work.

Each build gets its own workspace (local git worktree or remote sandbox) and a build-runner that owns its pipeline. Capacity caps concurrency: a work build holds a slot while it runs; an integration node holds one only while it verifies, not while collecting children. See [the integration tree](integration-overview.md).


## The log is the source of truth

The BuildStore holds typed, append-only event logs and artifacts:

- **Per-build log.** Phase transitions, verdicts, escalations and answers.
- **Repository journal.** Dispatcher runs, harvest and operator settings.
- **Artifacts.** Specs, plans, reports and evidence.

State is reduced from those events; a snapshot is only a cache.

Agents report through the typed `ab` CLI (`ab done`, `ab verdict`), not their output; code validates the deposit, applies the gates and records the transition.


## Resume the work, not the chat

A restart loses nothing. The dispatcher continues each build from its recorded phase, completed boundaries, artifacts and feedback, even in a replacement sandbox. Authority boundaries hold:

- Unanswered escalations stay parked until your operator agent answers.
- Pending operator commands and actionable work proceed.
- A restart never grants permission or resets an exhausted retry budget.


## The operator agent stays outside

Your operator agent is an external coding agent you direct, like Claude Code or Codex. It files and grooms tickets with you, operates the builds the repository's dispatcher dispatches, answers bounded escalations and manages merge consent, using the `ab` CLI locally or the same tools over MCP. You make the product calls. Autobuild never hosts or starts it, and its chat isn't part of the build's paper trail.

Next: [operator surfaces](operator-surfaces.md) for the controls, [one build end to end](builds.md) for the phases.
