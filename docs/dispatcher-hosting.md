---
title: "Dispatcher hosting"
group: "reference"
description: "Run the dispatcher locally or through bounded hosted invocations over durable state."
label: "Dispatcher hosting"
order: 11
---

# Dispatcher hosting

## Responsibility

The dispatcher claims eligible tickets, starts and observes build runners, settles publication and landing, and recovers durable work. Local and hosted arrangements run the same kernel. Your external operator agent watches and acts through the CLI or MCP; Autobuild never starts that agent.

## Shipped arrangements

### Local process

<!-- seam-config:start -->
```toml
forge = "github"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

With Autobuild installed in the repository, run:

```sh
bun ab dispatch
# Or perform one bounded pass:
bun ab dispatch --once
```

Install the selected runtime CLI, dependencies, Git, and check tools on the host. Supply runtime authentication, forge credentials, and any remote Store/project or workspace provisioning credentials before launch. Local SQLite needs no service login. [Repository setup](setup.md) covers reproducibility and readiness; [Forges](forges.md) covers authentication precedence.

A service manager may own the foreground process under an identity with the same configuration and credentials. Stop with graceful termination and allow drain/suspension to finish before restarting. Durable state supports resumption; restarting does not answer escalations or grant landing consent. See [the dispatcher lifecycle](dispatcher.md).

### Hosted scheduled dispatcher

Commit a remote-compatible repository configuration to its selected base branch:

<!-- seam-config:start -->
```toml
forge = "github"
plugins = ["@defrex/autobuild-vercel-sandbox"]

[store]
url = "https://builds.example.com"

[tickets]
source = "hosted"
teamKey = "ENG"

[workspace]
provider = "vercel-sandbox"

[workspace.config]
timeoutSeconds = 2700
environmentVariables = ["AI_GATEWAY_API_KEY"]

[workspace.config.runtimeProvisioning.pi]
install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"
preflight = "test \"$(pi --version)\" = \"0.84.4\" && pi update --models"

[roles.default]
runtime = "pi"
model = "vercel-ai-gateway/anthropic/claude-sonnet-4.6"
```
<!-- seam-config:end -->

Install the Sandbox plugin in the consuming project and make it available in the dispatcher deployment. Choose a real supported runtime/model and pinned provisioning commands for your account before use. Hosted tickets require the registered project's team key. The hosted HTTP Store, GitHub forge, remote ticket source, and remote workspace are independent selections required by this arrangement.

Deploy the optional `@defrex/autobuild-hosted-dispatcher` package and mount its `dispatcherEndpoint()` at `/api/dispatch`. A store-only deployment never dispatches. Server-only environment setup includes:

```sh
export AB_DISPATCHER_ORIGIN='https://builds.example.com'
export CRON_SECRET='<schedule secret>'
export GITHUB_TOKEN='<repository publication token>'
export DATABASE_URL='<postgres connection URL>'
export AI_GATEWAY_API_KEY='<runtime API credential>'
```

The service also needs its Store signing/blob/auth secrets and registered projects; see the [hosted service reference](hosted-service.md). Hosted invocation mints project-scoped execution authority; a separately launched origin-mode CLI uses its saved project credential or explicit `AB_TOKEN`. Origin dispatch reads configuration from the forge, requires exported forge credentials, and cannot load checkout-relative plugin modules.

On Vercel, the invocation's OIDC identity authenticates Sandbox provisioning; do not add `VERCEL_TOKEN` to that service. Outside that arrangement, provisioning needs the durable token/team/project or short-lived OIDC credentials described in [setup](setup.md). Forward only the declared runtime API credentials to guests, never Store or forge secrets.

Schedule authenticated invocations with deployment configuration:

```json
{
  "crons": [{ "path": "/api/dispatch", "schedule": "* * * * *" }]
}
```

Build and ship the running distribution's guest archive into the function bundle before deploying. The [hosted dispatcher deployment reference](hosted-dispatcher.md) covers packaging, the provider plugin, repository selection, and credential overrides. A bundled function cannot assume a source checkout or Bun is available for packing at runtime.

Each invocation is bounded (default work budget 240 seconds within a 300-second route). Unfinished work resumes on subsequent ticks while guests continue independently. The durable repository supervisor lease makes overlapping invocations yield safely. Selecting Postgres alone never moves dispatch to this service.

## Writing your own

Dispatcher hosting has no plugin manifest port. Deploy or invoke the supported local/origin dispatcher entrypoints and compose supported Store, workspace, and forge adapters. Use [Writing a plugin](plugin-authoring.md) for adapter extensions, and the [remote store protocol](remote-store-protocol.md) for a custom storage service. Keep coordination in durable state rather than adding private channels between processes.
