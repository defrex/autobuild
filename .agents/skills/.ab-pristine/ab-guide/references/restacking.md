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

Nodes observe parent movement durably but restack only on demand: before a
complete nonempty node verifies; before landing if its parent moved; when queued
dependency presence requires an ancestor change; on `ab restack <node>`; or on
accepted re-parenting. There is no eager mode or cadence option. Nested nodes
need their own demand. Existing frozen transactions, including ones reserved
before upgrade, finish first; later demand coalesces onto the latest parent.
Leaves keep verify-entry and awaiting-landing restacks for every target.

For observation cadence, durable wakes and last-check evidence, see
[node polling and status](integration-tree.md#polling-and-status).

Presence demand uses change identities, never ticket resolution alone. It follows
only the path from the nearest proven ancestor source down to the dependent's
actual destination, processing ancestors first. Unrelated siblings stay idle;
changes absent from all ancestors cannot trigger a speculative replay. Tickets
remain queued until presence is observed in their destination.

`ab restack <node>` (operator tool `builds.restack`, input `{repo, slug}`) records
a durable request, coalescing pending demand. It refuses leaves, terminal nodes,
and unopened nodes. Paused or blocked nodes wait for their normal safety gates.
A request arriving during replay survives until its parent and required identities
are covered. Re-parenting invalidates requests for the old destination.

Both dashboards show `parent N commits ahead`, `parent current`, or
`parent distance unknown`. Distance counts commits reachable from the observed
parent but not the last confirmed contribution base; it is not elapsed time or
poll count. Samples are invalidated by replay or re-parenting. A stale node
cannot verify or land; inventory and child landings continue while it collects.

Restack and reconcile publication reject tracked modifications with the existing
clean-worktree error. Nonignored untracked files do not block publication and
remain unpublished and untouched; each publication that encounters them records
a path-bearing `observation.recorded` followup, deduplicated by operation,
transaction, candidate SHA and exact path list on recovery. The phase-terminal
D5 clean-worktree rule for `ab done` remains unchanged.

Before replacement the kernel publishes retained tips, displaced heads and the
temporary change under immutable exact archive refs. `restack.*` facts record
preparation, replay, intent, archived replacement, contention and completion.
Unpublished request/loss records alone cannot preserve objects from a released
sandbox. The forge is authoritative for publication: after a push or on recovery,
its branch head must equal the intended SHA before completion. Local refs are
caches refreshed without an expected-old guard after confirmation; checkout files
are untouched. Local-git's shared database is the forge and retains authoritative
CAS. Remote publication uses exact expected-head leases and durable reservations; contention retains evidence
and retries without overwriting another writer. An overtaken successful guarded
write can retain its factual receipt, but unconfirmed candidate ancestry cannot
prove a write or promote a base. Contribution ownership uses recorded boundaries,
stable build identities and confirmed foreign rewrite aliases, never a merge-base
against the current destination. Remote guests park for trusted
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
Inventory retains its sampled source boundary even while the confirmed parent
boundary stays unchanged. It exposes source identities, hand-pushed changes (node-owned foreign commits), active operation,
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

Native cancellation receipts are candidate- and operation-specific. Publication
retries confirm forge state before reusing a receipt; external re-enables require
another confirmed cancellation. Classified transient landing failures retain
retry eligibility and recheck authorization after repository forge cooldown.
