# RFC 0002 — Integration-tree hardening (1.0 beta revision)

**Status:** proposed, 2026-10-20.

**Hat:** product. Every change proposed here ships to every user. Improvements
specific to how this repository runs Autobuild on itself are listed at the end
and are filed separately; they are not part of this proposal.

**Version:** a revision inside the 1.0 beta. It amends decided sections that
[RFC 0001](0001-integration-tree.md) introduced, most visibly the cascade
cadence (RFC 0001 §6.3–6.4 and question 4), before 1.0 leaves beta. Nothing
here changes the tree's ontology: nodes are tickets, builds are leaves, one
identity-carrying commit per build, declarative landing policy.

## 1. Problem

The first real use of the integration tree was the 1.0 website node (AUT-837,
seven children). It ran alongside root-targeted work on 2026-10-19 and 2026-10-20.
Its contributions landed, but the run took far more operator intervention,
tokens and GitHub API budget than the same work would have on the 0.x model.
The failures were not random. Each one is a place where the system still
assumes that branches are short-lived and only ever move forward from `main`.
A node branch breaks both assumptions. It lives for days, and the kernel
rewrites it whenever its parent moves.

Observed, in order of cost:

1. **Eager cascade multiplies conflict work.** Every movement of `main`
   replayed all of the node's contributions onto the new parent. Each
   contribution that conflicted cost one reconcile agent session. In this
   repository every build appended to `CHANGELOG.md`, so every contribution
   conflicted. A single parent move cost five reconcile sessions of about 1M
   input tokens each, for no semantic conflict. The node's leaves were also
   re-verified after every cascade, and one of them (AUT-841) exhausted its
   verify budget after a single real failure.
2. **A retry loop with a forge side effect ran unseen for fifteen hours.** A
   node publication failed at its final local-ref step on every dispatcher
   tick. Before failing, each attempt disabled native auto-merge on the node's
   PR. That made 1,139 `landing.native-applied` events and three GitHub API
   calls per minute. Nothing reached `ab watch`. The failure was visible only
   in per-tick janitor diagnostics, so the node sat stuck from 22:44 until an
   operator happened to read the store.
3. **GitHub rate limiting silently stranded a ready leaf.** The burned API
   budget made a native auto-merge application fail with a rate-limit error.
   The kernel recorded an observation and never retried, so a fully verified,
   policy-approved build (AUT-855) sat for eight hours.
