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

Anything that can write a ticket can propose work from an outside signal. Every source, whether file, direct Linear, hosted, or a plugin, shares the same content, workflow states, labels, and blockers. [Tickets and specs](tickets.md) covers the sources and the contract your operator agent writes with `ab-spec`.

- Scheduled ingesters for signals such as telemetry are proposed extensions, not shipped integrations.
- A signal is evidence for a proposal, not permission to dispatch work.


## Observations become reviewed tickets

Agents record discoveries as observations while staying within their current spec:

```sh
ab observe --kind followup --files src/retry.ts "Retry budget ignores jitter"
```

Observation harvest is a shipped repository workflow, not another build phase. It:

1. collects those observations,
2. synthesizes proposals,
3. reviews them, and
4. files approved tickets.

A run starts after `[policy].harvestThreshold` new unclaimed observations (default 5), or once `[policy].harvestMaxDrift` other builds (default 3) have merged since the oldest one (`0` disables drift).

Your operator agent reviews the resulting proposals against your goals, resolves questions with you, and grooms selected tickets to the [spec standard](tickets.md#groom-a-buildable-spec).


## Triage is the default gate

Proposals default to the configured Triage state for your operator agent to groom before dispatch. A repository explicitly waives that gate by setting `[tickets].proposalState` to its ready state:

```toml
[tickets]
source = "file"
readyState = "ready"
proposalState = "ready"
```

The waiver doesn't waive blocker eligibility or the dispatch spec gate.

The [dispatcher guide](dispatcher.md) explains readiness and claim; [Tickets and specs](tickets.md) explains buildable contracts, pinned specs, and deliberate revisions.
