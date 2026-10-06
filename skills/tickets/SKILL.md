---
name: tickets
description: Work this repo's local ticket tracker — create or edit a ticket, amend blockedBy dependencies, report the backlog, triage the inbox, move work between the lifecycle directories and any repository-defined states such as the icebox, or answer "what's the status of ticket X". Use whenever the user asks about tickets, blockers, the backlog, or wants something queued for autobuild to build.
---

# /tickets

The local ticket tracker is a directory of markdown files. `ls` and `mv` are
the state/backlog UI; source-agnostic `ab ticket` commands create and edit
content and blocker relationships. The default file source needs no secret.

## Where it lives

`.autobuild/tickets/` by default (if `autobuild.toml` has a `[tickets] dir`,
that directory instead), holding the four lifecycle state directories plus any others this repo adds.
`triage/`, `ready/`, `doing/`, and `done/` are the lifecycle directories the
dispatcher uses. Any other directory is a repository-defined state: the
dispatcher never moves tickets into it and never dispatches from it unless
`autobuild.toml` names it (for example `readyState` or `proposalState`).

```
.autobuild/tickets/
  triage/   # filed, not groomed — the inbox
  ready/    # groomed; file lifecycle-state gate satisfied
  doing/    # claimed; a build is running
  done/     # merged
  icebox/   # example of a repo-added state, present only once created
```

**A ticket's state is the directory it is in.** There is no `state` field
anywhere. Do not try to change a ticket's state by editing the file.

Each ticket is `<id>.md`: TOML frontmatter between `+++` fences carrying `id`
and `title` (and optional `labels` and `blockedBy`), then the body — which is
the spec.

## Create a ticket

```
ab ticket create "Rate-limit auth endpoints" --body spec.md [--labels bug,api] [--blocked-by file-1,file-2]
```

It lands in `triage/` and prints the new id. `--body` is a file, and its
contents are the spec — write it to the complete
[spec standard](../ab-guide/references/spec-standard.md) first (`/ab-spec` is
the conversational way to get there). A ticket whose body isn't a conforming
spec gets bounced back to `triage/` by the dispatcher rather than built.
Blocker ids are source-local; every blocker must exist before creation
succeeds.

For dependencies on any source, follow the
[safe blocker-filing workflow](../ab-guide/references/ticket-dependencies.md).
Direct and hosted Linear record blockers after creating the issue, so a ready
issue can be claimed before `create --blocked-by` returns. Stage dependents in a
known non-ready state, verify all blockers with `ab ticket show --json`, then use
`ab ticket move` to publish the intended ready destination. Do not use the local
file tracker's default state as an assumption about another configured source.

## Edit content or blockers

Use the configured TicketSource rather than hand-editing frontmatter/body:

```
ab ticket update file-3 --body spec.md
ab ticket update file-3 --title "New title" --labels bug,api
ab ticket update file-3 --labels ''
ab ticket block file-3 file-1
ab ticket unblock file-3 file-1
```

Update is partial: omitted fields stay untouched, while an explicitly empty
`--labels` clears labels. It cannot change state. For block/unblock the first
id is the ticket being edited; the second is its blocker. Both are safe to
retry, and adding validates the blocker exists and is not the ticket itself.

## Report the backlog

```
ab ticket states                # every state, lifecycle and custom: role, count, purpose
ls .autobuild/tickets/ready     # groomed candidates in the ready lifecycle state
ls .autobuild/tickets/doing     # what's building right now
```

The filename is the id. For a title, read the file's frontmatter. To report
the whole backlog, cover every state — lifecycle and custom — via
`ab ticket states` or by listing every directory under the tracker root, so the
report includes `icebox/` and any other category. `ab ticket list` without
filters shows only the ready state, regardless of custom states, so it is not a
backlog report.

## Groom / transition a ticket

Move the file:

```
mv .autobuild/tickets/triage/file-3.md .autobuild/tickets/ready/
```

