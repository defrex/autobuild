---
title: "Tickets and specs"
group: "concepts"
description: "How your operator agent writes buildable specs, chooses ticket kinds, and grooms work for the ready gate."
label: "Tickets and specs"
order: 5
---

# Tickets and specs

A ticket says what change to make and why. The tracker is the input; the build's pinned spec is the execution contract.


## Choose a source

Autobuild ships four ticket sources; plugins can register more through the same port:

- **File** stores tickets in lifecycle directories.
- **Linear** (direct) uses your team's workflow.
- **Hosted** is its own project-scoped service, not a Linear proxy.
- **GitHub** uses the repository's own issues, with states as labels.

The source supplies content, workflow states, labels, and blockers; configuration picks the source and ready gate. Everything else is source-agnostic.

```toml
[tickets]
source = "file"
readyState = "ready"
```

See [Ticket sources](ticket-sources.md) for setup, credentials, configuration and extension contracts.

## Groom a buildable spec

The spec standard asks for:

- **What and why.** The observable change and why it matters; implementation strategy is left to planning.
- **Acceptance criteria.** Verifiable facts that decide whether the work is done.
- **Out of scope.** Adjacent work the build must leave alone.
- **Evidence.** The decision, incident, data, or observations behind the request.

Your operator agent grooms the ticket with you using `ab-spec`, then moves it to the ready state with any required labels. Dispatch's spec gate returns ready tickets that can't become conforming specs to Triage with an explanation.

When the work comes from a forge issue, record it on the ticket: `--issues 824` when the ticket fully resolves issue #824 (`closes`, the default), or `--issues 820:refs` when it only partly addresses it. `ab ticket update --issues` replaces the set and `--issues ''` clears it. Sources that can't store issue links refuse the write and name the source.

A build freezes the links when it claims the ticket. On GitHub, a leaf build that targets the default branch writes `Closes #824` or `Refs #820` lines at the end of its PR body and before the trailers of its landed commit, so merging closes each fully resolved issue and back-links the rest. A leaf that targets a node branch writes only `Refs` lines into its PR body, which never close anything, and none into its landed commit; its links ride up to the root node's PR into the default branch, together with the node's own links, so they close when the node lands. A build that turns out to only partly resolve an issue downgrades it to `refs` with a recorded reason.

```sh
bun ab ticket create "Close stale sandboxes" --body spec.md --issues 824,820:refs
```

When a ticket must go next, such as a fix for a stuck build, mark it urgent instead of moving other tickets out of ready: `--priority urgent` on `ab ticket create` or `ab ticket update`. `--priority normal` removes it. The `file`, `hosted` and `linear` sources store priority. See [Ticket sources](ticket-sources.md#shipped-adapters).

```sh
bun ab ticket update AUT-12 --priority urgent
```

On the `github` source a ticket has assignees. `--assignees alice,me` on `ab ticket create` or `ab ticket update` sets them, where `me` is the owner of the GitHub credential. On update it replaces the whole set, `--assignees ''` clears it, and omitting the option leaves it alone. Set `[tickets].createAssignee` to assign every ticket Autobuild creates, including harvest proposals; explicit `--assignees` replace that default. `ab ticket show` prints the assignees, and JSON ticket reads carry an `assignees` array of usernames. Sources that can't store assignees refuse the option and name the source. See [Ticket sources](ticket-sources.md#shipped-adapters).

```sh
bun ab ticket update 412 --assignees octocat
```


## Backlog and rejected

Two optional lifecycle roles sit beside triage, ready, claimed and done:

- **Backlog** holds work you deferred on purpose. Nothing dispatches from it.
- **Rejected** holds work you considered and declined. A rejected ticket never unblocks the tickets it blocks, and a rejected child no longer holds its node open. The dispatcher moves a ticket here only when an optimization attempt ends without landing, including when you abort it.

Both roles are recommended. Map each to a native state with `[tickets].backlogState` and `[tickets].rejectedState`; `ab init` writes `backlog` and `rejected` for the file, hosted and GitHub sources, and a Linear team might use `Icebox` and `Canceled`. With a key unset, that role doesn't exist, and an [optimization node](optimization-nodes.md) is refused at dispatch: it needs the rejected role for its rejected attempts. Your operator agent moves tickets by role, so it never needs your native names:

```sh
bun ab ticket move AUT-12 --role backlog
```

Moving a ticket back to triage, backlog or ready restores ordinary behavior. "Building" isn't a role you move work into: it's the claimed state (`doing` for the file source), which the dispatcher sets.

## Ready is a gate, not a guarantee

The dispatcher claims only tickets in the ready state with the required labels and any source-specific filter. A ready ticket still waits on:

- **Blockers.** Unresolved prerequisite tickets keep it queued; they don't create a blocked build. With nodes, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration-overview.md).
- **Destination and capacity.** Its target must accept new work, and a capacity slot must be free and not reserved for an integration node awaiting verification, a finished build waiting to re-verify or reconcile, or a build resuming after its ticket wait ends; each of those is admitted before normal claims (see [slot admission order](dispatcher.md#slot-admission-order)). A pending `ab start` request reserves a slot ahead of the claims and parked work its tier outranks.

When a slot is free, the dispatcher takes urgent ready tickets first, then normal ones, each in the source's order. Urgent tickets also go ahead of normal builds waiting to re-verify, reconcile or resume, though not ahead of urgent ones. A claimed ticket's priority becomes its build's priority; to expedite a build that already exists, run `ab priority <slug> urgent`. Priority changes only that order: a blocked urgent ticket waits like any other while normal work proceeds, and an urgent ticket never stops or pauses a running build. The web dashboard's Queue tab lists tickets in the same order and marks urgent ones `URGENT`; the mark shows priority, not that the ticket will dispatch next.

Before ready filing, the agent checks `ab repository status --json`. With live
`operator.registrations`, it records intent, rejected alternatives and out-of-scope
reasons in the ticket body, files, tells you the existing operator will pick it up,
and stops without a watch. Otherwise it takes the operator role for the builds the repository's dispatcher dispatches.
Your explicit instruction overrides either default; non-ready work needs no watch.

At dispatch, Autobuild pins the spec, so later tracker edits don't change what reviewers approved. Editing the ticket alone publishes nothing; a deliberate revision must be published explicitly, and restarts planning. For a blocked build, your operator agent publishes it while answering an escalation:

```sh
bun ab answer <slug> --revise-spec-from-ticket
```

For a finished leaf that is waiting for its merge decision and not yet merged, reopen it with the revision instead; no escalation is needed, and the open PR is kept. Revising from the ticket also re-pins its assets. See [Send a finished build back](operating.md#send-a-finished-build-back):

```sh
bun ab reopen <slug> --revise-spec-from-ticket
```


## Work and node tickets

| Kind | Describes | Runs |
|---|---|---|
| Work | an individual change | the build pipeline |
| Node | a finite integration point | collects related work, verifies it together, merges into its parent |

Both kinds need conforming specs; a node's intent alone isn't a buildable contract. Set the kind with `ab ticket create` or `ab ticket update --kind work|node`. See [integrating related work](integration-overview.md) for targets, node admission and merge.

Outside signals and agent discoveries enter through [Intake and harvest](intake.md) as proposals, groomed before they become ready work.

Follow the [dispatcher guide](dispatcher.md) for what happens at claim, or [Getting started](getting-started.md) for a first ticket.
