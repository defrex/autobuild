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


### Forge cooldown admission and explicit recovery

Hosted repository event appends and atomic artifact deposits validate
`dispatcher.forge-degraded` before any durable mutation. The payload must match
its event schema, with a finite ISO `resetAt` at most 24 hours after server time
(inclusive). Already-expired deadlines are accepted. Invalid or out-of-horizon
writes return `400 validation` (the remote adapter exposes `EventValidationError`);
the server never clamps or invents a provider reset. Historical decoding has no clock-relative restriction.

Build-runner and build-phase grants may POST only the kernel-authored
`dispatcher.forge-degraded` repository fact through the events route. The
preceding `requireProject` check binds this exception to the exact repository
in the delegated claim. A hosted project identifies one repository. Delegates
cannot write recovery, deposits or other repository facts, regardless of the
actor claimed in an envelope.

An authorized operator can explicitly clear erroneous state through
`repository.forge_clear {repo, forge, reason}` or
`ab repository forge-clear --forge <name> --reason <text> [--json] [--store <ref>]`.
The reason is required and nonblank. The result contains the durable recovery
`event`, attributed to the authenticated human with normal `via` attribution.
Build and harvest delegates cannot invoke this operator mutation. CLI use
requires an operator outside build/harvest sessions. This is an override, not
proof of provider success. A clear appends once without reading history, even
when already healthy; later degradation wins by ordinary journal order.
Existing dispatcher/kernel automatic recovery and old payloads remain valid;
the recovered payload additionally accepts an optional nonblank `reason`.
