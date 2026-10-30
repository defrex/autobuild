# Integration trees

Autobuild organizes work as a tree rooted at the configured `baseBranch`.
Work tickets are leaves; node tickets are finite integration points that collect
children before merge into their parent. Nodes can nest. An omitted target
means the root, so repositories can continue sending every leaf directly there.
Blockers form a separate graph. In repositories with nodes, a blocker with a
build resolves only when its change identity is present in the dependent's
sampled destination, regardless of source completion. Without nodes, or for a
blocker without a build, native done-state resolution remains in effect.
See [restacking](restacking.md) for change identity and replay.

Presence is checked only at claim, never to interrupt existing work. The newest
build generation supplies evidence; ambiguous or unavailable evidence leaves the
dependent queued. Confirmed merge SHA reachability can prove presence without
a trailer, and a merged node transports its whole owned contribution. Empty
completed nodes contribute nothing. Sibling work waits for merge into the common
ancestor and demand the minimal restack path; same-node merges satisfy presence directly.

## Choosing a destination

First decide whether the feature should be more than one ticket at all; the
[spec standard](spec-standard.md#sizing-and-splitting) prefers fewer, larger
tickets cut at seams. Whenever grooming produces more than one ticket for a
feature, explicitly choose root or a node before filing. Use a node when the set should reach the base branch
as one integrated change, or intermediate states should not ship independently.
Use root when every ticket is independently valuable and safe to merge alone.
Nested nodes can collect a subfeature before contributing it to a larger feature.
A node provides one integrated delivery to its parent under the configured forge
method; it does not promise one physical Git commit.

Blockers and targets are independent: blockers order work; targets decide where
it merges. A blocker inside the same node resolves when its change merges into that
node, so a dependency chain can advance without waiting for root consent, subject
to the normal claim gates and presence rules. Dependencies across destinations
still need the presence evidence described above and in
[blocker resolution](ticket-dependencies.md#when-a-blocker-resolves).

Read the consuming repository's `autobuild.toml` and evaluate its effective
[merge policy](merge-policy.md) for the actual ticket kinds, destinations and
labels. Ordered `[[merge]]` rules use the first match; `from`, `into` and `label`
predicates are ANDed, with omitted predicates acting as wildcards. Without a
match, leaves default to auto and nodes to consent. Explain the resulting merge
and consent flow to the human in plain terms. Ask when grooming does not make the
destination choice clear. This decision is separate from workflow-state placement
and never authorizes promoting tickets to ready.

For example, **if** the matched rules require consent into root and allow automatic
merge into nodes (the staged-release example in the policy reference), a
root-targeted chain waits for consent separately for each ticket and ships each
intermediate change to the base branch. Under those same rules, children collect
automatically in a node and the verified, complete node waits for consent once
into root. Other matching rules can produce different flows; auto authorization
still obeys every readiness and merge gate. If the live dispatcher rejected a
configuration reload, the edited file is not evidence of its effective policy.
Resolve or report that uncertainty using existing operator repository status
and configuration-reload evidence before claiming which policy is active.

## Tickets and admission

Tickets default to `kind = "work"` with no `target`. A target is a node ticket
id in the same source. Targets must exist and be nodes; self-targets and ancestor
cycles are refused. A node with targeting tickets cannot be demoted, even when
those children are completed. Clear or reparent its children first.

File tickets persist kind and target in frontmatter. Hosted tickets validate
changes transactionally within the project. Existing tickets default to work with
no target; metadata changes increment the revision once, while equivalent aliases
and unchanged values do not. Legacy plugins without `integrationTree` support
read as work with no target and refuse explicit metadata writes, including clears
and mixed patches, with guidance to use a capable source.

Linear uses the exact `node` label for kind and the parent relation for target only when that parent has the node
label. Ordinary grouping parents remain grouping and survive unrelated edits;
explicit target clear clears the parent relation. Label replacement can demote a
node and receives the same guards; explicit kind and labels must agree. Linear
label and parent connections are fully paginated and guarded writes are refused.
Kind and target participate in content revisions; file writes retain their
best-effort unlocked semantics. `ab ticket edit` displays these fields read-only.

A ready node opens `ab-node/<slug>` at its parent's sampled head. Opening intent
and acknowledgement are durable. Its branch admits children immediately, with
no placeholder commit or PR. Idle nodes need no provisioned workspace, runner,
execution lease or dispatch capacity. A PR opens or is adopted when the node
has commits its current parent lacks; parent-only advancement remains empty.


A node requesting reconcile or verification is admitted before new ticket
claims. Its candidate occupancy excludes itself and capacity-bearing blocked or
paused descendants, following accepted source-qualified build target ancestry.
Running descendants and unrelated builds still count; ordinary blocked and
paused work retains its slot for every other admission. Provisioning reserves
node occupancy before the runner starts. This exception never raises the budget
for new claims. Status and both dashboards report actual occupancy, configured
capacity, effective display capacity and the nodes using descendant-held slots.
Idle collecting nodes remain free.

Claims freeze the destination build generation and branch. Missing, unopened,
merged, closed or aborted targets leave work queued with diagnostics. The newest
generation wins; a closed generation never falls back to an older open one.
Source metadata and effective ancestry are different: `ab ticket tree` shows
source targets, while build status shows the effective destination.

## Collect, verify and merge

Node `verify:*` context additionally exposes `nodeVerification`: the frozen
range, a JSON index path, contribution build slugs, preparation-time stored ticket
identities, event-authorized spec revisions and spec paths, and their commits.
The index maps every commit in the range using build identity trailers,
including earlier-cycle contributions and merge side history. Commits without
an identity are listed as unattributed (a mechanical classification). The manifest
and index also expose `handPushedCommits: [{sha, originalSha, message}]` for owned
hand-pushed commits in the frozen range, preserving original identity across restacks.
Their full messages express maintainer-authorized intent: judge quality and
consistency, and never fail them solely for lacking a covering spec. Other node
changes are authorized when covered by the current event-authorized node spec or the spec
of the contribution introducing it; use the commit mapping to find that spec.
The dispatcher collects these inputs with repository authority before launching
verification and atomically deposits a node-owned `node-verification-context`
artifact cited by exact revision in `integration.prepared`. Contributor specs
freeze at preparation; resumed and concurrent verifiers read the same cycle input.
Hydration reads only that node-owned artifact and grants no general contributor
read authority. Missing or ambiguous provenance prevents preparation; missing,
corrupt or mismatched prepared inputs fail hydration. Historical agent cycles
without a citation require a new integration cycle. Leaf context is unchanged.
See [iterating inside a node](#iterating-inside-a-node) for authoring and evolving
these sources of intent.

Create a node and direct work into it (replace ids with those returned by your
source):

```sh
ab ticket create "Release candidate" --body candidate.md --kind node
ab ticket update WORK-2 --target NODE-1
ab ticket tree
ab ticket tree --json
```

Use the ordinary native ticket lifecycle and ready gate to dispatch the node
and children. The tree includes completed work and empty nodes, sorted by id
among siblings; invalid external graphs and listing diagnostics remain explicit.
Each leaf runs the normal spec, plan/review, implement/review, verify and finalize
pipeline against its frozen destination.

A node collects until every ticket targeting it is natively done or cancelled,
all frozen child claims have settled, and at least one contribution has merged.
Triage, backlog and ready children keep it incomplete. Exhaustive enumeration
failures fail closed. Completeness is sampled again before verification and
publication; tracker edits cannot be transactional with a forge write.

The kernel runs all configured verify steps with normal path applicability on
the exact node head and parent. Either moving invalidates eligibility, even a
clean restack. Failed verification blocks the node and emits `integration.verification-failed` once per prepared cycle. Default `ab watch` includes it; `ab wait --for attention` also detects the current failure before notification. The fact names failed steps, head, parent and repair guidance. Watch baselines prior failures; reconcile status after arming. A new cycle can notify again, while historical facts do not keep a repaired node blocked. Recovery reports only the latest prepared cycle while its head and parent remain current; superseded failures are not backfilled. Recheck current status before filing a repair, since the node may have advanced after notification. To recover, file a repair child targeting
it; the repaired merged head permits a new cycle. If the contract changed, an
operator can explicitly revise the spec instead and verify again on the same head
(see operator node spec revisions below). Historical reports keep their
actual head/base citations. Integration grammar is collect → verify → merge →
close, with restacking and repair cycles along the way.

[Merge policy](merge-policy.md) defaults nodes to consent. Once complete and
verified, `ab merge <slug>` authorizes merge; it refuses incomplete nodes and
names open children. `ab hold <slug>` works before readiness and withdraws
consent. Automatic authorization still requires every readiness and merge gate.
A merged node completes its ticket and closes admission; it is not a perpetual
staging branch. Releases remain separate maintainer operations.

Human forge merges are an explicit escape hatch, including while incomplete,
paused or unverified. The janitor records human provenance and whether the actual
merged head was verified, then completes the ticket. Closing without merge or
aborting closes admission and returns the ticket to triage; already claimed
children retain their frozen destination.

## Iterating inside a node

Write the node spec as a finite integration charter: its goal, observable
completion conditions for the whole, and destination and merge expectations
under the effective policy. Put feature specifics in spec-standard children.
An open node supports three ways to iterate:

- **Add children.** Create spec-standard tickets targeting the node's ticket id,
  for example `ab ticket create "Account settings" --body settings.md --target <node-id>`.
  Ordinary children run their normal pipeline. Verification uses the provenance
  mapping to judge changes against the introducing child's spec or the current
  event-authorized node charter; a child contribution need not also be promised
  independently by the charter.
- **Push small maintainer-authorized tweaks.** Push to the node's recorded branch
  with meaningful commit messages describing intent. Verification reads the frozen
  range's owned `handPushedCommits` messages, judges quality and consistency, and
  cannot fail a tweak solely because it lacks a covering spec. This is maintainer
  iteration, not permission for phase agents to bypass their publication boundary.
- **Revise the charter when the charter itself changes.** Use
  `ab answer <node> --revise-spec replacement.md`, or update the ticket and import
  it with `ab answer <node> --revise-spec-from-ticket`. A ticket edit alone does
  not revise an active build. Children retain their specs, claims and targets;
  the node recollects and verifies the replacement revision, including on the
  same head and parent after failed verification. See
  [operator node spec revisions](#operator-node-spec-revisions) for admission
  restrictions.

Open children keep the node incomplete, including triage, backlog and ready
children. Completion remains finite: merged or otherwise ended nodes close
admission. Iteration does not relax verification of the exact head and parent,
or the configured readiness, consent and merge gates described above.

## Changing a parent

`ab ticket update NODE-1 --target NODE-2` reparents an open node;
`--no-target` moves it to the root. Omitted fields preserve existing values;
`--kind work` resets kind when valid. Only owned contributions replay onto the
new parent, then the same PR is retargeted. Empty and same-head moves need no
new commit or PR. Descendants restack only on their own demand.

The request is durable before the provider write. Source readback accepts the
new effective ancestry; branch publication, PR retargeting and completion have
separate receipts. Pending moves fence verification and merge and keep both
parents incomplete. Reparenting revokes merge consent; holds survive. Policy is
sampled again for the new parent, including when both parents have the same SHA.

Cycles, unopened/terminal parents, merge or closing nodes, unsupported PR
retargeting and busy writer operations refuse or defer the move with a reason.
Invalid direct provider edits leave effective ancestry unchanged and produce
durable diagnostics; restoring it clears the current refusal. Missing source
reads withhold acceptance, while an accepted operation can finish its reserved
Git/PR effects without the tracker. Ambiguous writes are reread on recovery.
Changing a claimed work ticket's target is refused before any combined patch is
written: abort and re-dispatch instead.

See [forge requirements](merge-policy.md#forge-requirements),
[restacking](restacking.md), and [migration from 0.x](migration-1.0.md).

## Integration detail

Both dashboards show destination (with the configured-base annotation for root
targets), row progress and steps, branch/restack state, and all open and merged
children with titles and states. Open children come first; live children show
their current phase, unbuilt children read `queued`, contributions read `merged`.
Cancelled tickets without contributions are excluded. Verification names the
expected steps and only outcomes bound to the current node head and destination;
failures name the repair-child instruction. Merge explains the rule and mode;
ready consent names `l` and `ab merge <slug>`. Conflicts name recorded files.
These are Store-only projections: additive `integration.observed.children`
metadata carries source/id, optional title and contribution build identity;
`node.item-conflicted.files` and conflicted `restack.replayed.files` retain paths.
Older events remain readable, with explicit unavailable titles/files. Display
metadata never changes completeness or merge eligibility.

## Demand-driven parent freshness

Collecting nodes may intentionally trail their parent. They refresh before
verification and merge, for queued dependency presence, on operator request,
and after accepted re-parenting. Descendants need independent demand; presence
requests follow only the minimal proven ancestor path. Unavailable immediate-parent
identities remain pending; durable availability facts bound idle preparation across
restart. Head, request, ancestry, alias and confirmed landing changes trigger a fresh
assessment. Re-parenting to another branch explicitly disposes of old destination
requests without claiming coverage. See
[restacking](restacking.md#timing-and-evidence) for timing, requests and distance.

## Polling and status

Opened integration nodes poll every tick until their durable activity has been
quiet for `policy.nodeIdleAfterSeconds` (default 600 seconds), then poll every
`policy.nodeIdlePollSeconds` (default 120 seconds). Holds and waiting for consent
qualify normally. Child claims, PR and merge activity, operator commands
(including repeated holds), restack requests and answers wake the next tick.
GitHub-only changes are discovered on the next due check, within the idle
interval plus normal tick scheduling while the dispatcher is running; failure,
cooldown and transport-budget gates still apply. Pending operations retain
active polling and action-time readiness checks remain fresh. Successful
`node.poll-checked` advisory facts preserve quiet history across restarts.
Each successfully observed activity or policy epoch records one quiet-period
anchor; unchanged active checks add no checkpoints. At the quiet threshold a
check may be immediately due, then each successful due idle check records its
completion. Growth is bounded by one anchor per observed epoch plus due idle
checks. Missing or unusable evidence forces a fresh check; interrupted or
contended writes leave the durable deadline unchanged and retry conservatively. `ab build status` reports active or idle cadence and the
last durably recorded successful check (or unrecorded evidence); this timestamp
can trail successful active checks.

## Operator node spec revisions

Operators may explicitly revise an opened idle collecting node or a node blocked on failed
integration verification without an escalation. Use
`ab answer <node> --revise-spec replacement.md` or, after amending its ticket,
`ab answer <node> --revise-spec-from-ticket`. Ticket edits alone do not revise
the build. Both forms enforce the same spec standard as leaf revisions.
Each kernel `spec.revised` records the exact artifact and operator identity
(with optional transport provenance); earlier revisions remain readable.
Ticket-origin revisions re-pin assets; supplied bodies preserve asset pins.
The node recollects and verifies the new revision, including on the same head
and parent after a failed cycle. Earlier cycles remain historical evidence
and cannot block or authorize merge under the replacement. Children keep
their specs, claims and targets; contributions are not restarted.
Active verification/reconcile or writer work, restack/reparent work, pause,
pending controls, merge intent and ended PRs refuse the no-escalation path.
A concurrent state change refuses publication with a retry explanation;
uncited artifacts are inert. Leaves still require an open escalation and
restart from `plan` after any unfinished reconcile resumes under the revised
spec and its publication is confirmed.



Parent node restacks are kernel rewrites. Child admission uses the dispatcher's
bounded indexed publication-receipt proof, retained in `target.moved.lineage`,
including after a child was paused across multiple restacks. External rewrites
without proof raise attention; node ownership alone never authorizes replay.
See [restacking](restacking.md).
