# RFC 0001 — The integration tree (Autobuild 1.0)

**Status:** accepted, 2026-10-18. The series is implemented; this document
preserves the proposal's history. The running design lives in
[SPEC](../SPEC.md#131-node-tickets-and-targets), with adopter references for
[integration trees](../docs/integration-tree.md), [landing](../docs/landing-policy.md),
[restacking](../docs/restacking.md), and [migration](../docs/migration-1.0.md).
Cutting the 1.0 release remains a separate maintainer action.

**Implementation disposition:** §13's proposed in-flight compatibility promise
was superseded by [SPEC §15.7](../SPEC.md#157-post-pr-lifecycle-d1--confirmed):
historical merge reconciliations retain meaning and establish later replay
bases, while resumed builds use current engine routing at newly reached
boundaries. There is no claim-version compatibility switch. See the migration
reference before upgrading. The §14 questions are resolved below.

**Hat:** product. Every change proposed here ships to every user. Nothing in it
encodes this repository's configuration.

**Version:** this is the model change that defines Autobuild 1.0. It reverses
a decided section of the specification (the merge standard, §15.7 [D1]),
changes the Forge and TicketSource ports, and changes how operators think about
landing work. Consuming repositories will need to update both configuration and
habits, which is what a major version is for.

---

## 1. Problem

Autobuild today assumes continuous deployment: every build opens a pull
request against one configured `baseBranch`, and merging it is the release
path. Builds produce correct implementations reliably, but correct is not the
same as *right*. The agent's product taste does not always match the
operator's, and the operator often wants to use the result, and revise it,
before it reaches production.

The workaround in practice is a single integration branch: set `baseBranch =
"staging"`, auto-merge everything into it, try it out, then promote staging to
production by hand. That works for one person with one line of work. It breaks
down as soon as there is concurrency of *intent*:

- A long redesign and an unrelated fix share one integration point. The fix
  cannot ship without the half-finished redesign, so the operator either
  cherry-picks it out or waits.
- With several people, the shared branch thrashes. Everything rebases against
  everything, and promotion becomes a negotiation.
- Autobuild's own release step (tagging `main` at a known-stable point) is the
  same pattern with the same limit.

The need is several independent integration points, each collecting the
builds that belong together, each landing on its own schedule, and composing
with one another.

## 2. Summary of the proposal

1. **The integration tree.** Work is organized as a tree. The root is the
   repository's `baseBranch`. Interior **nodes** are integration points, each
   with exactly one parent. **Leaves** are ordinary builds. A ticket names the
   node it lands into; a ticket with no target lands into the root, which is
   exactly today's behavior.
2. **Nodes are tickets.** An integration point is a ticket of kind `node`, with
   a spec like any other ticket. Its acceptance criteria describe the whole
   feature. Its build is the **integration build**, which owns the node's
   branch and, eventually, lands it.
3. **One change per build.** Every build contributes exactly one commit to
   shared history, carrying a stable identity trailer that survives any
   rewrite. Rewrites are recorded as facts in the log.
4. **Restack replaces merge-in.** The rebase ban is reversed. Shared branches
   move only by fast-forward or by a kernel-performed restack: replaying a
   branch's changes onto its parent's current head. No merge commits appear in
   shared history.
5. **Automatic descendant restack.** When a change lands on a node, every
   descendant node and every leaf build waiting on it restacks onto the new
   head, recursively. Upstream code always sits underneath downstream work, and
   conflicts are paid incrementally, one small change at a time.
6. **Landing policy is declarative project configuration.** Ordered rules
   decide, for each landing, whether it proceeds automatically or waits for
   consent. That replaces today's per-build auto-merge toggles and the
   dispatcher-wide auto-merge default as the primary control.
7. **Blockers resolve by presence.** A blocker is satisfied for a dependent
   ticket when the blocker's change is present in the dependent's target node.

## 3. Ontology

New and changed terms. Each lives in exactly one layer, per §4 of the spec.

| Term | Meaning |
|---|---|
| **Tree** | The repository's integration structure: the root, its open nodes, and the builds targeting them |
| **Root** | The node backed by `baseBranch`. It has no parent and never lands |
| **Node** | An integration point: a ticket of kind `node`, backed by one kernel-owned branch, with exactly one parent node |
| **Leaf build** | A build for an ordinary ticket. Unchanged pipeline; lands its change into its target node |
| **Integration build** | The build for a node ticket. Owns the node branch: creates it, restacks it, verifies it, lands it |
| **Target** | The node a ticket lands into. Frozen on the build at claim, as `baseBranch` is today |
| **Change** | One build's contribution to shared history: exactly one commit with an identity trailer |
| **Landing** | A change (from a leaf) or a node's stack of changes (from an integration build) arriving on its target |
| **Restack** | Replaying a branch's changes onto the current head of the branch it is based on |
| **Presence** | Whether a given change is contained in a given node's current head, derived from the log |

Reserved-word discipline is unchanged: **build** names a pipeline execution
and nothing else. A node is a ticket; its build is an integration build.

## 4. The tree

```text
main (root)
├── leaf builds                       land into main
├── AUT-800  node: redesign
│   ├── leaf builds                   land into AUT-800
│   └── AUT-812  node: nav overhaul
│       └── leaf builds               land into AUT-812
└── AUT-830  node: billing
    └── leaf builds                   land into AUT-830
```

Invariants:

- **Strictly a tree.** Every node has exactly one parent. A DAG would
  reintroduce the question this proposal exists to answer: where does this
  land? Combining two nodes means landing one into the other, or re-parenting
  one under the other (§11).
- **The root is the only node that is not a ticket.** It is `baseBranch`, it
  never lands, and its history is linear: each entry is one change, landed
  either directly by a leaf or as part of a node's stack.
- **Nodes are finite.** A node opens, collects changes, lands, and closes.
  Long-lived integration branches are not nodes (see §14 for the open
  question). A project that wants permanent staging sets its root to that
  branch and keeps release outside the tree, the way this repository tags
  `main`.
- **Unbounded depth.** A node may target another node.
- **A target must be open.** A ticket can be claimed only when its target node
  is open: claimed, its branch created, and not yet landed. Until then the
  ticket stays queued source work, exactly as a dependency-blocked ticket does
  today.

## 5. Change identity and the paper trail

The rebase ban rested on two objections. This section answers the structural
one; §6 answers the operational one.

**The objection.** Rebasing rewrites commit SHAs, and `implement.completed`
records commit SHAs [D3]. Rewriting severs the log from the code.

**The answer has three parts.**

1. **An identity trailer.** Every change commit carries
   `Autobuild-Build: <slug>`. The build slug is already immutable and unique
   per repository. The trailer is the analogue of a Jujutsu change-id: it
   survives rebase, squash-on-land, and forge-side rewrites such as GitHub's
   rebase-merge, which always mints new SHAs.
2. **Rewrites are facts.** Every kernel rewrite of a branch appends an event
   recording the old and new heads, the base it moved onto, and, per change,
   the old and new commit SHAs and whether the replay conflicted. The log
   always knows which SHA a change has on which branch.
3. **Reviewed history is archived.** Before a rewrite discards commits that
   any event references, the kernel pushes them under an archive ref in a
   reserved namespace. Every SHA the log names stays resolvable on the remote.
   Retention joins the existing open thread on archival policy (§18 of the
   spec).

[D3]'s property, that events carry SHAs and code travels through the Forge,
holds unchanged. What changes is that a SHA is evidence of a moment, and the
trailer is the identity.

**Canonicalization.** During plan, implement, and code-review the agent
commits however it likes, and review rounds keep their `{base, head}` ranges
exactly as today. The kernel **canonicalizes** a leaf's branch into its single
change commit at defined points (§6): the net diff from the build's base,
one commit, the message derived from the build's PR description, plus the
trailer. Canonicalization checks deterministically that the canonical tree
equals the pre-canonicalization tree, and records both heads.

**Foreign commits.** A person may push to a node branch directly. Such a commit
has no trailer, so it is carried through restacks as an anonymous change,
attributed to no build, and reported by the operator surfaces. It is
tolerated, not encouraged.

## 6. Restack

### 6.1 The operation

A restack of branch *B* onto branch *P* replays *B*'s changes, oldest first,
onto *P*'s current head:

- For a leaf, there is one change.
- For a node, the changes are every change the node holds that its parent
  does not, plus any foreign commits.
- A change whose identity is already present in *P* is dropped. This is how a
  landed node's stack disappears from a sibling that had absorbed it, and why
  forge-side SHA rewrites are harmless.

A restack with no conflicts is pure Git plumbing: no agent session, no
judgment, executed by the kernel. A conflicting replay is resolved by an agent
in the `reconcile` phase of the build that owns the branch, one change at a
time, with that change's own spec, plan, and implement-notes as context.

**Why this does not reproduce the loops that motivated the ban.** The observed
failure was rebasing branches of many work-in-progress commits against a
target that kept moving: conflicts re-resolved commit after commit, then again.
Here a leaf is always one commit, so a leaf restack has at most one resolution.
A node restack resolves at most one per change, and each change is small,
self-describing, and resolved with its own spec. The moving-target race is
handled the way reconcile handles it today: restack onto a recorded snapshot,
land only by fast-forward, and when the target moved in the meantime, restack
again. Only the new upstream changes can conflict. The existing
progress-versus-no-progress accounting
(`reconcile.progress-checked`, `policy.maxReconcileAttempts`) carries over.

### 6.2 Who writes which branch

- **Every branch has exactly one owning build.** A leaf branch belongs to its
  leaf build. A node branch belongs to its integration build.
- **A node branch moves in exactly two ways:** a child's landing appends on
  top of its head, or its integration build restacks it onto its parent. The
  kernel serializes the two per node under a node lease. Every push is
  guarded by an expected-head lease (`--force-with-lease` semantics). A lost
  race is retried, never forced.
- **Rewrites never happen under a live session.** A branch is restacked only
  while no agent session is running in its workspace. "Target moved" is
  recorded as a durable fact the moment it is observed. The owning build
  absorbs it at its next eligible point.

### 6.3 When builds restack

**Leaf builds restack at two points, not continuously:**

1. **On entering `verify:*`.** The kernel canonicalizes, then restacks onto the
   target's current head, so verification runs against current upstream. A
   verify failure routes back to `implement` as today. New commits stack on
   the canonical change, and the next verify entry canonicalizes again.
2. **While awaiting landing.** After `finalize`, every time the target moves.

Plan, implement, and code-review run against the base the build was cut from,
exactly as today. Rewriting a branch between review rounds would churn review
ranges for no benefit. The reviewer judges the change, not the snapshot it sat
on.

**Integration builds restack whenever the parent moves.** An integration build
mostly holds no runner (§7). Clean restacks happen kernel-side immediately. A
conflict attaches a runner for `reconcile`.

### 6.4 The cascade

When a change lands on node *N*, *N*'s head moves. The kernel then:

1. records a target-moved fact for every open child node of *N* and every
   leaf build targeting *N*;
2. restacks each child node (clean ones immediately, conflicted ones through
   their integration build's `reconcile`), which moves *their* heads and
   recurses;
3. restacks each leaf build that is awaiting landing; leaf builds earlier in
   the pipeline absorb at their next verify entry.

Landings on a busy root would otherwise trigger a storm. The cascade
**coalesces**: a restack always targets the parent's head as of when the
restack starts, never an intermediate one. Several upstream landings during
one restack cost a second restack, not one per landing.

### 6.5 Verification after a restack

A clean restack carries a semantic risk: Git found no textual conflict, but
the combination may not work. Today's equivalent is a PR that stays mergeable
while its base moves. Today that PR is not re-verified unless it conflicts,
and that remains the rule for leaves: a clean restack does not by itself
re-run `verify:*`. A conflicted restack does, under the existing
post-reconcile verification policy.

Nodes are different, because landing a node is the release gate: **a node
always verifies the exact head it is about to land.** If the parent moves
after that verification, the node restacks and verifies again before it
lands. The operator's preview environment tracks the node branch and needs no
coordination.

## 7. The integration build

A node ticket's build runs a different, fixed grammar:

```text
spec → open → collect ⟲ restack → verify:* → land → closed
```

- **open** — the kernel cuts the node branch from the parent's current head,
  in a branch namespace reserved for nodes (distinct from build branches,
  `ab/<slug>`, to avoid ref collisions). From then on, children may be claimed.
- **collect** — children land changes. The integration build holds no runner
  and consumes no capacity. Parent movement triggers restacks (§6.4).
- **complete** (the exit from collect) — the node is *complete*: every ticket targeting it is in a
  terminal state (done or cancelled), and at least one change has landed.
  Tickets still in triage, backlog, or ready keep the node open. Shipping part
  of a node means moving the remaining tickets elsewhere explicitly.
- **verify:*** — the repository's verify steps run against the node head.
  Whether nodes need different steps from leaves is open (§14).
- **land** — subject to landing policy (§8). The node's stack lands on the
  parent as its own changes, preserving one root commit per build, then the
  node closes. Its landing is itself a landing into the parent, so the
  parent's cascade follows.

There is no plan, implement, or code-review phase. An integration build never
authors code except through conflict resolution. Revisions are new child
tickets targeting the node.

The integration build also keeps a pull request open from the node branch into
its parent's branch, as the human review surface and the forge's landing
vehicle. Because the kernel keeps it restacked, it is always fast-forwardable.

The grammar stays fixed, per §5 of the spec. This adds a second fixed grammar
for a second kind of ticket. It does not open the door to generic workflow
DAGs, which remain out of scope.

## 8. Landing policy

### 8.1 Rules

Whether a landing proceeds automatically or waits for a human is a property
of *where* it lands, not of who requested it. The policy is ordered rules in
`autobuild.toml`; the first match wins:

```toml
[[landing]]
into = "root"          # a node landing on baseBranch: the release
mode = "consent"

[[landing]]
from = "node"          # every interior integration point
mode = "auto"

[[landing]]
mode = "auto"          # leaf builds land when green
```

Rule predicates (an initial set, to be kept small):

- `into` — `"root"`, `"node"`, or a specific node ticket id.
- `from` — `"leaf"` or `"node"`.
- `label` — a ticket label on the landing ticket.

Modes:

- `auto` — the kernel lands as soon as the landing is ready: a leaf after
  `finalize` and a clean, current restack; a node when complete and verified.
- `consent` — the landing waits for a durable consent command from an
  operator, or for a human to land it through the forge, which the janitor
  observes as it observes merges today.

A project with no `[[landing]]` rules gets one default, chosen for safety:
leaves `auto`, nodes `consent`. Whether that default, or the current
consent-everything default for leaves, is right for first-time users is open
(§14).

### 8.2 Determinism

Landing policy is dispatcher-owned configuration (spec §16.1), evaluated by
kernel code, never by an agent. When a landing becomes ready, the kernel
records which rule matched and the resulting mode as a fact, so a policy edit
mid-flight never makes the log ambiguous about why something landed.

Choosing a project's policy is a judgment call, and judgment belongs in a
skill: `ab-guide` gains guidance for walking an operator through the policy
that fits their team size, release process, and risk tolerance. Agents help
the operator write the rules; they never evaluate them.

### 8.3 What happens to auto-merge

The per-build auto-merge command and the dispatcher-wide auto-merge default
are replaced, not kept beside the rules:

- Per-landing escape hatches remain as operator commands: **hold** (do not
  land this even if policy says auto) and **land** (consent to this one
  landing). They are durable events, just as auto-merge commands are today.
- The repository-wide auto-merge default and its fan-out are retired.
- Merge gates are still never bypassed. Consent applied through the forge
  still uses forge-native auto-merge where a merge-blocking gate exists. The
  rules from §15.7 about proving the absence of gates carry over unchanged.

The operator's attention surface becomes one queue: **landings awaiting
consent**, each showing its verify results, its children, and its branch for
previews.

## 9. Dependencies

The existing rule, that an unresolved blocker prevents claim, keeps its shape.
What changes is what "resolved" means.

**A blocker is resolved for ticket X when the blocker's change is present in
X's target node.** Presence is derived from the log: landing facts and restack
facts record, for every node head, which change identities it contains.

| Blocker lands into | X targets | Resolved when |
|---|---|---|
| the same node | that node | the blocker lands |
| an ancestor of X's target | a descendant | the blocker lands, and the cascade restacks X's target onto it |
| a sibling subtree | its own node | the blocker's node lands into the common ancestor, and the cascade carries it down |
| a descendant of X's target | an ancestor | the blocker's node lands into X's target |

Because the cascade is automatic, no case needs operator action. A blocker on a
**node** ticket resolves when that node's whole stack is present, normally
when it lands.

Two consequences:

- **Ticket "done" and presence diverge.** A leaf ticket is done when its change
  lands in its target, but for a dependent elsewhere in the tree, done is not
  enough. For tickets that have builds, the dispatcher resolves blockers from
  the log, not from the source's done state. The source's done state still
  governs blockers that never had a build.
- **The never-consulted-mid-build rule is untouched.** Presence gates claim
  only.

## 10. Ports and adapters

### 10.1 TicketSource

- A `kind` field: `work` (default) or `node`.
- A `target` field: a node ticket id in the same source, or absent for the
  root. Writing it validates that the target is a node and that no cycle forms.
- Representation is the source's business, as it is for blockers. File
  tickets use frontmatter, and the hosted service uses columns. The Linear
  mapping is open (§14): its parent/sub-issue relation is the natural fit, but
  plenty of teams use sub-issues purely for grouping, so the mapping must be
  explicit.
- `ab ticket` gains the target and kind fields, and `ab ticket tree` renders
  the tree.

### 10.2 Forge

The Forge port grows from "push a branch, open a PR, squash it" to the
operations a tree needs:

- **create a branch** at a given SHA (opening a node);
- **lease-guarded force push** of a kernel-owned branch to an expected head;
- **land** with an explicit method: squash with a kernel-supplied message
  (leaves), or rebase/fast-forward (nodes), guarded by expected head;
- **retarget** an open PR's base, for re-parenting (§11);
- **archive refs** under a reserved namespace (§5).

GitHub requirements for a consuming repository, which `ab init` validation
should check and explain:

- Squash and rebase merges allowed. (GitHub's rebase-merge always mints new
  SHAs, and identity tracking makes that harmless.)
- "Require linear history" on protected branches is recommended. It stops a
  human's *Update branch* click from introducing a merge commit while the
  dispatcher is not running. When the dispatcher returns, it observes the moved
  target and restacks.
- Force-push permitted on the kernel-owned branch namespaces.

The local-git forge implements every operation directly. A node landing is a
true fast-forward.

Changing the Forge port is breaking for third-party forge plugins, which is
part of why this is 1.0.

## 11. Re-parenting and retargeting

- **Re-parenting an open node** changes its target: the integration build
  restacks it onto the new parent and retargets its PR. This is how two lines
  of work combine, and how a node is pulled forward to ship on its own.
- **Retargeting a queued ticket** is an ordinary ticket edit before claim.
- **Retargeting an in-flight leaf** is out of scope for the first release.
  Its target is frozen at claim. Abort and re-dispatch remain available.

## 12. Operator surfaces

- **CLI:** `ab ticket tree`; landing-consent and hold commands; `ab watch` and
  `ab wait` streams for landings, restacks, and the consent queue.
- **Shared projection:** the vocabulary in §3 enters the shared dashboard
  projection, so both frontends use the same terms (parity of vocabulary, per
  the repository's dashboard rule).
- **Terminal dashboard:** build rows show their target. Nodes show
  completeness, restack state, and landing readiness.
- **Web app:** a tree view is a new surface. Under the design rules, the shape
  of a new surface is a human decision made in a design session, never inside
  an unattended build. The tickets that implement it must say so, and stop at
  `ab escalate` without one.
- **MCP / operator tools:** parity with the CLI over the one tool registry.

## 13. Migration and compatibility

- **Historical logs replay unchanged.** A build without a target targets the
  root. Old reconcile merge commits remain in old histories. Only new shared
  history must be linear.
- **Configuration.** `baseBranch` keeps its name and becomes the root.
  `ab upgrade` translates the repository's auto-merge default into an
  equivalent `[[landing]]` rule set (on → leaves `auto`; off → leaves
  `consent`), and explains it.
- **Builds in flight at upgrade (superseded proposal).** The original promise
  that these finish under the old merge standard was not implemented; see the
  implementation disposition above and the migration reference.
- **Skills.** `ab-reconcile` is rewritten around resolving one change's replay.
  `ab-spec` and `ab-tickets` learn node tickets and targets, `ab-operate` learns
  the consent queue, and `ab-guide` documents the model and the landing
  policy. Each change advances all three copies (canonical, vendored,
  pristine) in one commit.
- **Specification.** Each implementing ticket amends `SPEC.md` for what it
  lands. The merge standard in §15.7 is rewritten, [D1] and [D3] are amended
  with this rationale, the pipeline grammar in §5 gains the integration
  grammar, and §4 gains the ontology terms.

## 14. Question dispositions

1. **Persistent nodes:** finite nodes are the decided model; landing closes
   admission and completes the ticket ([SPEC §13.1](../SPEC.md#131-node-tickets-and-targets)).
   Perpetual staging nodes are not part of this design.
2. **Linear representation:** exact `node` label plus the parent relation only
   when the parent is a node ([ticket metadata](../docs/integration-tree.md#tickets-and-admission)).
3. **Node verification:** all ordinary configured verify steps with normal path
   applicability; no separate implicit agent check
   ([node lifecycle](../docs/integration-tree.md#collect-verify-and-land)).
4. **Cascade cadence:** eager, coalesced after the active transaction, with no
   new throttle or completeness deferral ([restacking](../docs/restacking.md#timing-and-evidence)).
5. **Defaults:** leaf auto, node consent, whether or not a node has opened
   ([landing policy](../docs/landing-policy.md)).
6. **Incomplete consent:** refused with open children named; move remaining
   tickets explicitly rather than interpreting consent as a metadata mutation
   ([node lifecycle](../docs/integration-tree.md#collect-verify-and-land)).
7. **Archive retention:** refs remain indefinite; a future retention policy is
   carried in [SPEC §18](../SPEC.md#18-open-threads), item 2.
8. **Release:** remains outside the tree as a maintainer operation; a first-class
   release operation is not part of this design
   ([node lifecycle](../docs/integration-tree.md#collect-verify-and-land)).

## 15. Delivery plan

A series, ordered so each step ships on its own and so the series can build
inside its own node as early as possible.

1. **Change identity.** Identity trailer on every landing commit, archive refs,
   rewrite facts. Shippable in 0.x with no behavior change.
2. **Node tickets and targets.** Ticket `kind` and `target` across the file,
   hosted, and Linear sources. Integration builds open node branches, leaves
   claim against them, and a node lands by the operator merging its PR. After
   this step, the rest of the series runs as children of a `1.0` node, and
   0.x fixes keep landing on `main`.
3. **Restack primitive.** Canonicalization, kernel-side clean restack,
   lease-guarded pushes. Reconcile becomes "resolve one change's replay".
4. **Cascade.** Target-moved facts, coalescing, leaf restack at verify entry
   and while awaiting landing, node restacks.
5. **Integration grammar.** Completeness, node verification, landing by
   fast-forward or rebase-merge, closing.
6. **Landing policy.** `[[landing]]` rules, hold and land commands, retirement
   of the auto-merge default, `ab upgrade` translation.
7. **Presence-based blockers.**
8. **Re-parenting.**
9. **Operator surfaces.** CLI tree, shared projection, terminal dashboard, MCP
   tools. The web tree view follows, after a human design session.
10. **Documentation, skills, and the 1.0 release.**
