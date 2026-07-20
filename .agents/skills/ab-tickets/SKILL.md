---
name: ab-tickets
description: Work this repo's local ticket tracker — create or edit a ticket, amend blockedBy dependencies, report the backlog, move work between triage/ready/doing/done, or answer "what's the status of ticket X". Use whenever the user asks about tickets, blockers, the backlog, or wants something queued for autobuild to build.
---

# /tickets

The local ticket tracker is a directory of markdown files. `ls` and `mv` are
the state/backlog UI; source-agnostic `ab ticket` commands create and edit
content and blocker relationships. The default file source needs no secret.

## Where it lives

`.autobuild/tickets/` by default (if `autobuild.toml` has a `[tickets] dir`,
that directory instead), holding exactly four state directories:

```
.autobuild/tickets/
  triage/   # filed, not groomed — the inbox
  ready/    # groomed and dispatchable
  doing/    # claimed; a build is running
  done/     # merged
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
contents are the spec — write it to the spec standard first
(`docs/spec-standard.md`; `/ab-spec` is the conversational way to get there).
A ticket whose body isn't a conforming spec gets bounced back to `triage/` by
the dispatcher rather than built. Blocker ids are source-local; every blocker
must exist before creation succeeds.

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
ls .autobuild/tickets/ready     # what's dispatchable
ls .autobuild/tickets/doing     # what's building right now
```

The filename is the id. For a title, read the file's frontmatter. To report
the whole backlog, list all four directories — that listing is complete and
current by construction.

## Groom / transition a ticket

Move the file:

```
mv .autobuild/tickets/triage/file-3.md .autobuild/tickets/ready/
```

**Use `mv`, never `cp`.** A copy leaves the id in two state directories, and
every ticket operation — including the dispatcher's scan — then fails loudly
naming both paths. That is on purpose: the alternative is dispatching one
ticket twice.

Moving a ticket into `ready/` is the *entire* act of dispatching it. The
dispatcher picks it up on its next tick, moves it to `doing/` when it claims
it, `done/` on merge, and back to `triage/` if the build aborts or the spec
bounces.

**Don't hand-move anything out of `doing/`** — a build owns it. If you need to
stop a build, that's `ab` (or a human), not `mv`.

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

No label gate: `ready/` alone decides dispatchability under default config.
Labels exist as an optional frontmatter field, nothing more.

No Linear. If this repo's `autobuild.toml` sets `[tickets] source = "linear"`,
none of the above applies — the tracker is Linear, and state and labels live
there.
