---
title: "Getting started"
group: "start"
description: "Install Autobuild in your repository, configure it with ab init, validate setup, start the dispatcher, and ask your operator agent for the first change."
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

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind. Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite. See the [verification guide](verification.md).

Review the generated configuration and skills as repository files. Setup must establish the tools and credentials your chosen adapters need; installation alone does not configure a working pipeline. The [configuration reference](configuration.md) covers every field.


## 3. Validate setup

```
bun ab init --validate
```

Fix every named failure, review warnings and unknowns, and rerun validation before proceeding. Validation checks readiness without claiming tickets or starting builds.


## 4. Start dispatch

```
bun ab dispatch
```

Run this yourself and leave it running. The dispatcher claims tickets as they enter the tracker's configured ready state and shows a live dashboard. A draft or triage ticket is not ready merely because it exists.


## 5. Ask your operator agent for the first change

Open your coding agent at the repository root and load the installed `ab-operate` skill:

- Claude Code: `/ab-operate`
- Codex: `$ab-operate`
- Pi: `/skill:ab-operate`

Then ask in plain language:

> Help me specify a small retry-budget change. Ask me about the behavior and limits, file and groom the ticket when we agree, and watch it through landing. Ask me before granting landing consent.

The agent uses the grooming and ticket skills to develop acceptance criteria, scope, and evidence with you. Keep the first change small and give it checks that demonstrate success; the [spec standard](spec-standard.md) defines a buildable ticket. Dispatch is already running, so moving the ticket to ready makes it eligible for claim immediately.

Your agent watches recorded progress and answers build questions within your instructions, bringing unresolved decisions back to you. Landing follows the configured policy and gates; a green build does not guarantee immediate merge.

Continue with [Working with your operator agent](operating.md). The [configuration reference](configuration.md), [architecture map](architecture.md), and [design specification](../SPEC.md) cover the details.
