---
title: "Verification"
label: "Verification"
group: "concepts"
order: 6.5
description: "Configure verification gates, understand setup defaults, and collect evidence that your application meets its spec."
---

# Verification

Verification exercises the implemented result after code review. It is the gate between an approved change and finalization: a review can judge the implementation, but verification proves what the application actually does.

## Steps and outcomes

Autobuild runs ordered `verify:*` phases. The configuration reference defines [`[verify]`, `steps`, and each step table](configuration.md#verify-and-verifystep), with two kinds:

- **Check:** `kind = "check"` executes a named `command` from [`[commands]`](configuration.md#commands), without starting an agent. Exit zero passes; a nonzero exit fails, retaining command output.
- **Agent:** `kind = "agent"` runs the exact configured `skill`. Your repository supplies this [agent-verifier skill](skills.md#add-a-repository-local-skill); no prefix is inferred. Its typed `ab verdict` records pass, fail, or skip.

A pass advances to the next step. A failure returns its report or command output to implementation, then code review, then verification again. Retries are bounded by [`[policy].maxVerifyAttempts`](configuration.md#policy); reaching the limit requires guidance rather than an endless repair loop.

A skip also advances, but remains distinct from a pass and consumes no failure retry budget. Plan exclusions and path misses produce deterministic skips. An agent may skip only when the entire step does not apply, with a nonblank reason. An applicable behavior that cannot be exercised is a failure, never a skip or silent pass. See [pass, fail, and skip](configuration.md#pass-fail-and-skip).

## Select what a build needs

For ordinary verification, the kernel considers the approved plan's selected set first, then path applicability, then execution. Merge these fragments into an existing configuration rather than replacing its other gates.

This example defines [commands](configuration.md#commands) and an ordered [verify chain](configuration.md#verify-and-verifystep). Its `kind`, `command`, `skill`, and `always` fields use that schema; [`paths`](configuration.md#path-applicability) restricts the application verifier to relevant changes.

<!-- config-fragment:selection -->
```toml
[commands]
typecheck = "bun tsc --noEmit"
test = "bun test"

[verify]
steps = ["types", "unit", "app"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.unit]
kind = "check"
command = "test"

[verify.app]
kind = "agent"
skill = "verify-app"
paths = ["web/**", "src/routes/**"]
```

The example assumes a Bun/TypeScript application with a repository-authored `verify-app` skill. Choose actual toolchain commands and an installed skill for your repository.

A plan can start with this [TOML front matter](configuration.md#plan-selected-steps):

<!-- plan-front-matter:selection -->
```toml
+++
verifySteps = ["app", "types"]
+++
```

The `verifySteps` array is the complete selected set, including every mandatory step. Execution still follows configuration order: types, then app; unit is skipped. With no opening front matter, all configured steps are selected. An explicit empty array is valid only when no step is mandatory. Unknown or duplicate names, malformed metadata, and missing mandatory steps are rejected before the plan can complete.

[`always = true`](configuration.md#verify-and-verifystep) makes a step mandatory in plan selection and bypasses path gating. Otherwise, omitted paths mean unconditional applicability; supplied paths are positive, case-sensitive, repository-relative globs. Use literal segments, `*`, `?`, and whole-segment `**`; negation and absolute paths are invalid. Any matching build-owned changed path makes the selected step apply, including deletions and both sides of renames. After reconciliation the refreshed base excludes upstream-only changes. Failure to inspect the diff is an infrastructure failure, never permission to skip.

Post-reconcile cycles also honor the separately configured [`afterReconcile` policy](configuration.md#verify-and-verifystep), evaluated before plan and path selection. Its default re-verifies; excluded steps are recorded as policy skips.

## Route the verifier role

Agent steps route by their logical step name, not their skill name. In this standalone fragment, [`[roles.app]`](configuration.md#role-routing-for-an-agent-verify-step) selects the agent for the app step. The [`runtime` and `model` fields](configuration.md#roles) inherit independently from the default role when omitted.

<!-- config-fragment:routing -->
```toml
[verify]
steps = ["app"]

[verify.app]
kind = "agent"
skill = "verify-app"

[roles.default]
runtime = "codex"
model = "gpt-6.1-sol"

[roles.app]
runtime = "codex"
model = "gpt-6.1-sol"
```

## What initialization sets up

[`ab init` generates](configuration.md#what-ab-init-generates) a schema-valid skeleton with empty commands and an empty verification list (`steps = []`), then hands configuration to a setup agent. It installs the shipped skills and their setup reference, but no generic application verifier. A fresh skeleton is not a ready-made test chain.

The [installed setup procedure](../skills/guide/references/setup.md#make-the-environment-reproducible) tells the setup agent to inspect manifests, CI, tests, and repository conventions and configure:

- Real toolchain commands and ordered verification, with no invented commands or placeholders.
- End-to-end flows through the repository's real lifecycle and tools. Where judgment is needed, a repository-owned agent-verifier skill.
- Reproducible fresh workspaces: locked dependencies, required system tools, and idempotent checkout bootstrap through [`[commands].setup`](configuration.md#commands). Remote system tooling belongs in [`[workspace.config].provisioning`](configuration.md#vercel-sandbox).
- For browser applications, a dependency-free `scripts/browser-smoke.sh` that starts the dev server, launches headless Chromium through a repository-controlled path such as `CHROMIUM_BIN`, verifies the rendered page, and exits nonzero on failure.

Your agent derives what it can from the repository and involves you in choices requiring human decisions. Follow the [setup guide](setup.md) for readiness validation; readiness checks do not claim to execute the full application verify chain.

## Make verification convincing

Put fast deterministic checks first, so simple failures return quickly. Include at least one honest end-to-end step that drives the real application: create the resource, run the workflow, observe its result, and clean up through the actual lifecycle. Choose the narrowest flow that catches the regression.

Produce evidence a reviewer can open and reproduce. For each applicable acceptance criterion record the criterion, action, observation, and result. A failure needs reproduction inputs, expected and observed behavior, and relevant native logs. Passing screenshots, reports, or recordings should have stable artifact kinds so later attempts replace their designation.

Verifiers verify; they do not review the diff for style or fix product code. A repository skill should preserve the [agent-verifier CLI and evidence contract](../skills/guide/references/setup.md#authoring-an-agent-verifier): read context, exercise the application, attach passing evidence explicitly, and finish with a typed verdict. See [adding a repository-local skill](skills.md#add-a-repository-local-skill) for naming and harness discovery.

A **docs-drift verifier** is another useful repository-owned pattern: compare the behavior a build changes with the published instructions, and report passages that no longer hold. Autobuild doesn't install one by default. This repository configures one as its `docs` step, described in the worked example below.

## Worked example: this repository

Autobuild's own [configuration](https://github.com/defrex/autobuild/blob/main/autobuild.toml) defines the following ordered chain. These are this repository's choices, not product defaults. The [verify schema](configuration.md#verify-and-verifystep) defines its `steps`, `kind`, `command`, `skill`, and `always` fields; [path applicability](configuration.md#path-applicability) defines its visual selectors.

1. **lint — check.** Formatting and lint checks; mandatory.
2. **types — check.** TypeScript type checking.
3. **unit — check.** The repository test suite.
4. **postgres — check.** Ensure PostgreSQL is running, exercise live store and service suites plus migration checks, and verify hosted-service packaging; mandatory.
5. **dashboard — agent.** Capture terminal-dashboard frames and judge the rendered evidence.
6. **web-dashboard — agent.** Capture operator web-app frames and judge them against the recorded design.
7. **website — agent.** Capture marketing-site and docs frames at desktop and phone widths and compare with approved references.
8. **docs — agent.** Review the build's exact commit range for changed user-facing behavior, and fail when a passage in `docs/` no longer describes it accurately.

The check steps reference named [commands](configuration.md#commands). The last four steps are optional and path-scoped, using the repository's [terminal verifier](../.agents/skills/ab-verify-dashboard/SKILL.md), [web-app verifier](../.agents/skills/verify-web-dashboard/SKILL.md), [website verifier](../.agents/skills/verify-website/SKILL.md), and [docs verifier](../.agents/skills/verify-docs/SKILL.md). The docs step applies to changes in product source, skills, templates, `SPEC.md`, `README.md` and `docs/`. The terminal skill's legacy `ab-` name is not a convention for new repository skills: reserve that prefix for shipped skills and give new local skills plain names.

[Plan selection](configuration.md#plan-selected-steps) narrows this configured universe without changing its order. For this guide, lint, types, unit, postgres, website, and docs are warranted; the terminal and operator web-app surfaces are unaffected. Selecting website and docs still subjects each to its configured path check, and both include docs changes. Keeping both mandatory checks in the selection preserves the repository's gates, the website verifier supplies evidence of the published article and navigation, and the docs verifier confirms the article matches the behavior it describes.
