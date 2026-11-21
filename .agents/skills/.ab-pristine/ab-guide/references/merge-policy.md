# Merge policy

Merge authorization is an ordered, strict `[[merge]]` array in
`autobuild.toml`. Rules require `mode = "auto"` or `"consent"`; optional
predicates are ANDed, omissions are wildcards, and the first match wins.

| Predicate | Matches |
|---|---|
| `from` | `leaf` or `node` |
| `into` | `root`, any `node`, or an exact destination node ticket id |
| `label` | An exact, case-sensitive source ticket label |
| `paths` | At least one changed path matches a selector |
| `within` | Every changed path matches a selector, and at least one path changed |

Blank destinations and labels are invalid. With no match, leaves use auto and
nodes consent. Destination means the frozen effective destination, not mutable
source metadata. Successful source reads supply labels at readiness; unavailable
data defers the decision rather than pretending labels are empty.

### Changed paths

`paths` and `within` take the same selectors as `[verify.<step>].paths`:
positive, repository-relative, case-sensitive globs with `*`, `?` and
whole-segment `**`. An invalid selector is rejected when the configuration
loads, naming its rule, such as `merge[1].paths[0]`. The changed paths are the
ones the candidate head changes against its merge base with the destination,
as the build recorded when it produced that head. A rename counts both paths
and a deletion counts its path. Each candidate head is decided on its own
paths, and `landing.decided` records the paths the matched rule's selectors
matched: the first 20, sorted, with a total.

Evaluation never guesses a change. When it reaches a rule with a path
predicate and the candidate head's paths are not recorded, the decision is
deferred, recorded once and shown in `ab build status`; it is never evaluated
as an empty change. Only heads a build publishes are recorded, so a head
pushed to the branch outside a build stays deferred until the build publishes
a recorded head. A recorded empty change matches neither predicate. Rules
without path predicates decide without the fact.

