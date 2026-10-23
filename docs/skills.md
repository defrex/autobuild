---
title: "Skills"
label: "Skills"
group: "concepts"
order: 6
description: "Understand Autobuild's agent skills, customize their defaults for your repository, and keep your edits through upgrades."
---

# Skills

Skills guide the agents that plan, implement, review and operate Autobuild, one skill per phase or role. They supply judgment; deterministic code still owns build state, transitions, gates and publication.

## Strong defaults, yours to edit

`ab init` installs the shipped skills as ordinary repository files under `.agents/skills/ab-<name>/`. Each directory holds a `SKILL.md` and may include supporting references or scripts. They're defaults meant to be customized, not immutable prompts.

For example, add your implementation conventions to `.agents/skills/ab-implement/SKILL.md`:

- use the shared database adapter
- follow the existing error vocabulary
- run the project's integration checks

Change how agents do the work, not the lifecycle's deterministic gates. Keep each skill's typed CLI reporting contract: its context, notes deposit and completion command.

Commit your edits so every agent works from the same instructions. Edit the live skill tree, never its pristine baseline.

## The shipped skills

`ab init` installs these twelve skills:

| Skill | Role | Purpose |
|---|---|---|
| `ab-spec` | Pre-build grooming | Turn intent into a complete ticket spec with you; not a spec-phase session |
| `ab-plan` | Plan | Produce an implementation plan from the spec |
| `ab-plan-review` | Plan review | Check the plan against the spec independently |
| `ab-implement` | Implement | Execute the approved plan and commit the change |
| `ab-code-review` | Code review | Review the implementation against the contract independently |
| `ab-finalize` | Finalize | Write the pull request description after verification |
| `ab-reconcile` | Reconcile | Resolve conflicts in a kernel-prepared replay onto a refreshed base |
| `ab-operate` | External operator agent | File tickets, watch builds, answer escalations, control landing |
| `ab-tickets` | Ticket management | Read, create, groom and update tickets through the tracker interface |
| `ab-harvest` | Harvest synthesis | Turn claimed observations into structured ticket proposals |
| `ab-harvest-review` | Harvest review | Review those proposals independently |
| `ab-guide` | Reference | Explain the system, configuration, setup and installed skills |

- **Phase skills** are invoked by the runner. Don't start them manually.
- **Spec grooming and ticket management** happen before builds.
- **The operator agent** works outside the pipeline; observation harvest is a separate repository workflow.
- **No generic agent verifier ships.** Your repository supplies skills for its own evidence and checks.

## How upgrades preserve customization

Init also records upstream files under `.agents/skills/.ab-pristine/ab-<name>/`. This tracked tree is the last upstream baseline, not another editable copy.

`ab upgrade` runs a three-way merge on every distributed file, supporting files included:

- **Base:** the pristine copy
- **Local:** your edited file
- **Incoming:** the new upstream default

Independent edits combine cleanly. When edits overlap, an agent proposes a resolution biased toward your customization. Deterministic validation then checks that it:

- preserves clean regions
- adds no unresolved conflict markers
- keeps the skill's frontmatter identity

After a successful update, pristine advances to the incoming upstream bytes, not the merged result, so your edits stay visible to the next upgrade. New upstream support files arrive too. Removed upstream files are deleted if unedited; customized copies stay as repository-local support files.

### Reading the upgrade report

Merging is per file. A conflicted file keeps its live and pristine bytes untouched while other files advance. Each skill reports the aggregate of its files, with `conflicted` taking precedence over `resolved`, `merged`, `adopted` and `current`.

| Outcome | Meaning |
|---|---|
| `current` | Upstream is unchanged from the baseline; the local file stands. |
| `adopted` | Incoming bytes adopted and pristine advanced. Also covers restoring a missing live file, adding a new support file, or removing an unedited upstream-deleted support file. |
| `merged` | Independent changes combined and pristine advanced. Also a customized upstream-deleted support file, kept and released from its pristine record. |
| `resolved` | A local-biased agent resolution passed validation; pristine advanced to incoming. |
| `conflicted` | Resolution was unavailable, failed, was declined as ambiguous, or failed validation. Live and pristine stay untouched; conflict markers never enter the live skill. |
| `installed` | A distributed skill missing from both live and pristine trees was installed fresh. |
| `removed` | An eligible retired skill's unchanged live tree and owned discovery link were removed, or an already-missing tree's obsolete provenance and dangling owned link were cleaned up. |
| `kept` | A retired skill was customized, configured or unsafe to remove, or a user-owned Claude discovery entry was preserved while the canonical tree could go. Obsolete pristine ownership is cleared. |
| `unknown` | An installed `ab-*` name isn't in the distribution and was left alone. Don't take this as license to use the reserved prefix. |

**No pristine record.** Upgrade can't infer your edits:

- an absent local file is installed
- a local file identical to incoming establishes the baseline
- a differing local file is reported `conflicted`, not overwritten; review the reported pristine path and merge by hand

**Retirement.** `removed` and `kept` apply only to `ab-setup` and `ab-verify-e2e`.

- A pristine record proves Autobuild provenance; a same-named repository skill without one is left alone.
- A retired skill used by an agent verify or finalize step is kept, as is one whose configuration can't be inspected safely.
- Retirement clears obsolete ownership after classification, so the old skill doesn't come back or get reported again.

**Exit status.**

- **Discovery collisions fail.** A distinct real directory or foreign symlink at `.claude/skills/<name>` is preserved, reported, and makes upgrade exit nonzero, even when a retired canonical tree is removed. Preserved user-owned symlinks keep their exact target text.
- **Content conflicts don't.** `conflicted` results alone, including timeouts and cancelled resolution, still exit zero. Read the report, not just the exit code.

**Commit.** A conflict-free upgrade makes a local commit limited to upgrade-owned changes; `--no-commit` leaves them to you. Conflicts or unsafe Git conditions suppress the commit with an explanation. Review the output and diff. [Upgrading](upgrading.md) covers the full procedure.

## Add a repository-local skill

The `ab-` prefix is reserved for skills Autobuild ships. Give your own skills plain names, such as `verify-acceptance`, in `.agents/skills/verify-acceptance/SKILL.md` with a name, description and instructions. Application-specific evidence requirements belong there.

Every repository must configure an **acceptance check**: a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence and returns a typed verdict. It isn't a test suite and leaves no test files behind.

An agent verifier skill should tell the agent to:

1. Run `ab context` and read the materialized inputs.
2. Gather the application's required evidence.
3. Report `pass`, `fail` or `skip` through `ab verdict`. Its prose response is not the result.

Define what evidence counts as a pass or failure. Then select the skill by exact name in `autobuild.toml`:

```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"
```

Merge this into your existing configuration: append `acceptance` to your ordered steps rather than replacing them. No prefix is inferred from `skill`. See [Verification](verification.md#steps-and-outcomes) for step kinds and outcomes.

## Harness discovery

Codex and Pi read the canonical `.agents/skills/` tree directly. Claude Code reads `.claude/skills/`, where init links each shipped skill to its canonical directory. There's one editable copy.

For a new local skill, add its Claude link from the repository root:

```sh
mkdir -p .claude/skills
ln -s ../../.agents/skills/verify-acceptance .claude/skills/verify-acceptance
```

- **Check first.** If `.claude/skills/` and `.agents/skills/` already alias the same directory, no per-skill link is needed.
- **Don't overwrite.** Preserve existing user-owned directories and foreign links; resolve collisions deliberately.
- **Commit together.** Commit the local skill and its discovery link in one change.
