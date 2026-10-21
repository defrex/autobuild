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

Autobuild ships file, direct Linear, and hosted ticket sources. The file source stores tickets in lifecycle directories. Direct Linear uses your team's workflow. Hosted tickets are their own project-scoped service, not a proxy for Linear. Plugins can register additional ticket sources through the same port.

The source supplies ticket content, workflow states, labels, and blockers. Configuration chooses the source and ready gate; the rest of the build pipeline keeps the same vocabulary and behavior.


See [Ticket sources](ticket-sources.md) for adapter setup, credentials, configuration and extension contracts.

## Groom a buildable spec

The spec standard asks for four things:


- **What and why.** Describe the observable change and the reason it matters. Leave implementation strategy to planning.
- **Acceptance criteria.** State verifiable facts that a reviewer or check can use to decide whether the work is done.
- **Out of scope.** Name adjacent work the build must leave alone.
- **Evidence.** Link the decision, incident, data, or observations supporting the request.

Your operator agent grooms the ticket with you and moves it to the configured ready state with any required labels. Being present in a tracker is not enough. Dispatch's spec gate returns ready tickets that cannot become conforming specs to Triage with an explanation.


## Ready is a gate, not a guarantee

The dispatcher claims only tickets meeting the configured ready state and label requirements, plus any source-specific filter. Unresolved blockers leave a ticket queued rather than creating a blocked build. Destination availability and execution capacity also affect when it can start.

Blockers are distinct from a build escalation. They describe prerequisites between tickets. In a node-enabled repository, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration-overview.md).

At dispatch, Autobuild pins the spec for the build. Changing tracker text later does not quietly change what its reviewers approved. A deliberate spec revision requires your operator agent to record an answer to an escalation under your instructions and restarts planning.


## Work and node tickets

Work tickets describe individual changes and run the build pipeline. Node tickets describe finite integration points that collect related work, verify it together, and land into their parent. Both kinds need conforming specs: a node's intent alone is not a buildable contract.

A target chooses the integration destination; blockers choose prerequisites. They are separate relationships. Read about [integrating related work](integration-overview.md) for node admission and landing.

Outside signals and agent discoveries enter through [Intake and harvest](intake.md), where proposals are groomed before becoming ready work.

Read the [spec standard](spec-standard.md) and [ticket-source configuration reference](configuration.md) for the full contract. Follow the [dispatcher guide](dispatcher.md) to see what happens at claim, or [Getting started](getting-started.md) for a first ticket.
