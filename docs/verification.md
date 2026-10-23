---
title: "Verification"
label: "Verification"
group: "concepts"
order: 6.5
description: "Configure verification gates, understand setup defaults, and collect evidence that your application meets its spec."
---

# Verification

Verification exercises the implemented result after code review. It is the gate between an approved change and finalization: a review can judge the implementation, but verification proves what the application actually does.

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind.

Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite. Planners prefer unit and integration tests at seams; add end-to-end or browser-automation tests only when the repository already maintains such a suite or the spec asks for one.

## Steps and outcomes

Autobuild runs ordered `verify:*` phases. The `[verify]` table lists `steps`, and each step has its own table. Steps come in two kinds:

- **Check:** `kind = "check"` executes a named `command` from `[commands]`, without starting an agent. Exit zero passes; a nonzero exit fails, retaining command output.
- **Agent:** `kind = "agent"` runs the exact configured `skill`. Your repository supplies this [agent-verifier skill](skills.md#add-a-repository-local-skill); no prefix is inferred. Its typed `ab verdict` records pass, fail, or skip.

A pass advances to the next step. A failure returns its report or command output to implementation, then code review, then verification again. Retries are bounded by `[policy].maxVerifyAttempts`; reaching the limit requires guidance rather than an endless repair loop.

A skip also advances, but remains distinct from a pass and consumes no failure retry budget. Plan exclusions and path misses produce deterministic skips. An agent may skip only when the entire step does not apply, with a nonblank reason. An applicable behavior that cannot be exercised is a failure, never a skip or silent pass.

## Select what a build needs

For ordinary verification, the kernel considers the approved plan's selected set first, then path applicability, then execution. Merge these fragments into an existing configuration rather than replacing its other gates.

This example defines commands and an ordered verify chain. Its `kind`, `command`, `skill`, and `always` fields use that schema; `paths` restricts the application verifier to relevant changes.

<!-- config-fragment:selection -->
```toml
[commands]
typecheck = "bun tsc --noEmit"
test = "bun test"

[verify]
steps = ["types", "unit", "acceptance"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.unit]
kind = "check"
command = "test"

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"
paths = ["web/**", "src/routes/**"]
```

The example assumes a Bun/TypeScript application with a repository-authored `verify-acceptance` skill. Choose actual toolchain commands and an installed skill for your repository.

A plan can start with this TOML front matter:

<!-- plan-front-matter:selection -->
```toml
+++
verifySteps = ["acceptance", "types"]
+++
```

The `verifySteps` array is the complete selected set, including every mandatory step. Execution still follows configuration order: types, then acceptance; unit is skipped. With no opening front matter, all configured steps are selected. An explicit empty array is valid only when no step is mandatory. Unknown or duplicate names, malformed metadata, and missing mandatory steps are rejected before the plan can complete.

`always = true` makes a step mandatory in plan selection and bypasses path gating. Otherwise, omitted paths mean unconditional applicability; supplied paths are positive, case-sensitive, repository-relative globs. Use literal segments, `*`, `?`, and whole-segment `**`; negation and absolute paths are invalid. Any matching build-owned changed path makes the selected step apply, including deletions and both sides of renames. After reconciliation the refreshed base excludes upstream-only changes. Failure to inspect the diff is an infrastructure failure, never permission to skip.

Post-reconcile cycles also honor the separately configured `afterReconcile` policy, evaluated before plan and path selection. Its default re-verifies; excluded steps are recorded as policy skips.

## Route the verifier role

Agent steps route by their logical step name, not their skill name. In this standalone fragment, [`[roles.acceptance]`](agent-runtimes.md#choosing-models) selects the agent for the acceptance step. The `runtime` and `model` fields inherit independently from the default role when omitted.

<!-- config-fragment:routing -->
```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"

[roles.default]
runtime = "codex"
model = "gpt-6.1-sol"

[roles.acceptance]
runtime = "codex"
model = "gpt-6.1-sol"
```

## What initialization sets up

[`ab init` generates](getting-started.md#2-initialize-and-configure) a schema-valid skeleton with empty commands and an empty verification list (`steps = []`), then hands configuration to a setup agent. It installs the shipped skills and their setup reference, but no generic application verifier. A fresh skeleton is not a ready-made test chain.

The installed setup procedure tells the setup agent to inspect manifests, CI, tests, and repository conventions and configure:

- Real toolchain commands and ordered verification, with no invented commands or placeholders.
- A repository-owned acceptance-check skill selected from an agent verify step in every repository. Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite.
- Reproducible fresh workspaces: locked dependencies, required system tools, and idempotent checkout bootstrap through `[commands].setup`. Remote system tooling belongs in [`[workspace.config].provisioning`](workspaces.md).
- For browser applications, a dependency-free `scripts/browser-smoke.sh` that starts the dev server, launches headless Chromium through a repository-controlled path such as `CHROMIUM_BIN`, verifies the rendered page, and exits nonzero on failure.

Your agent derives what it can from the repository and involves you in choices requiring human decisions. Readiness validation checks the environment; it does not claim to execute the full application verify chain.

## Make verification convincing

Put fast deterministic checks first, so simple failures return quickly. Use the acceptance check to drive the built application against every spec acceptance criterion: create the resource, run the workflow, observe its result, and clean up through the actual lifecycle. Choose the narrowest flow that catches the regression.

Produce evidence a reviewer can open and reproduce. For each applicable acceptance criterion record the criterion, action, observation, and result. A failure needs reproduction inputs, expected and observed behavior, and relevant native logs. Passing screenshots, reports, or recordings should have stable artifact kinds so later attempts replace their designation.

Verifiers verify; they do not review the diff for style or fix product code. A repository skill should preserve the agent-verifier CLI and evidence contract: read context, exercise the application, attach passing evidence explicitly, and finish with a typed verdict. See [adding a repository-local skill](skills.md#add-a-repository-local-skill) for naming and harness discovery.

A **docs-drift verifier** is another useful repository-owned pattern: compare the behavior a build changes with the published instructions, and report passages that no longer hold. Autobuild doesn't install one by default. This repository configures one as its `docs` step, described in the worked example below.

## Worked example: this repository

Autobuild's own configuration defines the following ordered chain. These are this repository's choices, not product defaults. The verify schema defines its `steps`, `kind`, `command`, `skill`, and `always` fields; path applicability defines its visual selectors.

1. **lint — check.** Formatting and lint checks; mandatory.
2. **types — check.** TypeScript type checking.
3. **unit — check.** The repository test suite.
4. **postgres — check.** Ensure PostgreSQL is running, exercise live store and service suites plus migration checks, and verify hosted-service packaging; mandatory.
5. **dashboard — agent.** Capture terminal-dashboard frames and judge the rendered evidence.
6. **web-dashboard — agent.** Capture operator web-app frames and judge them against the recorded design.
7. **website — agent.** Capture marketing-site and docs frames at desktop and phone widths and compare with approved references.
8. **docs — agent.** Review the build's exact commit range for changed user-facing behavior, and fail when a passage in `docs/` no longer describes it accurately.

The check steps reference named commands. The last four steps are optional and path-scoped, using the repository's terminal verifier (`ab-verify-dashboard`), web-app verifier (`verify-web-dashboard`), website verifier (`verify-website`), and docs verifier (`verify-docs`). The docs step applies to changes in product source, skills, templates, `SPEC.md`, `README.md` and `docs/`. The terminal skill's legacy `ab-` name is not a convention for new repository skills: reserve that prefix for shipped skills and give new local skills plain names.

Plan selection narrows this configured universe without changing its order. For this guide, lint, types, unit, postgres, website, and docs are warranted; the terminal and operator web-app surfaces are unaffected. Selecting website and docs still subjects each to its configured path check, and both include docs changes. Keeping both mandatory checks in the selection preserves the repository's gates, the website verifier supplies evidence of the published article and navigation, and the docs verifier confirms the article matches the behavior it describes.
