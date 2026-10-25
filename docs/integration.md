# Iterating inside an integration node

A node collects related work into one finite delivery to its parent. Write its
ticket as a charter: why the integration matters, what observable conditions
make the whole done, and where and how it merges under the repository's effective
merge policy. Keep the usual spec sections: what and why, checkable acceptance
criteria, out of scope, and evidence. Put evolving feature specifics in children.

For example, a charter can aim for a coherent account-management flow, complete
when account settings and closure work together and pass integration verification.
Child tickets define the detailed behavior of those flows.

Create the node and children with ids returned by your ticket source:

```sh
ab ticket create "Account management" --body charter.md --kind node
ab ticket create "Account settings" --body settings.md --target <node-id>
ab ticket tree
```

While the node is open, add more spec-standard children as needed. Each ordinary
child runs its normal pipeline. Node verification uses contribution provenance
to judge ordinary changes against either the current event-authorized node
charter or the introducing child's spec. Each child need not be independently
promised by the charter.

For small maintainer-authorized tweaks, push to the node's recorded branch with
meaningful commit messages explaining intent. Verification reads the owned
hand-pushed commit messages in the frozen range and judges quality and
consistency; it cannot fail a tweak solely for lacking a covering spec.
Phase agents still follow their own publication boundaries.

When the charter itself changes, explicitly revise the active build:

```sh
ab answer <node> --revise-spec replacement.md
```

Alternatively, amend the ticket, then run
`ab answer <node> --revise-spec-from-ticket`. Editing the ticket alone does not
revise the build. Eligible idle collecting or verification-failed nodes recollect
and verify the replacement revision, even on the same head and parent after a
failed cycle. Children retain their specs, claims and targets.

Open children, including triage, backlog and ready tickets, keep the node
incomplete. Once complete, the node must pass verification on its exact head and
parent and satisfy its configured merge gates. Merge completes the node and
closes admission; use a new node for a later delivery. Consent requirements depend
on the effective policy.

See [integration trees](integration-tree.md#collect-verify-and-merge) for provenance
and completion details, [revision restrictions](integration-tree.md#operator-node-spec-revisions)
for when a replacement is accepted, and [merge policy](merge-policy.md) for
merge and consent rules.
