---
title: "Repository configuration"
group: "reference"
description: "Map autobuild.toml settings to verification, agent roles, capacity, ticket readiness, landing policy, and editable skills."
label: "Configuration"
order: 8
slug: "configuration"
---

# Repository configuration

`autobuild.toml` declares how your repository runs Autobuild. It chooses infrastructure, commands, agent roles, checks, and operating limits. Use the [full configuration reference](configuration.md) for every field and its defaults; this page maps the choices you need to make.


## Commands and extension steps

Named commands define repository tasks. Verification is an ordered list of deterministic command checks or agent verifiers. A repository can also declare optional verify steps for a build's plan to select when relevant.

Finalize post-steps run after PR creation, for work such as updating a changelog. A failed finalize post-step is recorded without failing an otherwise green build. Verify and finalize are the configurable extension points; configuration does not introduce arbitrary phases or reorder the fixed pipeline.


## Roles, models, and limits

Agent roles inherit runtime and model settings from `roles.default` and can override them for a particular job. Ordered alternates provide a declared fallback chain when a provider is unavailable. Choose agents for planning, implementation, review, and agent steps according to the work each role does.

Capacity bounds concurrent work. Policy limits bound review rounds, retries, and session budgets, defining when automation must stop for attention. These limits complement useful checks and clear specs; they do not establish correctness themselves.


## Admission and landing

Ticket settings choose the source and readiness criteria the dispatcher uses to admit work. Landing rules are ordered and first-match: predicates select automatic authorization or explicit consent for a source and destination. The [landing policy reference](landing-policy.md) describes defaults, readiness, and forge gates. See [Operating](operating.md) for consent and hold commands.

Build execution configuration is pinned for reproducibility, while dispatcher policy and role settings have live reload behavior. Consult the [configuration reference](configuration.md) for the boundary before changing settings during a build. Keep secrets outside committed TOML.


## Editable skills and installation

The vendored `ab-*` skills are repository files you can edit. They supply agent judgment: how to plan, implement, review, and operate in your project. Code still owns transitions, state, and gates. Customizing a skill does not replace those deterministic checks.


```
bun ab init
bun ab init --validate
```

`init` writes a stack-neutral configuration when absent, vendors skills, and hands repository-aware setup to a coding agent. It preserves existing configuration. Setup chooses meaningful commands and establishes adapter prerequisites; init does not invent checks from your stack. `init --validate` checks readiness for the configured arrangement.


```
bun ab upgrade
```

`upgrade` updates the installation on its distribution channel and merges upstream skill changes with repository edits, surfacing conflicts for resolution. It preserves customization rather than blindly replacing the installed skills. See [Upgrading](upgrading.md), [Skills](skills.md#how-upgrades-preserve-customization), the [setup reference](setup.md) and [skill installation contract](../SPEC.md#163-skill-installation-vendored-namespaced-editable-d11) for installation, validation, and upgrade details.
