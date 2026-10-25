---
title: "Integrating related work"
group: "concepts"
description: "Collect work in an integration tree, preserve change identity through restacks, and merge under explicit policy."
slug: "integration"
label: "Integration"
order: 4
---

# Integrating related work

Break a big feature into tickets, collect their changes on one branch, and merge the verified feature on main once. Work forms a tree rooted at `baseBranch`:

- **Work tickets** are leaves.
- **Node tickets** are finite integration points that collect children, then merge into their parent.
- Repositories without nodes send every work ticket to the root.


## Targets form the tree

A node opens an `ab-node/<slug>` branch at its parent's sampled head; nodes can nest. A work ticket targets a node by ticket id, or the root by default:

```sh
bun ab ticket create "Checkout redesign" --body checkout.md --kind node
bun ab ticket create "Cart summary" --body cart.md --target <node-id>
```

Claim freezes the destination build generation and branch; editing a claimed ticket can't redirect its change.

Leaves run the [normal build pipeline](builds.md). A node collects, verifies, merges, and closes. It finishes collecting when its targeting tickets are done or cancelled, frozen child claims have settled, and at least one contribution has merged.

- **Idle** nodes need no runner; empty nodes have no PR.
- **Repair** a failed node check with a child ticket targeting the node.
- **Merge** closes admission; a node isn't a perpetual staging branch.


## One identity per leaf change

A leaf contributes one canonical net change, however many commits it took.

- **Identity.** The `Autobuild-Build: <slug>` trailer carries it across SHA rewrites. Root squash merges keep it; node integration keeps each contributing identity, in order, rather than one node commit.
- **Restacks.** When a destination moves, Autobuild restacks onto it and cascades through descendants. Clean replay is automatic; a conflict attaches a reconcile runner with the source change's context, then verification as required.
- **Reverification.** Node verification covers the exact node head and parent; a change to either voids merge eligibility until reverified, even after a clean restack. A cleanly restacked waiting leaf can keep its prior verification; reports cite their actual head and base.


## Blockers are a separate graph

A target says where work integrates; a blocker says what must be available before dependent work starts.

```sh
bun ab ticket block <id> <blocker-id>
```

- **With nodes**, a blocker that has a build resolves when its change is present in the dependent's sampled destination. Sibling work may need to merge into a common ancestor and cascade first.
- **Presence** is checked at claim, without interrupting existing builds; missing or ambiguous evidence keeps the dependent queued.
- **Without nodes**, and for blockers without builds, the source ticket's done state resolves it.


## Policy authorizes merge

Ordered `[[merge]]` rules in `autobuild.toml` select `auto` or `consent`; the first match wins. Rules match source kind (`from`), destination (`into`), and ticket `label`. Without a match, leaves default to `auto` and nodes to `consent`.

```toml
# Leaves merge on the root automatically; everything else needs consent.
[[merge]]
from = "leaf"
into = "root"
mode = "auto"

[[merge]]
mode = "consent"
```

Your operator agent manages consent:

- `ab merge <slug>` records consent to a ready merge and clears a hold.
- `ab hold <slug>` suppresses merge, even before readiness, and withdraws consent.

Neither control, nor automatic authorization, bypasses readiness, verification, forge checks, protection, or merge gates.

[Tickets and specs](tickets.md) covers the input side of the tree.
