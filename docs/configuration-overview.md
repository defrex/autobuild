---
title: "Repository configuration"
group: "reference"
description: "Map autobuild.toml settings to verification, agent roles, capacity, ticket readiness, landing policy, and editable skills."
label: "Configuration"
order: 8
slug: "configuration"
---

# Repository configuration

`autobuild.toml` declares how your repository runs Autobuild: infrastructure, commands, agent roles, checks and operating limits. This page maps the choices you make.


## Commands and extension steps

Named commands define repository tasks. Verify and finalize steps run them, or an agent skill, in order:

```toml
[commands]
typecheck = "bun tsc --noEmit"

[verify]
steps = ["types", "acceptance"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill
```

- **Verify** is an ordered list of deterministic command checks and agent verifiers. Optional steps are selected by a build's plan when relevant.
- **Finalize** post-steps run after PR creation, for work such as updating a changelog. A failed post-step is recorded without failing an otherwise green build.
- **Verify and finalize are the only extension points.** Configuration can't add phases or reorder the fixed pipeline.

See the [verification guide](verification.md) for step selection and outcomes.


## Roles, models, and limits

Agent roles inherit runtime and model from `roles.default` and can override them per job. Ordered `alternates` are the fallback chain when a provider is unavailable.

```toml
capacity = 2

[roles.default]
runtime = "claude"

[roles.code-review]
runtime = "pi"
model = "kimi-coding/k3"

[policy]
maxReviewRounds = 6
maxVerifyAttempts = 3
sessionBudgetSeconds = 3600
```

- **Capacity** bounds concurrent work.
- **Policy limits** bound review rounds, retries and session budgets, and decide when automation stops for attention. They complement useful checks and clear specs; they don't establish correctness.


## Admission and landing

- **Tickets.** `[tickets]` chooses the source and the readiness criteria the dispatcher uses to admit work.
- **Landing.** `[[landing]]` rules are ordered and first-match: predicates on source and destination select automatic landing or explicit consent. [Integrating related work](integration-overview.md#policy-authorizes-landing) covers matching and defaults; [Working with your operator agent](operating.md) covers consent and hold commands.
- **Reloads.** Build execution configuration is pinned for reproducibility; dispatcher policy and role settings reload live.
- **Secrets** stay out of committed TOML.


## Editable skills and installation

The vendored `ab-*` skills are repository files you can edit. They supply agent judgment (how to plan, implement, review and operate in your project); code still owns transitions, state and gates, which no skill edit replaces.


```
bun ab init
bun ab init --validate
```

- **`init`** writes a stack-neutral configuration when none exists, vendors skills, and hands repository-aware setup to a coding agent. It preserves existing configuration and doesn't invent checks from your stack; setup chooses meaningful commands and adapter prerequisites.
- **`init --validate`** checks readiness for the configured arrangement.

Every repository must configure an **acceptance check**: a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence and returns a typed verdict. It isn't a test suite and leaves no test files behind.

- An existing end-to-end or browser suite goes in an ordinary `check` step.
- If none exists, setup doesn't create one; the acceptance check neither replaces nor seeds a suite.


```
bun ab upgrade
```

`upgrade` updates the installation on its distribution channel and merges upstream skill changes with your edits, surfacing conflicts for you to resolve rather than replacing customized skills. See [Upgrading](upgrading.md) and [Skills](skills.md#how-upgrades-preserve-customization).
