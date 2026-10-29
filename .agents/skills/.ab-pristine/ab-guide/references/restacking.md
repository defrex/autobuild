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

Destination heads come only from the authoritative forge branch; dispatcher-host
refs are never a fallback. Failed remote reads retain the accepted observation;
classified rate limits use repository forge degradation and cooldown. Changed
heads require immutable commit ancestry proof against the accepted target and
the destination base already used by replay. Missing capability or failed proof
defers new replay. A non-descendant without kernel lineage records
`target.rewritten` with branch,
previous SHA and observed SHA, retains the accepted target, and raises watch/wait
attention. Repeated rewrite pairs are deduplicated. Returning to a safe target
clears attention (`target.rewrite-cleared` when the accepted tip is unchanged).
Upstream force-pushes are never adopted automatically. Accepted node reparenting
starts a new branch scope; frozen transactions recover their retained inputs.

Kernel restacks of a node are admitted through durable guarded publication
receipts, not treated as external force-pushes. The dispatcher walks an index
keyed by node and previous head, at most 64 receipt lookups from each child
baseline; cost is capped independently of journal length or total receipts.
Exact links use point lookups. When forward child landings separate restacks,
the dispatcher walks backwards from the latest publication with an indexed
previous-receipt cursor. Every gap requires immutable ancestry from the earlier
published head to the later receipt's previous head, as do the baseline and tip
ends of the proof. Missing links never imply rewrite authority.
The proven receipts travel in `target.moved.lineage`; build-scoped runners use
that recorded proof without reading another build. Clearing attention for an
unchanged accepted SHA retains newly proven lineage in `target.rewrite-cleared`.
Missing receipts or a gap
over 64 still record `target.rewritten` and raise attention. Each hop makes at
most two immutable ancestry comparisons. The exact walk and gap recovery share
the same 64-read cap, including unsuccessful lookups. Unchanged accepted
polls read no receipts or event rows.


Accepted destination observations are durable `target.moved` facts, including while an
agent runs. Verify-entry restack freezes a current base before verification;
path selection excludes upstream-only paths. After finalize and post-steps,
waiting leaves restack when the target moves. Node-target finalize contributions
are canonicalized before guarded merge even when the target SHA is unchanged.
Clean replay starts no agent. A clean waiting leaf rewrite preserves completed
verification when build-owned config is unchanged, even when replay replaces
the pin commit's ancestry. Reports retain their actual cycle base/head.
Changed config still starts a fresh verification cycle while waiting. Before
running further verification steps, cycles also require known pin ancestry;
a future cycle captures fresh config from its checkout. Configuration
supersession is separate from replay and reconcile. Conflicted replay runs
reconcile and verification, and initial verification cannot be skipped through
post-reconcile policy.

Nodes observe parent movement durably but restack only on demand: before a
complete nonempty node verifies; before merge if its parent moved; when queued
dependency presence requires an ancestor change; on `ab restack <node>`; or on
accepted re-parenting. There is no eager mode or cadence option. Nested nodes
need their own demand. Existing frozen transactions, including ones reserved
before upgrade, finish first; later demand coalesces onto the latest parent.
Leaves keep verify-entry and awaiting-merge restacks for every target.

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

Both dashboards use `+N` beside the destination for commits it has that the
build lacks, no suffix when current, and `+?` when unknown. Merged and closed
builds omit the suffix. Terminal list rows put `→ destination +N` on the slug
line; work steps follow immediately and integration progress keeps only the
bar and child counts. Detail target/Parent fields use the same suffix.

Work distance counts destination commits absent from the sampled current build
head (`BUILD..TARGET`). It is advisory durable telemetry refreshed during normal
target polls, including when the build head changes. Unavailable or stale samples
are unknown; this observation does not change merge or restack decisions.

Integration parent distance counts commits reachable from the observed parent
but not the last confirmed contribution base; it is not elapsed time or poll
count. Samples are invalidated by replay or re-parenting. This freshness gate
applies to nodes: a stale node cannot verify or merge; inventory and child merges
continue while it collects.

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
child merges. Reservations freeze expected head, parent, contribution boundary,
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

See [integration trees](integration-tree.md), [merge](merge-policy.md), and
[migration](migration-1.0.md).

Native cancellation receipts are candidate- and operation-specific. Publication
retries confirm forge state before reusing a receipt; external re-enables require
another confirmed cancellation. Classified transient merge failures retain
retry eligibility and recheck authorization after repository forge cooldown.

## Leaf publication retry recovery

Leaf restack and reconcile publication retry classified transient forge or transport
failures six times after the initial attempt, waiting 30, 60, 120, 240, 300 and
300 seconds. `publication.retry-scheduled` records the operation, frozen rewrite
identity, episode anchor, failure ordinal, last error and absolute retry time;
restart resumes that schedule without rerunning the resolver. These retries do
not consume `maxPhaseAttempts`. A seventh transient failure records
`publication.retry-exhausted` and raises `publication-retry-limit`, naming the last
error and six retries. Answering that escalation opens a fresh publication episode
for the same retained intent without resetting agent phase failures. Pending
publication keeps its workspace through backoff and unresolved exhaustion.
Classified rate limits retain repository cooldown and consume no publication
retry allowance. Rejected pushes, lease conflicts, dirty trees and unclassified
errors retain their existing behavior.

## Ticket preparation before build creation

Before claiming, the dispatcher journals a repository-scoped preparation intent;
a won claim and the exact selected creation slug are durable boundaries. Caught
asset-copy, spec-authoring, naming, and build-creation failures return the ticket
to configured Ready; a nonconforming spec goes to configured Triage. Recovery
checks the exact selected build first: a matching record and atomic
`build.created` retain ownership even if creation threw after committing.
Unavailable or conflicting readback never authorizes release or a replacement
build. Pending attempts retain the original failure, latest recovery error and
retry deadline in the canonical repository reduced value; resolved attempts
leave that value. Under repository ownership, each tick admits at most eight
due recovery attempts, before intake and independently of capacity or intake
settings, with a 30-second durable retry delay after recovery failure. Unresolved
ticket identities remain withheld. An uncertain claim outcome or unrelated
external ticket state, missing ticket/state, or conflicting slug ownership terminates
automatic recovery with an `abandoned` resolution and diagnostic reason. The
ticket is left unchanged; an operator can leave it finished or cancelled, or
inspect ownership and explicitly return it to Ready for another attempt. These
cases stop provider polling and diagnostic appends. Recovery failures are
reported without preventing janitor, lease sweep, or other dispatch recovery.
This is not general process
crash recovery. Confirmed Ready/Triage transitions settle idempotently, so a
failed bounce comment does not return an invalid ticket to Ready.

Once a build is established, ordinary interrupted-dispatch recovery completes
its missing boundaries; preparation cleanup cannot release its claim.
