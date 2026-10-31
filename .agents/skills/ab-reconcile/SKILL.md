---
name: ab-reconcile
description: Resolve the kernel-prepared replay of a build's single change onto its refreshed base. Invoked by the build-runner as the reconcile phase; takes only the build slug.
disable-model-invocation: true
---

# /ab-reconcile <build>

The kernel has collapsed this build's contribution into one change and replayed
it onto a frozen refreshed base. Your job is to preserve both the build's intent
and the behavior already merged upstream. Work on the prepared detached HEAD;
the kernel retains the published branch until guarded publication succeeds.

For a node conflict, `nodeChange` names the integration owner, transaction,
current item, source SHA and optional source build. The prepared replay is only
that change, not the whole node. The materialized spec, plan and implement-notes
belong to the source build. For a foreign item, inspect `foreign-change.patch`
and preserve foreign status without adding an identity; escalate if its intent
cannot be established. Missing source context requires escalation. The replay
base is `conflict.baseSha`; preserve the source build's trailer rather than the
integration owner's. `ab done` retains the item and records its receipt; trusted
kernel plumbing advances the remaining stack after the session ends. Do not
publish, collapse the node, choose another item, or rewrite the public branch.

Scratch output, downloaded references, probes, and temporary scripts belong under `.ab/`
(prefer the current `$AB_CONTEXT_DIR` when appropriate), never at the worktree
root, and must not be committed. Manifest-directed artifact paths remain authoritative.

Large scratch belongs under the session's `.ab/` directory (prefer `$AB_CONTEXT_DIR`),
not `/tmp`: this includes ad-hoc PostgreSQL data/cluster directories, Cargo target
directories, browser profiles, and database copies. Configure `PGDATA`,
`CARGO_TARGET_DIR`, and explicit browser profile paths for those resources.
Keep `TMPDIR` outside the worktree for test suites and commands that discover
repositories or configuration through parent directories, including focused tests
and Git probes. Do not relocate required installed tooling or retained evidence;
manifest-directed artifact paths remain authoritative. Never commit scratch.


## Session shape

1. Run `ab context`. Read the printed manifest and its `materialized` paths for
   the spec, approved plan, implement-notes, and any `$AB_CONTEXT_DIR/guidance.json` guidance. `replay` names the
   original head, old contribution base, single change, frozen target base and
   whether replay conflicted. A replay may originate at verify entry before any
   PR exists; `restackId` identifies an adopted automatic transaction. Never fetch, merge, rebase, select another base,
   or move the named branch yourself. Missing replay inputs require escalation, except a node item uses `nodeChange` and `conflict.baseSha` instead of `replay`.
   If the manifest includes `workspaceRecovery`, read that materialized note.
   It distinguishes exact preserved commits restored before the session from
   known lost candidates and unobservable additional work. A retired reconcile
   result is reconstructed on the prepared replay under its retained frozen
   target; do not search for the known nonexistent candidate. Preserved work
   remains the starting point for continuation.
2. Inspect `git status` and the prepared replay. If conflicts remain, resolve
   them with the explicit charge to regress against neither side:
   - Preserve the behavior the spec and approved plan require.
   - Preserve the behavior already merged on the target base.
   Stage only the resolved files and run `git cherry-pick --continue`. If the
   change is now redundant, preserve an empty commit with `git commit
   --allow-empty --no-edit`; never skip away the build's identity. A clean
   replay already has its commit and still needs inspection and checks.
3. Run fast checks that cover the resolution — typecheck, lint, unit or focused
   tests. Skip slow suites (integration, end-to-end, browser): post-reconcile
   verification reruns the configured steps, and a step the repository's
   post-reconcile policy skips is a risk it chose. The result must be exactly one commit
   with exactly one parent equal to `replay.targetBase` (or `conflict.baseSha` for a
   node item) and exactly one terminal
   `Autobuild-Build: <build>` trailer. For node items use the source identity in
   `nodeChange.build`; a foreign item must have no build trailer. Do not create a merge commit.
4. Write the manifest's `notesPath`: what collided, how each resolution preserves
   both sides, and the checks run. Never commit notes or any other `.ab/` path.
   Legacy tracked scratch may be inherited unchanged from either input; do not
   author scratch changes as part of resolution.
5. Run `ab done --notes <notesPath>`. The kernel validates, archives recorded
   evidence, and publishes with an exact expected-head lease. Exact forge
   readback confirms publication; local refs are caches. Candidate ancestry alone
   cannot establish an unconfirmed write or contribution boundary. If the branch
   changed, it prepares another replay of the observed complete contribution
   onto the same frozen base. Read context again, inspect and resolve that replay,
   run checks, update notes, then retry completion. Never push yourself.

A publication success message parks this turn for kernel publication;
do not repeat `ab done` after success. Post-reconcile verification follows the
captured policy and begins a fresh cycle after confirmed publication. A conflict
at initial verify entry still requires initial checks regardless of that policy.

A leaf replay resumed after a spec revision uses the revised spec as its
contract. Its historical plan and implement notes describe the retained change;
they cannot override that contract. After confirmed publication the build
restarts planning, implementation and review before verification, rather than
entering the ordinary post-reconcile verification cycle directly.

## When not to resolve

Escalate semantic conflicts, incompatible or deleted branch history, or choices
that the spec does not settle. Do not guess away either side's behavior:

```
ab escalate "The target changes the session-token format but the build keys its limiter on the old format. Which behavior should the limiter adopt?" --refs src/auth.ts
```

A human answer in guidance is authoritative while the spec remains the contract.
If they cannot both be satisfied, escalate the contradiction. Reconcile has no
code-review round; risky resolutions need human judgment. The only successful
terminal commands are `ab done` and `ab escalate`.

Read the manifest path printed by `ab context`. Its `materialized` keys are
relative to `contextDir`: join them to locate collision-adjusted inputs.
Manifest path fields are workspace-relative; use `notesPath` for producer notes.
Run commands from the workspace root.
