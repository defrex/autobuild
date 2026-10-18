# Restacking and change identity

A leaf contributes one net change, independent of its WIP commit count. Before
verification the kernel collapses its contribution relative to the effective
diff base and replays it onto the sampled destination. Implementation and review
do not rewrite history. Verification failures return to implementation; later
commits append until the next approved cycle. Later reviews use the effective
base from the preceding successful restack; the original cut remains provenance.

The terminal `Autobuild-Build: <slug>` trailer identifies a change across SHA
rewrites. Reachable identities determine presence, including blockers; old SHAs
alone do not. Each canonical leaf replay has one parent and one identity,
including an empty resolved change. Root leaf squash retains that identity;
node fast-forwards preserve ordered contributing identities.

## Timing and evidence

Destination observations are durable `target.moved` facts, including while an
agent runs. Verify-entry restack freezes a current base before verification;
path selection excludes upstream-only paths. After finalize and post-steps,
waiting leaves restack when the target moves. Node-target finalize contributions
are canonicalized before guarded landing even when the target SHA is unchanged.
Clean replay starts no agent. A clean waiting leaf rewrite preserves prior
verification; reports retain their actual cycle base/head. Conflicted replay
runs reconcile and verification, and initial verification cannot be skipped
through post-reconcile policy.

Every open node observes its parent and cascades movement to descendants,
including empty nodes without PRs. Movement coalesces onto the newest sample
after an active frozen transaction finishes; no separate throttle is configured.
Unlike clean waiting leaves, nodes must reverify any changed head or parent.

Before replacement the kernel publishes retained tips, displaced heads and the
temporary change under immutable exact archive refs. `restack.*` facts record
preparation, replay, intent, archived replacement, contention and completion.
Unpublished request/loss records alone cannot preserve objects from a released
sandbox. Publication uses exact expected-head CAS; contention retains evidence
and retries without overwriting another writer. Remote guests park for trusted
publication after teardown. Historical merge reconciliations keep their original
interpretation and supply a promoted contribution base for later replay.

## Node contributions and recovery

Node replay enumerates oldest-first first-parent contributions above the last
completed boundary (initially the opening SHA). Inherited foreign history is
excluded from node ownership; the boundary advances only on confirmed completion.
Ordered source identities survive, and identities already reachable upstream
are dropped. Untagged commits, including empty ones, are foreign.

A separate node writer lease and durable reservation serialize restacks and
child landings. Reservations freeze expected head, parent, contribution boundary,
archives, changes and merge proofs. Lease expiry recovers the same operation,
not a competing one. Prepared/conflicted/replayed item receipts, publication
intent, proven replacement and settlement distinguish each recovery boundary.
Inventory exposes source identities, node-owned foreign commits, active operation,
conflict item and unsafe merge evidence.

Only a conflicted item attaches a reconcile runner. It receives the original
source build's pinned spec, approved plan and implement-notes, with the integration
owner identified separately. Missing artifacts or invalid identity escalate.
Foreign conflicts receive commit metadata and a diff; unclear intent escalates.
Completion validates exactly one commit on the item's replay base, preserving
identity or foreign status. The agent never publishes the stack; dispatcher
publication waits for session and execution settlement.

## Foreign merges

Before any replay or publication, inspect every merge's non-first-parent history,
including nested side history, against identities reachable in the frozen parent.
Flattening is safe only when the merge has no own identity and every side-history
identity is already present upstream. It becomes one foreign first-parent delta,
including resolution content or an empty result; side identities stay inherited.
An identity-bearing merge, absent upstream side identity, malformed or ambiguous
identity refuses the whole restack. The branch and contribution boundary remain
untouched and the integration build escalates with offending evidence. The kernel
never preserves merge topology or decomposes an unsafe merge automatically.

See [integration trees](integration-tree.md), [landing](landing-policy.md), and
[migration](migration-1.0.md).
