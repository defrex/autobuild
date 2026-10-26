---
title: "How Autobuild works"
group: "start"
description: "The ticket-driven development lifecycle, its review and verification gates, and the repositories it fits."
label: "Overview"
order: 0
slug: ""
---

# How Autobuild works

Autobuild runs coding agents through a fixed pipeline that takes a groomed ticket to a verified pull request, with a separate workspace for each build. Three actors keep that work moving:

- **You** decide goals, scope, tradeoffs, and how much authority to delegate.
- **Your operator agent** is an external agent that writes specs, files and grooms tickets, operates the builds the repository's dispatcher dispatches, and answers questions within your instructions. The `ab` CLI is primarily its interface; agents without a shell can use local stdio MCP or the Operator API.
- **The dispatcher** claims ready work and runs the durable pipeline, including isolated agent sessions, checks, and publication.


## From a ticket to a change

A ticket states the observable change, why it matters, acceptance criteria, explicit limits, and evidence. Grooming turns it into a buildable spec and moves it to the tracker's ready state; filing alone doesn't make it ready.

The dispatcher claims ready tickets up to your configured capacity and runs each through the same pipeline:

1. **Spec.** The ticket's spec becomes the build's contract.
2. **Plan and plan review.** An agent proposes a plan; an independent reviewer checks it against the spec and can request revisions.
3. **Implement and code review.** An agent commits the change; a fresh reviewer's findings send it back for another round.
4. **Verify.** Your configured checks, commands or agent verifiers, run in ordered stages whose members may run concurrently. A failed stage settles, then returns every failed report to implementation. See [Verification](verification.md). This effectively replaces CI.
5. **Finalize.** An agent writes the pull request description and Autobuild opens the PR.

Merge depends on the configured policy and merge gates. Conflicts are reconciled, then verified again. Related work can be collected into an integration tree before merge.


## Where it fits

Autobuild fits repositories whose work can be stated as clear tickets and checked automatically.

- **Requirements.** Bun, git, and your agent runtime (Claude Code, Codex CLI, or Pi) with its access and credentials.
- **Throughput over latency.** Independent builds run side by side, but each one pays for planning, review, and verification. A small edit you need now is better done directly in your coding agent.
- **Not a product owner.** It doesn't make product decisions or make vague tickets precise without your input; builds stop for answers, and your agent brings unresolved decisions back to you. If you can't state what done means, or your checks can't detect a broken change, fix grooming and verification first.


## Using these docs

Start with [Getting started](getting-started.md), then:

- **Concepts:** [builds](builds.md), the [dispatcher](dispatcher.md), [integration](integration-overview.md), [tickets](tickets.md) with the [spec standard](tickets.md#groom-a-buildable-spec), and [Skills](skills.md) for editable agent defaults.
- **Operating and configuring:** [Working with your operator agent](operating.md), [Seams](seams.md), and the [configuration reference](configuration-overview.md).
- **Reference:** [CLI](cli.md), [Upgrading](upgrading.md), [Troubleshooting](troubleshooting.md), and the [Glossary](glossary.md).