**Use `mv`, never `cp`.** A copy leaves the id in two state directories, and
every ticket operation — including the dispatcher's scan — then fails loudly
naming both paths. That is on purpose: the alternative is dispatching one
ticket twice.

Moving a file ticket into `ready/` satisfies the local file tracker's
lifecycle-state gate. It makes the ticket a dispatch candidate; it does not
guarantee an immediate claim. An unresolved `blockedBy` dependency prevents
dispatch even when the ticket's state, labels, and spec otherwise qualify. The
dependent stays in `ready/`, unclaimed and without a build.

The dependency gate clears once every declared blocker has either reached the
source's completed state (`done/` for the file tracker) or had its relationship
deliberately removed with `ab ticket unblock file-3 file-1`. The dispatcher
re-evaluates the dependent on a later tick; it can then become eligible without
another move to `ready/`, subject to the remaining dispatch gates and available
capacity. Blocker edits must use the source-agnostic `ab ticket block` and
`ab ticket unblock` commands shown above.

When the dispatcher claims an eligible file ticket, it moves it to `doing/`,
then to `done/` on merge or back to `triage/` if the build aborts or the spec
bounces.

**Don't hand-move anything out of `doing/`** — a build owns it. If you need to
stop a build, that's `ab` (or a human), not `mv`.

## Icebox

`icebox/` is work deliberately deferred, groomed or not, that nothing
dispatches from. The first time it is needed, create it:

```
ab ticket state create icebox --about "Deferred on purpose; nothing dispatches from here"
```

Move a ticket in with `ab ticket move file-3 icebox`. To revive one, move it to
`triage/` when it needs regrooming, or to `ready/` when its spec still holds.

## Triage the backlog

To run a pass over `triage/`:

1. Run `ab ticket states` to see which destinations exist.
2. For each ticket in `triage/`, read it with `ab ticket show <id>` and judge
   whether its body meets the
   [spec standard](../ab-guide/references/spec-standard.md).
3. Move it to `ready/` if it conforms and should be built; to `icebox/` if it
   should wait; to another existing category if one fits; otherwise leave it in
   `triage/` and tell the user why.
4. Report every move to the user in the session — id, title, destination, and
   reason. A move leaves no comment on the ticket, so the report is the only
   record of why.

## Inventing categories

Run `ab ticket states` before creating anything. Reuse an existing state whose
purpose fits. Create a new one only for a recurring reason that no existing
state covers, with a lowercase hyphenated noun name and a one-line `--about`
purpose. `icebox` is the first worked example; `rejected` is a second:

```
ab ticket state create rejected --about "Considered and declined; kept for the record"
```

Never invent a second ready, doing, or done state, never move anything out of
`doing/`, and never create states for a build's internal progress — the
lifecycle belongs to the dispatcher. Remember that `ab ticket list` without
filters still shows only the ready state, however many custom states exist.

## Rules

- Never edit frontmatter to change state — the directory is the state.
- Use `ab ticket update|block|unblock` for body, title, label, and `blockedBy`
  changes; do not hand-edit those fields.
- Never `git add` the tracker. The backlog is local-machine state, not shared
  work; nothing here is published by committing it. (The default tracker
  carries its own `.gitignore`, so git does not see it at all. Under an
  explicit `[tickets] dir` the directory is the user's — it may well be
  tracked — so the rule stands on its own either way.)
- Ids are allocated by `ab ticket create`. Don't hand-write ticket files.

## What is not here

No default label gate for the file tracker: labels do not narrow the ready
listing under default config. That does not make `ready/` sufficient;
unresolved blockers are an independent dispatch gate.

No Linear lifecycle UI. Directory-based lifecycle operations (`ls`, `mv`, and
the state directories) are file-tracker-only. If this repo's
`autobuild.toml` sets `[tickets] source = "linear"`, do not apply that lifecycle
guidance: state and labels live in Linear. The source-agnostic `ab ticket block`
and `ab ticket unblock` commands still edit blocker relationships through the
configured source.
