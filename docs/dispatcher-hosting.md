---
title: "Dispatcher hosting"
group: "reference"
description: "Run the dispatcher locally or through bounded hosted invocations over durable state."
label: "Dispatcher hosting"
order: 11
---

# Dispatcher hosting

## Responsibility

The dispatcher claims eligible tickets, starts and observes build runners, settles publication and landing, and recovers durable work.

- **One kernel.** Local and hosted arrangements run the same code.
- **The operator agent is yours.** It watches and acts through the CLI or MCP; Autobuild never starts it.

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

Before launch, the host needs:

- the selected runtime CLI, dependencies, Git and check tools
- runtime authentication and forge credentials ([Forges](forges.md) covers precedence)
- credentials for any remote Store project or workspace provisioning; local SQLite needs no service login

[Workspaces](workspaces.md) covers reproducibility and readiness.

A service manager may own the foreground process, under an identity with the same configuration and credentials. To restart, stop it gracefully and let drain and suspension finish. Work resumes from durable state, but a restart never answers escalations or grants landing consent. See [the dispatcher lifecycle](dispatcher.md).

### Hosted scheduled dispatcher

Commit a remote-compatible configuration to its selected base branch:

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

- **Four independent selections** are required: the hosted HTTP Store, GitHub forge, a remote ticket source and a remote workspace. Hosted tickets need the registered project's team key.
- **Install the Sandbox plugin** in the consuming project and make it available to the dispatcher deployment.
- **Replace the example** runtime, model and pinned provisioning commands with supported values for your account.

Deploy the optional `@defrex/autobuild-hosted-dispatcher` package and mount its `dispatcherEndpoint()` at `/api/dispatch`. A store-only deployment never dispatches. Server-only environment includes:

```sh
export AB_DISPATCHER_ORIGIN='https://builds.example.com'
export CRON_SECRET='<schedule secret>'
export GITHUB_TOKEN='<repository publication token>'
export DATABASE_URL='<postgres connection URL>'
export AI_GATEWAY_API_KEY='<runtime API credential>'
```

The service also needs its Store signing, blob and auth secrets, and registered projects.

- **Execution authority.** A hosted invocation mints project-scoped authority. A separately launched origin-mode CLI uses its saved project credential or an explicit `AB_TOKEN`.
- **Origin dispatch** reads configuration from the forge, requires exported forge credentials, and can't load checkout-relative plugin modules.
- **Sandbox provisioning.** On Vercel, the invocation's OIDC identity authenticates it; don't add `VERCEL_TOKEN` to that service. Elsewhere, provisioning needs the durable token, team and project, or short-lived OIDC credentials, described in [Workspaces](workspaces.md).
- **Guests** receive only the declared runtime API credentials, never Store or forge secrets.

Schedule authenticated invocations in deployment configuration:

```json
{
  "crons": [{ "path": "/api/dispatch", "schedule": "* * * * *" }]
}
```

Build the running distribution's guest archive into the function bundle before deploying. A bundled function can't assume a source checkout or Bun is available to pack it at runtime.

Each invocation is bounded: a 240-second default work budget inside a 300-second route.

- Unfinished work resumes on later ticks; guests keep running independently.
- The durable repository supervisor lease makes overlapping invocations yield safely.
- Selecting Postgres alone never moves dispatch to this service.

## Writing your own

Dispatcher hosting has no plugin manifest port. Deploy or invoke the supported local or origin dispatcher entrypoints and compose the supported Store, workspace and forge adapters. Keep coordination in durable state, never in private channels between processes.

See [Writing a plugin](plugin-authoring.md) for adapter extensions and [Build store](build-store.md#writing-your-own) for a custom storage service.
