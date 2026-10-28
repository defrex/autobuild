---
title: "Intake and harvest"
group: "concepts"
description: "Turn outside signals and agent observations into reviewed proposals for your operator agent to triage and groom."
label: "Intake and harvest"
order: 5.5
---

# Intake and harvest

Outside signals and agent observations propose work. Your operator agent triages proposals, consults you on product choices, and grooms selected work to the [spec standard](tickets.md#groom-a-buildable-spec) before dispatch.


## Sources carry proposals

Anything that can write a ticket can propose work. Every source, including plugins, shares the same content, workflow states, labels, and blockers; see [Tickets and specs](tickets.md).

- Scheduled ingesters for signals such as telemetry are proposed extensions, not shipped integrations.
- A signal is evidence for a proposal, not permission to dispatch work.


## Observations become reviewed tickets

Agents record discoveries as observations while staying within their current spec:

```sh
ab observe --kind followup --files src/retry.ts "Retry budget ignores jitter"
```

Observation harvest, a shipped repository workflow rather than a build phase, collects observations, synthesizes and reviews proposals, and files approved tickets.

Proposals can join an existing ticket in the harvest ledger. The ledger facts shown during synthesis and review are scan-time context; at filing, each approved join is checked against fresh ticket existence and resolution in the selected source. Only existing, unresolved ledger targets from that source can be joined. Missing or resolved targets require suppression, and approval does not override this fresh check.

A run starts after `[policy].harvestThreshold` new unclaimed observations (default 5), or once `[policy].harvestMaxDrift` other builds (default 3) have merged since the oldest one (`0` disables drift).


## Triage is the default gate

Proposals land in the configured Triage state for grooming. A repository waives that gate by setting `[tickets].proposalState` to its ready state:

```toml
[tickets]
source = "file"
readyState = "ready"
proposalState = "ready"
```

The waiver doesn't skip blocker eligibility or the dispatch spec gate.

The [dispatcher guide](dispatcher.md) covers readiness and claim; [Tickets and specs](tickets.md) covers pinned specs and revisions.
