---
name: verify-docs
description: Repository-local semantic documentation drift review for verify:docs.
disable-model-invocation: true
---

# Verify documentation drift

Run `ab context`. Read the printed manifest, its materialized spec, pinned assets,
and any guidance. Require nonempty `commitRange.base` and `commitRange.head` in
that manifest. Use those exact revisions throughout: `git diff <base>..<head>`.
Read surrounding code and docs at both supplied revisions with `git show`.
Missing or unreadable range, revisions, or diff is a failure. Never substitute
merge-base, a destination branch, HEAD~1, working-tree changes, or other commits.
Do not re-evaluate applicability or emit skip.

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
- An overall verdict. Missing evidence is a failure with a report.

Do not edit code or docs, commit, push, or attach arbitrary artifacts. End exactly
once with `ab verdict pass --notes .ab/docs-verify-report.md` or
`ab verdict fail --report .ab/docs-verify-report.md`.