First match still wins, so **protective rules belong first**: put a `paths`
rule that holds sensitive files ahead of any `within` rule that releases the
rest. See [Protected paths](#protected-paths).

A leaf is ready after verification and finalize on a current base; a node must
be complete and verified at its exact head and parent. `landing.decided` retains
that candidate, labels, mode and the full matched rule/index or explicit default.
Editing configuration does not revise that decision. A replacement candidate
gets a fresh decision, evaluated on its own changed paths, and that decision
governs. A reconcile or restack head can therefore match a different rule: a
documentation change that merged automatically waits for consent once its new
head touches a protected file. Native auto-merge armed under the old decision
is cancelled before the new head is published. Policy is live dispatcher
configuration, separate from the pinned execution pipeline.

`ab hold <slug>` suppresses merge and revokes consent, even before readiness.
`--reason <text>` records why; status, merges, builds and both dashboards show it
until a later hold or merge replaces it.
`ab merge <slug>` requires readiness, clears hold and consents to this merge
into its destination. Consent survives head replacement, clean restacking,
verification and re-finalization until hold or completion; it approves the merge
rather than an immutable diff. Consent given under a rule with `paths` or
`within` predicates is revoked when a reconcile's own edits, or a leaf
restack's [generated-file regeneration](restacking.md#generated-file-conflicts),
touch a file those predicates match (the recorded resolution, not upstream-only
changes): `landing.consent-revoked`
raises default attention naming the files and both heads, and the build returns
to the consent queue for its new head. Accepted node reparenting and
reopening a finished leaf (`ab reopen`) also revoke consent; a reopen keeps a
hold.
`ab merge <slug> --head <sha>` binds consent to the head the reviewer saw: it
refuses with `head-mismatch`, recording nothing, unless `<sha>` (full or at
least seven characters) is the current candidate head. Build status and the
consent queue show the current candidate head beside the head consent was
given at; `--head` does not change survival. Commands and receipts
are sequence-correlated: hold acknowledgement confirms native cancellation;
merge acknowledgement does not claim gates passed. MCP/operator tools offer the
same actions; the terminal uses `l`/`o`. These controls record durable actions; merge consent does not mean the merge gates have passed.

## Worked configurations

These independent minimal configurations each parse on their own. Add your
repository's commands, roles and verification before operating it.

### Continuous deployment

```toml
baseBranch = "main"
merge = []

[tickets]
source = "file"
readyState = "ready"
```

Root leaves and leaves entering nodes default to auto; every node defaults to
consent. No special rule is needed for a repository without integration nodes.

### Staged release

```toml
baseBranch = "main"

[[merge]]
into = "root"
mode = "consent"

[[merge]]
into = "node"
mode = "auto"

[tickets]
source = "file"
readyState = "ready"
```

Leaves and nodes entering the root match rule 1 and require consent. Leaves and
nested nodes entering any node match rule 2 and merge automatically when ready.
A specific destination can replace `"node"` with its ticket id, such as
`"REL-1"`; it matches that frozen destination only.

### Team review

```toml
baseBranch = "main"

[[merge]]
label = "review"
mode = "consent"

[[merge]]
from = "node"
mode = "consent"

[[merge]]
mode = "auto"

[tickets]
source = "file"
readyState = "ready"
```

Any source carrying exactly `review` matches rule 1. Other nodes match rule 2;
other leaves match rule 3. `Review` does not match `review`. Moving the catch-all
to the front would shadow both safeguards and automatically authorize nodes too.
Authorization never bypasses verification, checks, protection or merge gates.

### Protected paths

```toml
baseBranch = "main"

[[merge]]
paths = ["autobuild.toml", ".agents/**", "SPEC.md", "docs/policy/**"]
mode = "consent"

[[merge]]
within = ["docs/**", "README.md"]
mode = "auto"

[[merge]]
mode = "consent"

[tickets]
source = "file"
readyState = "ready"
```

Rule 1 holds any change that touches a protected file, whatever else it
changes. Rule 2 merges changes confined to documentation automatically. Every
other change matches rule 3 and waits for consent. Protective rules belong
first: placed after rule 2, a documentation change under `docs/policy/**` would
match rule 2 and merge automatically.

Consent given under rule 1 lasts only while the reviewed protected change does.
A clean restack keeps it, and so does a reconcile that resolves conflicts
without editing a protected file. A reconcile whose resolution edits a protected
file revokes it, and the new head needs fresh consent.

## Merge methods

Root-target leaves squash into one identity-bearing commit per build.
Node-target children use serialized, exact-parent guarded fast-forwards;
node-to-local-git-root merge also fast-forwards, preserving each contribution and
verified hand-pushed commit. A node stack that is non-linear, repeats or combines
identities, or holds a commit the node does not own is refused once with operator
attention naming the commit, not retried.
Node-to-GitHub-root merge uses PR rebase merge guarded on verified head after
a final parent freshness read. Enforced up-to-date protection provides a fenced
merge; uncertainty is recorded as unfenced and requires immutable merged-tree
audit. A mismatch raises operator attention without rewriting the shared parent.
Pending audits survive completion and retry until settled.

Root leaves land by one of three routes. Behind a real merge-blocking gate,
Autobuild arms GitHub-native auto-merge. An authoritatively ungated root
permits an inspected-head guarded direct squash; unknown gate state defers.
When GitHub GraphQL is unavailable to the dispatcher, as from Claude Code on
the web, whose GitHub proxy refuses GraphQL, native auto-merge cannot be
armed, so a gated root leaf lands by polling. On each dispatcher tick
Autobuild checks whether GitHub reports the PR clear to merge (`clean`,
`unstable` or `has_hooks`, and mergeable) at the verified head. It then reads
that state again, rechecks consent, and squashes guarded on that head. It
never relies on GitHub refusing a premature merge, so a credential that could
bypass branch protection never merges a blocked PR. Rows show
`merge polling`. Polling lands only while a dispatcher runs, so native
auto-merge stays the route wherever GraphQL works: it lands even after the
dispatcher stops.

A polling landing settles once into awaiting a human merge, shown as
`merge awaits a human merge`, and Autobuild makes no further landing attempt
for that candidate when either holds: GitHub exposes a merge queue for the
base over REST (a ruleset merge-queue rule, or merge-queue merges GitHub
reports for the base branch), or GitHub refuses the guarded squash of a PR it
had just reported clear, in which case its refusal message is shown. A squash
request cannot enter a merge queue. A human merges the PR on GitHub, and
Autobuild records that like any human forge merge. A classic
branch-protection merge queue that GitHub does not expose over REST and has
never recorded a merge-queue merge cannot be detected. A PR GitHub keeps
reporting blocked there stays `merge polling` and never merges. In
GraphQL-blocked environments, use a ruleset merge queue or merge such PRs by
hand.

Node targets instead require authoritative proof of
an ungated destination, cancel native auto-merge and serialize the guarded push.
Gated or unproven node destinations stay open with actionable diagnostics.
A push alone is not evidence of merge: a node-target merge is recorded only
under the publication readback rule in Forge requirements. Forge
acknowledgement, a merged-SHA comment and closing an unacknowledged open
review, is best-effort after the merge is recorded and never decides, retries
or fails the merge.

Native application receipts bind to exact candidates; consent does not. Every
replacement confirms cancellation first; the next poll reconciles native state
before other actions. Stale enables are repaired by polling. An
already-enabled native request counts as applied only after the forge confirms
its squash method and identity message. Each eligible poll re-reads an armed
request and repairs it when PR edits or a human arm left it stale. On GitHub
the expected headline and body come from the PR and the repository's squash
title and message settings, with the build trailer and issue-link handling on
top. Landing reads use REST; GraphQL only arms or disarms native auto-merge,
after one read-only availability probe per dispatcher process. A GraphQL
refusal is remembered for 30 minutes, so a blocked environment sends at most
one GraphQL request per process in that window, and none on a quiet polling
tick. Quiet polls do not re-check merge queues; native enable, repair and
direct merge do, and the polling route checks merge-queue activity when it
first selects polling and again whenever GitHub reports the PR clear. This bounded
model requires replacement-head checks to take far longer than a poll interval. It
has no durable native-effect reservation. Human forge merges record whether a
hold was overridden; possible stale-enable merges raise operator attention.
No result is undone by rewriting the target.

## Forge requirements

The kernel must publish and fetch immutable exact archive refs under
`refs/autobuild/archive/<slug>/<sha>` and replace branches with an exact
expected-old-head guard. Namespace or permission failures stop publication;
there is no branch/tag fallback. When an environment refuses non-branch Git pushes,
as Claude Code on the web's GitHub proxy does, the GitHub adapter creates the same
archive ref through REST ref creation and confirms it by exact readback. Commits that
exist only in the local workspace cannot use this fallback and fail with an actionable
error. Archive retention remains indefinite pending a
retention policy. See [restacking](restacking.md).

Tree admission requires node branch creation, authoritative branch-head reads
and comparison. Reparenting additionally requires PR retargeting. Controlled
merge requires exact-parent guarded publication and authoritative gate proof;
GitHub root nodes also need rebase merge support. Root leaves require squash
support. Readiness inspection reports method/publication hard failures and
linear-history/freshness recommendations without changing provider settings or
pushing probes. Unknown permission never proves permission.

Legacy plugins can remain readable without supporting tree operations: old
ticket sources read as work/root and refuse tree metadata writes. This read
compatibility does not grant forge tree capabilities. Upgrade adapters before
admitting nodes or requesting unsupported retargeting or merge operations.
For the lifecycle see [integration trees](integration-tree.md); for old controls
and upgrade conversion see [migration](migration-1.0.md).

Publication, including a node-target merge, is acknowledged only by exact
authoritative head readback of the destination: `ls-remote` on an origin
forge, the shared database for local-git. A node merge is recorded when that
readback shows exactly the candidate head, or from the durable receipt of an
accepted guarded write overtaken before readback. A different observed head is
contention and records no merge; a failed readback records nothing and is
retried. Interrupted publication recovers by the same exact readback; an
unconfirmed candidate's descendants do not prove success. Durable confirmed
receipts preserve historical writes. Local refs cache confirmed heads; remote
expected-head leases and durable writer reservations still guard writes.
Local-git's shared database retains authoritative CAS.

Native cancellation receipts are candidate- and operation-specific. Publication
retries confirm forge state before reusing a receipt; external re-enables require
another confirmed cancellation. Classified transient merge failures retain
retry eligibility and recheck authorization after repository forge cooldown.

## Deprecated spellings

`ab land` and `ab landings` remain callable aliases for `ab merge` and `ab merges`,
with one deprecation notice on stderr. `node-landed` remains an alias for the
`ab wait --for node-merged` condition. Ordinary help lists only the current names.

The deprecated `[[landing]]` config array has the same semantics as `[[merge]]`
and warns after validation. Commands that read the file warn each time they run.
`ab dispatch` reports it once at startup with its other configuration notices
(stderr, or the dashboard's warning region), and once more for each changed
`autobuild.toml` it evaluates — including a change it rejects or has not yet
applied, which is labelled as pending. Repeated evaluation and phase launches
stay quiet, and a build branch's own `landing` key is not reported because merge
policy comes from the dispatcher's configuration. Declare only one spelling,
including empty arrays.
`ab upgrade` renames the old root key and table headers while preserving policy;
unsupported spellings require the reported manual edit before retrying.

MCP discovery offers `merges.list` and its deprecated alias `landings.list`.
`builds.control` accepts canonical `merge` and deprecated `land` actions through
both MCP bindings, with an optional `head` that binds consent like `--head`. HTTP control bodies and durable event fields retain their
existing wire names, including `land`, `landing.decided`, and `integration.landed`.
