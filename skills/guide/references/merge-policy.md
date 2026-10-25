# Merge policy

Merge authorization is an ordered, strict `[[merge]]` array in
`autobuild.toml`. Rules require `mode = "auto"` or `"consent"`; optional
predicates are ANDed, omissions are wildcards, and the first match wins.

| Predicate | Matches |
|---|---|
| `from` | `leaf` or `node` |
| `into` | `root`, any `node`, or an exact destination node ticket id |
| `label` | An exact, case-sensitive source ticket label |

Blank destinations and labels are invalid. With no match, leaves use auto and
nodes consent. Destination means the frozen effective destination, not mutable
source metadata. Successful source reads supply labels at readiness; unavailable
data defers the decision rather than pretending labels are empty.

A leaf is ready after verification and finalize on a current base; a node must
be complete and verified at its exact head and parent. `landing.decided` retains
that candidate, labels, mode and the full matched rule/index or explicit default.
Editing configuration does not revise that decision. A replacement candidate
gets a fresh decision. Policy is live dispatcher configuration, separate from
the pinned execution pipeline.

`ab hold <slug>` suppresses merge and revokes consent, even before readiness.
`ab merge <slug>` requires readiness, clears hold and consents to this merge
into its destination. Consent survives head replacement, restacking, verification
and re-finalization until hold or completion; it approves the merge rather than
an immutable diff. Accepted node reparenting revokes it. Commands and receipts
are sequence-correlated: hold acknowledgement confirms native cancellation;
merge acknowledgement does not claim gates passed. MCP/operator tools offer the
same actions; the terminal uses `l`/`o`. The hosted web app offers **Merge** and
**Hold** on a merge awaiting consent. These controls record the same durable
actions; **Merge** does not mean the merge gates have passed.

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

## Merge methods

Root-target leaves squash into one identity-bearing commit per build.
Node-target children use serialized, exact-parent guarded fast-forwards;
node-to-local-git-root merge also fast-forwards, preserving the contributions.
Node-to-GitHub-root merge uses PR rebase merge guarded on verified head after
a final parent freshness read. Enforced up-to-date protection provides a fenced
merge; uncertainty is recorded as unfenced and requires immutable merged-tree
audit. A mismatch raises operator attention without rewriting the shared parent.
Pending audits survive completion and retry until settled.

Root leaf native auto-merge is used behind a real merge-blocking gate. An
authoritatively ungated root permits an inspected-head guarded direct squash;
unknown gate state defers. Node targets instead require authoritative proof of
an ungated destination, cancel native auto-merge and serialize the guarded push.
Gated or unproven node destinations stay open with actionable diagnostics.
Successful push proves merge; forge acknowledgement is best-effort, including
a merged-SHA comment and closing an unacknowledged open review.

Native application receipts bind to exact candidates; consent does not. Every
replacement confirms cancellation first; the next poll reconciles native state
before other actions. Stale enables are repaired by polling. This bounded model
requires replacement-head checks to take far longer than a poll interval. It
has no durable native-effect reservation. Human forge merges record whether a
hold was overridden; possible stale-enable merges raise operator attention.
No result is undone by rewriting the target.

## Forge requirements

The kernel must publish and fetch immutable exact archive refs under
`refs/autobuild/archive/<slug>/<sha>` and replace branches with an exact
expected-old-head guard. Namespace or permission failures stop publication;
there is no branch/tag fallback. Archive retention remains indefinite pending a
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

Publication acknowledgement requires exact authoritative head readback, including
recovery. An unconfirmed candidate's descendants do not prove success. Durable
confirmed receipts preserve historical writes. Local refs cache confirmed heads;
remote expected-head leases and durable writer reservations still guard writes.
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
and warns after validation. Declare only one spelling, including empty arrays.
`ab upgrade` renames the old root key and table headers while preserving policy;
unsupported spellings require the reported manual edit before retrying.

MCP discovery offers `merges.list` and its deprecated alias `landings.list`.
`builds.control` accepts canonical `merge` and deprecated `land` actions through
both MCP bindings. HTTP control bodies and durable event fields retain their
existing wire names, including `land`, `landing.decided`, and `integration.landed`.
