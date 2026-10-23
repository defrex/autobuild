---
title: "Operator surfaces"
group: "reference"
description: "Watch and act through the terminal, web app, CLI, or MCP with your operator agent."
label: "Operator surfaces"
order: 12
---

# Operator surfaces

## Responsibility

Operator surfaces are where your operator agent and you watch and act: inspect tickets and builds, answer escalations, pause work and authorize landing. Autobuild exposes state and controls; it never hosts or starts your agent, which can run anywhere.

## Shipped arrangements

### Terminal dashboard and local CLI

A local Store needs no additional dashboard credential:

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

```sh
bun ab dispatch
bun ab builds
bun ab build status example-build --json
```

- **Dispatch** shows the terminal dashboard when interactive.
- **A shell-capable agent** uses the CLI, including `bun ab watch` and `bun ab wait`, to follow durable progress and act.
- **The dashboard and API** read the same reduced lifecycle vocabulary.

A local CLI can also use a remote Store:

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Run `bun ab connect https://builds.example.com` to approve the registered project and save its credential outside the checkout; CI can set `AB_TOKEN` instead. This credential authorizes the project only, separate from forge and runtime authentication. See [Build store](build-store.md).

### Web app

The hosted web app shows registered repositories and their durable builds.

- **Sign-in** uses the deployment's GitHub authentication and email allowlist, independent of any local CLI credential.
- **Secrets** (database, blob, signing, OAuth, allowlist) live on the service, never in repository TOML or browser bundles.

### Local stdio MCP

For an agent with an MCP client but no convenient shell, configure the client to launch the installed CLI:

```sh
bun ab mcp
```

This is a client process command, not a TOML setting.

- **Scope.** Run it from the connected project, or pass `--store` and `--repo` to select and constrain authority.
- **Lifetime.** It serves the same closed operator tool registry over stdio and exits on client EOF; no daemon.
- **Phase refusal.** It refuses phase-session `AB_*` authority, including malformed tuples, because repository-wide tools can't be narrowed to one phase.
- **Attribution.** Sessionless writes use the local user identity, as CLI writes do.

### Hosted HTTP MCP

A remote operator agent connects its MCP client to `https://builds.example.com/mcp` over Streamable HTTP.

- **Authentication** is OAuth with discovery, dynamic registration, PKCE and rotating refresh tokens; you authorize through the deployment's sign-in and allowlist. Project `AB_TOKEN` credentials don't substitute for it.
- **Every call** rechecks access and repository scope.
- **Durable writes** name the authorizing identity and MCP client.

An agent with a shell may keep using the CLI instead.

## Writing your own

There's no operator-surface plugin map. Build a client of the versioned, authenticated Operator API, or connect through MCP.

- Tools, schemas, annotations and execution all derive from one registry, which keeps CLI, API and MCP at parity and preserves write attribution.
- Follow the API's request, version and authentication requirements; don't infer commands from dashboard markup.
- A new surface adds no pipeline phase and no embedded operator agent.

[Writing a plugin](plugin-authoring.md) covers infrastructure adapters, a separate extension route.
