---
title: "Intake and harvest"
group: "concepts"
description: "Turn outside signals and agent observations into reviewed proposals for your operator agent to triage and groom."
label: "Intake and harvest"
order: 5.5
---

# Intake and harvest

Outside signals propose work. Your operator agent triages those proposals, consults you for product choices, and grooms the selected work into buildable specs before dispatch.


## Sources carry proposals

Anything that can write a ticket can propose work from an outside signal. Autobuild ships file, direct Linear, and hosted project-scoped ticket sources; plugins can register others. They share content, workflow states, labels, and blockers. [Tickets and specs](tickets.md) covers those sources and the contract your operator agent writes with `ab-spec`.

Scheduled ingesters for signals such as telemetry remain proposed extensions; they are not shipped integrations. A signal is evidence for a proposal, not permission to dispatch work.


## Observations become reviewed tickets

Agents record discoveries as observations while staying within their current spec. Autobuild's shipped observation harvest collects those discoveries, synthesizes proposals, reviews them, and files approved tickets. Harvest is a repository workflow, not another build phase.

Your operator agent reviews the resulting proposals with your goals in mind, resolves questions with you, and grooms selected tickets to the [spec standard](tickets.md#groom-a-buildable-spec).


## Triage is the default gate

Proposals default to the configured Triage state for grooming by your operator agent before dispatch. A repository can explicitly waive that harvest grooming gate with `[tickets].proposalState`, including choosing its ready state. That waiver does not waive blocker eligibility or the dispatch spec gate.

The [dispatcher guide](dispatcher.md) explains readiness and claim; [Tickets and specs](tickets.md) explains buildable contracts, pinned specs, and deliberate revisions.
