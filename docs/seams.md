---
title: "Infrastructure seams"
group: "reference"
description: "Choose stores, agent runtimes, forges, workspaces, and ticket sources, and understand where local and remote execution run."
label: "Seams"
order: 7
---

# Infrastructure seams

Autobuild separates the pipeline from the infrastructure that runs it. Adapters supply storage, agent execution, code publication, workspaces and tickets, and you choose each one independently: a remote database doesn't move computation to a remote machine.


## Storage and tickets

The BuildStore and the ticket source are separate choices.

- **BuildStore.** Local SQLite with filesystem artifacts is the default. A Postgres adapter provides database-backed storage, and the hosted HTTP service exposes a Postgres-backed Store over the network. The adapter and the service that exposes it are distinct parts of a deployment.
- **Tickets.** Local files, Linear, or hosted tickets. A hosted Store doesn't require hosted tickets.

See [Build store](build-store.md) and [Tickets](ticket-sources.md).


## Agents, code, and workspaces

- **Agent runtimes.** Claude Code, Codex and Pi ship. Roles choose runtimes and models; the model doesn't decide where an agent runs.
- **Forges.** GitHub and local git ship. Local git works without GitHub pull requests, but remote setups need GitHub's publication path.
- **Workspaces.** Local builds use disposable git worktrees. Vercel Sandbox provisions remote machines for build runners, agents and checks.

Every environment needs the selected runtime, tools, dependencies and credentials; remote ones also need reproducible provisioning. [Workspaces](workspaces.md) covers provisioning and readiness checks.


## What runs where

| Piece | All local | All remote |
|---|---|---|
| Dispatcher | your machine | hosted, scheduled, origin-mode configuration |
| Build runners, agents, checks | your machine, in git worktrees | Vercel Sandbox |
| Store | local SQLite | hosted Store on Postgres |
| Tickets | file or any other source | a remote ticket source |
| Forge | local git or GitHub | GitHub |
| Operator access | terminal dashboard and local CLI | browser or MCP connector |

- **File tickets and local git** keep the all-local arrangement independent of GitHub.
- **The operator agent stays external** in both arrangements.
- **All remote still needs provisioning and credentials.** Choosing Postgres alone doesn't enable it.
- **Mixed deployments** work within adapter constraints, for example a local dispatcher with a hosted Store and remote sandboxes.

[Dispatcher hosting](dispatcher-hosting.md) explains scheduled operation, placement and credentials.


## Extend the boundaries

- **Plugin modules** register ticket sources, agent runtimes, workspace providers and forges. See [Writing a plugin](plugin-authoring.md).
- **BuildStores** implement the storage adapter or remote protocol contract, not a plugin manifest registration.
- **Verify and finalize steps** and editable skills extend repository behavior; the phase grammar stays fixed. See [Configuration](configuration-overview.md).
- **Hosting and operator surfaces** are deployment and access choices, not plugin ports.

## Seam guides

- [Tickets](ticket-sources.md): file, Linear, hosted, and optional ticket trees.
- [Agent runtimes](agent-runtimes.md): Claude Code, Codex, Pi, and model selection.
- [Workspaces](workspaces.md): git worktree, Vercel Sandbox, and provisioning.
- [Forges](forges.md): GitHub, local git, and safe publication adapters.
- [Build store](build-store.md): SQLite, Postgres, HTTP, and storage contracts.
- [Dispatcher hosting](dispatcher-hosting.md): local processes and scheduled hosted ticks.
- [Operator surfaces](operator-surfaces.md): terminal, web, CLI, and MCP access.
- [Writing a plugin](plugin-authoring.md): modules, contracts, packaging, and publishing.
