---
name: ab-tickets
description: Work this repo's local ticket tracker — create or edit a ticket, amend blockedBy dependencies, report the backlog, triage the inbox, move work between lifecycle roles (triage, backlog/icebox, ready, rejected) and any repository-defined states, or answer "what's the status of ticket X". Use whenever the user asks about tickets, blockers, the backlog, or wants something queued for autobuild to build.
---

# /tickets

The local ticket tracker is a directory of markdown files. `ls` and `mv` are
the state/backlog UI; source-agnostic `ab ticket` commands create and edit
content and blocker relationships. The default file source needs no secret.

## Node tickets and targets

Use a spec-standard charter for the node's integration goal, whole-level
completion and policy-controlled merge; put feature specifics in children.
While the node is open, iterate by adding spec-standard children targeting its
ticket id, pushing small maintainer-authorized tweaks to its recorded branch
with meaningful intent in commit messages, or explicitly revising its charter.
Node verification judges ordinary changes against the current event-authorized
charter or the introducing child's spec through the provenance mapping. Owned
hand-pushed commit messages authorize tweaks, judged for quality and consistency;
a missing covering spec alone is not a failure.

A ticket edit alone does not revise the active build. Use
`ab answer <node> --revise-spec replacement.md` or
`ab answer <node> --revise-spec-from-ticket`; children keep their specs, claims
and targets while the node recollects and verifies the new revision, including
on the same head after failure. See
[iterating inside a node](../ab-guide/references/integration-tree.md#iterating-inside-a-node)
and [revision restrictions](../ab-guide/references/integration-tree.md#operator-node-spec-revisions).
Open children keep the node incomplete, including triage, backlog and ready
children; a rejected child does not. Completed nodes close admission.

For node lifecycle, target validation and source-specific storage, read
[nodes and targets](../ab-guide/references/integration-tree.md). When filing
related work, follow the shared
[destination choice](../ab-guide/references/integration-tree.md#choosing-a-destination)
guidance before choosing root or a node.

```sh
ab ticket create "Integration" --body spec.md --kind node
ab ticket create "Child" --body child.md --target <node-id>
ab ticket update <id> --target <node-id>
ab ticket update <id> --no-target
ab ticket update <id> --kind work
ab ticket show <id> --json
ab ticket tree --json
```

## Hosted ticket ids

When `[tickets].source = "hosted"`, use readable ids such as `ENG-12` with
`ab ticket show`, `update`, `move`, `block`, and `unblock`. Inputs accept any
letter case and old UUID ids remain aliases. Output shows canonical readable
ids; blocker references use the same identity. Numbering belongs to each project
and never resets or reuses deleted numbers within a project lifetime. Permanent
project deletion removes the counter; browser-approved reconnection starts at 1. A `teamKey` change affects future
prefixes only. File and Linear id rules are unchanged. See the
[hosted ticket protocol](../ab-guide/references/remote-ticket-protocol.md).

## Where it lives

`.autobuild/tickets/` by default (if `autobuild.toml` has a `[tickets] dir`,
that directory instead), holding the four lifecycle state directories plus any others this repo adds.
`triage/`, `ready/`, `doing/`, and `done/` are the lifecycle directories the
dispatcher uses. Any other directory is a repository-defined state: the
dispatcher never moves tickets into it and never dispatches from it unless
`autobuild.toml` names it (for example `readyState` or `proposalState`).
The optional backlog and rejected roles are directories too, named by
`[tickets].backlogState` and `rejectedState` (`ab init` writes `backlog` and
`rejected`); the dispatcher never claims from or moves into them.

```
.autobuild/tickets/
  triage/    # filed, not groomed — the inbox
  ready/     # groomed; file lifecycle-state gate satisfied
  doing/     # claimed; preparing or running a build
  done/      # merged
  backlog/   # the backlog role once configured and first used
  rejected/  # the rejected role once configured and first used
```

"Building" is the claimed role, `doing/` for this tracker. It is not a role you
move work into: the dispatcher moves a ticket there when it claims it.

**A ticket's state is the directory it is in.** There is no `state` field
anywhere. Do not try to change a ticket's state by editing the file.

Each ticket is `<id>.md`: TOML frontmatter between `+++` fences carrying `id`
and `title` (and optional `labels`, `blockedBy` and `issueLinks`), then the body — which is
the spec.

## Create a ticket

```
ab ticket create "Rate-limit auth endpoints" --body spec.md [--labels bug,api] [--blocked-by file-1,file-2] [--issues 824,820:refs]
```

It lands in `triage/` and prints the new id. `--body` is a file, and its
contents are the spec — write it to the complete
[spec standard](../ab-guide/references/spec-standard.md) first (`/ab-spec` is
the conversational way to get there). A ticket whose body isn't a conforming
spec gets bounced back to `triage/` by the dispatcher rather than built.
Blocker ids are source-local; every blocker must exist before creation
succeeds. When the ticket originates from a forge issue, attach it with
`--issues`: `N` (intent `closes`, the default) when the ticket fully resolves
the issue, `N:refs` when it only partly addresses it.

For dependencies on any source, follow the
[safe blocker-filing workflow](../ab-guide/references/ticket-dependencies.md).
Direct Linear and GitHub record blockers after creating the issue, so a ready
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
ab ticket update file-3 --issues 824:refs
ab ticket block file-3 file-1
ab ticket unblock file-3 file-1
```

Update is partial: omitted fields stay untouched, while an explicitly empty
`--labels` clears labels. `--issues` replaces the whole set of issue links and
`--issues ''` clears it. It cannot change state. For block/unblock the first
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
report includes the backlog and rejected states and any other category. The
roles column of `ab ticket states` names which states hold `backlog` and
`rejected`. `ab ticket list` without filters shows only the ready state,
regardless of other states, so it is not a backlog report.

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
bounces. A caught failure before build creation returns it to configured Ready
after safe ownership checks; unfinished recovery stays durably tracked and
withheld from another claim. Uncertain ownership or externally changed/missing
tickets end automatic recovery with an `abandoned` resolution, reported once
in that tick's dispatcher diagnostics, leaving the ticket unchanged for
operator inspection. See [preparation recovery](../ab-guide/references/restacking.md#ticket-preparation-before-build-creation).

**Don't hand-move anything out of `doing/`** — dispatch preparation or a build owns it. If you need to
stop a build, that's `ab` (or a human), not `mv`.

Before moving work into `ready/` (or any source's configured ready state),
check `ab repository status --json` for live `operator.registrations`. If an
operator is present, preserve intent, rejected alternatives and out-of-scope
reasons in the ticket body, file, tell the human the existing operator will
pick it up, and stop without a watch. Otherwise load `ab-operate` and take the
role for the builds the repository's dispatcher dispatches. Explicit human
instructions override these defaults; non-ready filing needs no watch. See
[After filing](../ab-spec/SKILL.md#after-filing-check-operator-presence).

## Backlog (icebox)

The backlog role holds work deliberately deferred, groomed or not, that nothing
dispatches from. "Ice it", "icebox" and "backlog" all mean this role. Move by
role, so you never need the repository's native name:

```
ab ticket move file-3 --role backlog
```

A source that creates states creates the role state on first use. To revive a
ticket, use `--role triage` when it needs regrooming, or `--role ready` when its
spec still holds.

## Rejected

The rejected role holds work that was considered and declined. "Reject" and
"won't do" mean this role:

```
ab ticket move file-3 --role rejected
```

A rejected ticket never resolves a blocker: tickets it blocks stay unclaimed,
and `ab ticket show` marks it `(rejected)`. A rejected child no longer keeps its
node incomplete. Moving it back to triage, backlog or ready restores ordinary
behavior with no other step.

## When a role is not configured

Both roles are optional. When the repository has not set the key, the move is
refused with a message naming it (`[tickets].backlogState` or
`[tickets].rejectedState`). Tell the human, and recommend setting the key to the
state that should hold that work, for example `backlogState = "backlog"`. Do not
invent a custom state in its place, and do not move to a state that only shares
the role's name: without the key, that state holds no role.

## Triage the backlog

To run a pass over `triage/`:

1. Run `ab ticket states` to see which destinations exist.
2. For each ticket in `triage/`, read it with `ab ticket show <id>` and judge
   whether its body meets the
   [spec standard](../ab-guide/references/spec-standard.md).
3. Move it with `--role ready` if it conforms and should be built,
   `--role backlog` if it should wait, or `--role rejected` if it won't be
   done; to another existing category if one fits; otherwise leave it in
   `triage/` and tell the user why.
4. Report every move to the user in the session — id, title, destination, and
   reason. A move leaves no comment on the ticket, so the report is the only
   record of why.

## Inventing categories

Run `ab ticket states` before creating anything. Reuse an existing state whose
purpose fits. Create a new one only for a recurring reason that no existing
state covers, with a lowercase hyphenated noun name and a one-line `--about`
purpose:

```
ab ticket state create needs-design --about "Waiting on a design decision"
```

Deferred and declined work belong to the backlog and rejected roles, never to an
invented state; see [When a role is not configured](#when-a-role-is-not-configured).
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

No GitHub lifecycle UI either. When `[tickets] source = "github"`, tickets are
the repository's issues and ids are issue numbers (`123` or `#123`). State
lives on GitHub as one `autobuild:<state>` label on an open issue (none means
triage) and as the closing reason (completed is done, not planned is the
rejected role). Issue links to other issues are `autobuild-link:<intent> #<n>`
labels, and blockers are native issue dependencies. Use `ab ticket move` and
`--issues` rather than editing those labels on GitHub, and never leave two state
labels on one issue: it drops out of listings until one is removed.
`ab ticket state create` makes the `autobuild:<state>` label, with the purpose
as its description, and refuses an existing name as hosted creation does. GitHub
tickets carry no comment history, so `ab ticket show` lists none; only
`ab ticket export` and `import` read it.

## Hosted ticket states

For `[tickets].source = "hosted"`, states are project-owned service data.
Run `ab ticket states` before creating a state, and reuse an existing purpose
when it fits. `ab ticket state create needs-design --about "Waiting on design"` creates
an empty state with an optional one-line, nonblank purpose. Custom names use
one to forty lowercase letters, digits, or hyphens, starting with a letter.
Hosted creation refuses an existing name in any letter case and never replaces
its purpose; file creation remains idempotent and can update the purpose.

Use `ab ticket create --state <name>`, `ab ticket move <id> <name>`, and
`ab ticket list --state <name>` with any existing state. Unknown states are
refused with the available names. Configured states are added automatically;
former configuration roles remain custom states with their tickets intact.
Listing puts role-holding states first in workflow order (triage, backlog,
ready, claimed, done, rejected), then other states, including empty states and
purposes. Move by role with `ab ticket move <id> --role backlog|rejected|triage|ready`
exactly as for the file source; MCP `tickets.move` takes the same roles. A role
mapped onto an existing state, such as `backlogState = "icebox"`, keeps that
state and its tickets. Configured names keep their spelling; lookup prefers an exact match, then a unique
case-insensitive match. States belong to one project.

The directory `ls` and `mv` instructions above apply only to the file source.
For MCP, use `tickets.states` and `tickets.state.create`; the latter requires
an attributed operator identity and normal project authorization.

## Revision-checked ticket writes

Every ticket read includes an opaque `revision`. Pass it as `expectedRevision`
(on MCP/operator requests) or `--expected-revision <opaque>` on `ab ticket update`,
`move`, `block` and `unblock`. A stale write fails without changing anything and
reports the current revision. Omission preserves unguarded behavior. Blocker
checks cover the entire batch. Dispatcher moves remain unguarded and change the
revision. Sources without guarded writes, including Linear and GitHub, refuse
supplied revisions rather than ignoring them.

`ab ticket edit <id>` opens `$VISUAL`, falling back to `$EDITOR`, using TOML
frontmatter and a Markdown body. Only title, body and labels are editable;
kind, target, id, blockers, issue links, creation key and reference comments are read-only. It saves only
changed fields with the opening revision. Sources without guarded writes,
including Linear and GitHub, re-read the ticket immediately before an
unguarded write and refuse a changed revision, with the no-lock race window of file checks. Unchanged or formatting-only edits
write nothing. On conflict, invalid input or editor failure, the error names an
absolute file path containing the edited text. Read the current ticket and
reapply the intended changes before retrying; conflicts are never merged.

File and Linear revisions fingerprint kind, target, title, body, canonical label/blocker sets
and state; file revisions also cover nonempty issue links. GitHub revisions
fingerprint title, body, canonical label/blocker sets, state and issue links,
including the ticket's own issue; GitHub tickets carry no comments. Reverting identical
content restores its fingerprint. File checks
re-read immediately before writing, with the existing no-lock race window.
Direct file edits and state-directory moves change revisions. File comments
change the body and revision; separate hosted comments do not. Hosted revisions
are monotonic decimal bigint strings, and checks run under the same row lock
and transaction as all requested changes. Hosted reads return a coherent
snapshot of fields, blockers and revision.

Read before writing, and copy the opaque revision verbatim:

```sh
ab ticket show AUT-8 --json
ab ticket update AUT-8 --title 'Revised title' --expected-revision '<revision from show>'
ab ticket edit AUT-8
```

Use `expectedRevision` on MCP `tickets.update`, `tickets.move`, `tickets.block`
and `tickets.unblock` with the revision from `tickets.get` or `tickets.list`.
