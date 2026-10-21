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

- **You** decide goals, scope, tradeoffs, and how much authority to delegate. You mainly run the dispatcher and perform upgrades.
- **Your operator agent** is an external agent that writes specs, files and grooms tickets, watches builds, answers questions within your instructions, and authorizes landing. The `ab` CLI is primarily its interface; remote agents use MCP.
- **The dispatcher** claims ready work and runs the durable pipeline, including isolated agent sessions, checks, and publication.

You mostly talk to your agent. Autobuild neither hosts nor starts that agent.


## From a ticket to a change

A ticket starts with the observable change, why it matters, acceptance criteria, explicit limits, and evidence. Grooming turns those decisions into a buildable spec and moves the ticket to the tracker's configured ready state. Writing a ticket alone does not make it ready to build.

The dispatcher claims ready tickets and starts builds up to your configured capacity. Each work ticket runs the same pipeline:


1. **Spec.** Establish the ticket's spec as the contract for the build.
2. **Plan and plan review.** An agent proposes an implementation plan. An independent reviewer checks it against the spec and can request revisions.
3. **Implement and code review.** An agent commits the change. A fresh reviewer checks the implementation; findings send it back for another round.
4. **Verify.** Your configured checks run in order. They can be commands or agent verifiers. A failed check returns the build to implementation.
5. **Finalize.** An agent writes the pull request description and Autobuild opens the PR.

Landing still depends on the configured policy and merge gates. If the PR conflicts, reconciliation is followed by verification again. A green build is not a promise of immediate merge. Related work can also be collected into an integration tree before landing.


## Agents judge; code moves the build

Agents plan, implement, and review. Deterministic code owns transitions, state, gating, and publication. Every phase reports through the typed CLI; agent output alone never decides whether a phase succeeded.

Build state comes from a typed, append-only event log. Artifacts and feedback are stored with the build, so resumption uses durable state rather than a continuing chat. Open escalations remain parked until an answer is recorded.

For the full model, read the [design specification](../SPEC.md) and [architecture map](architecture.md).


## Where it fits

Autobuild fits repositories where work can be described as clear tickets and checked with useful automated verification. You need Bun, git, and the prerequisites for your selected agent runtime: Claude Code, Codex CLI, or Pi. Runtime access and credentials are part of your setup.

It favors throughput over the latency of one change: independent builds can run side by side, while each still pays for planning, review, and verification. A small edit that needs an immediate answer may be better handled directly in your coding agent.

It does not replace product decisions or make vague tickets precise without your input. If you cannot state what done means, or your checks cannot detect a broken change, grooming and verification need attention first. Builds can stop for escalation answers; your agent should bring unresolved product decisions back to you.


## Using these docs

Start with [Getting started](getting-started.md) for installation and a first ticket. These pages introduce the system for engineers evaluating it. Read about [builds](builds.md), the [dispatcher](dispatcher.md), [integration](integration-overview.md), [tickets](tickets.md), and [Skills](skills.md) for editable agent defaults, plus [Working with your operator agent](operating.md), [Seams](seams.md), and [Configuration](configuration-overview.md); the repository holds the detailed references. Consult [CLI](cli.md), [Upgrading](upgrading.md), [Troubleshooting](troubleshooting.md), and the [Glossary](glossary.md) for reference.

The [configuration reference](configuration.md) describes what you configure. The [spec standard](spec-standard.md) defines a buildable ticket.
