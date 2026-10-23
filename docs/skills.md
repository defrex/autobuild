---
title: "Skills"
label: "Skills"
group: "concepts"
order: 6
description: "Understand Autobuild's agent skills, customize their defaults for your repository, and keep your edits through upgrades."
---

# Skills

Skills guide the agents that plan, implement, review, and operate Autobuild. Each skill covers a phase or role. They supply judgment; deterministic code still owns build state, transitions, gates, and publication.

## Strong defaults, yours to edit

`ab init` installs the shipped skills as ordinary repository files under `.agents/skills/ab-<name>/`. Each directory contains a `SKILL.md` and may include supporting references or scripts. These are strong defaults you are meant to customize, rather than immutable prompts.

For example, add your project's required implementation conventions to `.agents/skills/ab-implement/SKILL.md`: use the shared database adapter, follow the existing error vocabulary, and run the project's integration checks. Preserve the skill's typed CLI reporting contract, including its context, notes deposit, and completion command. Customize how agents do the work while keeping the lifecycle's deterministic gates intact.

Commit your edits with the repository so every agent works from the same instructions. Edit the live skill tree, not its pristine baseline.

## The shipped skills

`ab init` installs these twelve skills:

- `ab-spec` — **Pre-build grooming.** Help you turn intent into a complete ticket spec; this is not a running spec-phase session.
- `ab-plan` — **Plan.** Produce an implementation plan from the spec.
- `ab-plan-review` — **Plan review.** Independently check the plan against the spec.
- `ab-implement` — **Implement.** Execute the approved plan and commit the change.
- `ab-code-review` — **Code review.** Independently review the implementation against the contract.
- `ab-finalize` — **Finalize.** Write the pull request description after verification.
- `ab-reconcile` — **Reconcile.** Resolve conflicts in a kernel-prepared replay onto a refreshed base.
- `ab-operate` — **External operator agent.** Guide your agent as it files tickets, watches builds, answers escalations, and controls landing.
- `ab-tickets` — **Ticket management.** Read, create, groom, and update tickets through the tracker interface.
- `ab-harvest` — **Harvest synthesis.** Turn claimed observations into structured ticket proposals.
- `ab-harvest-review` — **Harvest review.** Independently review those proposals.
- `ab-guide` — **Reference.** Explain the system, configuration, setup, and installed skills.

The runner invokes phase skills; do not start them manually. Spec grooming and ticket management happen before builds. The operator agent works outside the pipeline, and observation harvest is a separate repository workflow. Autobuild does not ship a generic agent-verifier skill: your repository supplies skills for its own evidence and checks.

## How upgrades preserve customization

Init also records the upstream files under `.agents/skills/.ab-pristine/ab-<name>/`. This tracked tree is the last upstream baseline, not another editable copy.

`ab upgrade` compares three versions of each distributed file: the pristine base, your edited local file, and the incoming upstream default. This includes supporting files as well as `SKILL.md`. Independent edits combine cleanly. When edits overlap, an agent proposes a resolution biased toward your deliberate customization. Deterministic validation checks that the proposal preserves clean regions, contains no new unresolved conflict markers, and retains the skill's frontmatter identity.

After a successful update, pristine advances to the incoming upstream bytes, not the customized merge. This leaves your edits visible for the next upgrade. New upstream support files arrive too; removed upstream files are deleted if unedited, while customized copies remain as repository-local support files.

### Reading the upgrade report

Merging happens per file. A conflicted file keeps both its live and pristine bytes untouched, while other files can advance independently. Each skill's report aggregates its file outcomes, with `conflicted` taking precedence over `resolved`, `merged`, `adopted`, and `current`.

