---
title: CLI
group: reference
order: 16
description: "Every command, grouped by your responsibilities and your operator agent’s."
---

# CLI

Run `bun ab <command>`; `bun ab help <command>` lists flags and subcommands. See [Operating](operating.md) for workflows.

## For you

- `accounts` — Authorize a ChatGPT subscription for a local dispatcher or connected project.

- `dispatch` — Run the dispatcher and dashboard.
- `init` — Install skills and hand setup to a coding agent.
- `upgrade` — Update Autobuild and merge default skills.
- `connect` — Connect to a hosted service with browser approval.
- `disconnect` — Revoke and remove the saved credential.
- `secrets` — List metadata, set or remove write-only project secrets.

## For your operator agent

- `help` — Show the overview or one command's help.
- `ticket` — Create, groom, inspect, and move tickets.
- `repository` — Inspect durable dispatcher settings.
- `merges` — List merges awaiting consent.
- `builds` — List builds and status.
- `build` — Inspect one build's state and events.
- `watch` — Follow events with a resumable cursor. Opt-in `--operator` registers advisory liveness for a repository-wide standing watch; unflagged watches write nothing.
- `wait` — Block until a build condition holds; print one record.
- `mcp` — Serve the operator tools over stdio.
- `pause` — Request a build or repository pause.
- `resume` — Resume a paused build or repository.
- `answer` — Answer escalations or request a retry.
- `abort` — Request irreversible build termination and cleanup.
- `restack` — Request a node restack onto its current parent.
- `hold` — Hold a merge, withdrawing consent.
- `merge` — Consent to a ready merge.
- `models` — Search Pi's model catalog.
- `plugin` — Inspect, diagnose, and contract-test adapters.
- `context` — Materialize the current phase's inputs.
- `artifact` — Deposit, fetch, or download versioned artifacts.
- `observe` — Record an observation outside the build's scope.
- `done` — Complete a producer phase.
- `verdict` — Complete a review or verification phase.
- `escalate` — Park the build with a question for you.
- `harvest` — Inspect or drive observation harvesting.

Phase commands (`context`, `done`, `verdict`) use runner-scoped session authority: the runner starts phase agents, never your operator agent. See [Skills](skills.md).


Permanent hosted data removal is available on the web app's Projects page to
super users and owners of the project's organization. `ab disconnect` only
revokes a credential; admin `projects remove` only unregisters access and retains
data. Project deletion removes hosted builds, tickets, blobs, secrets and accounts,
revokes every credential and retains only a minimal deletion audit. It does not
change local files or configuration. Failed cleanup is retryable with access
already refused. Reconnecting requires fresh browser approval and starts empty,
with hosted ticket numbering reset to 1. See
[permanent project deletion](operator-api.md#permanent-project-deletion).
