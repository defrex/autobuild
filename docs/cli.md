---
title: CLI
group: reference
order: 13
description: "Every command, grouped by your responsibilities and your operator agent’s."
---

# CLI

Examples use the repository-installed CLI: `bun ab <command>`. Run `bun ab help <command>` for flags and subcommands. See [Operating](operating.md) and the [operator API reference](operator-api.md) for workflows.

## For you

- `dispatch` — Run the repository dispatcher and dashboard.
- `init` — Install skills and hand setup to a coding agent.
- `upgrade` — Update Autobuild and merge default skills.
- `connect` — Connect this project to a hosted service with browser approval.
- `disconnect` — Revoke and remove this project's saved credential.

## For your operator agent

- `help` — Show the overview or detailed command help.
- `ticket` — Create, groom, inspect, and move tickets.
- `repository` — Inspect durable repository dispatcher settings.
- `landings` — List ready landings awaiting consent.
- `builds` — List repository builds and status.
- `build` — Inspect one build's state and events.
- `watch` — Follow events with a resumable cursor.
- `wait` — Wait for a build condition and print one record.
- `mcp` — Serve the operator tool registry over stdio.
- `pause` — Request a build or repository pause.
- `resume` — Resume a paused build or repository.
- `answer` — Answer escalations or request a retry.
- `abort` — Irreversibly request build termination and cleanup.
- `restack` — Request a node restack onto its current parent.
- `hold` — Hold a landing and withdraw consent.
- `land` — Consent to a ready landing.
- `models` — Search Pi's model catalog.
- `plugin` — Inspect, diagnose, and contract-test adapters.
- `context` — Materialize the current phase's inputs.
- `artifact` — Deposit, fetch, or download versioned artifacts.
- `observe` — Record a structured observation outside the build's scope.
- `done` — Complete the current producer phase.
- `verdict` — Complete a review or verification phase.
- `escalate` — Park the build with a question for you.
- `harvest` — Inspect or drive observation harvesting.

Phase commands such as `context`, `done`, and `verdict` use runner-scoped session authority. The runner invokes phase agents; this inventory does not instruct your operator agent to start phases manually. See [Skills](skills.md).
