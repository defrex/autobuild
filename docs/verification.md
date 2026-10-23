---
title: "Verification"
label: "Verification"
group: "concepts"
order: 6.5
description: "Configure verification gates, understand setup defaults, and collect evidence that your application meets its spec."
---

# Verification

Verification runs after code review and before finalize. Review judges the code; verification proves what the built software does.

Every repository needs an **acceptance check**: an agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence and returns a typed verdict. It isn't a test suite and leaves no test files.

- **Existing e2e or browser suite:** wire it in as an ordinary `check` step.
- **No suite:** don't create one; the acceptance check neither replaces nor seeds one.
- **Plans** prefer unit and integration tests at seams, adding e2e tests only where a suite exists or the spec asks.

## Steps and outcomes

`[verify].steps` lists ordered `verify:*` steps, each configured in its own table.

| Kind | Runs | Outcome |
|---|---|---|
| `check` | a named `command` from `[commands]`, no agent | exit 0 passes; nonzero fails, keeping the output |
| `agent` | the exact `skill` you configure ([repository-local](skills.md#add-a-repository-local-skill), no prefix inferred) | `ab verdict` records pass, fail or skip |

- **Pass** advances to the next step.
- **Fail** sends the report back through implement and code review, then verification, up to `[policy].maxVerifyAttempts`; then the build escalates.
- **Skip** advances without counting as a pass or spending retries. Plan exclusions and path misses skip deterministically. An agent may skip only when the whole step doesn't apply, with a reason; an applicable behavior it can't exercise is a failure.

## Select what a build needs

Plan selection applies first, then path applicability. Merge fragments like this into your configuration:

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

Substitute your own commands and acceptance skill.

A plan selects steps with TOML front matter:

<!-- plan-front-matter:selection -->
```toml
+++
verifySteps = ["acceptance", "types"]
+++
```

- `verifySteps` is the complete set, including every mandatory step. Execution keeps configuration order: types, then acceptance; unit is skipped.
- No front matter selects every step. An empty array is valid only when no step is mandatory.
- Unknown or duplicate names, malformed metadata and missing mandatory steps are rejected before the plan completes.

Path rules:

- `always = true` makes a step mandatory and bypasses path gating.
- Without `paths`, a step always applies. With `paths`, it applies when any build-owned changed path matches, including deletions and both sides of a rename.
- Globs are case-sensitive and repository-relative: literal segments, `*`, `?` and whole-segment `**`. No negation or absolute paths.
- After a reconcile, upstream-only changes don't count.
- A diff that can't be inspected is an infrastructure failure, never a skip.

After a reconcile, the `afterReconcile` policy applies before plan and path selection. By default it re-verifies; excluded steps are recorded as policy skips.

## Route the verifier role

Agent steps route by step name, not skill name: [`[roles.acceptance]`](agent-runtimes.md#choosing-models) picks the agent for the `acceptance` step. Omitted `runtime` and `model` each inherit from the default role.

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

[`ab init`](getting-started.md#2-initialize-and-configure) writes a skeleton with empty commands and `steps = []`, which verifies nothing, then hands off to a setup agent.

The setup agent reads manifests, CI, tests and conventions, asks what it can't infer, and configures:

- real toolchain commands and an ordered verify chain, with no placeholders
- a repository-owned acceptance-check skill on an agent step, plus any existing e2e suite as a `check` step
- reproducible workspaces: locked dependencies, required system tools and an idempotent `[commands].setup` bootstrap, with remote tooling in [`[workspace.config].provisioning`](workspaces.md)
- for browser apps, a dependency-free `scripts/browser-smoke.sh` that starts the dev server, opens the page in headless Chromium (via a path such as `CHROMIUM_BIN`) and exits nonzero on failure

`bun ab init --validate` checks the environment, not your verify chain.

## Make verification convincing

- **Order:** fast deterministic checks first.
- **Acceptance:** drive the built app through each criterion (create the resource, run the workflow, observe, clean up) with the narrowest flow that catches the regression.
- **Evidence:** for each criterion, record the criterion, action, observation and result. A failure includes reproduction inputs, expected and observed behavior, and native logs. Give passing screenshots, reports and recordings stable artifact kinds so later attempts replace them.
- **Scope:** verifiers don't review style or fix code. See [adding a repository-local skill](skills.md#add-a-repository-local-skill).

A **docs-drift verifier** is another useful pattern: it reports published-doc passages that a build's behavior changes no longer match. Autobuild doesn't ship one; this repository's `docs` step is one.

## Worked example: this repository

Autobuild's own chain: this repository's choices, not defaults.

| # | Step | Kind | What it does |
|---|---|---|---|
| 1 | lint | check | formatting and lint; mandatory |
| 2 | types | check | TypeScript type checking |
| 3 | unit | check | the test suite |
| 4 | postgres | check | live store, service and migration suites, plus hosted-service packaging; mandatory |
| 5 | dashboard | agent | captures terminal-dashboard frames and judges them |
| 6 | web-dashboard | agent | captures operator web-app frames and judges them against the design |
| 7 | website | agent | captures site and docs frames at desktop and phone widths, compared with approved references |
| 8 | docs | agent | fails when a `docs/` passage no longer matches the build's user-facing changes |

Steps 5 to 8 are optional and path-scoped, run by repository skills `ab-verify-dashboard`, `verify-web-dashboard`, `verify-website` and `verify-docs`. The docs step applies to product source, skills, templates, `SPEC.md`, `README.md` and `docs/`. The terminal verifier's `ab-` prefix is legacy; local skills get plain names.

A plan for a docs change like this page selects lint, types, unit, postgres, website and docs; both of the last two pass their path checks because they cover `docs/`. The untouched dashboard steps aren't selected.
