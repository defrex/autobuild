# Migrating from 0.x to 1.0

The integration tree changes replay and landing authorization. It does not cut a
release or rename `baseBranch`: that setting now names the tree root. Existing
tickets default to work with no target and continue targeting the root. Adopt
nodes only when useful; see [integration trees](integration-tree.md).

## Configuration and installed skills

Run `ab upgrade` against the intended repository. It updates the recognized
installation and three-way merges vendored skills with their pristine defaults;
review local conflicts. `--no-self-update` skips installation update while still
performing repository migration and skill merging. Preserve local customizations
and use the installed [setup reference](setup.md) to review verification and roles.

When `landing` is absent, upgrade reads the target repository's configured
BuildStore journal, ignoring ambient `AB_STORE` for that choice, and appends:

| Legacy repository default | Leaf rule | Node rule |
|---|---|---|
| ON | auto | consent |
| OFF or no fact | consent | consent |

A genuinely absent local journal counts as no fact. An unreadable or unavailable
journal fails migration with guidance: restore store access and retry, or write
explicit rules after deciding the desired policy. Existing valid landing arrays
are preserved byte-for-byte, including root-level `landing = []`, which selects
the new leaf-auto/node-consent defaults. Fresh init uses those new defaults.
See [landing policy](landing-policy.md) for complete worked configurations.

The repository auto-merge default, its fan-out and old CLI/default controls are
retired. Use `ab land` and `ab hold`, not an old repository switch. Historical
explicit per-build `build.auto-merge-requested`/`cancelled` facts map to land/hold
until a new landing command supersedes them; historical default-seeded requests
confer no consent. New claims do not materialize old defaults.

## Builds already in flight

Historical events and merge reconciliations keep their replay/display meaning;
old merge commits remain valid history. Later replay uses the promoted historical
contribution base. The current engine can restack resumed builds at newly reached
verification or waiting-for-landing boundaries, and current landing rules govern
new readiness decisions. There is no claim-version switch promising every old
build finishes with the old merge standard. Drain old work before switching
versions if retaining old execution behavior is required. Simultaneous old and
new writers are not a supported migration strategy.

Execution pipeline configuration stays owned by the build and is re-pinned
from its checkout at each verify cycle; live dispatcher
landing policy is separate. A recorded readiness decision retains its rule
snapshot despite configuration edits; a new candidate receives a new decision.
Explicit consent persists through replay and re-verification until hold or
completion, except accepted node reparenting revokes it.

## The reversed rebase ban

The old ban protected event-recorded SHAs and avoided resolving the same conflict
for every WIP commit. The new standard replays one net leaf change or ordered
node contributions, retains displaced history through immutable archive refs and
durable rewrite facts, and resolves each conflicted item once. Ordinary agent
rebase of WIP history is still inappropriate. Agents resolve kernel-prepared
replay; the kernel owns branch replacement with expected-head guards.

Root leaves squash; node destinations and local-git root nodes fast-forward;
GitHub root nodes use guarded rebase merge with recorded fencing/audit limits.
Check [forge requirements](landing-policy.md#forge-requirements) and
[restacking](restacking.md) before enabling nodes on a plugin forge. Ensure
archive publication/read permissions, tree capabilities and required merge
methods are available; legacy read compatibility is insufficient.

## Demand-driven node restacks

Parent movement is now observed without starting a node replay. Existing frozen
transactions finish after upgrade; subsequent replay needs completeness before
verification, freshness before landing, dependency presence, operator demand
(`ab restack <node>`), or accepted re-parenting. Nested nodes need independent
demand. Leaves keep their existing timing. There is no eager compatibility mode.
See [restacking](restacking.md) for durable requests and parent commit distance.