- `current` — Upstream has not changed from the baseline; the local file stands as it is.
- `adopted` — Incoming upstream bytes were adopted and pristine advanced. This also covers restoring a missing live file, adding a new support file, or removing an unedited upstream-deleted support file.
- `merged` — Independent changes combined cleanly and pristine advanced. A customized upstream-deleted support file is also preserved with this outcome, relinquishing its pristine record.
- `resolved` — Overlapping edits received a local-biased agent resolution that passed validation; pristine advanced to incoming upstream.
- `conflicted` — Resolution was unavailable, failed, was declined as ambiguous, or failed validation. That file's live and pristine bytes stay untouched; conflict markers never enter the live skill.
- `installed` — A distributed skill absent from both the live and pristine trees was installed fresh.
- `removed` — An eligible retired skill's unchanged live tree and owned discovery link were removed, or its already-missing live tree's obsolete provenance and owned dangling link were cleaned up.
- `kept` — A retired skill was customized, configured, or unsafe to remove; or a user-owned Claude discovery entry was preserved even though the canonical tree could be removed. Obsolete pristine ownership is cleared.
- `unknown` — An installed `ab-*` name is absent from the distribution and was left alone. This is protective behavior, not a reason to use the reserved prefix for new skills.

Without a pristine record, upgrade cannot infer your edits. An absent local file can be installed, and a local file already identical to incoming upstream can establish its baseline. A differing local file is reported as `conflicted` rather than overwritten. Review the reported pristine path and merge by hand when needed.

The `removed` and `kept` retirement outcomes apply only to `ab-setup` and `ab-verify-e2e`. A pristine record proves their Autobuild provenance; a same-named repository-authored skill without one is left alone. A retired skill referenced by an agent verify or finalize step is kept, as is one whose configuration cannot be inspected safely. Retirement clears obsolete ownership after classification, so it does not repeatedly resurrect or report the old skill.

Claude discovery collisions are separate from content conflicts. A distinct real directory or foreign symlink at `.claude/skills/<name>` is preserved, reported, and makes upgrade exit nonzero, even when an eligible retired canonical tree is removed. Preserved user-owned symlinks retain their exact target text. Content-level `conflicted` results alone retain an exit-zero contract, including timeouts or cancelled resolution; inspect the report rather than relying only on the exit code.

A conflict-free upgrade makes a local commit by default, limited to upgrade-owned changes; `--no-commit` leaves them for you to commit. Conflicts or unsafe Git conditions suppress that automatic commit with an explanation. Review the output and diff. [Upgrading](upgrading.md) covers the full procedure.

## Add a repository-local skill

Reserve the `ab-` prefix for skills Autobuild ships and installs. Give repository additions plain names, such as `verify-acceptance`, and create `.agents/skills/verify-acceptance/SKILL.md` with its name, description, and instructions. Keep application-specific evidence requirements there.

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind.

For an agent verifier, instruct the agent to run `ab context`, read the materialized inputs, inspect the application's required evidence, and report its typed `pass`, `fail`, or `skip` verdict through `ab verdict`. Define what evidence constitutes a pass or failure. The skill should use the verify session's CLI contract, rather than treating its prose response as the result.

Select that skill by its exact name in `autobuild.toml`:

```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"
```

Merge this example into your existing configuration: append `acceptance` to the existing ordered steps instead of replacing them. No prefix is inferred from `skill`. See [Verification](verification.md#steps-and-outcomes) for verify-step kinds and outcomes.

## Harness discovery

Codex and Pi discover the canonical `.agents/skills/` tree directly. Claude Code discovers `.claude/skills/`; init creates links there for shipped skills, pointing to the same canonical directories. There is one editable copy.

For a new local skill, add its Claude link from the repository root:

```sh
mkdir -p .claude/skills
ln -s ../../.agents/skills/verify-acceptance .claude/skills/verify-acceptance
```

Check the existing layout first. If `.claude/skills/` and `.agents/skills/` already alias the same directory, discovery is already satisfied and no per-skill link is needed. Preserve existing user-owned directories or foreign links; resolve a collision deliberately instead of overwriting another skill tree. Commit the local skill and any new discovery link together.
