---
title: "Operator surfaces"
group: "reference"
description: "Watch and act through the terminal, web app, CLI, or MCP with your operator agent."
label: "Operator surfaces"
order: 12
---

# Operator surfaces

## Responsibility

These are the places your operator agent and you watch and act: inspect tickets and builds, answer escalations, pause work, and authorize landing. The operator agent is external and can run anywhere. Autobuild exposes state and controls; it does not host or start your agent.

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

Dispatch presents the terminal dashboard when interactive. A shell-capable operator agent uses the CLI, including `bun ab watch` or `bun ab wait`, to inspect durable progress and act. The dashboard and API read the same reduced lifecycle vocabulary.

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

Run `bun ab connect https://builds.example.com` to approve the registered project and save its credential outside the checkout. CI can use explicit `AB_TOKEN`. This credential authorizes the project, independently of forge/runtime authentication. See [Build store](build-store.md).

### Web app

The hosted web app presents registered repositories and their durable builds. You sign in through the deployment's GitHub authentication and email allowlist. Browser access does not depend on a local CLI credential. The database, blob, signing, OAuth, and allowlist secrets belong on the service, never in repository TOML or browser bundles.

### Local stdio MCP

For an agent with an MCP client but no convenient shell integration, configure the client to launch the installed CLI:

```sh
bun ab mcp
```

This is a client process command, not an Autobuild TOML setting. Run it from the connected project, or use its `--store` and `--repo` flags to select/constrain authority. It serves the same closed operator tool registry over stdio and exits on client EOF; it needs no persistent daemon. It refuses phase-session `AB_*` authority, including malformed tuples, because repository-wide tools cannot be narrowed to one phase. Sessionless writes use the local user identity, as CLI writes do.

### Hosted HTTP MCP

A remote operator agent connects its MCP client to `https://builds.example.com/mcp` using Streamable HTTP. OAuth discovery, dynamic registration, PKCE, and rotating refresh tokens handle authentication. You authorize through the deployment's sign-in and allowlist. Every call rechecks access and repository scope; durable writes name the authorizing identity and MCP client. Project `AB_TOKEN` credentials are not a substitute for this OAuth flow.

An agent with a shell may keep using the CLI instead.

## Writing your own

There is no operator-surface plugin map. Build a client of the versioned, authenticated Operator API, or connect through MCP. Tools, schemas, annotations, and execution derive from one registry, preserving CLI/API/MCP parity and write attribution. Follow the API's request/version and authentication requirements rather than inferring commands from dashboard markup.

[Writing a plugin](plugin-authoring.md) covers infrastructure adapters, a separate extension route. A new surface does not create a new pipeline phase or an embedded operator agent.
