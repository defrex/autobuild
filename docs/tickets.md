---
title: "Tickets and specs"
group: "concepts"
description: "How your operator agent writes buildable specs, chooses ticket kinds, and grooms work for the ready gate."
label: "Tickets and specs"
order: 5
---

# Tickets and specs

A ticket tells Autobuild what change to make and why it matters. Your operator agent uses `ab-spec` with you to turn that intent into a buildable spec. The tracker is the input interface; the build's pinned spec is the execution contract.


## Choose a source

Autobuild ships three ticket sources, and plugins can register more through the same port:

- **File** stores tickets in lifecycle directories.
- **Linear** (direct) uses your team's workflow.
- **Hosted** is its own project-scoped service, not a proxy for Linear.

The source supplies ticket content, workflow states, labels, and blockers. Configuration chooses the source and ready gate; the rest of the pipeline behaves the same with any source.

```toml
[tickets]
source = "file"
readyState = "ready"
```

See [Ticket sources](ticket-sources.md) for adapter setup, credentials, configuration and extension contracts.

## Groom a buildable spec

The spec standard asks for four things:

- **What and why.** Describe the observable change and the reason it matters. Leave implementation strategy to planning.
- **Acceptance criteria.** State verifiable facts that a reviewer or check can use to decide whether the work is done.
- **Out of scope.** Name adjacent work the build must leave alone.
- **Evidence.** Link the decision, incident, data, or observations supporting the request.

Your operator agent grooms the ticket with you, then moves it to the configured ready state with any required labels. Being in the tracker isn't enough. Dispatch's spec gate returns ready tickets that can't become conforming specs to Triage with an explanation.


## Ready is a gate, not a guarantee

The dispatcher claims only tickets in the configured ready state, with the required labels and any source-specific filter. Even then, other conditions decide when a ticket starts:

- **Blockers.** These are prerequisites between tickets, not build escalations. Unresolved ones leave the ticket queued rather than creating a blocked build. In a node-enabled repository, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration-overview.md).
- **Destination and capacity.** Its target must accept new work, and a capacity slot must be free.

At dispatch, Autobuild pins the spec, so later tracker edits don't quietly change what reviewers approved. A deliberate revision requires your operator agent to answer an escalation under your instructions, and restarts planning:

```sh
bun ab answer <slug> --revise-spec-from-ticket
```


## Work and node tickets

| Kind | Describes | Runs |
|---|---|---|
| Work | an individual change | the build pipeline |
| Node | a finite integration point | collects related work, verifies it together, lands into its parent |

Both kinds need conforming specs: a node's intent alone isn't a buildable contract. Set the kind with `ab ticket create` or `ab ticket update --kind work|node`.

A target chooses the integration destination; blockers choose prerequisites. Read about [integrating related work](integration-overview.md) for node admission and landing.

Outside signals and agent discoveries enter through [Intake and harvest](intake.md), where proposals are groomed before becoming ready work.

Follow the [dispatcher guide](dispatcher.md) to see what happens at claim, or [Getting started](getting-started.md) for a first ticket.
