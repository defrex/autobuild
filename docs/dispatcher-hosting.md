---
title: "Dispatcher hosting"
group: "reference"
description: "Run a local dispatcher with local or remote workspaces over durable state."
label: "Dispatcher hosting"
order: 11
---

# Dispatcher hosting

## Responsibility

The dispatcher claims eligible tickets, starts and observes build runners, settles publication and merge, and recovers durable work. Local and origin-mode arrangements run the same kernel. Your operator agent acts through the CLI or MCP; Autobuild never starts it.

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

### Origin-mode dispatcher with remote workspaces

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

Run the supported CLI from an HTTPS GitHub origin:

```sh
bun ab dispatch --origin https://github.com/acme/app --plain --store https://builds.example.com
```

Use a remote store that speaks the remote BuildStore protocol.
Connect the project with `ab connect` or supply `AB_TOKEN`. Hosted tickets use
that registered project's team key. Install the Sandbox plugin on the dispatcher
host and replace the example runtime and model with your account's values.
Origin mode reads configuration from the forge and cannot load checkout-relative
plugins. Export push-capable `GITHUB_TOKEN` or `GH_TOKEN`; forge credentials stay
on the host. Sandbox provisioning needs `VERCEL_OIDC_TOKEN` or the durable
`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` tuple. Guests receive only
declared runtime API credentials and scoped execution grants.
See `docs/setup.md` for origin-mode setup and [Workspaces](workspaces.md).

## Writing your own

There's no hosting plugin port. Invoke the local or origin dispatcher entrypoints with supported Store, workspace and forge adapters, and keep coordination in durable state, never private channels between processes.

See [Writing a plugin](plugin-authoring.md) for adapters and [Build store](build-store.md#writing-your-own) for custom storage.
