---
title: "Operator surfaces"
group: "reference"
description: "Watch and act through the terminal, CLI, local stdio MCP, or Operator API with your operator agent."
label: "Operator surfaces"
order: 12
---

# Operator surfaces

## Responsibility

Operator surfaces are where you and your operator agent inspect tickets and builds, answer escalations, pause work and authorize merge. Autobuild never hosts or starts your agent; it runs anywhere.

## Shipped arrangements

### Terminal dashboard and local CLI

A local Store needs no dashboard credential:

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

- Interactive `dispatch` shows the terminal dashboard.
- A shell-capable agent follows progress and acts through the CLI, including `bun ab watch` and `bun ab wait`.
- A standing CLI operator uses `bun ab watch --operator --json` after checking `bun ab repository status --json` for existing presence. It operates the builds the repository's dispatcher dispatches and adopts new ones.
- Presence is advisory, allows multiple registrations, and is not exposed by MCP. Termination attempts withdrawal; routine timeout/count re-arms keep the five-minute grace. SIGKILL and failed withdrawal rely on TTL expiry.
- Dashboard and API share one lifecycle vocabulary.

A local CLI can use a remote Store:

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

`bun ab connect https://builds.example.com` approves the registered project and saves its credential outside the checkout; CI sets `AB_TOKEN` instead. It authorizes the project only, not forge or runtime access. See [Build store](build-store.md).

### Local stdio MCP

For an agent with an MCP client but no convenient shell, configure the client to launch:

```sh
bun ab mcp
```

- **Scope.** Run from the connected project, or pass `--store` and `--repo` to constrain authority.
- **Lifetime.** Serves the operator tool registry over stdio; exits on client EOF. No daemon.
- **Phase refusal.** Refuses phase-session `AB_*` authority, including malformed tuples: repository-wide tools can't be narrowed to one phase.
- **Attribution.** Sessionless writes use the local user identity, like the CLI.

## Writing your own

There's no operator-surface plugin map. Build a client of the versioned, authenticated Operator API, or launch local stdio MCP.

- One registry defines tools, schemas, annotations and execution, keeping CLI, API and MCP at parity.
- Follow the API's request, version and authentication requirements; don't scrape dashboard markup.
- A new surface adds no pipeline phase and no embedded operator agent.

[Writing a plugin](plugin-authoring.md) covers infrastructure adapters.
