---
name: verify-docs
description: Repository-local semantic documentation drift review for verify:docs.
disable-model-invocation: true
---

# Verify documentation drift

Large scratch belongs under the session's `.ab/` directory (prefer `$AB_CONTEXT_DIR`),
not `/tmp`: this includes ad-hoc PostgreSQL data/cluster directories, Cargo target
directories, browser profiles, and database copies. Configure `TMPDIR`, `PGDATA`,
`CARGO_TARGET_DIR`, and explicit browser profile paths for scratch subprocesses as
appropriate. Do not relocate required installed tooling or retained evidence;
manifest-directed artifact paths remain authoritative. Never commit scratch.

Run `ab context`, then resolve `context_dir="${AB_CONTEXT_DIR:-.ab}"`
(unset or empty falls back to `.ab`). Read the printed manifest, normally
`"$context_dir/context.json"`, and its materialized inputs from that context
directory: the spec (normally `"$context_dir/spec.md"`), pinned assets, and any
guidance (normally `"$context_dir/guidance.json"`). Follow printed or
manifest-allocated paths when they differ; use allocated paths verbatim,
without adding another context prefix. Quote variable-derived paths and reuse
or recompute `context_dir` in later shell invocations. Require nonempty
`commitRange.base` and `commitRange.head` in that manifest. Use those exact revisions throughout: `git diff <base>..<head>`.
Read surrounding code and docs at both supplied revisions with `git show`.
Missing or unreadable range, revisions, or diff is a failure. Never substitute
merge-base, a destination branch, HEAD~1, working-tree changes, or other commits.
Do not re-evaluate applicability or emit skip.

When the manifest contains `nodeVerification`, read its allocated `indexPath`,
every contribution's `specPath` and all full `handPushedCommits` messages. Require
the index `range` to match `commitRange` and its identities, spec revisions,
contribution commit lists and hand-pushed entries to agree with the manifest.
Missing, unreadable or inconsistent required node evidence fails; do not guess alternate
paths, specs, identities or ranges. Empty contribution or hand-pushed lists are
valid. Use the index mapping and history only inside the supplied range to tie
changed behavior to its introducing contribution (build, ticket and spec revision)
or listed hand-pushed commit (current SHA, original SHA and full message).
Read these sources alongside the node spec as intended-behavior context; do not
borrow intent from an unrelated child or treat `unattributedCommits` as maintainer
authorization. Without `nodeVerification`, retain the leaf spec context above.
Code and before/after docs remain evidence of actual behavior: intended behavior
never excuses documentation drift.

Inventory the diff's changed user-facing behavior: configuration, defaults,
constraints, CLI/API contracts, lifecycle, ticket workflows, installed skill
instructions, setup, and user-visible UI terminology or behavior. Search `docs/`
for those concepts and read the relevant passages even when no docs file changed.
Compare before and after behavior with documentation at both exact revisions.
A touched docs filename is not evidence of coverage: its resulting passages must
accurately explain the changed behavior. Accurate existing documentation can pass
with an explicit reason. Internal refactors and tests can pass with an explicit
no-user-facing-change rationale. Judge only this build's behavior; do not conduct
a general docs audit or invent requirements beyond the spec. Do not rewrite README.
Use operator agent or your agent for the agent, and you for the human.

Write `.ab/docs-verify-report.md` containing:

- Exact base and head and the executed diff command.
- Each behavior and its source locations, the applicable docs page and section,
  before/after documentation evidence, and per-item pass/fail reasoning.
- For each failure, the behavior that drifted, specific `docs/<page>.md`
  section(s) needing updates (or an appropriate existing page for newly exposed
  behavior), and the required correction.
- Relevant introducing contribution identities and spec revisions or hand-pushed
  SHA, original SHA and message intent, and how they inform each node behavior.
  Record missing or inconsistent provenance evidence explicitly.
- An overall verdict. Missing evidence is a failure with a report.

Do not edit code or docs, commit, push, or attach arbitrary artifacts. End exactly
once with `ab verdict pass --notes .ab/docs-verify-report.md` or
`ab verdict fail --report .ab/docs-verify-report.md`.
