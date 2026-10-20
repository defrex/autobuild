---
name: finalize-changelog
description: Add an opened build PR to this repository's changelog. Invoked as the changelog finalize post-step; takes only the build slug.
disable-model-invocation: true
---

# /finalize-changelog <build>

You are a failure-tolerant finalize post-step. The PR is already open. Add this
build's one-line PR summary to the repository changelog as one local commit;
the kernel, not you, publishes that commit.

## Context and inputs

1. Run `ab context` first. Post-step sessions reuse the base `finalize` phase
   manifest, so its `pr-description` deposit and its `done` / `escalate`
   terminals no longer apply: finalize already deposited the description and
   opened the PR. Never replace that deposit and never call either terminal.
2. Use only Autobuild's typed read surfaces for build-specific data. Save their
   output under ignored `.ab/` scratch:

   ```sh
   mkdir -p .ab/changelog
   ab build status "$AB_BUILD" --json > .ab/changelog/status.json
   ab artifact get pr-description > .ab/changelog/pr-description.md
   ```

   `$AB_BUILD` must be the invocation's `<build>` slug. Do not query `gh`, the
   forge, Git remotes, or infer PR data from the branch.
3. From the status JSON, require `.pr.number` to be a safe positive integer and
   `.pr.url` to be a nonblank string. The title is the artifact's first physical
   line only: strip leading Markdown heading hashes and surrounding whitespace,
   collapse remaining whitespace runs to one space, and require a nonblank
   result. Ignore the description body.

## Changelog operation

The only accepted entry format is:

```text
- [#<number>](<url>) — <title>
```

Require a clean worktree before starting. Let the stable marker be `[#<number>](`.
Count it across CHANGELOG.md (including historical releases) and the canonical
`.changelog/<number>.md` fragment. Validate an existing fragment with
`parseFragment` from `tools/changelog-fragments.ts`. Exactly one existing
representation is an idempotent no-op, even after release consumption. Never
rewrite an existing fragment when its title changes. Duplicates or malformed
fragments are clean observed semantic failures.

With zero representations, create `.changelog/<number>.md` exclusively (never
overwrite), containing exactly the entry above plus a trailing newline. Use
`renderFragment` from `tools/changelog-fragments.ts` to validate inputs.
Do not modify CHANGELOG.md. Inspect the new file and the staged diff: only this
path and exactly this one entry may be added. Reject unrelated changes. Run
`git diff --check` and `git diff --cached --check`. On semantic failure remove
only this session's newly created uncommitted fragment, then observe the failure.

```sh
git add -- .changelog/<number>.md
# Defensive: finalize commits must never fail on missing or partial identity
# (an email-only or name-only identity still fails `git commit`). Skip the
# fallback only when both keys resolve; otherwise set the repo-local identity
# (.git/config — invisible to the cleanliness guard, no sudo) to the same bot
# identity as the workspace `git-identity` provisioning step in autobuild.toml.
{ [ -n "$(git config user.name || true)" ] && [ -n "$(git config user.email || true)" ]; } || \
  { git config user.name 'autobuild[bot]'; git config user.email 'autobuild[bot]@users.noreply.github.com'; }
git commit -m "chore: add changelog entry for #<number>" -- .changelog/<number>.md
git status --porcelain
```

The final status must be empty. Never amend or rewrite history. Never push.

## Failure-tolerant ending

For missing/malformed status or artifact data, duplicate markers, or any other clean semantic no-op, leave tracked
files exactly as they were and record one specific observation, for example:

```sh
ab observe --kind followup --files CHANGELOG.md \
  "Finalize changelog entry for $AB_BUILD was not created: <specific reason>"
```

Then end normally. Do not dirty the worktree to signal failure. Agent/runtime,
Git, dirty-worktree, history, and publication failures are also failure-tolerant
at the kernel boundary: the kernel records the failed step and its follow-up
without turning the green build red. Do not hide such failures, retry by
rewriting history, or operate on the remote.

A successful commit, an idempotent one-marker no-op, or an observed clean
semantic failure all end by simply returning from the session. Never call
`ab done`, `ab verdict`, or `ab escalate`.
