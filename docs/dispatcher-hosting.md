---
title: "Dispatcher hosting"
group: "reference"
description: "Run the dispatcher locally or through bounded hosted invocations over durable state."
label: "Dispatcher hosting"
order: 11
---

# Dispatcher hosting

## Responsibility

The dispatcher claims eligible tickets, starts and observes build runners, settles publication and merge, and recovers durable work. Local and hosted arrangements run the same kernel. Your operator agent acts through the CLI or MCP; Autobuild never starts it.

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

```sh
bun ab dispatch
# Or perform one bounded pass:
bun ab dispatch --once
```

The host needs:

- the runtime CLI, dependencies, Git and check tools ([Workspaces](workspaces.md))
- runtime authentication and forge credentials ([Forges](forges.md) covers precedence)
- credentials for a remote Store or workspace provisioning, if used

A service manager may own the process under an identity with the same configuration and credentials. To restart, stop gracefully and let drain and suspension finish; work resumes from durable state. A restart never answers escalations or grants merge consent. See [the dispatcher lifecycle](dispatcher.md).

### Hosted scheduled dispatcher

Commit a remote-compatible configuration to the base branch:

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

- **Required:** hosted HTTP Store, GitHub forge, remote ticket source, remote workspace. Hosted tickets need the registered project's team key.
- **Install the Sandbox plugin** in the project and make it available to the dispatcher deployment.
- **Replace the example** runtime, model and provisioning commands with values for your account.

Deploy `@defrex/autobuild-hosted-dispatcher` and mount its `dispatcherEndpoint()` at `/api/dispatch`; a store-only deployment never dispatches. Server-only environment includes:

```sh
export AB_DISPATCHER_ORIGIN='https://builds.example.com'
export CRON_SECRET='<schedule secret>'
export GITHUB_TOKEN='<repository publication token>'
export DATABASE_URL='<postgres connection URL>'
export AI_GATEWAY_API_KEY='<runtime API credential>'
```

Plus the Store's signing, blob and auth secrets, and registered projects.

- **Authority.** A hosted invocation mints project-scoped authority; a separately launched origin-mode CLI uses its saved project credential or `AB_TOKEN`.
- **Origin dispatch** reads configuration from the forge, needs exported forge credentials, and can't load checkout-relative plugins.
- **Sandbox provisioning.** On Vercel, the invocation's OIDC identity authenticates; don't add `VERCEL_TOKEN`. Elsewhere, it needs a durable token, team and project, or short-lived OIDC credentials ([Workspaces](workspaces.md)).
- **Guests** get only the declared runtime API credentials, never Store or forge secrets.

Schedule authenticated invocations:

```json
{
  "crons": [{ "path": "/api/dispatch", "schedule": "* * * * *" }]
}
```

Build the distribution's guest archive into the function bundle before deploying; the function can't pack it at runtime.

- **Bounded ticks:** a 240-second default work budget inside a 300-second route. Unfinished work resumes on later ticks; guests run independently.
- **Overlap:** the repository supervisor lease makes overlapping invocations yield.
- Selecting Postgres alone never moves dispatch here.

## Writing your own

There's no hosting plugin port. Invoke the local or origin dispatcher entrypoints with supported Store, workspace and forge adapters, and keep coordination in durable state, never private channels between processes.

See [Writing a plugin](plugin-authoring.md) for adapters and [Build store](build-store.md#writing-your-own) for custom storage.
