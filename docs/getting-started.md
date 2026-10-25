---
title: "Getting started"
group: "start"
description: "Install Autobuild in your repository, configure it with ab init, validate setup, start the dispatcher, and ask your operator agent for the first change."
label: "Getting started"
order: 1
---

# Getting started

Start in the repository you want Autobuild to build. You need:

- [Bun](https://bun.sh) and git
- your agent runtime's local prerequisites: Claude Code, Codex CLI, or Pi
- for the GitHub forge, an authenticated [gh CLI](https://cli.github.com) or an exported `GITHUB_TOKEN` or `GH_TOKEN`; the local-git forge needs no account or remote


## 1. Install in the repository

```
bun add -D @defrex/autobuild
```

Run the CLI as `bun ab`. If installation creates `package.json` and `bun.lock`, commit them and ignore `node_modules/`.


## 2. Initialize and configure

```
bun ab init
```

Initialization vendors the editable `ab-*` skills, writes a stack-neutral `autobuild.toml`, and hands repository-aware setup to a coding agent. Follow that handoff to choose a runtime and model, ticket tracker, forge, workspace, and meaningful verification commands for your stack.

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. See the [verification guide](verification.md).


## 3. Start dispatch

```
bun ab dispatch
```

Run this yourself and leave it running. The dispatcher shows a live dashboard and claims tickets as they enter the tracker's configured ready state; a draft or triage ticket isn't ready.


## 4. Ask your operator agent for the first change

Open your coding agent at the repository root, then ask in plain language:

> Help me specify a small retry-budget change. Ask me about the behavior and limits, file and groom the ticket when we agree, and watch it through merge. Ask me before granting merge consent.

The agent works out acceptance criteria, scope, and evidence with you.

- Keep the first change small, with checks that demonstrate success. The [spec standard](tickets.md#groom-a-buildable-spec) defines a buildable ticket.
- With dispatch running, a ticket moved to ready is eligible for claim immediately.
- Your agent watches progress and answers build questions within your instructions, bringing unresolved decisions back to you.
- Merge follows the configured policy and gates; a green build doesn't guarantee immediate merge.

Continue with [Working with your operator agent](operating.md) and the [configuration reference](configuration-overview.md).
