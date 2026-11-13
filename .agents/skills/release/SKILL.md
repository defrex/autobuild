---
name: release
description: Cut a release of this repository — bump the version, cut the changelog, tag, push, publish the GitHub Release, and tell the reporters of resolved GitHub issues that their fix shipped. Use whenever the maintainer asks to cut, publish, or tag a release, or asks how releasing this repo works.
---

# /release

Releasing is a maintainer-triggered repository operation, not part of any
build pipeline. One command does the whole thing: `bun run release`
(`tools/release.ts`). Your job is to get the preconditions right, dry-run,
then run it — never to hand-edit the version, changelog, tag, or GitHub
Release yourself. After a stable release, also
[tell issue reporters it shipped](#tell-issue-reporters-it-shipped).

This is repo-local maintainer tooling. `tools/` does not ship in the package,
so nothing here is product surface.

A patch release must not change the protocol: patches on a release line are
interchangeable in both directions. Protocol changes require a new major.minor
line and retained handlers for every line still in the supported client window.

The release command automatically records the outgoing published client’s protocol
identity, outgoing catalog-header identity (when its client sends one), publication
timestamp, and frozen reducer contract, recovering missing
evidence from the integrity-checked npm artifact. It freezes the target’s generated
finished shapes and reducer versions before running target-version gates. Never
hand-edit historical contracts or publication dates. Dry-run prints these candidate
files and restores both original bytes and file existence after the gates.

Support ends only after two newer published minor lines and 90 days since the
successor line first shipped, including across majors. The floor is 1.2; earlier
clients are always refused. Prereleases do not start stable retirement clocks and
patches do not reset them. Keep publication facts after retiring contracts.
Preparation refuses missing supported identities, contracts, or retained handler
evidence before committing or publishing. Review the frozen compatibility matrix
when adding or retiring a wire family. No real release is part of a feature build.

## Preconditions

The command refuses to proceed unless all of these hold, so check them first
rather than discovering them through a failed run:

- Clean worktree. Unrelated local edits must be stashed — `git stash push -m
  <msg> -- <paths>` — and popped after the release completes.
- On the configured base branch (`baseBranch` in `autobuild.toml`, `main`),
  and not behind `origin`.
- `gh` authenticated (`gh auth status`).
- Logged in to the npm registry (`bun pm whoami` prints your user; `npm login`
  if not). The command refuses before running any gate otherwise, because the
  final stage publishes every non-private workspace package to npm.
- `CHANGELOG.md` has exactly one `## Unreleased` heading with at least one
  pending entry, either beneath it or in `.changelog/<PR-number>.md`.

## Launcher contract preflight

Before dry-run, identify the actual most recently published GitHub Release,
including prereleases (exclude drafts and compare publication timestamps across
all pages, for example `gh api --paginate repos/{owner}/{repo}/releases`). Do not
infer it from sorted tags, the stable-only latest endpoint, or package versions.
Resolve absent or ambiguous publication/tag evidence before releasing. Read
`packages/core/src/cli/dispatch-launch-contract.ts` at that release's tag and at
HEAD with `git show <tag>:<path>` and `git show HEAD:<path>`.

Compare `DISPATCH_LAUNCH_VERSION`, `DISPATCH_OVERLAP_VERSION`, and their frozen
ABI. Independently negotiated rollback capability is not itself a launcher ABI
bump. If the previous release predates the launcher, require a one-time adoption
restart warning. For a launcher ABI change, require a pending
`.changelog/<PR-number>.md` entry explicitly saying that maintainers must
**gracefully restart the launcher manually** to adopt the change. Create or
amend the relevant fragment before dry-run and commit it first, preserving the
release command's clean-worktree precondition. Do not hand-edit a cut release
section. Verify that the warning survives the dry-run candidate notes and,
after publication, the published GitHub Release notes. The command still owns
versioning, changelog cutting, tagging and publishing.

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
committing anything, and the test gate fails spuriously when the suite runs with
`CLAUDECODE=1` set. Bun's reporter suppresses per-test `(pass)` lines under
that variable, and `packages/core/src/cli/plugin-authoring-guide.integration.test.ts` asserts on a
nested `bun test`'s printed test name. Prefix every release command with
`env -u CLAUDECODE`. If that test is ever rewritten to assert on exit status
instead of reporter output, this note can go.

## Prereleases

Use an exact version selector for a prerelease:

```sh
env -u CLAUDECODE bun run release --version 1.0.0-beta.0 --dry-run
env -u CLAUDECODE bun run release --version 1.0.0-beta.0
```

The first prerelease identifier names the npm dist-tag: `beta` for
`1.0.0-beta.0`, `rc` for `1.0.0-rc.2`. Numeric identifiers, `latest`,
and identifiers interpreted as semver ranges are refused before gates.
Every published package uses `--tag <channel>`; the stable `latest` tag stays
at the last stable release. GitHub receives `--prerelease --latest=false`.

The same preflight, peer-floor guard, gates, summary, lock refresh and smoke
checks run. A prerelease requires pending entries from either source. Its
GitHub notes contain those current entries under the version/date heading,
with the optional summary. It leaves fragments, CHANGELOG.md, README.md, hosted deployment
pins and hosted documentation byte-identical. Its commit contains only workspace
manifests and bun.lock when the refresh changes it. Recovery commands preserve
the channel and GitHub flags; run them exactly as printed.

A later stable target consumes all accumulated Unreleased entries once, updates
the README and hosted pins, and publishes under `latest`. Both
`--version 1.0.0` and `--major` from `1.0.0-beta.2` select stable 1.0.0.

## What the command does for a stable release

A real run, in order: runs the three gates with the target version
temporarily written into every version-bearing release file except the
changelog, then restores them; asks Claude non-interactively for
a short release summary; writes every workspace `package.json`,
`CHANGELOG.md` (cutting `## Unreleased` into `## vX.Y.Z — DATE` and leaving
Unreleased empty), and the pinned README install command
(`bun add -d --exact @defrex/autobuild@X.Y.Z`); refreshes `bun.lock` with
`bun install --lockfile-only` so it records the new workspace versions;
commits exactly those files as
`chore: release vX.Y.Z`; creates an annotated tag; smokes the tag from a clean
clone; atomically pushes the commit and tag; publishes a GitHub Release whose
notes are the exact cut changelog section and uploads the guest distribution
archive to it; and finally runs `bun publish --access public` for each
non-private workspace package in dependency order (`@defrex/autobuild`, then
`@defrex/autobuild-postgres-store`, then
`@defrex/autobuild-hosted-store-service`, then
`@defrex/autobuild-hosted-dispatcher`).

Do not perform any of those steps by hand, and do not add files to the release
commit. Stable releases validate workspace manifests, changelog, README, the
hosted template/deployment manifests and hosted docs when present, and
`bun.lock` when the refresh changed it. A release
that leaves `bun.lock` stale makes every later install rewrite it, so builds
start with a dirty lockfile.

## When something goes wrong

- **A gate fails.** The temporary version bump is restored, so no release files
  were changed; fix the failure and start over. If a gate *modifies* the
  worktree or a bumped release file, the command restores it and aborts.
- **The summary fails.** Optional by design: it warns and continues with every
  changelog bullet intact. Not a reason to stop.
- **Anything fails before the push.** The command restores the pre-release
  commit and deletes the unpushed tag itself. Just retry.
- **The GitHub Release fails after the push.** The branch and tag are already
  public. **Do not rewrite or delete those refs.** The error prints a verbatim
  `gh release create` recovery command containing the exact cut-section notes,
  then the archive upload and `bun publish` commands; run them as printed.
- **An npm publish fails.** Everything before it is public and stays. npm
  publication is not revertible, so the error names the packages still
  unpublished with the exact `bun publish` command for each, in order. Fix the
  cause (usually auth or a transient registry error) and run those commands;
  never bump the version to work around it.

## Afterwards

Restore any stash you took, and confirm the result: `git log --oneline -2`,
`git tag --list`, `gh release list --limit 3`, and
`npm view @defrex/autobuild version`.

For prereleases, run `npm view @defrex/autobuild dist-tags` and confirm the
beta or rc tag names the new version while latest still names the last stable
release. A project can install the channel or pin an exact version as a development
dependency. The channel resolves at install time, and the resulting version
is saved exactly:

```sh
bun add -d --exact @defrex/autobuild@beta
bun add -d --exact @defrex/autobuild@1.0.0-beta.0
```

## Tell issue reporters it shipped

Issues close when their PR merges, which is before the fix is installable. After
a **stable** release, comment on every GitHub issue that release resolves, so
whoever filed it (a person, or an agent working in another project) learns
which version to install. This is part of the release: do it without being
asked, and report what you posted.

Skip this for prereleases. The stable release that follows consumes the same
changelog entries and notifies once.

Do it only after `npm view @defrex/autobuild version` prints the new version.
The registry can lag a few minutes behind the publish, and the comment tells
people to install.

List the candidates first. This reads the PRs from the published release
notes, then the issues each PR links, either as a closing reference or as
`Closes`, `Fixes`, `Resolves` or `Refs #N` in the PR body:

```sh
V=v1.7.0   # the tag just released
gh release view "$V" --json body --jq .body | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+' | sort -un |
while read -r pr; do
  gh pr view "$pr" --json closingIssuesReferences,body --jq '
    ([.closingIssuesReferences[].number]
     + [.body | scan("(?i)\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?) #([0-9]+)") | .[0] | tonumber])
    | unique | .[]'
done | sort -un |
while read -r issue; do
  gh issue view "$issue" --json number,state,stateReason,author,url,comments --jq \
    "\"#\(.number) \(.state) \(.stateReason) by \(.author.login) \(.url) notified=\([.comments[].body | select(contains(\"/releases/tag/$V\"))] | length)\""
done
```

Comment on an issue only when all of these hold:

- Its URL is an issue, not a pull request (`Refs #N` can name a PR).
- It is `CLOSED` with reason `COMPLETED`. An issue that is still open was only
  partly addressed (`Refs`), so it gets no comment; name it in your report
  instead. An issue closed as not planned gets none either.
- `notified=0`. A nonzero count means an earlier run already posted for this
  version, so a retry never comments twice.

Then post one comment per issue, naming the PRs from this release that
addressed it:

```sh
gh issue comment <issue> --body "This shipped in [v1.7.0](https://github.com/defrex/autobuild/releases/tag/v1.7.0) (#937, #936). Upgrade with \`bun add -d --exact @defrex/autobuild@1.7.0\`.

Posted by <agent name>, working as @defrex's operator agent."
```

Keep the release URL in the body exactly as shown: it is the marker the
`notified` check looks for. The last line applies when an agent posts under
the maintainer's account; a maintainer posting by hand drops it. Do not
reopen, close, relabel or otherwise change the issue.

Finish by telling the maintainer which issues were notified, which were
skipped, and why.

Build entries live in `.changelog/<PR-number>.md`; nobody edits Unreleased by
hand for a build. Existing Unreleased entries remain compatibility inputs for
the next stable cut. Releases combine both sources, newest numeric PR first,
reject duplicate PR representations, and preserve legacy prose afterward.
Stable releases delete consumed fragments in the release commit and leave
Unreleased empty. Dry-run reports each planned deletion without changing files.
Prereleases preserve all fragment and changelog bytes and quote every pending
entry in their notes and summary input. Pre-push rollback restores fragments.
