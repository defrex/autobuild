---
title: "How Autobuild works"
group: "start"
description: "The ticket-driven development lifecycle, its review and verification gates, and the repositories it fits."
label: "Overview"
order: 0
slug: ""
---

# How Autobuild works

Autobuild takes a groomed ticket through planning, implementation, review, verification, and pull request creation. It runs coding agents inside a fixed pipeline, with a separate workspace for each build. Three actors keep that work moving:

- **You** decide goals, scope, tradeoffs, and how much authority to delegate.
- **Your operator agent** is an external agent that writes specs, files and grooms tickets, watches builds, and answers questions within your instructions. The `ab` CLI is primarily its interface; remote agents use MCP.
- **The dispatcher** claims ready work and runs the durable pipeline, including isolated agent sessions, checks, and publication.


## From a ticket to a change

A ticket states the observable change, why it matters, acceptance criteria, explicit limits, and evidence. Grooming turns it into a buildable spec and moves it to the tracker's ready state; writing a ticket alone doesn't make it ready.

The dispatcher claims ready tickets up to your configured capacity. Each work ticket runs the same pipeline:

1. **Spec.** Establish the ticket's spec as the contract for the build.
2. **Plan and plan review.** An agent proposes an implementation plan. An independent reviewer checks it against the spec and can request revisions.
3. **Implement and code review.** An agent commits the change. A fresh reviewer checks the implementation; findings send it back for another round.
4. **Verify.** Your configured checks run in order. They can be commands or agent verifiers. A failed check returns the build to implementation. This effectively replaces CI.
5. **Finalize.** An agent writes the pull request description and Autobuild opens the PR.

Beyond the pipeline:

- **Landing** depends on the configured policy and merge gates.
- **Conflicts** are reconciled, then verified again.
- **Related work** can be collected into an integration tree before landing.


## Where it fits

Autobuild fits repositories where work can be described as clear tickets and checked by useful automated verification.

- **Requirements.** Bun, git, and the prerequisites for your agent runtime: Claude Code, Codex CLI, or Pi. Runtime access and credentials are part of your setup.
- **Throughput over latency.** Independent builds run side by side, but each one pays for planning, review, and verification. A small edit that needs an immediate answer may be better handled directly in your coding agent.
- **Not a product owner.** It doesn't make product decisions or make vague tickets precise without your input. If you can't state what done means, or your checks can't detect a broken change, fix grooming and verification first.
- **Escalations.** Builds can stop for answers; your agent brings unresolved product decisions back to you.


## Using these docs

Start with [Getting started](getting-started.md) for installation and a first ticket. Then:

- **Concepts:** [builds](builds.md), the [dispatcher](dispatcher.md), [integration](integration-overview.md), [tickets](tickets.md), and [Skills](skills.md) for editable agent defaults.
- **Operating and configuring:** [Working with your operator agent](operating.md), [Seams](seams.md), and the [configuration reference](configuration-overview.md).
- **Reference:** [CLI](cli.md), [Upgrading](upgrading.md), [Troubleshooting](troubleshooting.md), and the [Glossary](glossary.md).

The [spec standard](tickets.md#groom-a-buildable-spec) defines a buildable ticket.
