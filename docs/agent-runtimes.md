---
title: "Agent runtimes"
group: "reference"
description: "Choose Claude Code, Codex, or Pi, route producer and reviewer models, and implement a runtime adapter."
label: "Agent runtimes"
order: 14
---

# Agent runtimes

## Responsibility

A runtime transports agent turns: it starts, continues, cancels and ends sessions, captures transcripts and usage, and classifies failures.

- **Roles** choose the runtime and model.
- **The workspace provider** decides where they execute.
- **Neither starts your operator agent.** That external agent writes specs, grooms tickets, watches dispatch, answers escalations and authorizes landing through the CLI or MCP.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Each example is a complete minimal config for local execution: install and authenticate the chosen CLI on the dispatcher host, then run `bun ab init --validate` before dispatch.

A local subscription login is host state and doesn't move to a remote sandbox. For remote execution, provision every selected runtime and alternate explicitly and forward only its API credentials; see [Workspaces](workspaces.md).

| Runtime | Models | Model ids | Default when `model` is omitted |
|---|---|---|---|
| `claude` | Anthropic, via Claude Code | `claude-` family | the CLI's default |
| `codex` | OpenAI, via the Codex CLI | `gpt-` family | the CLI's default |
| `pi` | many providers | `provider/model` | `kimi-coding/k3` |

Set the model with the role's `model` field. Model and output protocol flags are adapter-owned, so don't repeat them in `args`.

### Claude Code (`claude`)

Install `claude` following [Claude Code setup](https://code.claude.com/docs/en/setup), then launch it and log in, or use supported API authentication. API-backed environments need a provider credential such as `ANTHROPIC_API_KEY`, not copied login state. See [Claude authentication](https://code.claude.com/docs/en/authentication) for account requirements.

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

Install `codex` using the [official CLI instructions](https://developers.openai.com/codex/cli) and run `codex login` before local builds. [Codex authentication](https://developers.openai.com/codex/auth) supports account login or an API key. API use needs its own credential, commonly `OPENAI_API_KEY`, and billing authority; your machine's subscription login doesn't authenticate a fresh sandbox.

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

Install `pi` using [Pi's setup guide](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Locally, start `pi` and `/login` with a supported subscription, or supply the provider's API credentials; a Vercel AI Gateway route, for example, needs `AI_GATEWAY_API_KEY`. Pi's provider configuration decides which account serves the model.

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

Set an explicit route when using a provider other than the `kimi-coding/k3` default. Example ids show syntax, not availability: confirm the provider and model are available to your account.

## Choosing models

- **Producers.** Use one strong general coding model as the default for planning and implementation.
- **Reviewers.** Use a different strong model, preferably from another provider, for plan review, code review and agent verification. Independent review can expose different assumptions; it doesn't guarantee correctness.
- **Operator model.** If your operator agent already critiques specs well, its model is a good reviewer candidate.
- **Measure** quality on your repository, along with cost, latency and account limits.

This repository's example, recorded on **2026-10-21**, uses `gpt-6.1-sol` through Codex for producers and `claude-opus-5-5` through Claude for reviewers, with reciprocal alternates. These are dated ids, not product defaults or a catalog. Check provider availability and `bun ab models` before adopting them, and keep the producer/reviewer split as ids change.

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

- **Verifier roles** use the logical step name (`roles.acceptance`), not the skill name. Author the repository-owned `verify-acceptance` skill before using this example. Check steps run commands and need no model.
- **Inheritance.** Each role inherits omitted fields from `roles.default` independently; an explicit `args` list replaces the inherited one.
- **Alternates** are ordered availability routes, not extra reviewers. Classified availability or exhaustion failures, or a missing runtime executable, select the next route; credential and ordinary configuration failures need repair. A fallback may cost provider independence, so check which runtime actually ran.

## Writing your own

Implement `AgentRunner`, return it in a `RuntimeRegistration`, and register the factory in `agentRuntimes`. Import public types from `@defrex/autobuild/plugin-sdk`; [Writing a plugin](plugin-authoring.md) covers manifest mechanics.

A runtime must:

- preserve start/continue/end session identity, complete transcripts and usage, and a refreshed environment on each turn
- use the distribution-managed `ab` launcher supplied for the session, never a CLI from the build branch
- keep an endable handle after cancellation, so the runner can deposit the partial transcript
- report failures with verbatim diagnostics, the retry-compatible `permanent` bit and, when classifiable, `cause: availability | exhaustion | credentials | configuration`; never classify authentication as capacity loss
- declare `servesModels` prefixes and an optional matching `defaultModel`, which validate routing without a fixed catalog

Optional capabilities:

- **`oneShot`**, tool-free and separate from phase sessions.
- **Native resume.** Only implementations that declare it run `describeNativeResumeContract` with a `NativeResumeContractFixture`, and they must preserve fresh-process identity and continuation semantics.

Test with an `AgentRunnerContractFactory` whose `AgentRunnerContractHarness` fixtures cover successful turns, typed failures and cancellation, including turn-environment observations and cleanup. Run `describeAgentRunnerContract` unchanged, or expose its fixture through the plugin descriptor and run:

```sh
bun ab plugin test agent-runtime acme
```

Exercise declared streaming and one-shot capabilities through their harness fixtures too. A CLI that emits plausible text without keeping the session contract isn't a conforming runtime.
