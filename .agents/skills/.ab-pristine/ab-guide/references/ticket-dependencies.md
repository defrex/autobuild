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

Read [nodes and targets](integration-tree.md) for lifecycle, validation and
source storage, and [choosing a destination](integration-tree.md#choosing-a-destination)
when filing a feature set. Blockers order work independently of merge targets;
merge authorization follows the repository's matched policy.

## When a blocker resolves

In a repository with nodes, a blocker that has a build resolves when its change
is present in the dependent's target head (or the configured root branch).
Source done state and aggregate blocker flags do not bypass this gate. A
confirmed merge SHA reachable from the sampled target proves presence even
without a build trailer. A node blocker requires its entire completed owned
contribution, including nested changes and foreign commits, excluding inherited
parent history. An empty completed contribution is satisfied; missing evidence,
an open or aborted node, or ambiguous newest build generations remain queued.
Older successful generations are never substituted for the newest build.

Destination observations retain versioned, head-bound Git witnesses (reachable
commit SHAs and direct build trailers) and a fixed-length evidence digest. Current
confirmed landings and aliases from only the destination's accepted ancestry are
reapplied before reuse. Unrelated merged history and ready destinations do not
invalidate this proof. Head changes require a fresh Git sample; legacy observations
without witnesses refresh once rather than replaying repository history. Current
readiness and newest-generation checks still apply before claim.

- Same node: the blocking change merges directly into the target.
- Ancestor: the change merges into an ancestor, then presence demand restacks only the required path to the target.
- Sibling: the blocking node merges into their common ancestor, then presence demand reaches the target through the minimal ancestor path.
- Descendant: the blocking node merges into the dependent's target ancestor.

Blockers that never had a build, and repositories without nodes, retain the
source's done-state rule. Waiting tickets stay source work; diagnostics identify
the missing blocker and destination. Presence is checked only when claiming,
against an exact sampled head revalidated before claim. Changing presence later
never stops an existing build.
