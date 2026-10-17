# Filing tickets with blockers safely

`ab ticket create --blocked-by` validates prerequisite ids and records blocking
relationships, but a single CLI command is **not an atomic publication guarantee**.
In particular, direct Linear creates the issue first and adds
its blocker relationships in separate requests. If the issue is already in the
ready state, a dispatcher can see it before those relationships exist. A
successful create response containing every blocker does not prove that no build
was claimed during the request. Harvest's durable creation reservations protect
its own filing workflow; ordinary interactive ticket creation has no such hold.

## Safe interactive workflow

For tickets with prerequisites, determine the intended final state from the
human's instruction, then the configured create state or source default. Do not
invent a different final destination. If that destination is ready, or the source
default's eligibility is unknown, stage the ticket in a known non-ready state
before publishing it. Use the repository's triage state when it differs from its
ready state. This temporary staging does not require another placement approval.
If no non-ready state can be established, resolve that before creating the
dependent; never guess that a name such as "Backlog" is safe in every repository.

1. Create prerequisites in dependency order and extract each new `.ref.id` from
   the complete `--json` response, never the human confirmation line.
2. Create the dependent in the non-ready staging state with **all** known
   `--blocked-by` ids in the create command.
3. Read it back with `ab ticket show <id> --json`. Verify its state is still
   non-ready and every expected blocker is present. Repair missing relationships
   through `ab ticket block`, then read back again.
4. Only after verification, move it to the intended final state with
   `ab ticket move <id> <state> --json`. Verify the final state and blockers.

For a repository whose configured triage and ready states are `Triage` and
`Ready`, respectively, and whose human requested ready placement:

```sh
ab ticket create "Dependent" --body dependent.md --state Triage --blocked-by ENG-8,ENG-9 --json > dependent-ticket.json
dependent_id="$(jq -r '.ref.id' dependent-ticket.json)"
ab ticket show "$dependent_id" --json
# Verify state and the full blocker set before the following command.
ab ticket move "$dependent_id" Ready --json
```

If creation fails after an issue may have been written, find and repair that
issue rather than blindly creating a duplicate. Leave partial work non-ready
until the blockers are verified. If the intended destination was already
non-ready, create there, verify, and leave it there. For a source default that
cannot be determined, clarify the final destination rather than silently making
the ticket ready.

## Already-claimed work

Adding blockers does not stop a build already claimed from an earlier listing.
When the human authorizes restarting premature work: request `ab abort <slug>`,
wait for dispatcher cleanup to finish and return the ticket to triage, verify
or repair the blocker set, and only then move the ticket back to ready. Moving
the ticket before cleanup finishes can be overwritten by cleanup. Ready with
unresolved blockers is the normal waiting state: dispatch rechecks dependencies
and claims the ticket only after they resolve and other readiness gates pass.

## Node tickets and targets

Tickets have `kind = "work"` by default, or `kind = "node"` for a named
integration point. The optional `target` is a node ticket id in the same source;
omission means the configured `baseBranch` root. Nodes may target other nodes.
These fields currently describe intent only: dispatch, branches and landing
behavior are unchanged in this increment. Blockers remain a separate graph.

Use `ab ticket create "Integration" --body spec.md --kind node`, then
`ab ticket update <id> --target <node-id>`. Clear a target with `--no-target`;
reset kind with `--kind work`. Omitted fields preserve existing values.
`ab ticket show <id> [--json]` exposes both fields; `ab ticket tree [--json]`
shows the configured root and every ticket, including completed work and empty
nodes, nested by target with state. Siblings are sorted by id. Invalid external
graphs and listing diagnostics are reported explicitly.

Targets must exist and be nodes in the configured source. Self-targeting,
ancestor cycles and demoting a node with targeting tickets are refused before
any part of the requested update is written, regardless of ticket state.
Clear or reparent its children before demotion. File frontmatter persists the
fields; `ab ticket edit` displays them read-only. Change them through update.
Kind and target participate in content revisions and revision-checked writes.
File writes retain their existing best-effort, unlocked concurrency semantics.

Linear uses the exact `node` issue label for kind and the parent relation for
target, only when the parent carries that label. Ordinary grouping parents do
not impose targets and survive unrelated updates. Explicit target clear clears
the parent relation. Label replacements can demote nodes and receive the same
guards; explicit kind and label instructions must agree about `node`. Label
and parent connections are fully paginated. Linear still refuses guarded writes.

Hosted sources and legacy plugins read as work with no target and refuse any
explicit metadata write, including clears and mixed patches, with guidance to
use a capable source. No hosted storage or protocol change is implied.
