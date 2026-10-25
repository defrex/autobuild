---
title: "Repository configuration"
group: "reference"
description: "Map autobuild.toml settings to verification, agent roles, capacity, ticket readiness, merge policy, and editable skills."
label: "Configuration"
order: 8
slug: "configuration"
---

# Repository configuration

`autobuild.toml` declares your repository's infrastructure, commands, agent roles, checks and operating limits.


## Commands and extension steps

Verify and finalize steps run named commands or agent skills. Verification runs ordered stages whose members may run concurrently; finalize post-steps run serially. A plain list of verify step names keeps serial execution, as in this example:

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

- **Verify**: command checks and agent verifiers. A build's plan selects optional steps.
- **Finalize** post-steps run after PR creation, e.g. a changelog update. A failed post-step is recorded without failing a green build.
- These are the only extension points; configuration can't add or reorder phases.

See the [verification guide](verification.md).


## Roles, models, and limits

Roles inherit runtime and model from `roles.default` and override them per job. Ordered `alternates` are fallbacks when a provider is unavailable.

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
- **Policy limits** bound review rounds, retries and session budgets, and decide when automation stops for attention.


## Admission and merge

- **Tickets.** `[tickets]` sets the source and readiness criteria for admitting work.
- **Merge.** Ordered, first-match `[[merge]]` rules on source and destination select automatic merge or explicit consent. See [Integrating related work](integration-overview.md#policy-authorizes-merge) for matching and defaults, [Working with your operator agent](operating.md) for consent and hold commands.
- **Reloads.** Build execution configuration is pinned; dispatcher policy and role settings reload live.
- **Secrets** stay out of committed TOML.


## Editable skills and installation

The vendored `ab-*` skills are editable repository files supplying agent judgment: how to plan, implement, review and operate. Code owns transitions, state and gates.

```
bun ab init
bun ab init --validate
```

- **`init`** writes a stack-neutral configuration if none exists, vendors skills, and hands repository-aware setup (commands, adapter prerequisites) to a coding agent. Existing configuration is preserved.
- **`init --validate`** checks readiness for the configured arrangement.

Every repository must configure an **acceptance check**: an agent verify step that runs the built software, exercises each acceptance criterion, attaches evidence and returns a typed verdict. It leaves no test files behind. An existing end-to-end or browser suite goes in an ordinary `check` step; setup doesn't create one.

```
bun ab upgrade
```

`upgrade` updates the installation on its distribution channel and merges upstream skill changes into your edits, surfacing conflicts instead of overwriting. See [Upgrading](upgrading.md) and [Skills](skills.md#how-upgrades-preserve-customization).
