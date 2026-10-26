---
title: "Infrastructure seams"
group: "reference"
description: "Choose stores, agent runtimes, forges, workspaces, and ticket sources, and understand where local and remote execution run."
label: "Seams"
order: 7
---

# Infrastructure seams

Adapters supply storage, agent execution, code publication, workspaces and tickets. You choose each independently: a remote database doesn't move computation to a remote machine.


## Storage and tickets

- **BuildStore.** Local SQLite with filesystem artifacts by default; a remote store implementing the remote BuildStore protocol.
- **Tickets.** Local files, Linear, or hosted tickets. A hosted Store doesn't require hosted tickets.

See [Build store](build-store.md) and [Tickets](ticket-sources.md).


## Agents, code, and workspaces

- **Agent runtimes.** Claude Code, Codex and Pi. Roles choose runtime and model.
- **Forges.** GitHub and local git. Remote setups need GitHub.
- **Workspaces.** Local git worktrees, or Vercel Sandbox machines for runners, agents and checks.

Every environment needs the runtime, tools, dependencies and credentials; remote ones also need reproducible provisioning. See [Workspaces](workspaces.md).


## What runs where

| Piece | All local | All remote |
|---|---|---|
| Dispatcher | your machine | origin-mode CLI on an operator host |
| Build runners, agents, checks | your machine, in git worktrees | Vercel Sandbox |
| Store | local SQLite | remote BuildStore protocol |
| Tickets | file or any other source | a remote ticket source |
| Forge | local git or GitHub | GitHub |
| Operator access | terminal dashboard and local CLI | Operator API client |

- File tickets and local git make all-local independent of GitHub.
- The operator agent is external in both.
- Choosing a remote Store alone does not move dispatch or build execution off this machine.
- Mixed deployments work within adapter constraints, e.g. a local dispatcher with a hosted Store and remote sandboxes.

See [Dispatcher hosting](dispatcher-hosting.md).


## Extend the boundaries

- **Plugin modules** register ticket sources, agent runtimes, workspace providers and forges. See [Writing a plugin](plugin-authoring.md).
- **BuildStores** implement the storage or remote protocol contract, not a plugin registration.
- **Verify and finalize steps** and editable skills extend repository behavior; the phases stay fixed. See [Configuration](configuration-overview.md).
- **Hosting and operator surfaces** are deployment choices, not plugin ports.

## Seam guides

- [Tickets](ticket-sources.md): file, Linear, hosted, ticket trees.
- [Agent runtimes](agent-runtimes.md): Claude Code, Codex, Pi, models.
- [Workspaces](workspaces.md): git worktree, Vercel Sandbox, provisioning.
- [Forges](forges.md): GitHub, local git, publication adapters.
- [Build store](build-store.md): SQLite, remote HTTP, contracts.
- [Dispatcher hosting](dispatcher-hosting.md): local and origin-mode CLI processes.
- [Operator surfaces](operator-surfaces.md): terminal, CLI, stdio MCP, Operator API.
- [Writing a plugin](plugin-authoring.md): modules, contracts, packaging, publishing.
