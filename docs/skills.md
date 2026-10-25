---
title: "Skills"
label: "Skills"
group: "concepts"
order: 6
description: "Understand Autobuild's agent skills, customize their defaults for your repository, and keep your edits through upgrades."
---

# Skills

Skills guide the agents that plan, implement, review and operate Autobuild, one per phase or role. They supply judgment; code owns build state, transitions, gates and publication.

## Strong defaults, yours to edit

`ab init` installs the shipped skills as repository files under `.agents/skills/ab-<name>/`: a `SKILL.md` plus optional references or scripts. For example, tell `.agents/skills/ab-implement/SKILL.md` to use the shared database adapter, follow the existing error vocabulary and run the project's integration checks.

- Change how agents work, not the lifecycle's gates. Keep each skill's typed CLI contract: context, notes deposit and completion command.
- Commit edits so every agent shares them.
- Edit the live tree, never its pristine baseline.

## The shipped skills

| Skill | Purpose |
|---|---|
| `ab-spec` | Groom intent into a ticket spec with you; not a spec-phase session |
| `ab-plan` | Plan the implementation from the spec |
| `ab-plan-review` | Check the plan against the spec independently |
| `ab-implement` | Execute the approved plan and commit |
| `ab-code-review` | Review the implementation against the contract independently |
| `ab-finalize` | Write the pull request description after verification |
| `ab-reconcile` | Resolve conflicts in a kernel-prepared replay onto a refreshed base |
| `ab-operate` | External operator agent: operate the builds the repository's dispatcher dispatches, adopt new work, answer escalations and control merge |
| `ab-tickets` | Read, create, groom and update tickets through the tracker interface |
| `ab-harvest` | Turn claimed observations into ticket proposals |
| `ab-harvest-review` | Review those proposals independently |
| `ab-guide` | Reference for the system, configuration, setup and installed skills |

- **Phase skills** (plan through reconcile) are runner-invoked; don't start them manually.
- **Spec, ticket and operator skills** work outside the pipeline. Observation harvest is a separate repository workflow.
- **No generic agent verifier ships.** Your repository supplies its own evidence and checks.

## How upgrades preserve customization

Init records upstream files under `.agents/skills/.ab-pristine/ab-<name>/`, a tracked baseline rather than an editable copy. `ab upgrade` three-way merges every distributed file, supporting files included:

- **Base:** the pristine copy
- **Local:** your file
- **Incoming:** the new upstream default

Overlapping edits get an agent resolution biased toward your customization, validated to preserve clean regions, add no conflict markers and keep frontmatter identity.

On success, pristine advances to the incoming upstream bytes, not the merged result, so your edits stay visible to the next upgrade. New upstream support files are added. Removed upstream files are deleted if unedited; customized copies stay as repository-local files.

### Reading the upgrade report

Each skill reports the aggregate of its files; `conflicted` outranks `resolved`, `merged`, `adopted` and `current`.

| Outcome | Meaning |
|---|---|
| `current` | Upstream unchanged; the local file stands |
| `adopted` | Incoming bytes adopted, pristine advanced; also restoring a missing live file, adding a support file, or deleting an unedited upstream-removed one |
| `merged` | Independent changes combined, pristine advanced; also a customized upstream-removed support file, kept and released from pristine |
| `resolved` | Local-biased agent resolution passed validation; pristine advanced to incoming |
| `conflicted` | Resolution unavailable, failed, declined as ambiguous, or invalid. Live and pristine untouched while other files advance; no conflict markers in the live skill |
| `installed` | Missing from both live and pristine trees; installed fresh |
| `removed` | Eligible retired skill's unchanged tree and owned discovery link removed, or a missing tree's obsolete provenance and dangling owned link cleaned up |
| `kept` | Retired skill customized, configured or unsafe to remove, or a user-owned Claude discovery entry preserved while the canonical tree went; obsolete pristine ownership cleared |
| `unknown` | `ab-*` name not in the distribution; left alone. Not license to use the reserved prefix |

**No pristine record:**

- absent local file: installed
- local file identical to incoming: becomes the baseline
- differing local file: `conflicted`, not overwritten; merge by hand against the reported pristine path

**Retirement** (`removed`, `kept`) applies only to `ab-setup` and `ab-verify-e2e`, and only with a pristine record proving Autobuild provenance; a same-named repository skill without one is left alone. A retired skill is kept when an agent verify or finalize step uses it or its configuration can't be inspected safely. Obsolete ownership is then cleared, so the skill doesn't return or get reported again.

**Exit status.**

- **Discovery collisions fail.** A distinct real directory or foreign symlink at `.claude/skills/<name>` is preserved (symlinks keep their exact target text), reported, and exits nonzero, even when a retired canonical tree is removed.
- **Content conflicts don't.** `conflicted` results alone, including timeouts and cancelled resolution, exit zero. Read the report, not just the exit code.

**Commit.** A conflict-free upgrade makes a local commit limited to upgrade-owned changes; `--no-commit` leaves them to you. Conflicts or unsafe Git state suppress the commit with an explanation. See [Upgrading](upgrading.md).

## Add a repository-local skill

`ab-` is reserved for shipped skills. Give yours plain names, such as `.agents/skills/verify-acceptance/SKILL.md` with a name, description and instructions. Application-specific evidence requirements belong there.

Every repository needs an **acceptance check**: a repository-owned agent verify step that exercises each acceptance criterion against the built software. It isn't a test suite and leaves no test files. Its skill tells the agent to:

1. Run `ab context` and read the materialized inputs.
2. Gather the evidence the skill defines as a pass or failure.
3. Report `pass`, `fail` or `skip` through `ab verdict`; its prose response isn't the result.

Select the skill by exact name (no prefix is inferred), appending `acceptance` to your existing steps:

```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"
```

[Verification](verification.md#steps-and-outcomes) covers step kinds and outcomes.

## Harness discovery

Codex and Pi read `.agents/skills/` directly. Claude Code reads `.claude/skills/`, where init links each shipped skill to its canonical directory, so there's one editable copy. Link a new local skill from the repository root:

```sh
mkdir -p .claude/skills
ln -s ../../.agents/skills/verify-acceptance .claude/skills/verify-acceptance
```

- **Check first.** If `.claude/skills/` and `.agents/skills/` already alias the same directory, skip per-skill links.
- **Don't overwrite** existing user-owned directories or foreign links; resolve collisions deliberately.
- **Commit** the skill and its link together.
