---
name: ab-reconcile
description: Resolve a conflicted PR by merging base into the build branch. Invoked by the build-runner as the reconcile phase; takes only the build slug.
disable-model-invocation: true
---

# /ab-reconcile <build>

The build's PR no longer merges cleanly: main moved. Your job is one merge
commit — base merged *into* the build branch — that preserves both what this
build was for and what landed on main since. **Never rebase**: rebasing
re-resolves conflicts against a moving target and severs recorded SHA
provenance, so it is banned in this system.

## Session shape

1. Run `ab context`. Read the manifest path printed by the command (normally
   `.ab/context.json`) and use its `materialized` paths for the spec, plan, and
   implement notes; legacy tracked paths may relocate them. It also contains
   conflict info (`baseSha`) and — when a human answered an escalation a previous
   attempt raised — `.ab/guidance.json`, their answer to it. Kernel plumbing
   fetched the PR's configured base and resolved this SHA immediately before
   your session, so the commit already exists locally; it is not the older
   conflict-detection snapshot.
2. `git merge <baseSha>` in the workspace and resolve every conflict with
   the explicit charge to **regress against neither side**:
   - The spec and plan tell you what this branch's changes are *for* — a
     resolution that quietly drops the behavior they describe is a failed
     reconcile, even if it compiles.
   - The incoming base commits are already merged reality — a resolution
     that undoes them will break main.
3. Textual conflicts with one faithful resolution: resolve them. Then run
   the repo's checks (typecheck, tests) — a merge that compiles but fails
   tests is not resolved.
4. Write the manifest's `notesPath` (normally `.ab/reconcile-notes.md`) with
   each conflicted file, what collided, and why the resolution preserves both
   sides; then run `ab done --notes <notesPath>`. The notes bytes reach the
   store only through this flag; the file is never committed.

   `ab done` requires the merge commit to exist and the worktree to be
   clean; the push is plumbing. Verification re-runs in full afterward
   because reconciliation changed code — that is expected, not a failure.

## When not to resolve

A **semantic** conflict — both sides changed the same behavior's meaning,
the resolution needs a decision the spec doesn't make, or preserving both
sides is impossible — escalates rather than guesses:

```
ab escalate "main's abc123 changed the session-token format; this build's rate limiter keys on the old format. Adopt the new format (touches spec criterion 3) or key differently?" --refs src/auth.ts
```

When an earlier attempt escalated and a human answered, `.ab/guidance.json`
carries the escalation id and their answer. It is authoritative feedback for
this attempt — resolve the way it says — while the spec remains the contract
this phase is measured against; if the two cannot both be satisfied, escalate
again rather than guess. Reconcile has no review round, so guidance is the only
feedback it ever receives.

Never stage or commit anything under `.ab/`, including with `git add -f`.
Tracked legacy scratch needs no index flags or stash: leave it untouched and
let the normal merge inherit, update, or delete it from a parent.

A wrong guess here lands directly on main. Exactly one terminal command:
`ab done` or `ab escalate`.
