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

Verification uses ordered stages. A string in `[verify].steps` is a singleton
stage; a nonempty array groups members that start together. Empty stages and
repeated names are errors. Plain string lists retain serial event sequences.
Every member resolves post-reconcile policy, approved selection/`always`, then
path applicability at stage entry. Only pass or skip satisfies a member. The
next stage, or finalize after the last, waits for every member to pass or skip.

By default a failure lets all siblings finish; the settled stage routes once
with every failed report, and no later stage runs. `failFast = true` on either
step kind instead cancels members without outcomes, preserving existing
outcomes. The kernel records `verify.cancelled {step, attempt, cause: {step}}`.
Cancellation is neither a pass nor a failure. It ends the entire build execution
through its existing process-group or environment supervisor; a replacement
execution resumes before implement can start. This opt-in teardown/relaunch cost
avoids per-member process groups and ensures cancelled descendants cannot keep
writing to the shared workspace, including after a crash.

An agent escalation holds its own member while siblings continue. The barrier
waits for the answer and that member's rerun, unless fail-fast cancels it.
Cancellation supersedes only that exact verifier occurrence's agent escalations,
including late raises and answers. They stay in history but no longer block,
route guidance, reset budgets, revise the spec or request abort. Answer commands
reject a superseded escalation as stale. Unrelated escalations retain authority.

All members of a cycle share one monotonic attempt. A failed cycle spends one
`maxVerifyAttempts` unit regardless of its failure count. Restart preserves
outcomes and reruns members without outcomes at that same attempt, with
independent agent contexts under `$AB_CONTEXT_DIR` in the shared workspace.
Integration nodes use the same barriers with exact head, parent and restack
identity; their failed-cycle attention is published only after settlement.

Each step has its own `[verify.<step>]` table.

For example: `steps = ["types", ["unit", "integration"], ["acceptance", "docs"]]`.

| Kind | Runs | Outcome |
|---|---|---|
| `check` | a named `command` from `[commands]`, no agent | exit 0 passes; nonzero fails, keeping the output |
| `agent` | the exact `skill` you configure ([repository-local](skills.md#add-a-repository-local-skill), no prefix inferred) | `ab verdict` records pass, fail or skip |

- **Pass** satisfies the member; the next stage waits for its siblings.
- **Fail**, after its stage settles, sends all failed reports back through implement and code review, then verification, up to `[policy].maxVerifyAttempts`; then the build escalates.
- **Skip** satisfies its member without counting as a pass or spending retries. Plan exclusions and path misses skip deterministically. An agent may skip only when the whole step doesn't apply, with a reason; an applicable behavior it can't exercise is a failure.

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
| 3 | unit | check | the test suite, minus database-backed integration tests |
| 4 | build | check | packs every publishable package and checks its contents, imports and bins; mandatory |
| 5 | integration | check | database-backed store, service and migration suites, plus a packed hosted-service deploy rehearsal |
| 6 | ui-tui | agent | captures terminal-dashboard frames and judges them |
| 7 | ui-app | agent | captures operator web-app frames and judges them against the design |
| 8 | ui-website | agent | captures site and docs frames at desktop and phone widths, compared with approved references |
| 9 | docs | agent | fails when a `docs/` passage no longer matches the build's user-facing changes |
| 10 | proa-rust | check | runs the Proa experiment's tooling tests, Rust checks and linked build |
| 11 | ui-proa | agent | captures the Proa experiment's pages and judges them against its ANSI reference |

Steps 5 to 11 are optional and path-scoped. Integration covers core, the Postgres store and the hosted packages; the other agent steps run through repository skills `verify-ui-tui`, `verify-ui-app`, `verify-ui-website`, `verify-docs` and `verify-ui-proa`. The docs step applies to product source, skills, templates, `SPEC.md`, `README.md` and `docs/`.

The two Proa gates apply only to changes in `experiments/proa-server/`, the repository-local `verify-ui-proa` skill or its discovery link. Their prerequisites, commands, capture contract and cache limitations are documented in the `experiments/proa-server/tools/README.md`. These gates are this repository's experiment configuration, not product defaults.

A plan for a docs change like this page selects lint, types, unit, build, ui-website and docs; both of the last two pass their path checks because they cover `docs/`. The untouched ui-tui and ui-app steps aren't selected.

Grouped failures retain the legacy `feedback.verify` object for the first report
in configured order. A decisive `verify.stage-failed` receipt carries the full
ordered reports and cancelled members; `implement.started.verifyStageFailure`
references it. `ab context` materializes all reports and lists cancelled members
as not run, including when guidance is the immediate feedback. Older readers
defer on the decisive new event rather than misreading the stage's outcome.

Implement cancellation feedback is scoped to its referenced failed-stage receipt,
including guidance rounds. Later implement rounds without that receipt have no
`cancelledVerify` list. Finalize receives historical reports but omits that list;
its current verification gates have passed or been skipped.
