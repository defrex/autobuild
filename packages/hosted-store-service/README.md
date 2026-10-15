# `@defrex/autobuild-hosted-store-service`

The optional hosted Autobuild service composes the remote BuildStore and the
full TicketSource HTTP protocol with `@defrex/autobuild-postgres-store`; the
protocol servers live here while their client half, wire schemas, and token
minting ship in the `@defrex/autobuild` core package. The Next.js application
lives in this package's `app/` tree: it mounts those machine protocols
unchanged and serves the cookie-authenticated operator dashboard on the same
origin. `server.ts` in this package remains the named bare-Bun
machine-service entrypoint for non-Next hosts.

## Deploy the full service

Use the package's `deployment/package.json` and `deployment/vercel.json` as a
small Git repository, install with Bun, commit the lockfile, and import it into
Vercel. The template explicitly pins both this service and its required core
peer to the same release. The package build command stages the complete application, migrates
Postgres, then builds Next.js. No source checkout or patch is needed.

Follow the [hosted service setup](https://github.com/defrex/autobuild/blob/main/docs/hosted-service.md)
for the exact template, environment, checks, and upgrade procedure. Store-only
mode is the default: without the optional dispatcher, `/api/dispatch` returns
503 with “dispatch runs elsewhere for this deployment”, and no cron is supplied.

The existing `ab-hosted-store` binary still mints machine tokens locally:

```sh
AB_STORE_SECRET='…' bunx ab-hosted-store mint operator --ttl-seconds 3600
```

Deployment operator tokens cover store and ticket operations, allowing one
dispatcher credential. Legacy admin tokens still cover store administration but
cannot access tickets.

The same deployment also serves the versioned [operator API](https://github.com/defrex/autobuild/blob/main/docs/operator-api.md).
External agents connect to the [MCP server](https://github.com/defrex/autobuild/blob/main/docs/mcp.md) at `/mcp` — the
same operator tool registry over Streamable HTTP with OAuth 2.1 through Better
Auth — and every write is attributed to the person who authorized the client.
Mint an attributed human-operator token with `--user`; unlike the deployment
credential, it can use only the operator API and its signed identity is recorded
on every control:

```sh
AB_STORE_SECRET='…' bun packages/hosted-store-service/src/bin.ts mint operator \
  --user 'Ada Lovelace' --ttl-seconds 3600
```

Mint a least-privilege build/session token with an explicit future expiry:

```sh
AB_STORE_SECRET='…' bun packages/hosted-store-service/src/bin.ts mint build \
  --build my-build --session implement --expires-at 2026-09-03T00:00:00Z
```

Minting is entirely local: the command reads only `AB_STORE_SECRET`, contacts no
server, and prints only the token. Do not put the signing secret in a repository,
browser, client host, command history, or logs; rotate it to revoke all tokens.

A deployment has one ticket backend. `AB_TICKET_BACKEND` defaults to `database`,
which stores team-scoped tickets, comments, and blockers in PostgreSQL with the
`Triage`, `Ready`, `Doing`, and `Done` lifecycle. Override those distinct names
with `AB_TICKET_TRIAGE_STATE`, `AB_TICKET_READY_STATE`,
`AB_TICKET_DOING_STATE`, and `AB_TICKET_DONE_STATE`. Set the backend to `linear`
and provide `LINEAR_API_KEY` on the service to pass every request to the
existing Linear adapter. That key never belongs on dispatcher or browser
hosts. Team and claim/create policy arrive per request from repository config. The signed-in web Tickets surface uses the same durable effective config, discovers lifecycle names from this configured backend, and polls every two seconds. Its create/edit/move/block operations are delegated through short-lived attributed operator tokens; provider credentials and bearer tokens never reach the browser.
Run the migration before serving (the deployment build does so automatically); it adds separately versioned ticket and
Better Auth schemas without changing an existing BuildStore v1 marker. Startup
never creates or changes schema.

Each artifact is content-by-value and limited to **1,048,576 decoded bytes (1
MiB)**. Base64 and JSON make the HTTP body larger. A larger deposit receives a
JSON 413 error naming that ceiling and does not mutate the store.

Each event read also accepts a bounded wait (`?since=N&wait=S` on the build and
repository event routes): when nothing newer than `since` exists, the server
holds the request until such an event is appended or `S` seconds elapse, then
answers. `wait` is one or more ASCII digits (whole seconds); any other form is a
400 validation error, and a value above the hosted ceiling of **25 seconds** is
clamped to 25, never rejected. The ceiling must stay under the machine routes'
`maxDuration` of 60 s (`app/builds/[[...path]]/route.ts` and
`app/repos/[[...path]]/route.ts` in this package's app tree), which exists to cover the hold; raise the
two together if you change either.

### Web/auth variables

- `BETTER_AUTH_SECRET`: separate 32+ character high-entropy session secret.
- `BETTER_AUTH_URL`: exact public origin (`http://localhost:3000` locally).
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: server-only OAuth app values.
- `AB_WEB_AUTH_PROVIDERS=github`: enabled provider set.
- `AB_WEB_ALLOWED_EMAILS`: comma-separated, case-insensitive operator allowlist.
- `AB_WEB_REPOSITORIES`: comma-separated repositories visible through the web
  gateway. Entries are repository identities — normalized `https://` origins
  (e.g. `https://github.com/defrex/autobuild`); ssh-like spellings such as
  `git@github.com:defrex/autobuild.git` are accepted and normalized. They must
  match the Store's identity for the repository: since the checkoutless
  dispatch change, `BuildRecord.repo` and the dispatcher's repository key are
  the repository's normalized origin URL, not a checkout path. Records written
  before that change are keyed by checkout path, are not migrated, and remain
  visible only where their recorded `repoOrigin` matches the querying
  checkout's origin (decision 2026-09-10: dropping the old identity's history
  is acceptable).
- `AB_WEB_MCP_RESOURCE` (optional): the protected resource the MCP server
  binds tokens to; defaults to `<BETTER_AUTH_URL>/mcp`. See the
  [MCP server](https://github.com/defrex/autobuild/blob/main/docs/mcp.md).

Removing an email blocks its next gateway request even if its database-backed
session has not expired. Rotate `BETTER_AUTH_SECRET` to end every browser
session. `AB_STORE_SECRET`, GitHub's client secret, PostgreSQL/blob credentials,
machine tokens, and OAuth account tokens are server-only and must never use a
`NEXT_PUBLIC_` name.

On another Bun-capable host, `bun run dev` or `bun run start` from this
package directory serves the full
application. `bun run hosted-store` serves machine routes only.

## Hosted dispatcher

The dispatch kernel is not part of this package. The cron-authenticated
`GET /api/dispatch` endpoint, its `pack-distribution` bin command, and the
packed-distribution trace helper live in the separate
[`@defrex/autobuild-hosted-dispatcher`](https://github.com/defrex/autobuild/blob/main/packages/hosted-dispatcher/README.md)
package; a deployment opts into building by installing it and mounting its
route, and a deployment that only hosts state never attempts a dispatch tick.
See the [operator procedure](https://github.com/defrex/autobuild/blob/main/docs/hosted-dispatcher.md) for the
schedule, incident pauses, and behavior details.

The Sandbox SDK authenticates with the deployment's own OIDC identity inside
Vercel functions, so no `VERCEL_TOKEN` belongs on a hosted deployment either
way; see the dispatcher package's README for the dispatcher environment
variables and credential handling.
