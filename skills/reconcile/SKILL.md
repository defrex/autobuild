---
name: reconcile
description: Resolve a conflicted PR by merging base into the build branch. Invoked by the build-runner as the reconcile phase; takes only the build slug.
---

# /ab-reconcile <build>

The build's PR no longer merges cleanly: main moved. Your job is one merge
commit — base merged *into* the build branch — that preserves both what this
build was for and what landed on main since. **Never rebase** (SPEC §15.7:
rebase re-resolves conflicts against a moving target and severs recorded
SHA provenance; it is banned in this system).

## Session shape

1. Run `ab context`. You get `.ab/spec.md`, `.ab/plan.md`,
   `.ab/implement-notes.md`, and the conflict info (`baseSha` in
   `.ab/context.json`). Kernel plumbing fetched the PR's configured base and
   resolved this SHA immediately before your session, so the commit already
   exists locally; it is not the older conflict-detection snapshot.
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
4. Write `.ab/reconcile-notes.md` — each conflicted file, what collided,
   how you resolved it and why that preserves both sides — then:

   ```
   ab done --notes .ab/reconcile-notes.md
   ```

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

A wrong guess here lands directly on main. Exactly one terminal command:
`ab done` or `ab escalate`.
