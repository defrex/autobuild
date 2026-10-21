---
title: "Infrastructure seams"
group: "reference"
description: "Choose stores, agent runtimes, forges, workspaces, and ticket sources, and understand where local and remote execution run."
label: "Seams"
order: 7
---

# Infrastructure seams

Autobuild separates the pipeline from the infrastructure that runs it. Adapters supply storage, agent execution, code publication, workspaces, and tickets. Choose each responsibility explicitly; selecting a remote database does not move computation to a remote machine.


## Storage and tickets

The default local BuildStore uses SQLite and filesystem artifacts. A separate Postgres adapter provides database-backed storage. The hosted HTTP service exposes a network-accessible Store backed by Postgres. A storage adapter and the service that exposes it are distinct parts of a deployment.

Ticket sources are selected independently of the BuildStore: local files, Linear, or hosted tickets. Using a hosted Store does not require using hosted tickets. See the [architecture map](architecture.md) and [hosted service reference](hosted-service.md) for the boundaries.


## Agents, code, and workspaces


- **Agent runtimes.** Claude Code, Codex, and Pi are shipped adapters. Roles choose runtimes and models. Model selection does not itself decide where an agent runs.
- **Forges.** GitHub and local git are shipped adapters. Local git permits local operation without GitHub pull requests; it does not supply the GitHub publication path required by the remote setup.
- **Workspaces.** Local builds use disposable git worktrees. Vercel Sandbox provisions remote machines for build runners, agents, and checks.

Each environment needs the selected runtime, tools, dependencies, and credentials. Remote execution also needs provisioning and reproducible setup. Follow the [setup reference](setup.md) for the supported adapter combinations and readiness checks.


## What runs where

**All local.** Your machine runs the dispatcher, build runners, agent runtime CLIs, checks, git worktrees, and local Store. File tickets and the local-git forge can keep this arrangement independent of GitHub. You can watch dispatch in the terminal and operate through the local CLI.

**All remote.** A hosted scheduled dispatcher uses origin-mode repository configuration. Vercel Sandbox runs build runners, agents, and checks; GitHub holds code and receives publication. A hosted Store backed by Postgres records progress, and a remote ticket source supplies work. Your operator agent and you use the browser or MCP connector. The operator agent remains external. Provisioning and credentials are still required; this is not enabled merely by choosing Postgres.

Mixed deployments are supported within adapter constraints, such as a local dispatcher using a hosted Store and remote sandboxes. The [hosted dispatcher reference](hosted-dispatcher.md) explains scheduled operation; the [setup reference](setup.md) covers placement and credentials.


## Extend the boundaries

Configured plugin modules can register ticket sources, agent runtimes, workspace providers, and forges. BuildStore extensions use the storage adapter or remote protocol contract, rather than a plugin manifest registration.

Ordered verify and finalize steps and editable skills extend repository behavior while the phase grammar stays fixed. See [Configuration](configuration-overview.md) and the [full configuration reference](configuration.md) for plugin modules and extension points.

Hosting and operator surfaces are deployment and access choices, not plugin registration ports.

## Seam guides

- [Tickets](ticket-sources.md): file, Linear, hosted, and optional ticket trees.
- [Agent runtimes](agent-runtimes.md): Claude Code, Codex, Pi, and model selection.
- [Workspaces](workspaces.md): git worktree, Vercel Sandbox, and provisioning.
- [Forges](forges.md): GitHub, local git, and safe publication adapters.
- [Build store](build-store.md): SQLite, Postgres, HTTP, and storage contracts.
- [Dispatcher hosting](dispatcher-hosting.md): local processes and scheduled hosted ticks.
- [Operator surfaces](operator-surfaces.md): terminal, web, CLI, and MCP access.
- [Writing a plugin](plugin-authoring.md): modules, contracts, packaging, and publishing.
