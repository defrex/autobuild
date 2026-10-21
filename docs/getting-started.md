---
title: "Getting started"
group: "start"
description: "Install Autobuild in your repository, configure it with ab init, groom a ticket, and start the dispatcher."
label: "Getting started"
order: 1
---

# Getting started

Start in the repository you want Autobuild to build. You need [Bun](https://bun.sh), git, and the local prerequisites for the agent runtime you select: Claude Code, Codex CLI, or Pi.

The GitHub forge needs an authenticated [gh CLI](https://cli.github.com) or an exported `GITHUB_TOKEN` or `GH_TOKEN`. The local-git forge needs no account or remote. Setup will help choose the arrangement for your repository.


## 1. Install in the repository


```
bun add -D @defrex/autobuild
```

This adds Autobuild as a development dependency. If installation creates `package.json` and `bun.lock`, commit them and ignore `node_modules/`. Run the repository-installed CLI with `bun ab`.


## 2. Initialize and configure


```
bun ab init
```

Initialization vendors the editable `ab-*` skills, writes a stack-neutral `autobuild.toml`, and hands repository-aware setup to a coding agent. Follow that handoff to choose a runtime and model, ticket tracker, forge, workspace, and meaningful verification commands for your stack.

Review the generated configuration and skills as repository files. Setup must establish the tools and credentials your chosen adapters need; installation alone does not configure a working pipeline. The [configuration reference](configuration.md) covers every field.


## 3. Groom the first ticket

Open your coding agent in the repository and invoke the installed `ab-spec` skill. For an example request, use the invocation for your runtime:


- Claude Code: `/ab-spec add a retry budget`
- Codex: `$ab-spec add a retry budget`
- Pi: `/skill:ab-spec add a retry budget`

The agent asks questions, develops acceptance criteria, records scope and evidence, and files the ticket in your configured tracker. Decide what the change should do, then groom it to the tracker's configured ready state. A draft or triage ticket is not dispatchable just because it exists.

Keep the first change small enough to review and give it checks that can demonstrate success. Use the [spec standard](spec-standard.md) to assess whether the ticket is buildable.


## 4. Start dispatch


```
bun ab dispatch
```

The dispatcher claims ready work and shows a live dashboard. The README quickstart starts dispatch before grooming; either order works because the dispatcher claims ready tickets as they arrive.

Each claimed work ticket gets an isolated build and moves through planning, review, implementation, verification, and PR creation. Watch the build's recorded state. When it escalates, your operator agent must record an answer to the question before it can continue. Merge still follows the configured landing policy and gates.

For deeper reference, read the [configuration reference](configuration.md), [architecture map](architecture.md), and [design specification](../SPEC.md). Return to the [overview](overview.md) for the lifecycle and its limits.
