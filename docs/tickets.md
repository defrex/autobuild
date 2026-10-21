---
title: "Tickets are the interface"
group: "concepts"
description: "Choose a ticket source, groom buildable specs, and admit proposed work through the ready gate."
label: "Tickets"
order: 5
---

# Tickets are the interface

A ticket tells Autobuild what change to make and why it matters. Grooming turns that intent into a buildable spec. The tracker is the input interface; the build's pinned spec is the execution contract.


## Choose a source

Autobuild ships file, direct Linear, and hosted ticket sources. The file source stores tickets in lifecycle directories. Direct Linear uses your team's workflow. Hosted tickets are their own project-scoped service, not a proxy for Linear. Plugins can register additional ticket sources through the same port.

The source supplies ticket content, workflow states, labels, and blockers. Configuration chooses the source and ready gate; the rest of the build pipeline keeps the same vocabulary and behavior.


## Groom a buildable spec

The spec standard asks for four things:


- **What and why.** Describe the observable change and the reason it matters. Leave implementation strategy to planning.
- **Acceptance criteria.** State verifiable facts that a reviewer or check can use to decide whether the work is done.
- **Out of scope.** Name adjacent work the build must leave alone.
- **Evidence.** Link the decision, incident, data, or observations supporting the request.

A human grooms the ticket and moves it to the configured ready state with any required labels. Being present in a tracker is not enough. Dispatch's spec gate returns ready tickets that cannot become conforming specs to Triage with an explanation.


## Ready is a gate, not a guarantee

The dispatcher claims only tickets meeting the configured ready state and label requirements, plus any source-specific filter. Unresolved blockers leave a ticket queued rather than creating a blocked build. Destination availability and execution capacity also affect when it can start.

Blockers are distinct from a build escalation. They describe prerequisites between tickets. In a node-enabled repository, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration.md).

At dispatch, Autobuild pins the spec for the build. Changing tracker text later does not quietly change what its reviewers approved. A deliberate spec revision requires an operator answer to an escalation and restarts planning.


## Intake proposes work

Anything that can write a ticket can propose work from an outside signal. Autobuild's shipped observation harvest collects discoveries agents record while staying within their current spec, synthesizes proposals, reviews them, and files approved tickets. Harvest is a repository workflow, not another build phase.

Proposals default to the configured Triage state for a human to groom before dispatch. A repository can explicitly waive that harvest grooming gate with `[tickets].proposalState`, including choosing its ready state. That waiver does not waive blocker eligibility or the dispatch spec gate.

Scheduled ingesters for signals such as telemetry remain proposed extensions; they are not shipped integrations. A signal is evidence for a proposal, not permission to dispatch work.

Read the [spec standard](spec-standard.md), [ticket-source configuration reference](configuration.md), and [design specification](../SPEC.md) for the full contract and intake model. Follow the [dispatcher guide](dispatcher.md) to see what happens at claim, or [Getting started](getting-started.md) to groom a first ticket.
