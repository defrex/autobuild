# RFC 0006 — Lazy integration and merge strategies

**Status:** proposed, 2026-11-20, and revised the same day with the
maintainer's rulings on every open question (§11). Not decided design.
`SPEC.md` describes the running system until a ticket that builds a section
of this RFC amends it.

**Hat:** product. Configuration, restack timing, update and landing strategies,
forge capabilities, events, operator surfaces and `ab-guide` guidance ship to
every user. Adopting any new strategy in this repository's `autobuild.toml` is
separate repository configuration.

---

## 1. Problem

Autobuild currently implements one integration model everywhere: **eager linear
replay** (`SPEC.md` §15.7). Every settled leaf restacks whenever its target
branch moves, and every integration node replays its child commits one by one
onto the moved parent so the node lands as a linear stack.

That model gives clean, linear history, but two failure modes compound when
merge throughput drops or integration stacks grow deep:

1. **Eager restack thrash across waiting leaves (#1005).**
   `landingRestackDue` (`packages/core/src/kernel/engine.ts`) triggers a
   restack on *every* settled leaf as soon as `main` moves. With N open PRs
   waiting behind slow CI or manual consent, every single merge rewrites the
   head of all N - 1 remaining PRs. Each rewrite cancels in-flight CI, forces
   a fresh CI run, invalidates human review diffs, and turns any file overlap
   into a conflict → agent reconcile → re-verification → fresh review loop.
   Under a 28-minute CI suite and ~20 open PRs, one measured hour of two CI
   runners produced one mergeable result while the rest went to invalidated
   runs, and 47 ready PRs dropped out of merge passes in a single day (#1005).
2. **Commit-by-commit conflict amplification on deep integration nodes.**
   Unlike a leaf — which collapses its net contribution into one commit before
   replaying (`SPEC.md` §15.7) — an integration node preserves each child's
   individual `Autobuild-Build:` commit in a linear range
   (`packages/core/src/kernel/integration-stack.ts`) so GitHub's rebase-merge
   or local fast-forward lands every child commit onto `main`. When `main`
   changes something that conflicts with an early commit in a deep node stack
   (for example 8–20 children), sequential per-item replay
   (`packages/core/src/kernel/node-restack.ts`) can hit the same conflict
   again on each subsequent child commit — burning repeated agent reconcile
   sessions resolving the same conflict one commit at a time.
3. **Rigid branch-update and landing topology.**
   Today, root leaves always replay + squash-merge, root nodes always replay +
   linear-stack rebase-merge (or local fast-forward), and there is no way for
   a repository to trade a strictly linear intermediate branch for faster
   single-pass conflict resolution, fewer force-pushes on open PRs, or
   squash/merge-commit landing for nodes (such as optimization nodes whose
   hill-climb attempts do not each need to appear as separate commits on
   `main`).

Declared generated-file regeneration (`AUT-1266` / #1002) and open-PR
backpressure (`AUT-1288` / #1004) reduce the frequency of these storms, but
neither addresses the underlying O(N²) eager-restack amplification or the
O(K) per-commit conflict cost on a K-child node.

---

## 2. Goal and summary

Separate two orthogonal decisions that Autobuild currently conflates:

1. **When** a waiting branch updates against its moved target (**restack
   timing**):
   - **`eager`** (default, today's behavior): update as soon as the target
     branch moves.
   - **`on-landing`** (lazy): hold a waiting branch on its verified head while
     it waits for consent, hold, or its turn to land. Update only when it holds
     the destination's **landing turn** (or when an operator explicitly runs
     `ab restack`), serializing landings per destination so N consented PRs
     do not thundering-herd each other (§5).
2. **How** a branch absorbs upstream changes and lands on its destination
   (**update strategy** and **landing strategy**):
   - **`update = "replay"`** (default, today's behavior): collapse-and-replay
     for leaves; item-by-item linear replay for nodes.
   - **`update = "merge"`** (opt-in): merge the moved parent into the branch
     with a single 3-way merge commit (`git merge --no-ff <parent>`). Conflicts
     against `main` are resolved **once** against the net tree instead of once
     per child commit, and leaf PRs stop force-pushing during review (§6.2).
   - **`land = "squash" | "rebase" | "merge"`**: explicit landing method
     validated against `update` at config parse time. A branch updated via
     `merge` cannot land via linear `rebase`/fast-forward; it lands via
     `squash` (one clean commit carrying all contributing build identities and
     issue links) or `merge` (one merge commit preserving child commits on the
     second parent) (§6.3).

Defaults remain identical to today (`eager`, `replay`, `squash` for leaves,
`rebase` for nodes). Existing repositories see zero behavior change until they
opt in.

---

## 3. Ontology

| Term | Meaning |
|---|---|
| Restack timing | Policy deciding *when* a settled build updates onto a moved target: `eager` or `on-landing`. |
| Landing turn | Exclusive (or bounded) per-destination admission slot under `on-landing` that lets one authorized build update, pass required checks, and land before the next authorized build updates. |
| Update strategy | Git mechanism used to incorporate a moved parent into a build branch: `replay` (linear rewrite) or `merge` (parent sync merge commit). |
| Landing strategy | Forge mechanism used to land a verified branch into its destination: `squash`, `rebase` (linear stack / fast-forward), or `merge` (merge commit). |
| Sync merge commit | A kernel-created merge commit whose first parent is the branch's prior head and second parent is the sampled destination SHA (`parents = [oldHead, parent]`), carrying a durable sync marker so provenance distinguishes it from foreign merges. |
| Provenance set | The set of contributing child build identities and verified `handPushedCommits` owned by a node relative to its synced parent (`parent..head`). |

---

## 4. Configuration

Configuration must reject impossible combinations (such as `update = "merge"`
with `land = "rebase"`) at config validation time, never mid-landing.

Per maintainer ruling (§11, Decision 1), `restack`, `update`, and `land` live
directly on `[[merge]]` rules (which already select by `from = "leaf" |
"node"`, `paths`, `within`, and live-reload as dispatcher policy per
`SPEC.md` §16.1):

```toml
# Example A: lazy leaves (no force-push, squash to main) + fast merge-updated nodes
[[merge]]
from = "leaf"
mode = "consent"
restack = "on-landing"     # "eager" (default) | "on-landing"
update = "merge"           # "replay" (default) | "merge"
land = "squash"            # leaf default: "squash"; also "merge"

[[merge]]
from = "node"
mode = "auto"
restack = "on-landing"     # update only on presence demand, ab restack, or landing turn
update = "merge"           # resolve conflicts once against main instead of per-child
land = "squash"            # "rebase" (default for replay) | "squash" (default for merge) | "merge"
```

### 4.1 Compatibility matrix

Config validation enforces the Git-topology invariants up front:

| Target kind | `update` | Valid `land` values | Default `land` |
|---|---|---|---|
| Leaf → root | `replay` | `squash`, `merge` | `squash` |
| Leaf → root | `merge` | `squash`, `merge` | `squash` |
| Node → root | `replay` | `rebase`, `squash`, `merge` | `rebase` |
| Node → root | `merge` | `squash`, `merge` | `squash` |
| Child → node | `replay` | `fast-forward` (unchanged) | `fast-forward` |

`update = "merge"` paired with `land = "rebase"` is a **parse-time error**
explaining that merge commits cannot be rebased linearly onto the destination.

### 4.2 Forge capability preflight

At startup and `ab init --validate`, the forge adapter checks whether the
configured landing strategy is compatible with repository settings where
observable:

- `land = "rebase"` requires linear-stack / rebase-merge (or `local-git`
  fast-forward) as today.
- `land = "squash"` requires squash merging enabled on GitHub (already
  required for leaves).
- `land = "merge"` requires merge commits enabled on GitHub and conflicts with
  GitHub's "Require linear history" branch protection rule (reported clearly
  in readiness diagnostics and landing refusal).

### 4.3 Live vs. pinned semantics

Following `SPEC.md` §16.1, `[[merge]]` policy — including `restack`, `update`,
and `land` — is **live dispatcher configuration**, evaluated at decision
boundaries rather than frozen at claim time. Switching an in-flight repository
from `eager` to `on-landing` takes effect immediately on the next tick without
restarting builds.

Switching `update` from `merge` back to `replay` on an already-synced branch
that already contains sync merge commits is handled safely: once a branch has
recorded a kernel sync merge commit, its landing strategy must remain
non-`rebase` (`squash` or `merge`) until it lands or is rebuilt (never silently
attempting a linear rebase over a merge commit).

---

## 5. Lazy integration (`restack = "on-landing"`)

### 5.1 Waiting leaves stay still

Under `restack = "on-landing"`:

- `target.moved` still records the latest observed destination SHA and branch
  distance (`behind N commits`) for visibility, using existing bounded reads.
- `landingRestackDue` (`packages/core/src/kernel/engine.ts`) returns `false`
  for a settled root leaf until the leaf is **due to update**:
  1. It holds the destination's **landing turn** (§5.2) and its head is behind
     the current destination SHA, **or**
  2. An operator explicitly ran `ab restack <slug>`, **or**
  3. The forge reports an actual `pr.conflicted` on the PR *and* the build is
     not explicitly held (`ab hold`) (§11, Decision 2).
- While a non-conflicting PR waits for consent, is held by an operator, or is
  queued behind an earlier landing turn, its head SHA **does not move**.
  In-flight CI runs finish undisturbed, reviewers inspect a stable head, and
  head-bound consent (`AUT-1204`) stays valid. Genuinely conflicted (unheld)
  PRs reconcile proactively so reviewers see mergeable, verified code and
  consent leads straight to a clean merge.

### 5.2 Serialized landing turn (lightweight merge queue)

Without serialization, switching 10 consented PRs to `on-landing` would still
cause all 10 to restack onto `main` at the same instant, race CI, land 1, and
invalidate the other 9.

To prevent that thundering herd, `on-landing` introduces a deterministic
**landing turn** per destination branch (fixed at `1` active turn per
destination in v1; §11, Decision 6):

1. **Eligibility.** A settled build is eligible for the destination's landing
   turn when `landingAuthorized(state.landing)` holds (either `mode = "auto"`
   with no active hold, or explicit `ab merge` consent for the current
   verified head) and it is not paused, escalated, aborted, or discarded.
2. **Selection order.**
   1. `urgent` builds first (`AUT-1290`), then `normal`.
   2. Within the same priority, earliest authorization sequence (FIFO by
      `landing.decided` / `build.land-requested` seq), so builds land
      predictably without starvation.
   3. Optional fast path: if an eligible build is *already* up to date with
      `main` and clear to merge, prefer it so zero-work merges drain
      immediately.
3. **Turn lifecycle.**
   - While holding the turn: if behind `main`, the build updates onto current
     `main` using its configured `update` strategy (`replay` or `merge`).
   - If the update is **clean** (or resolved solely by `[[generated]]`
     regeneration), existing verification and merge consent survive (matching
     `SPEC.md` §15.7 and `AUT-1204`), and the janitor waits for required forge
     checks on the updated head and lands the PR.
   - If the update **conflicts** and requires agent reconciliation (or if
     reconcile edits protected paths and revokes consent per `AUT-1205`), or
     if forge CI turns red (`AUT-1291`), or if an operator runs `ab hold`,
     `ab pause`, `ab reopen` (`AUT-1289`), or `ab abort`, the build **yields
     the landing turn immediately** so the next eligible build advances
     without waiting behind a stalled PR.
   - Once the PR merges (or closes), the turn releases on the same tick and
     passes to the next eligible build.
4. **Interaction with GitHub's native merge queue.**
   When the destination branch has a GitHub merge queue enabled, GitHub itself
   serializes rebase/merge + CI batching. Under `on-landing`, an authorized
   build does not need to restack onto `main` locally before arming native
   auto-merge / entering GitHub's merge queue (unless GitHub requires an
   up-to-date branch before queue entry or reports a conflict).

### 5.3 Lazy integration for nodes

Nodes already use demand-driven restacking (`nodeRestackDemand` in
`packages/core/src/kernel/node-restack-demand.ts`): a collecting node stays on
its opening base until a dependent requires presence, an operator runs
`ab restack`, or the node becomes complete.

Under `restack = "on-landing"` on a node:

- Becoming complete triggers verification on the node's current parent (so the
  operator can review a verified node without waiting for `main` to stop
  moving), or updates once before final verification if behind — see §11.
- Once verified and awaiting consent, the node **does not re-restack and
  re-run full node verification on every `main` move**. It updates onto
  current `main` only when it takes the landing turn (after consent / auto
  authorization) or when an operator runs `ab restack`.

### 5.4 Consent survival and safety

Head-bound consent (`AUT-1204`) and protected-path revocation (`AUT-1205`)
must not be weakened by `on-landing`:

- When an operator consents to head `H` (which is behind `main`) via
  `ab merge <slug> --head H`, consent binds to `H`.
- When the build takes its landing turn and performs a **clean** update
  `H → H'` onto `main` (zero conflict resolution, zero agent edits), consent
  carries cleanly to `H'` exactly as `SPEC.md` §15.7 already allows for clean
  eager restacks.
- Any conflict requiring an agent reconcile creates a reconciled resolution
  diff: protected-path rules (`AUT-1205`) revoke consent if protected files
  were touched, and repositories may optionally require re-consent after any
  conflict resolution.

---

## 6. Merge-commit updates and landing strategies

### 6.1 Why deep nodes pay an O(K) penalty under `replay`

Today's node restack (`packages/core/src/kernel/node-restack.ts`) freezes
`oldBase..oldHead` as an ordered list of K child commits and calls
`replayNodeChange` one commit at a time onto `parent`. If `main` refactored a
symbol or edited a shared file touched by children 1, 3, 5, and 8:

- Child 1 conflicts → agent reconcile session #1.
- Child 3 conflicts on the same region because child 3's original patch was
  written against `oldBase` → agent reconcile session #2.
- Children 5 and 8 repeat the same conflict → sessions #3 and #4.

Each reconcile costs workspace/session startup, context loading, edits, and
conflict verification. By contrast, the node's *tip* `oldHead` already
represents the composed, self-consistent result of all K children. A single
3-way merge between `oldHead` and `parent` (with merge base `oldBase`)
resolves the net conflict **once**.

### 6.2 Merge-commit update (`update = "merge"`)

#### On an integration node

When a node configured with `update = "merge"` needs to incorporate a moved
`parent`:

1. **Preflight & archive.** Archive `oldHead` and `parent` under
   `refs/autobuild/archive/<slug>/<sha>` as today, and check whether `parent`
   is already an ancestor of `oldHead` (no-op).
2. **Single 3-way merge.** In the kernel worktree, run a detached merge of
   `parent` into `oldHead` (`git merge --no-ff --no-commit <parent>`).
   - **Clean merge:** commit with parents `[oldHead, parent]`, deterministic
     subject (`Merge <parentBranch> (<shortSha>) into node <slug>`), and a
     kernel sync trailer `Autobuild-Sync: <parentSha>`. Publish to the node
     branch with compare-and-swap, advance `contributionBase` /
     `syncedParent` to `parent`, and record `node.sync-merged` (clean). Zero
     child commits are rewritten.
   - **Conflicted merge:**
     - First run declared `[[generated]]` regeneration (`AUT-1266`) if every
       conflicted path matches a generated rule. If regeneration resolves the
       conflict cleanly, commit the sync merge commit with zero agent
       session!
     - Otherwise, launch **one** reconcile agent session on the conflicted
       merge state (giving the agent the node's charter, child contribution
       summaries, and conflict files). The agent resolves the conflicts once
       and finishes via `ab done`; the kernel commits the resolved merge
       commit with parents `[oldHead, parent]` and trailer
       `Autobuild-Sync: <parentSha>`, then runs node verification on the
       resulting head.
3. **Provenance & `verifyDiffBase` invariants.**
   Because `parent` is now an ancestor of `head`:
   - `git diff parent..head` (identical to `parent...head`) is the exact net
     diff of the node against `parent`.
   - `verifyDiffBase` (`AUT-1274`) is simply `parent` — every command and
     agent verifier sees the exact delta the node would introduce onto
     `parent`.
   - `collectNodeVerificationProvenance` (`node-verification-context.ts`)
     enumerates commits in `parent..head` excluding kernel sync merges:
     every child commit carrying `Autobuild-Build: <child>` and every
     maintainer `handPushedCommit` (from `AUT-1285`) remains uniquely
     reachable and attributed without double-counting any upstream commits
     pulled in through `parent`.
   - Child commits already merged upstream into `parent` (identified by
     `Autobuild-Build:` trailer or presence evidence) are automatically
     recognized as upstream — if `parent..head` has an empty tree diff
     (`head^{tree} == parent^{tree}`), the node settles cleanly without
     spurious verification (aligning with `AUT-1286`).

#### On a leaf build

When a leaf configured with `update = "merge"` needs to incorporate a moved
`main`:

- Instead of collapsing the leaf into a rewritten single commit and
  force-pushing, the kernel runs a 3-way merge of `main` into the leaf's
  `head` (`parents = [oldHead, main]`, trailer `Autobuild-Sync: <mainSha>`).
- **Clean merge** pushes fast-forward to the PR branch — **no force-push**,
  preserving GitHub inline review comment anchors and commit-by-commit PR
  review progress.
- **Conflicted merge** runs `[[generated]]` regeneration first, then at most
  one reconcile session if needed, committing a resolved merge commit
  (fast-forward push, still no force-push).
- `verifyDiffBase` and `head.paths-recorded` use `main..head`, which equals
  the leaf's exact net diff against `main`.

### 6.3 Landing strategies (`land = "squash" | "rebase" | "merge"`)

#### `land = "rebase"` (existing node default)

Unchanged from today (`mergeLinearStack` on GitHub, guarded fast-forward on
`local-git`), plus `AUT-1285` support for verified `handPushedCommits`.
Allowed only with `update = "replay"`.

#### `land = "squash"` (existing leaf default; **new for nodes**)

- **Leaf → root:** unchanged from today.
- **Node → root:**
  1. Verify `parent` is an ancestor of `head` (the verified head is up to date
     with the sampled destination tip) and that `head` matches the verified
     integration cycle.
  2. Compose the squash commit title and body from the node's PR title/body
     (respecting repository squash settings from `AUT-1216`), appending:
     - All combined `Closes #N` / `Refs #N` issue links (already computed by
       `nodeIssueLinksForForge`),
     - `Autobuild-Build: <nodeSlug>` plus one `Autobuild-Build: <childSlug>`
       trailer per contributing child build in `parent..head` (so downstream
       `observePresence` / `buildTrailers` recognizes every landed child build
       as present on `main`!).
  3. Execute a head-fenced REST squash merge (`PUT /pulls/:n/merge` with
     `merge_method: "squash"`, `sha: head`, `commit_title`, `commit_message`),
     or a guarded single-commit fast-forward squash on `local-git`.
     *Bonus:* works with GitHub native auto-merge (squash), GitHub merge
     queues, and GraphQL-blocked environments (`AUT-1216`, `AUT-1217`)!
  4. **Post-landing audit (`auditIntegrationLanding`):** verifies
     `verifiedHead^{tree} == landed^{tree}` (or that all expected child
     `Autobuild-Build:` trailers appear on `landed` when `main` moved
     concurrently and GitHub performed a clean merge-base squash).

#### `land = "merge"` (**new for nodes and leaves**)

- **Node → root (and optionally Leaf → root):**
  1. Verify `parent` is an ancestor of `head` and `head` matches the verified
     cycle.
  2. Update PR issue links as today, and execute a head-fenced REST merge
     commit (`PUT /pulls/:n/merge` with `merge_method: "merge"`, `sha: head`,
     carrying `Autobuild-Build: <slug>` in the merge commit message), or
     `git merge --no-ff` on `local-git`.
  3. On `main`, `--first-parent` history stays clean (one merge commit per
     node/leaf), while the second parent preserves every child commit and its
     `Autobuild-Build:` trailer intact.
  4. **Post-landing audit:** verifies tree parity and that every contributing
     child build identity in the verified cycle is reachable in
     `parent..landed` (excluding `parent` ancestry).

### 6.4 Linear-stack accelerator (`git rerere` / conflict memory)

For repositories whose GitHub branch protection enforces **"Require linear
history"** (which prohibits `land = "merge"` and may prefer `land = "rebase"`
over `land = "squash"` for nodes), `update = "merge"` cannot be used with
`land = "rebase"`.

A complementary optimization for `update = "replay"` on deep nodes is
**per-restack conflict resolution reuse**: enabling `git rerere` inside the
isolated node-restack worktree across the sequential items of one restack
transaction (seeded from each agent-resolved item's preimage/postimage before
moving to item i+1). That keeps strictly linear history while letting a
repeated conflict on the same hunk resolve deterministically on subsequent
commits without waking another agent reconcile session. Deferred to a follow-up
PR per §11 (Decision 5).

---

## 7. Interaction with existing subsystems

- **Verification & `verifyDiffBase` (`AUT-1274`):** Under `update = "merge"`,
  `parent` is an ancestor of `head`, so `git diff parent..head` is exact and
  `verifyDiffBase` requires no special-casing for command or agent verify
  steps.
- **Generated-file regeneration (`AUT-1266` / #1002):** Runs identically on a
  conflicted sync merge, resolving generated-only conflicts in one pass
  instead of once per child commit.
- **Head-bound consent & protected paths (`AUT-1204`, `AUT-1205`):** Clean
  updates (replay or merge) preserve consent; conflicted reconciles compute
  resolution paths against the synced parent and revoke protected-path consent
  identically.
- **Verified hand-pushed commits (`AUT-1285`):** Under `update = "merge"`,
  hand-pushed commits stay untouched in `parent..head` without needing replay,
  and land cleanly under both `land = "squash"` and `land = "merge"`.
- **Empty-range / post-landing cancellation (`AUT-1286`):** If a sync merge
  results in `head^{tree} == parent^{tree}` (all changes already upstream),
  no verification cycle is prepared.
- **Open-PR backpressure (`AUT-1288`) & red-CI surfacing (`AUT-1291`):**
  Complement `on-landing` directly — backpressure caps N, `on-landing`
  eliminates the N× CI invalidation storm, and red-CI surfacing +
  `ab reopen` (`AUT-1289`) recover PRs that fail CI after taking their turn.
- **Optimization nodes (`RFC 0005`):** An optimization node may land 10–30
  small winning attempts; pairing it with `update = "merge"` and
  `land = "squash"` avoids both deep replay conflicts and 30 micro-commits on
  `main`.
- **Forge port (`packages/core/src/ports/types.ts`):** Adds narrow optional
  landing methods (`mergeCommit` / node squash support on `Forge`, with
  `github` and `local-git` implementations passing shared contract tests) and
  keeps `mergeLinearStack` untouched.

---

## 8. Events and reducer impact

All new state is derived from small, typed events following `SPEC.md` §15 and
the reducer-revision ledger:

- **Landing turn (`on-landing`):**
  - `landing.turn-acquired { destination, head }` /
    `landing.turn-yielded { destination, reason }` on the build log (or
    computed deterministically from repository digest ordering + explicit
    holder lease on the repository log — avoiding churn when builds finish).
    Exact representation is chosen to guarantee **zero events while idle** and
    no duplicate turn assignment across hosted dispatcher invocations.
- **Merge-commit update (`update = "merge"`):**
  - `restack.synced { operation, parent, previousHead, head, method: "merge", conflicted: boolean }`
    (or extending existing `restack.completed` / `node.restack-completed` with
    `method: "replay" | "merge"` so existing selectors and dashboards reuse
    one code path).
- **Landing method:**
  - `integration.landed` and `pr.merged` record `method?: "rebase" | "squash" | "merge"`
    (optional for backward compatibility with historical events).

Reducer accumulator/shape changes follow `bun tools/reducer-revision.ts` and
preserve backward compatibility with all existing event logs.

---

## 9. Store read cost and forge budget

Per `AGENTS.md`, recurring read cost is a correctness property:

- **Store reads:** Zero new recurring store reads. Landing-turn selection and
  `landingRestackDue` evaluate purely from existing reduced repository/build
  facts already held in the dispatcher tick (`O(active builds)` in memory;
  zero event-row reads while idle). Existing in-memory read-budget harnesses
  under `packages/core/src/testing/` must prove bounded cost for both
  `on-landing` and `update = "merge"`.
- **Forge requests:** Major net reduction. Under `on-landing` with N open
  PRs, each merge triggers **1** branch update (the next turn holder) instead
  of **N - 1** branch updates, cutting archive-ref pushes, branch pushes,
  CI triggers, and ETag invalidations from O(N²) to O(N).

---

## 10. Operator surfaces and guidance

- **`ab builds`, `ab merges`, `ab build status`, terminal & web dashboards
  (shared projection):**
  - Distinguish `"behind main (N commits, waiting for landing turn)"` or
    `"behind main (N commits, awaits consent)"` from active `"restacking"`.
  - Show which build currently holds a destination's landing turn (in
    `ab merges` and `ab repository status`).
  - Display the effective `update` / `land` strategy on build detail when
    non-default.
- **`ab restack <slug>`:** Always forces an immediate update on demand using
  the build's configured `update` strategy, even under `restack = "on-landing"`.
- **`ab-guide` and `docs/configuration.md`:** Document the tradeoffs clearly:
  - When to choose `on-landing` (slow CI, consent-gated queues, >3 concurrent
    open PRs).
  - When to choose `update = "merge"` + `land = "squash"` vs `land = "merge"`
    vs `update = "replay"` + `land = "rebase"`, including GitHub
    branch-protection rules ("Require linear history", "Require branches to be
    up to date", GitHub merge queues).
  - Keep canonical (`skills/`), vendored (`.agents/skills/ab-*`), and pristine
    (`.agents/skills/.ab-pristine/ab-*`) copies synchronized.

---

## 11. Decisions

Settled by the maintainer on 2026-11-20:

1. **Configuration lives on `[[merge]]` rules (§4).** `restack`, `update`, and
   `land` are fields on `[[merge]]`, sharing `from = "leaf" | "node"`, path
   predicates, and live-reload policy semantics with `mode`.
2. **Reconcile real forge conflicts proactively on unheld lazy PRs (§5.1).**
   Under `restack = "on-landing"`, clean `target.moved` updates wait until the
   landing turn (or explicit `ab restack`), preserving CI runs and review
   stability for non-conflicting PRs. When the forge reports an actual
   `pr.conflicted`, unheld PRs reconcile proactively so reviewers inspect
   mergeable, verified code and consent lands cleanly. Held builds (`ab hold`)
   skip conflict reconciliation until unheld or explicitly restacked.
3. **`update = "merge"` supports both integration nodes and root leaves (§6.2).**
   Leaves gain non-force-push PR updates while still squash-merging (or
   merge-committing) to `main`; nodes gain single-pass conflict resolution
   instead of per-child replay loops.
4. **Support both `land = "squash"` and `land = "merge"` alongside `rebase` (§6.3).**
   Supporting all three aligns with GitHub's native merge options and user
   preferences; `land` defaults to `squash` when `update = "merge"` is chosen
   without an explicit `land`.
5. **Linear-stack `git rerere` conflict reuse is deferred (§6.4).**
   A good follow-up optimization for repositories that must keep
   `update = "replay"` + `land = "rebase"`, not required in this RFC's initial
   delivery.
6. **Landing turn concurrency is fixed at `1` per destination branch (§5.2).**
   Parallel turns re-introduce the CI invalidation race; batching belongs to
   integration nodes and GitHub's native merge queue.

---

## 12. Delivery plan

Ready to file once the current queue drains and the in-flight optimization node
completes. Splits cleanly into a wide, low-conflict sequence (as an integration
node or root tickets):

| Step | Scope | Depends on |
|---|---|---|
| 1. Policy contract & config | `restack`, `update`, `land` on `[[merge]]`, validation matrix, forge readiness checks, reducer/event types | — |
| 2. Lazy integration & landing turn (#1005) | `on-landing` gating for leaves and nodes (ignoring clean `target.moved` until turn; reconciling unheld `pr.conflicted`), serialized per-destination landing turn with priority/FIFO ordering and stuck-turn yield, consent survival on clean turn update, GitHub merge-queue handoff | 1 |
| 3. Merge-commit updates (`update = "merge"`) | Single 3-way sync merge for nodes and leaves, `[[generated]]` conflict regeneration on sync merge, provenance/`verifyDiffBase` over `parent..head` excluding sync merges, empty-tree settlement | 1 |
| 4. Node `squash` and `merge` landing | Forge `squash`/`merge` landing for nodes (and `merge` for leaves), multi-trailer build identity & issue-link composition on node squash, post-landing tree + identity audit | 1, 3 |
| 5. Operator surfaces, docs & scenarios | Shared dashboard projection, `ab merges` / `ab repository status` / `ab builds`, end-to-end scenarios covering lazy queues + merge-updated deep nodes, `SPEC.md` amendments, `docs/`, and synchronized `ab-*` skills | 2, 3, 4 |

Note that **Step 2** (which directly resolves #1005) and **Step 3** (merge-commit
updates) sit on opposite sides of the contract in Step 1 and can build in
parallel.

---

## 13. Alternatives considered

- **Full built-in speculative merge queue (batch N PRs, run combined CI, split
  on failure).** Duplicates both Autobuild's existing integration nodes and
  GitHub's native merge queue while adding significant speculative-rollback
  complexity. Serialized `on-landing` turns give most of the CI savings with a
  fraction of the machinery; repositories that want batch verification can
  group work in a node or turn on GitHub's merge queue.
- **Always squash-collapse a node before replaying onto `main`.** Solves the
  K-commit conflict loop, but destroys individual child commits *before*
  verification and still force-pushes the node branch on every update.
  `update = "merge"` keeps child commits intact for review and verification,
  never force-pushes, and lets the repository still choose `land = "squash"`
  or `land = "merge"` at the end.
- **Allowing merge commits inside `land = "rebase"`.** Impossible under GitHub's
  rebase-merge API and `local-git` linear fast-forward invariants; refusing
  the combination at config parse time prevents late landing failures.

---

## Evidence

- GitHub issue #1005 (2026-11-20): `@mikecra` measured 1 mergeable result per
  hour across two CI runners under `capacity = 6` and ~20 open PRs, with 47
  cases in one day of a ready PR dropping out of a merge pass because `main`
  moved and triggered eager restacks across every waiting PR.
- Maintainer discussion, 2026-11-20: on deep integration nodes, linear
  commit-by-commit replay repeatedly hits the same merge conflict one commit at
  a time; trading linear branch history for merge-commit updates could be a
  worthy speed tradeoff alongside lazy `on-landing` integration.
- `SPEC.md` §13.1 & §15.7: leaves collapse to one commit before replay and
  squash-merge at root; nodes replay item-by-item and land via linear stack
  rebase-merge / fast-forward.
- `packages/core/src/kernel/engine.ts` (`landingRestackDue`),
  `packages/core/src/kernel/node-restack.ts` (`prepareNodeReplay`,
  `replayNodeChange`), `packages/core/src/kernel/node-restack-demand.ts`, and
  `packages/core/src/kernel/integration-stack.ts`.
