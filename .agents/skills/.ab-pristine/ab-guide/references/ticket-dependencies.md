# Filing tickets with blockers safely

`ab ticket create --blocked-by` validates prerequisite ids and records blocking
relationships, but on most sources a single CLI command is **not an atomic
publication guarantee**. Direct Linear creates the issue first and adds its
blocker relationships in separate requests. If the issue is already in the
ready state, a dispatcher can see it before those relationships exist. A
successful create response containing every blocker does not prove that no build
was claimed during the request. Harvest's durable creation reservations protect
its own filing workflow; ordinary interactive ticket creation has no such hold.

GitHub stages for you. A ready-bound create with blockers opens in triage,
records every blocker, and only then moves to ready. Claim also re-reads
blockers fresh, so one `create --blocked-by` never exposes an unblocked ready
ticket and needs no manual staging. A partial failure leaves the ticket in
triage, so reading it back still matters. The workflow below is the portable
procedure for any source whose create order you do not know.

## Safe interactive workflow

For tickets with prerequisites, determine the intended final state from the
human's instruction, then the configured create state or source default. Do not
invent a different final destination. If that destination is ready, or the source
default's eligibility is unknown, stage the ticket in a known non-ready state
before publishing it. Use the repository's triage state when it differs from its
ready state. This temporary staging does not require another placement approval.
If no non-ready state can be established, resolve that before creating the
dependent; never guess that a name such as "Backlog" is safe in every repository.
A configured backlog role is a known non-ready state: `ab ticket move <id>
--role backlog` reaches it without knowing its native name.

1. Create prerequisites in dependency order and extract each new `.ref.id` from
   the complete `--json` response, never the human confirmation line.
2. Create the dependent in the non-ready staging state with **all** known
   `--blocked-by` ids in the create command.
3. Read it back with `ab ticket show <id> --json`. Verify its state is still
   non-ready and every expected blocker is present. Repair missing relationships
   through `ab ticket block`, then read back again.
4. Only after verification, move it to the intended final state with
   `ab ticket move <id> <state> --json`, or by role with
   `ab ticket move <id> --role ready --json`. Verify the final state and blockers.

A blocker in the configured rejected state never resolves: its dependents stay
unclaimed until the blocker leaves that state or is removed with
`ab ticket unblock`.

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
This recipe applies to ordinary tickets. Aborting an
[optimization attempt](optimization-nodes.md#landing-and-settlement) settles it
`aborted` and its node moves the ticket to rejected, whatever `--to` says, and
no `ticket.handed-back` event follows; wait for the node's
`attempt.ticket-rejected` instead.
When the human authorizes restarting premature work and the blocker set is
already right, request `ab abort <slug> --to ready`: cleanup moves the ticket
straight back to ready with its blockers kept, so no second move is needed.
If the ticket no longer meets the spec standard, cleanup returns it to triage
instead and the hand-back names the missing parts; groom it before moving it
to ready.
If the blockers need changing first, verify or repair them once the
`ticket.handed-back` repository event for that build arrives; the dispatcher
writes nothing to the ticket for that hand-back afterwards. Ready with
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

Destination observations record a head-bound, query-scoped probe rather than
the destination's history: only the commit SHAs and direct build trailers in the
proof closure of the identities being decided (blocker identities, plus the
landings and confirmed foreign aliases that could transport them), which of those
are reachable from the sampled head, presence answers for only those identities,
and a fixed-length evidence digest. Observation size is bounded by that closure,
independent of the destination's reachable commit count and of repository history.
While the head is unchanged and the probe covers the current questions, current
confirmed landings and aliases from only the destination's accepted ancestry are
reapplied without Git; unrelated merged history and ready-set changes neither
invalidate it nor append events. A moved head requires a fresh Git sample. A
newly relevant landing or a new question needs only a new probe: a dispatcher
still holding the full in-memory witness for that branch and head compacts one
without Git, and otherwise samples Git once. Observations without a probe,
including older full-history witnesses, are never trusted for admission: they
are re-derived once the same way, and an unavailable sample leaves the dependent
queued; neither replays repository history. Current readiness and
newest-generation checks still apply before claim.

- Same node: the blocking change merges directly into the target.
- Ancestor: the change merges into an ancestor, then presence demand restacks only the required path to the target.
- Sibling: the blocking node merges into their common ancestor, then presence demand reaches the target through the minimal ancestor path.
- Descendant: the blocking node merges into the dependent's target ancestor.

Blockers that never had a build, and repositories without nodes, retain the
source's done-state rule. Waiting tickets stay source work; diagnostics identify
the missing blocker and destination. Presence is checked only when claiming,
against an exact sampled head revalidated before claim. Changing presence later
never stops an existing build.
