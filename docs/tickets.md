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


## Backlog and rejected

Two optional lifecycle roles sit beside triage, ready, claimed and done:

- **Backlog** holds work you deferred on purpose. Nothing dispatches from it.
- **Rejected** holds work you considered and declined. A rejected ticket never unblocks the tickets it blocks, and a rejected child no longer holds its node open.

Both roles are recommended. Map each to a native state with `[tickets].backlogState` and `[tickets].rejectedState`; `ab init` writes `backlog` and `rejected` for the file, hosted and GitHub sources, and a Linear team might use `Icebox` and `Canceled`. With a key unset, that role doesn't exist. Your operator agent moves tickets by role, so it never needs your native names:

```sh
bun ab ticket move AUT-12 --role backlog
```

Moving a ticket back to triage, backlog or ready restores ordinary behavior. "Building" isn't a role you move work into: it's the claimed state (`doing` for the file source), which the dispatcher sets.

## Ready is a gate, not a guarantee

The dispatcher claims only tickets in the ready state with the required labels and any source-specific filter. A ready ticket still waits on:

- **Blockers.** Unresolved prerequisite tickets keep it queued; they don't create a blocked build. With nodes, prerequisites with builds must be present at the sampled destination; see [integration and blocker presence](integration-overview.md).
- **Destination and capacity.** Its target must accept new work, and a capacity slot must be free.

Before ready filing, the agent checks `ab repository status --json`. With live
`operator.registrations`, it records intent, rejected alternatives and out-of-scope
reasons in the ticket body, files, tells you the existing operator will pick it up,
and stops without a watch. Otherwise it takes the operator role for the builds the repository's dispatcher dispatches.
Your explicit instruction overrides either default; non-ready work needs no watch.

At dispatch, Autobuild pins the spec, so later tracker edits don't change what reviewers approved. A deliberate revision goes through your operator agent answering an escalation, and restarts planning:

```sh
bun ab answer <slug> --revise-spec-from-ticket
```


## Work and node tickets

| Kind | Describes | Runs |
|---|---|---|
| Work | an individual change | the build pipeline |
| Node | a finite integration point | collects related work, verifies it together, merges into its parent |

Both kinds need conforming specs; a node's intent alone isn't a buildable contract. Set the kind with `ab ticket create` or `ab ticket update --kind work|node`. See [integrating related work](integration-overview.md) for targets, node admission and merge.

Outside signals and agent discoveries enter through [Intake and harvest](intake.md) as proposals, groomed before they become ready work.

Follow the [dispatcher guide](dispatcher.md) for what happens at claim, or [Getting started](getting-started.md) for a first ticket.
