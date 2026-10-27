---
title: "Agent runtimes"
group: "reference"
description: "Choose Claude Code, Codex, or Pi, route producer and reviewer models, and implement a runtime adapter."
label: "Agent runtimes"
order: 14
---

# Agent runtimes

## Responsibility

A runtime transports agent turns: it starts, continues, cancels and ends sessions, captures transcripts and usage, and classifies failures. Roles choose the runtime and model; the workspace provider decides where they execute. Neither starts your operator agent, which works externally through the CLI or MCP.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Examples are complete minimal configs for local execution: install and authenticate the CLI on the dispatcher host, then run `bun ab init --validate`.

Claude Code supports named subscription and Kimi Code billing [accounts](configuration-overview.md#accounts). In a remote sandbox, the guest holds placeholders and host egress policy supplies credentials only to the selected provider. Use the unmodified runtime with your own subscription for ordinary individual usage. Provision every selected runtime and alternate; Pi and Codex retain their existing authentication. See [Workspaces](workspaces.md).

| Runtime | Models | Model ids | Default model |
|---|---|---|---|
| `claude` | Anthropic or a selected Kimi Code account, via Claude Code | `claude-` family; Kimi membership IDs with a Kimi account | CLI default; `kimi-for-coding` for Kimi |
| `codex` | OpenAI, via the Codex CLI | `gpt-` family | the CLI's default |
| `pi` | many providers | `provider/model` | `kimi-coding/k3` |

Set the model with the role's `model` field, not in `args`; the adapter owns model and output-protocol flags.

### Claude Code (`claude`)

Install `claude` ([setup](https://code.claude.com/docs/en/setup)) and log in. Remote environments can select a declared subscription or Kimi Code account; legacy API routes can use `ANTHROPIC_API_KEY`. Host login files are not copied; see [Claude authentication](https://code.claude.com/docs/en/authentication).

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "claude"
```
<!-- seam-config:end -->

### Codex (`codex`)

Install `codex` ([CLI instructions](https://developers.openai.com/codex/cli)) and run `codex login`. API use needs its own credential, commonly `OPENAI_API_KEY`, with billing authority; see [Codex authentication](https://developers.openai.com/codex/auth).

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "codex"
```
<!-- seam-config:end -->

### Pi (`pi`)

Install `pi` ([setup guide](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)), then `/login` with a supported subscription or supply the provider's API credentials (a Vercel AI Gateway route needs `AI_GATEWAY_API_KEY`). Pi's provider configuration decides which account serves the model.

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

Set an explicit route for any provider other than the `kimi-coding/k3` default. Example ids show syntax, not availability.

## Choosing models

- **Producers** (plan, implement): one strong general coding model.
- **Reviewers** (plan review, code review, agent verification): a different strong model, preferably from another provider, to expose different assumptions. If your operator agent critiques specs well, its model is a good candidate.
- **Measure** quality, cost, latency and account limits on your repository.

This repository's example, recorded **2026-10-21**, uses `gpt-6.1-sol` (Codex) for producers and `claude-opus-5-5` (Claude) for reviewers, with reciprocal alternates. These are dated ids, not defaults; check `bun ab models` before adopting them.

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

- **Verifier roles** use the step name (`roles.acceptance`), not the skill name; author the `verify-acceptance` skill first. Check steps run commands and need no model.
- **Inheritance.** Each role inherits omitted fields from `roles.default` field by field; an explicit `args` list replaces the inherited one.
- **Alternates** are ordered availability routes, not extra reviewers. Availability or exhaustion failures, or a missing executable, select the next route; credential and configuration failures need repair. A fallback may cost provider independence, so check which runtime ran.

## Writing your own

Implement `AgentRunner`, return it in a `RuntimeRegistration`, and register the factory in `agentRuntimes`. Import from `@defrex/autobuild/plugin-sdk`; [Writing a plugin](plugin-authoring.md) covers the manifest.

A runtime must:

- preserve start/continue/end session identity, complete transcripts and usage, and refresh the environment each turn
- use the session's supplied `ab` launcher, never a CLI from the build branch
- keep an endable handle after cancellation so the runner can deposit the partial transcript
- report failures with verbatim diagnostics, the `permanent` bit and, when classifiable, `cause: availability | exhaustion | credentials | configuration`; never classify authentication as capacity loss
- declare `servesModels` prefixes and an optional matching `defaultModel` for routing validation

Optional capabilities:

- **`oneShot`**, tool-free and separate from phase sessions.
- **Native resume.** Declaring it means running `describeNativeResumeContract` with a `NativeResumeContractFixture` and preserving fresh-process identity and continuation semantics.

Test with an `AgentRunnerContractFactory` whose `AgentRunnerContractHarness` fixtures cover successful turns, typed failures, cancellation, turn-environment observations and cleanup. Run `describeAgentRunnerContract` unchanged, or expose its fixture through the plugin descriptor and run:

```sh
bun ab plugin test agent-runtime acme
```

Exercise declared streaming and one-shot capabilities through their harness fixtures too.
