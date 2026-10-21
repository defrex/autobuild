---
title: "Agent runtimes"
group: "reference"
description: "Choose Claude Code, Codex, or Pi, route producer and reviewer models, and implement a runtime adapter."
label: "Agent runtimes"
order: 14
---

# Agent runtimes

## Responsibility

A runtime transports agent turns: start, continue, cancel and end sessions, capture transcripts and usage, and classify failures. Roles choose the runtime and model; the workspace provider decides where they execute. Neither choice starts your external operator agent, which writes specs, grooms tickets, watches dispatch, answers escalations and authorizes landing through the CLI or MCP.

## Shipped adapters

Install Autobuild with `bun add -d --exact @defrex/autobuild`. These are complete minimal configs for local execution. Install and authenticate the chosen CLI on the dispatcher host, then run `bun ab init --validate` before dispatch. A local subscription login is host state: it does not automatically move to a remote sandbox. For remote execution, provision every selected runtime and alternate explicitly and forward only its required API credentials; see [Workspaces](workspaces.md).

### Claude Code (`claude`)

Choose Claude Code for Anthropic models through its CLI and configured authentication. Install the `claude` executable following [Claude Code setup](https://code.claude.com/docs/en/setup), launch `claude` and complete login. Local use needs the configured account login or supported API authentication; API-backed environments need the appropriate provider credential, such as `ANTHROPIC_API_KEY`, rather than copied interactive login state. Consult [Claude authentication](https://code.claude.com/docs/en/authentication) for account requirements.

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "claude"
```
<!-- seam-config:end -->

Omitting `model` uses the CLI's unnamed default. Explicit model ids for this adapter use the `claude-` family; model/output protocol flags are adapter-owned, so use the role's `model` field rather than duplicating those flags in `args`.

### Codex (`codex`)

Choose Codex for OpenAI models through the `codex` CLI. Install it using the [official CLI instructions](https://developers.openai.com/codex/cli), run `codex login`, and authenticate before starting local builds. [Codex authentication](https://developers.openai.com/codex/auth) supports account login and API-key authentication. API use requires its own credential, commonly `OPENAI_API_KEY`, and billing authority; a subscription login on your machine does not authenticate a fresh sandbox.

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "codex"
```
<!-- seam-config:end -->

Omitting `model` uses the CLI's default. Explicit Codex model ids use the `gpt-` family in Autobuild's runtime registry. Use the `model` role field, not a competing model flag in `args`.

### Pi (`pi`)

Choose Pi for provider-qualified models across providers. Install the `pi` executable using [Pi's setup guide](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). For local use, start `pi` and use `/login` for a supported subscription, or supply the selected provider's API credentials. For example, a Vercel AI Gateway route needs `AI_GATEWAY_API_KEY`. Pi's provider configuration determines which account serves the requested model.

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "pi"
model = "vercel-ai-gateway/anthropic/claude-sonnet-4.6"
```
<!-- seam-config:end -->

Pi accepts provider-qualified `provider/model` ids. Its registry default is `kimi-coding/k3` when no model is supplied; select an explicit route when using another provider. Example ids illustrate syntax, not promised availability. Confirm the chosen provider and model are available to your account.

## Choosing models

Start with one strong general coding model as the producer default for planning and implementation. Use a different strong model for plan review, code review and agent verification, preferably from another provider. Independent review can expose different assumptions; it does not guarantee correctness. If your operator agent already works well for spec critique, its model is a useful reviewer candidate while another model builds. Check quality on your repository along with cost, latency and account limits.

This repository's worked example, recorded on **2026-10-21**, uses GPT `gpt-6.1-sol` through Codex for producers and `claude-opus-5-5` through Claude for reviewers, with reciprocal alternates. These are dated example ids, not product defaults or a current model catalog. Keep the producer/reviewer separation as ids change; check current provider availability and `bun ab models` before adopting the example.

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance"

[roles.default]
runtime = "codex"
model = "gpt-6.1-sol"
alternates = [{ runtime = "claude", model = "claude-opus-5-5" }]

[roles.plan]
runtime = "codex"
model = "gpt-6.1-sol"
alternates = [{ runtime = "claude", model = "claude-opus-5-5" }]

[roles.implement]
runtime = "codex"
model = "gpt-6.1-sol"
alternates = [{ runtime = "claude", model = "claude-opus-5-5" }]

[roles.plan-review]
runtime = "claude"
model = "claude-opus-5-5"
alternates = [{ runtime = "codex", model = "gpt-6.1-sol" }]

[roles.code-review]
runtime = "claude"
model = "claude-opus-5-5"
alternates = [{ runtime = "codex", model = "gpt-6.1-sol" }]

[roles.acceptance]
runtime = "claude"
model = "claude-opus-5-5"
alternates = [{ runtime = "codex", model = "gpt-6.1-sol" }]
```
<!-- seam-config:end -->

The `acceptance` extension illustrates routing an agent verifier; author the repository-owned `verify-acceptance` skill before using it. Agent verify roles use the logical step name (`roles.acceptance`), not the skill name. Check steps run commands and need no model.

Each role inherits omitted fields independently from `roles.default`; an explicit `args` list replaces the inherited list. Alternates are ordered availability routes, not additional reviewers. Classified availability or exhaustion can select another route; credential failures and ordinary configuration failures need repair. A classified missing runtime executable may also use an alternate. A fallback may reduce provider independence, so inspect which runtime actually ran. See [role configuration](configuration.md#roles) for routing details.

## Writing your own

Implement `AgentRunner`, return it in a `RuntimeRegistration`, and register the factory in `agentRuntimes`. Import the public types from `@defrex/autobuild/plugin-sdk` and follow [Writing a plugin](plugin-authoring.md) for manifest mechanics.

Preserve start/continue/end session identity, complete transcripts and usage, and a refreshed environment on each turn. Use the distribution-managed `ab` launcher supplied for the session; never substitute a CLI from the build branch. Cancellation must retain an endable handle so the runner can deposit the partial transcript. Failures need verbatim diagnostics, the retry-compatible `permanent` bit and, when classifiable, `cause: availability | exhaustion | credentials | configuration`. Do not misclassify authentication as capacity loss.

Declare `servesModels` prefixes and an optional matching `defaultModel`; these validate routing without inventing a fixed catalog. Optional tool-free `oneShot` is separate from phase sessions. Native resume is also optional: only implementations declaring it should run `describeNativeResumeContract` with a `NativeResumeContractFixture` and preserve fresh-process identity/continuation semantics.

Build an `AgentRunnerContractFactory` with `AgentRunnerContractHarness` fixtures for successful turns, typed failures and cancellation, including turn-environment observations and cleanup. Run the unchanged `describeAgentRunnerContract`, or expose its fixture through the plugin descriptor and run:

```sh
bun ab plugin test agent-runtime acme
```

Exercise declared streaming and one-shot capabilities through their harness fixtures too. A CLI that emits plausible text without preserving the session contract is not a conforming runtime.
