---
title: "Integrating related work"
group: "concepts"
description: "Collect work in an integration tree, preserve change identity through restacks, and land under explicit policy."
slug: "integration"
label: "Integration"
order: 4
---

# Integrating related work

Break a big feature into tickets, collect their changes on its branch, and land the whole verified feature on main once. Autobuild keeps the related work in sync.

Work forms a tree rooted at `baseBranch`:

- **Work tickets** are leaves.
- **Node tickets** are finite integration points that collect children, then land into their parent.
- A repository can also send every work ticket directly to the root.


## Targets form the tree

A node opens an `ab-node/<slug>` branch at its parent's sampled head. Nodes can nest. A work ticket targets a node by ticket id, or defaults to the root when its target is omitted:

```sh
bun ab ticket create "Checkout redesign" --body checkout.md --kind node
bun ab ticket create "Cart summary" --body cart.md --target <node-id>
```

Claim freezes the destination build generation and branch; editing a claimed ticket can't redirect its change.

Leaves run the [normal build pipeline](builds.md). Nodes collect, verify, land, and close. A node finishes collecting when:

- its targeting tickets are done or cancelled,
- frozen child claims have settled, and
- at least one contribution has landed.

Idle nodes need no runner, and empty nodes have no PR.

- **Verification** checks the exact node head and parent. A change to either invalidates landing eligibility and requires verification again, even after a clean restack.
- **Repair.** A child ticket targeting the node can fix a failed node check.
- **Closing.** A landed node closes admission; it isn't a perpetual staging branch.


## One identity per leaf change

A leaf contributes one canonical net change, however many implementation commits it took.

- **Identity.** The `Autobuild-Build: <slug>` trailer carries it across commit SHA rewrites. Root leaf squash landings retain it, and node integration preserves the ordered contributing identities; a whole node doesn't become one leaf commit.
- **Restacks.** When a destination moves, Autobuild restacks onto it and cascades through descendants. Clean replay is automatic. A conflict attaches a reconcile runner with the source change's context, followed by verification as required.
- **Reverification.** Nodes always reverify a changed head or parent. A clean restack of a waiting leaf can retain its prior verification, whose reports keep citing their actual head and base.


## Blockers are a separate graph

A target says where work integrates. A blocker says which prerequisite must be available before dependent work can start.

```sh
bun ab ticket block <id> <blocker-id>
```

- **With nodes**, a blocker that has a build resolves when its change is present in the dependent's sampled destination, not merely when the source ticket says done. Sibling work may need to land into a common ancestor and cascade first.
- **Presence** is checked at claim, without interrupting existing builds. Missing or ambiguous evidence keeps the dependent queued.
- **Without nodes**, and for blockers without builds, the source's native done state resolves it.


## Policy authorizes landing

Ordered `[[landing]]` rules in `autobuild.toml` select `auto` or `consent`; the first matching rule wins. Rules can match the source kind (`from`), destination (`into`), and ticket `label`. Without a match, leaves default to `auto` and nodes to `consent`.

```toml
# Leaves land on the root automatically; everything else needs consent.
[[landing]]
from = "leaf"
into = "root"
mode = "auto"

[[landing]]
mode = "consent"
```

Your operator agent manages consent under your instructions:

- `ab land <slug>` records consent to a ready landing and clears a hold.
- `ab hold <slug>` suppresses landing, even before readiness, and withdraws consent.

Neither these controls nor automatic authorization bypass readiness, verification, forge checks, protection, or merge gates.

The [Tickets and specs](tickets.md) page explains the input side of the tree.