4. **Ancestry assumptions broke under rewritten destinations.** Two separate
   bugs had the same shape:
   - The build-owned review range was computed by merge-base against a
     destination that had since been cascade-rewritten. The range then
     covered sibling builds' work, and a verifier rejected that work as out of
     scope (fixed in #661).
   - The node publication acknowledged success by compare-and-swapping a
     local branch ref from an expected old head. The ref had been recreated
     at a different commit, so the swap could never succeed, although the
     forge already held the intended head.
5. **Mixed versions fail closed on a shared store.** A process reading
   reductions that a newer version wrote rejects them (`invalid persisted
   value for buildReadFacts`) and stops working entirely. That process can be
   a dispatcher, an operator CLI or an agent CLI. It happened twice:
   - A dispatcher started before a merge could not read logs that newer
     runners had written, so every tick failed.
   - After a restart, newer runners wrote facts that older agent processes
     could not read, so every phase failed with "no terminal".

   Long-lived node branches make mixed versions routine rather than rare. Any
   adopter hits the same failure when the store is shared during an upgrade,
   or when a hosted service runs a minor version ahead of its clients.

**Decided addition — integration-capacity-priority (2026-10-20).** At capacity
5, two unrelated runners and three blocked website-node children starved the
node's answered reconcile from 14:36:22 through at least 14:51 UTC. Node reconcile
and verification now take admission priority over new claims and exclude their
own blocked or paused descendants from candidate occupancy. Unrelated load
continues to limit admission. Effective capacity displays explain borrowed
slots; ordinary ticket admission never uses the expanded display limit. This
addition does not decide or ship the other proposals in this RFC.

## 2. Summary of the proposal

Five changes:

1. **Lazy cascade.** A node restacks onto its parent when something needs the
   node to be current, not whenever the parent moves (§3).
2. **Version-tolerant reads.** Older readers tolerate facts and reductions
   written by newer versions within the supported window. They recompute
   rather than reject, and refuse only operations that depend on what they
   cannot understand (§4).
3. **The forge is the source of truth for publication.** Acknowledgement
   compares the forge's state with the recorded intent. Local refs are a cache
   that is overwritten, never compared against. Every remaining ancestry or
   merge-base derivation of "this build's change" is replaced with change
   identity (§5).
4. **Side-effect discipline in background loops.** Forge mutations are
   idempotent against their durable receipts. Persistent per-build failures
   back off and become attention events. Forge rate limiting becomes a
   repository-level degradation with an honored reset (§6).
5. **Budgets measure failures, not churn.** A verify or reconcile cycle that a
   parent movement started does not consume the budget meant to stop a build
   that keeps failing (§7).

## 3. Lazy cascade

### 3.1 Decision being revised

RFC 0001 §6.3 had integration builds restack "whenever the parent moves".
Question 4 settled the cadence as "eager, coalesced after the active
transaction, with no new throttle or completeness deferral." Coalescing bounds
storms during one transaction. It does not bound the total. Cost grows with
*contributions × parent movements*, and a node's contributions grow while it
waits for its last children.

### 3.2 Proposal

A node branch stays on the parent head it last restacked onto until one of
these **demand points**:

1. **Node verification.** Before a complete node verifies, it restacks onto
   its parent's current head. This is unchanged in effect, because RFC 0001
   §6.5 already requires a node to verify the exact head it is about to land.
2. **Landing.** If the parent moved after verification, the node restacks and
   verifies again before it lands, as today.
3. **Presence demand.** A queued build targeting the node (or a descendant)
   may be blocked by a build whose change has reached the node's parent but not
   the node. The kernel then restacks the node so the blocker can become
   present. Without this, lazy cascade would deadlock cross-node dependencies,
   which RFC 0001 §9 resolves by presence.
4. **Operator request.** `ab restack <node>` and the matching operator tool
   restack a node now. It is useful before reviewing a node's preview against
   current `main`.
5. **Re-parenting.** Unchanged: moving a node replays onto its new parent.

Restacks caused by demand still coalesce exactly as today. Nested nodes follow
the same rule: a child node restacks onto its parent node only at its own
demand points. A demanded restack of a parent does not cascade into its
children unless they also have a demand.

**Leaves are unaffected.** Leaves restack at verify entry and while awaiting
landing (RFC 0001 §6.3) onto their *target's* head. For a leaf targeting a
node, that head moves only when siblings land, which costs one cheap
single-commit replay each. Leaves targeting the root behave exactly as in 0.x.

### 3.3 Consequences

- **Conflicts with the parent surface later and together.** A node that sat
  for a week meets a week of upstream change in one restack. The total
  conflict work is never more than eager cascade's and is usually much less,
  because intermediate parent states are skipped entirely. The node's
  reconcile resolves against the final parent state once, instead of against
  every intermediate one.
- **Children build against a stale parent.** Work inside a node no longer
  sees upstream fixes until the node restacks. A child that needs an upstream
  change declares it as a blocker, and presence demand (§3.2, item 3)
  delivers it. An operator who wants it anyway uses `ab restack`.
- **The node's PR may show as behind or conflicting on the forge between
  demand points.** That is accurate, and harmless, because a node never
  lands without restacking and verifying first.
- **No configuration option.** Lazy is the only behavior. An eager option
  would keep both code paths alive for a cadence nobody has shown a need
  for. If a need appears, a later RFC can add a staleness bound as a demand
  point.

### 3.4 Alternatives considered

- **Debounced eager cascade** (at most one cascade per window). It bounds the
  rate but not the total, and adds a timing knob with no principled value.
- **Squashing the node's contributions into one commit at cascade time.**
  It makes conflicts cheaper, but gives up per-build identity on the node
  branch, which presence-based blockers and the paper trail depend on.
- **A deterministic resolution tier for known add-only files.** It fixes the
  changelog case specifically, but the product cannot know which files are
  add-only. The recommendation instead goes into the `ab-guide` setup
  reference: per-build changelog fragments over a shared append-only file.
  That is the pattern that removed the conflict in this repository (AUT-860).

## 4. Version-tolerant reads

### 4.1 Rule

Within the supported client window, **a reader never fails because a writer
was newer**:

- **Unknown event types** in a build or repository log are skipped by
  reducers that do not know them. They are kept in raw event reads and counted
  in the reduction as "facts from a newer version".
- **A persisted reduction whose reducer version the reader does not recognize
  is not an error.** The reader recomputes the reduction from events with its
  own reducer, using the store's existing incremental fold or snapshot
  machinery, and does not overwrite the newer persisted value. This applies
  to local stores, the Postgres store and the hosted service alike.
- **A reader refuses only operations whose correctness depends on what it
  skipped.** When a build's reduction counts newer facts of a kind the reader
  cannot interpret, the reader may still display the build and answer
  read-only queries. Kernel decisions that could contradict those facts are
  deferred, with a diagnostic naming the newer version: claiming, phase
  routing, landing and publication. Event catalog entries carry this
  classification. A new event type is *advisory*, which older readers can
  safely ignore, or *decisive*, which defers older writers' decisions for
  that build.

### 4.2 What this guarantees

- An operator CLI upgraded ahead of the dispatcher keeps working, and so does
  the reverse.
- A dispatcher keeps ticking across merges that add event types. Builds that
  carry decisive newer facts are deferred with an attention record that says
  "restart the dispatcher on version X". The repository's other builds are
  unaffected.
- A hosted service one minor version ahead of a client serves it without
  read failures, which the compatibility window already promises at the
  protocol level.

### 4.3 What it does not change

Writes stay strictly validated: a writer never records a field or type its own
catalog does not define. Reading known types becomes tolerant only of fields a
newer catalog added (§10, question 4). A known field with an invalid value is
still an error. Persisted values a reader *does* recognize are still validated,
and an invalid one is still an error.

## 5. The forge is the source of truth for publication

### 5.1 Publication acknowledgement

Every kernel publication records intent before its effect: node rewrites,
leaf restacks, reconcile publications, and implement and finalize pushes.
This proposal changes how a publication is *acknowledged*:

- After the push, or on recovery, the kernel reads the remote branch head
  from the forge. If it equals the intended head, the publication succeeded.
- Local branch refs in the dispatcher's repository or in workspaces are then
  set to the published head unconditionally. They are caches, never
  compare-and-swap guards. The guard against a concurrent writer is the
  forge-side lease (`--force-with-lease` on the recorded expected head) and
  the durable writer reservation, both of which already exist.
- If the remote head is neither the expected old head nor the intended head,
  the publication is contended. That is handled as today.

### 5.2 Change identity over ancestry

A full audit replaces every remaining derivation of "this build's change",
"this node's contributions" or "this build's base" from merge-base or
ancestry. The replacement is the identity trailer plus the recorded
rewrite facts. This repairs the review-range class of bug for good (#661 fixed
one instance) and covers anything else that compares SHAs across a rewrite.
The audit lists every ancestry use it keeps, with the reason ancestry is
correct there.

## 6. Side-effect discipline in background loops

### 6.1 Idempotent forge mutations

A forge mutation whose durable receipt already records the desired state for
the current candidate is not repeated. If the forge confirms it, only an
observation is refreshed. "Disable native auto-merge before publishing" is the
motivating case: one receipt per candidate and publication attempt, not one
per tick.

### 6.2 Persistent janitor failures

A per-build janitor failure that recurs on consecutive ticks:

- backs off per build, exponentially, capped at a few minutes, with the timing
  persisted so a restart does not reset it;
- after a threshold (proposed: ten minutes of consecutive failure), raises a
  build attention record, `build.janitor-failing`, carrying the failure
  message. `ab watch` reports it by default, the dashboards show it on the
  build's row, and it clears when an attempt succeeds.

### 6.3 Forge rate limiting

A forge error classified as rate limiting (GitHub primary and secondary limits
included) puts the repository into **forge degradation**, with the provider's
reset time. Ticket-source degradation already works this way. While degraded,
forge-dependent work waits until the reset instead of failing and retrying per
build. Forge degradation is reported through repository status and the
existing degradation-past-reset attention rule. **Every landing application
that failed during degradation is retried after recovery.** A verified,
approved build is never left waiting on a one-shot failure.

### 6.4 Request budgets

Per-tick forge request counts become part of tick telemetry, alongside the
store request counts from the request-reduction work. A build that drives more
than its share is named in repository status. This makes the next loop of
§6.1's kind diagnosable from `ab repository status` instead of from GitHub's
rate-limit page.

## 7. Budgets measure failures, not churn

- **Verify attempts** (`policy.maxVerifyAttempts`) count verify cycles that
  *failed*. A cycle started because the target moved (a restack at verify
  entry, a cascade or a reconcile) does not consume an attempt unless it
  fails. A failure after a restack consumes one, as today.
- **Phase attempts** (`policy.maxPhaseAttempts`) are not consumed by sessions
  that failed for an infrastructure reason the kernel can classify. That
  includes a session deferred under §4.1, and a session that could not read
  its own build. Those are deferrals with diagnostics, not phase failures.
- Reconcile budgets are unchanged.

## 8. Operator surfaces

- `ab restack <node>` and an operator tool of the same shape (§3.2).
- `ab watch` default attention gains `build.janitor-failing` (§6.2), forge
  degradation (§6.3), and newer-version deferral (§4.1).
- `ab repository status` gains forge degradation and per-build forge request
  counts.
- The shared dashboard projection shows a node's staleness: how far its
  parent has moved since its last restack. It also shows the deferral and
  janitor-failing states. Both frontends use the same terms.

## 9. Migration and compatibility

- Lazy cascade applies to open nodes on upgrade. A node already mid-transaction
  finishes that transaction. After that, it restacks only on demand.
- §4 is the first version that tolerates newer writers. Readers older than it
  still fail closed. Upgrading every process that shares a store to this
  version restores the guarantee from then on.
- New event types introduced by this RFC are classified per §4.1, so mixed
  versions within the beta behave correctly as soon as the readers ship.
- The hosted service's protocol identity changes only if a wire shape
  changes. Reductions recomputed client-side need no protocol change.

## 10. Question dispositions

1. **Should lazy cascade be configurable?** Proposed no (§3.3). Revisit only
   with a demonstrated need, as a staleness demand point.
2. **Should presence demand restack the whole ancestor chain?** Proposed yes,
   only up to the node whose parent holds the blocker, and no further.
3. **Janitor-failing threshold and backoff cap.** Proposed ten minutes and
   five minutes. They are policy values, configurable like the other
   `policy.*` limits.
4. **Should advisory and decisive classification be per event type or per
   payload field?** Proposed per event type, because it is simpler to audit.
   Known event payloads are strict objects today, so an additive optional
   field written by a newer version is rejected by an older reader as well.
   §4's rule therefore also covers additive fields on known types. Older
   readers drop fields they do not know when reducing, and still validate
   the fields they do. A new field that would change a decision is
   introduced as a new decisive event type instead.

## 11. Delivery plan

Ordered so each step ships on its own, and so the riskiest behavior change
(lazy cascade) lands on top of the diagnostics that would reveal its mistakes.

1. **Version-tolerant reads** (§4). First, because every other ticket adds
   event types, and this one makes adding them safe.
2. **Forge degradation and side-effect discipline** (§6). Idempotent native
   landing receipts, janitor backoff and attention, rate-limit degradation
   with landing retry, and forge request telemetry.
3. **Forge-truth publication and the identity audit** (§5).
4. **Budgets measure failures** (§7).
5. **Lazy cascade** (§3, §8's `ab restack`), with SPEC, `docs/restacking.md`,
   `docs/integration-tree.md` and the migration reference updated. RFC 0001's
   question 4 disposition is amended.
6. **Integration capacity priority** (decided addition in §1): shared capacity
   projection, descendant-sensitive node admission, priority and effective-slot
   reporting, with starvation regression coverage.
7. **Guide recommendation** for per-build changelog fragments in the `ab-guide`
   setup reference (§3.4).

## 12. Not in this RFC: this repository's own setup

Filed separately as repository-configuration tickets:

- Agents in this repository run `bun bin/ab.ts` from their build's branch.
  That makes every long-lived node child run older CLI code than the runner.
  They should run the CLI of the checkout the runner itself came from, as
  consumer repositories already do through the distribution's agent bin.
- Restart discipline for the self-hosted dispatcher after kernel-changing
  merges, now that a clean stop suspends sessions (AUT-855).
- The `ab-` prefix on this repository's local changelog skill was removed by
  AUT-860.

## Evidence

- Website node AUT-837, 2026-10-19/20. Restack `node-restack-8fff44fe` used
  five reconcile sessions (1.31M, 1.14M, … input tokens), all for
  `CHANGELOG.md` Unreleased conflicts. Its publication then failed on
  `git update-ref … is at 67db79ed but expected e0e50ea0` every tick from
  22:44 to 13:52, with 1,139 `landing.native-applied {enabled:false}` events.
- AUT-855 (`native-session-resumption`): `landing.decided` at 23:43, then at
  04:48 "API rate limit exceeded", with no retry until an operator re-requested
  landing after a dispatcher restart.
- AUT-840 (`dispatcher-intake-motion`): review range `52d9452f..8c7528ad`
  after a node cascade. Fixed by #661 (AUT-850).
- AUT-841, AUT-863, AUT-840: `invalid persisted value for buildReadFacts`
  in agent sessions after newer runners wrote `session.native-handle-recorded`.
  Earlier, the dispatcher's own ticks failed the same way. During the
  integration-tree series, a runner crash loop (2026-10-18) had the same
  cause.
- AUT-841 exhausted `maxVerifyAttempts = 3` after verify attempts 1–3 passed
  and attempt 4 failed once, with cycles started by node restacks.
