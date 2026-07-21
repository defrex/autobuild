---
name: ab-finalize-changelog
description: Add an opened build PR to this repository's changelog. Invoked as the changelog finalize post-step; takes only the build slug.
disable-model-invocation: true
---

# /ab-finalize-changelog <build>

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
3. From the status JSON, require `.pr.number` to be a positive integer and
   `.pr.url` to be a nonblank string. The title is the artifact's first physical
   line only: strip leading Markdown heading hashes and surrounding whitespace,
   collapse remaining whitespace runs to one space, and require a nonblank
   result. Ignore the description body.

## Changelog operation

The only accepted entry format is:

```text
- [#<number>](<url>) — <title>
```

Before editing tracked files:

- Require exactly one level-two heading whose whole line is `## Unreleased`
  (trailing horizontal whitespace is harmless). Missing or multiple matching
  headings are a semantic failure.
- Let the stable marker be the literal `[#<number>](` for this PR and count it
  across `CHANGELOG.md`. Exactly one occurrence is a successful replay no-op:
  make no commit and end normally. More than one is a semantic failure. Never
  append another entry in either case.
- With zero markers, require all PR/title inputs above. Normalize the title to
  one line, construct exactly the format shown, and insert it as the first
  nonblank content beneath `## Unreleased`, before every existing entry. Keep
  one blank separator below the heading (introduce it when the empty scaffold
  has none), and do not reorder or rewrite existing lines.

After insertion, prove before committing that:

- this PR marker occurs exactly once;
- the new entry is the first nonblank content in the Unreleased section;
- `git diff --check -- CHANGELOG.md` passes; and
- the unstaged diff has exactly one added entry line, with no removed or
  modified existing lines and no changed path besides `CHANGELOG.md`. The only
  other permitted addition is the heading's blank separator when the section
  was the empty scaffold.

If any proof fails, restore only the uncommitted `CHANGELOG.md` change and use
the semantic-failure path below. Otherwise stage only that file, inspect the
staged diff once more, and create one commit:

```sh
git add -- CHANGELOG.md
git commit -m "chore: add changelog entry for #<number>" -- CHANGELOG.md
git status --porcelain
```

The final status must be empty. Never amend or rewrite history. Never push.

## Failure-tolerant ending

For missing/malformed status or artifact data, a missing/ambiguous Unreleased
section, duplicate markers, or any other clean semantic no-op, leave tracked
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
