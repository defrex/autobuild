---
title: "Integrating related work"
group: "concepts"
description: "Collect work in an integration tree, preserve change identity through restacks, and land under explicit policy."
slug: "integration"
label: "Integration"
order: 4
---

# Integrating related work

Break a big feature into tickets, collect their changes on its branch, and land the whole verified feature on main once. Autobuild keeps related work in sync while your operator agent manages landing under your authority.

Autobuild organizes work as a tree rooted at your configured `baseBranch`. Work tickets are leaves. Node tickets are finite integration points that collect children before landing into their parent. A repository can also send every work ticket directly to the root.


## Targets form the tree

A node opens an `ab-node/<slug>` branch at its parent's sampled head. Nodes can nest. A work ticket targets a node by ticket id, or defaults to the root when its target is omitted. Claim freezes the destination build generation and branch; editing a claimed work ticket cannot silently redirect its change.

Leaves run the [normal build pipeline](builds.md). Nodes instead collect, verify, land, and close. A node finishes collecting when its targeting tickets are done or cancelled, frozen child claims have settled, and at least one contribution has landed. Idle nodes need no runner, and empty nodes have no PR.

Node verification checks the exact node head and parent. A change to either invalidates landing eligibility and requires verification again, even after a clean restack. A failed node check can be repaired by a child ticket targeting that node. A landed node closes admission; it is not a perpetual staging branch.


## One identity per leaf change

A leaf contributes one canonical net change, however many implementation commits it took. The `Autobuild-Build: <slug>` trailer carries its identity across commit SHA rewrites. Root leaf squash landings retain that identity, and node integration preserves the ordered contributing identities. A whole node does not become one leaf commit.

Autobuild restacks changes when their destination moves and cascades parent movement through descendants. Clean replay is automatic. A conflict attaches a reconcile runner with the source change's context, followed by verification as required. Nodes always reverify a changed head or parent; a clean waiting leaf restack can retain its prior verification, whose reports keep their actual head and base citations.


## Blockers are a separate graph

A target says where work integrates. A blocker says which prerequisite must be available before dependent work can start. In repositories with nodes, a blocker that has a build resolves when its change is present in the dependent's sampled destination, rather than merely when the source ticket says done.

Presence is checked at claim, without interrupting existing builds. Sibling work may need to land into a common ancestor and cascade before it is available. Missing or ambiguous evidence keeps the dependent queued. Repositories without nodes, and blockers without builds, use the source's native done-state resolution.


## Policy authorizes landing

Ordered `[[landing]]` rules in `autobuild.toml` select `auto` or `consent`. Rules can match the source kind, destination, and ticket label; the first matching rule wins. Without a match, leaves default to auto and nodes to consent.

Under your instructions, your operator agent uses `ab land <slug>` to record consent to a ready landing and clear a hold. It uses `ab hold <slug>` to suppress landing even before readiness and withdraw consent. Neither these controls nor automatic authorization bypass readiness, verification, forge checks, protection, or merge gates.

Read the [integration-tree reference](integration-tree.md) for admission and node lifecycle, the [restacking reference](restacking.md) for change identity and recovery, and the [landing-policy reference](landing-policy.md) for rules and forge requirements. The [Tickets and specs](tickets.md) explains the input side of the tree.
