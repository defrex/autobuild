---
title: "Tickets and specs"
group: "concepts"
description: "How your operator agent writes buildable specs, chooses ticket kinds, and grooms work for the ready gate."
label: "Tickets and specs"
order: 5
---

# Tickets and specs

A ticket says what change to make and why. The tracker is the input; the build's pinned spec is the execution contract.


## Choose a source

Autobuild ships three ticket sources; plugins can register more through the same port:

- **File** stores tickets in lifecycle directories.
- **Linear** (direct) uses your team's workflow.
- **Hosted** is its own project-scoped service, not a Linear proxy.

The source supplies content, workflow states, labels, and blockers; configuration picks the source and ready gate. Everything else is source-agnostic.

```toml
[tickets]
source = "file"
readyState = "ready"
```

See [Ticket sources](ticket-sources.md) for setup, credentials, configuration and extension contracts.

## Groom a buildable spec

The spec standard asks for:

- **What and why.** The observable change and why it matters; implementation strategy is left to planning.
- **Acceptance criteria.** Verifiable facts that decide whether the work is done.
- **Out of scope.** Adjacent work the build must leave alone.
- **Evidence.** The decision, incident, data, or observations behind the request.

Your operator agent grooms the ticket with you using `ab-spec`, then moves it to the ready state with any required labels. Dispatch's spec gate returns ready tickets that can't become conforming specs to Triage with an explanation.


## Ready is a gate, not a guarantee

The dispatcher claims only tickets in the ready state with the required labels and any source-specific filter. A ready ticket still waits on:

- **Blockers.** Unresolved prerequisite tickets keep it queued; they don't create a blocked build. With nodes, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration-overview.md).
- **Destination and capacity.** Its target must accept new work, and a capacity slot must be free.

Before ready filing, the agent checks `ab repository status --json`. With live
`operator.registrations`, it records intent, rejected alternatives and out-of-scope
reasons in the ticket body, files, tells you the existing operator will pick it up,
and stops without a watch. Otherwise it takes the operator role for the builds the repository's dispatcher dispatches.
Your explicit instruction overrides either default; non-ready work needs no watch.

At dispatch, Autobuild pins the spec, so later tracker edits don't change what reviewers approved. A deliberate revision goes through your operator agent answering an escalation, and restarts planning:

```sh
bun ab answer <slug> --revise-spec-from-ticket
```


## Work and node tickets

| Kind | Describes | Runs |
|---|---|---|
| Work | an individual change | the build pipeline |
| Node | a finite integration point | collects related work, verifies it together, merges into its parent |

Both kinds need conforming specs; a node's intent alone isn't a buildable contract. Set the kind with `ab ticket create` or `ab ticket update --kind work|node`. See [integrating related work](integration-overview.md) for targets, node admission and merge.

Outside signals and agent discoveries enter through [Intake and harvest](intake.md) as proposals, groomed before they become ready work.

Follow the [dispatcher guide](dispatcher.md) for what happens at claim, or [Getting started](getting-started.md) for a first ticket.
