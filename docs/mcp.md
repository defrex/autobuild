# The hosted MCP server

The hosted service exposes the agent tool registry over [Streamable HTTP](https://modelcontextprotocol.io) at
`/mcp`, on the same origin as the operator dashboard. External agents — Claude
web, Claude Desktop, Claude Code, Codex, or any harness with an MCP client —
get the same operator surface the embedded orchestrator has, at parity by
construction: tool names, descriptions, JSON schemas, and annotations are read
from the registry's closed table, and every execution goes through the
operator API's token-verified protocol.

## What the endpoint serves

- **Every registry tool**, with its schema and annotations, plus
  **`repositories.list`** — a read-only tool returning the repository
  identities this deployment serves (the values every tool's `repo` field
  accepts). The binding is data-driven: when a future ticket adds registry
  entries, they appear on the endpoint with no change to the deployment.
- **Server instructions** summarizing how Autobuild works (dispatcher, builds,
  tickets, harvest, notes) and pointing clients at `repositories.list`.
- A **stateless transport**: fresh transport and server per request, JSON
  responses, no session ids. Every request is authenticated independently, so
  cold starts behave identically to warm instances.

## Authentication: OAuth 2.1 through Better Auth

The endpoint is an OAuth 2.1 **protected resource**; the deployment's Better
Auth instance is the **authorization server**. An unauthenticated request to
`/mcp` receives `401` with an RFC 9728 `WWW-Authenticate` challenge pointing at
`/.well-known/oauth-protected-resource`. From there a client:

1. Reads the protected-resource metadata (served at the origin root and under
   `/api/auth`) to discover the authorization server.
2. Reads the authorization-server metadata
   (`/.well-known/oauth-authorization-server`) — authorization, token, and
   dynamic-registration endpoints, plus the `jwks_uri`.
3. Registers dynamically (`POST /api/auth/mcp/register`, RFC 7591); the
   registered `client_name` becomes the `via` marker recorded on writes.
4. Runs the authorization-code flow with PKCE through `GET /api/auth/mcp/authorize`.
   A signed-out person is redirected to the deployment's sign-in page (the
   existing GitHub sign-in and email allowlist); the flow resumes after
   sign-in. A person outside the allowlist cannot complete the flow — and the
   resource re-checks the allowlist on every tool call, so a person dropped
   from the list has their live tokens refused immediately (`403`).
5. Exchanges the code at `/api/auth/mcp/token`; access tokens are short-lived
   and refresh tokens rotate. Consent renders only when the client sends
   `prompt=consent` (the plugin's designed behavior); clients that omit it
   receive a code directly.

Every tool call resolves the token's subject to the signed-in operator, mints
the same 30-second attributed operator token the web gateway mints — stamped
with `via: {kind: "mcp", client}` — and executes the named tool through the
operator server. A mutating tool's durable event therefore names the person
who authorized the client and which client executed it:

```json
{ "kind": "human", "user": "ada@example.com", "via": { "kind": "mcp", "client": "Claude web" } }
```

Tool calls naming a repository outside the deployment's served set are refused
(`kind: "validation"`).

## Duration limits

The MCP route's `maxDuration` is 300 s (Vercel Pro default) — the same pairing
the [dispatcher route](hosted-dispatcher.md) documents. Tool-requested bounded
waits (`builds.events`' `waitSeconds`) are clamped to **`MCP_MAX_WAIT_SECONDS`
= 240 s** at the binding, so no single MCP request outlives the route's limit;
the registry's own schema currently caps that tool's waits lower, and the
clamp is the guard that holds if that cap rises.

## Connecting clients

### Claude web (custom connector)

Settings → Connectors → **Add custom connector**, enter the deployment URL
plus `/mcp` (e.g. `https://operator.example/mcp`). Claude discovers the
authorization server from the protected-resource metadata, registers
dynamically, and sends the person through GitHub sign-in and the consent page;
the OAuth callback is `https://claude.ai/api/mcp/auth_callback` (allowed by
dynamic registration — no configuration needed on the deployment).

### Claude Code

```sh
claude mcp add --transport http autobuild https://operator.example/mcp
```

Claude Code runs the same OAuth 2.1 flow in the terminal (it opens a browser
for sign-in and consent).

### Codex

```sh
codex mcp add autobuild --url https://operator.example/mcp
```

### Any MCP client

Point the client at `<deployment>/mcp` over Streamable HTTP. A client only
needs RFC 9728 discovery, dynamic client registration, PKCE, and refresh —
the standard surface the endpoint serves.

## Operational variables

- `AB_WEB_MCP_RESOURCE` (optional): the protected resource the plugin binds
  tokens to. Defaults to `<BETTER_AUTH_URL>/mcp`, which is correct for the
  standard deployment; override only when a proxy or custom domain fronts the
  function. Must be an absolute http(s) URL (https in production).
- `BETTER_AUTH_URL`: the public origin — the authorization-server issuer and
  the default MCP resource's base.
- `AB_WEB_ALLOWED_EMAILS`: the operator allowlist. Sign-in admission and every
  MCP tool call are checked against it.
- `AB_WEB_REPOSITORIES`: the served repository identities (the
  `repositories.list` payload and the per-call `repo` scope).

The endpoint requires no additional variables beyond the hosted service's
existing web/auth set. Note that consent renders when the client sends
`prompt=consent`; a client that omits it gets a code directly (the plugin's
designed behavior).
