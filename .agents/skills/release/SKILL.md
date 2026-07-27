---
name: release
description: Cut a release of this repository — bump the version, cut the changelog, tag, push, and publish the GitHub Release. Use whenever the maintainer asks to cut, publish, or tag a release, or asks how releasing this repo works.
---

# /release

Releasing is a maintainer-triggered repository operation, not part of any
build pipeline. One command does the whole thing: `bun run release`
(`tools/release.ts`). Your job is to get the preconditions right, dry-run,
then run it — never to hand-edit the version, changelog, tag, or GitHub
Release yourself.

This is repo-local maintainer tooling. `tools/` does not ship in the package,
so nothing here is product surface.

## Preconditions

The command refuses to proceed unless all of these hold, so check them first
rather than discovering them through a failed run:

- Clean worktree. Unrelated local edits must be stashed — `git stash push -m
  <msg> -- <paths>` — and popped after the release completes.
- On the configured base branch (`baseBranch` in `autobuild.toml`, `main`),
  and not behind `origin`.
- `gh` authenticated (`gh auth status`).
- `CHANGELOG.md` has exactly one `## Unreleased` heading with at least one
  entry beneath it. An empty section is a hard refusal.

## Running it

**Always dry-run first.** It performs the full preflight, runs the gates, and
prints every candidate file without writing, committing, or publishing
anything.

```sh
env -u CLAUDECODE bun run release --patch --dry-run   # or --minor / --major
env -u CLAUDECODE bun run release --version 0.3.0 --dry-run
```

Then the real run, with the same selector:

```sh
env -u CLAUDECODE bun run release --version 0.3.0
```

`--version` takes an exact semver and is not required to be greater than the
current one, so it can correct a wrong version in `package.json`.

### Always unset CLAUDECODE

`bun run release` runs the repository's lint, typecheck, and test gates before
touching any file, and the test gate fails spuriously when the suite runs with
`CLAUDECODE=1` set. Bun's reporter suppresses per-test `(pass)` lines under
that variable, and `src/cli/plugin-authoring-guide.test.ts` asserts on a
nested `bun test`'s printed test name. Prefix every release command with
`env -u CLAUDECODE`. If that test is ever rewritten to assert on exit status
instead of reporter output, this note can go.

## What the command does for you

A real run, in order: runs the three gates; asks Claude non-interactively for
a short release summary; writes `package.json`, `CHANGELOG.md` (cutting
`## Unreleased` into `## vX.Y.Z — DATE` and leaving Unreleased empty), and the
pinned README install command; commits exactly those three files as `chore:
release vX.Y.Z`; creates an annotated tag; atomically pushes the commit and
tag; and publishes a GitHub Release whose notes are the exact cut changelog
section.

Do not perform any of those steps by hand, and do not add files to the release
commit — it validates that it contains exactly those three paths.

## When something goes wrong

- **A gate fails.** No release files were changed; fix the failure and start
  over. If a gate *modifies* the worktree, the command restores it and aborts.
- **The summary fails.** Optional by design: it warns and continues with every
  changelog bullet intact. Not a reason to stop.
- **Anything fails before the push.** The command restores the pre-release
  commit and deletes the unpushed tag itself. Just retry.
- **The GitHub Release fails after the push.** The branch and tag are already
  public. **Do not rewrite or delete those refs.** The error prints a verbatim
  `gh release create` recovery command containing the exact cut-section notes;
  run it as printed.

## Afterwards

Restore any stash you took, and confirm the result: `git log --oneline -2`,
`git tag --list`, `gh release list --limit 3`.
