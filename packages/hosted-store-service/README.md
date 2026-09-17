# `@defrex/autobuild-hosted-store-service`

The optional hosted Autobuild service composes the remote BuildStore and the
full TicketSource HTTP protocol with `@defrex/autobuild-postgres-store`; the
protocol servers live here while their client half, wire schemas, and token
minting ship in the `@defrex/autobuild` core package. The Next.js application
lives in this package's `app/` tree: it mounts those machine protocols
unchanged and serves the cookie-authenticated operator dashboard on the same
origin. `server.ts` in this package remains the named bare-Bun
machine-service entrypoint for non-Next hosts.

## Configure and run locally

The service and PostgreSQL adapter are published to npm
(`@defrex/autobuild-hosted-store-service`, `@defrex/autobuild-postgres-store`)
separately from the `@defrex/autobuild` CLI. The deployable web application
runs from a release checkout: clone the compatible release tag and install it
as shown in the [complete environment reference](../../docs/configuration.md),
then migrate the database (the migration is idempotent):

```sh
DATABASE_URL=postgres://… bun run postgres:migrate
```

Set `AB_STORE_SECRET`, `DATABASE_URL` (or an explicit `AB_POSTGRES_URL`), one
blob backend, and the web/auth
variables below in that pinned checkout. Register a GitHub OAuth app with
`http://localhost:3000/api/auth/callback/github` as its local callback, then
run the dev script from this package directory:

```sh
cd packages/hosted-store-service
bun run dev
```

The GitHub app needs access to the user's primary email (`user:email`, or the
GitHub App equivalent read-only email permission). Open `http://localhost:3000`.
The browser receives only Better Auth's secure HTTP-only session cookie; it
never receives a store/operator token or a signing/provider secret. To run only
the legacy machine service use `bun run hosted-store` (from the package
directory); `AB_HOST` defaults to
`0.0.0.0` and `PORT` defaults to `3000`. Check the public
endpoint with `curl http://localhost:3000/health`; it reports the Autobuild and
remote-protocol versions without opening the database. Clients use the deploy
URL and an offline-minted token:

```sh
export AB_STORE=https://store.example.com
export AB_TOKEN="$(AB_STORE_SECRET='…' bun packages/hosted-store-service/src/bin.ts mint operator --ttl-seconds 3600)"
ab dispatch
```

Deployment operator tokens cover store and ticket operations, allowing one
dispatcher credential. Legacy admin tokens still cover store administration but
cannot access tickets.

The same deployment also serves the versioned [operator API](../../docs/operator-api.md).
External agents connect to the [MCP server](../../docs/mcp.md) at `/mcp` — the
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
Run the migration before serving (`bun run deploy:build` does so inside a
hosted build); it adds separately versioned ticket and
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

## Deploy to Vercel

1. Import this repository and select `packages/hosted-store-service` (the
   package directory holding `vercel.json` and the Next.js app) as the Root
   Directory. `bun install` from a workspace member installs the whole
   workspace.
2. Select Bun. The checked-in `vercel.json` in the package directory pins Bun
   1.4.x and sets the build
   command to `bun run deploy:build`, which runs the idempotent migration
   against the deployment's own database URL and then builds the Next.js
   output. Pages and machine routes are one deployment.
3. Create a GitHub OAuth app whose callback is
   `https://YOUR_ORIGIN/api/auth/callback/github` and grant read-only email.
4. Add the store/database/blob variables and every web/auth variable below to
   each target environment. A Neon database and a Blob store connected through
   Vercel Storage inject `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` themselves. Generate an independent Better Auth secret with at
   least 32 high-entropy characters. `AB_HOST` and `PORT` are not needed.
5. Deploy, then verify `/health`, browser sign-in, an operator control, a
   ticket, and an artifact round-trip. The build log names the database host
   the migration prepared; the build fails, and nothing goes live, when no
   database URL is configured or the existing schema is incompatible with the
   release being deployed.

The shape follows Vercel's [Bun runtime](https://vercel.com/docs/functions/runtimes/bun).
The 1 MiB decoded ceiling leaves room for base64/JSON beneath Vercel Functions'
[4.5 MB request and response payload limit](https://vercel.com/docs/functions/limitations#request-body-size).

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
  [MCP server](../../docs/mcp.md).

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
[`@defrex/autobuild-hosted-dispatcher`](../hosted-dispatcher/README.md)
package; a deployment opts into building by installing it and mounting its
route, and a deployment that only hosts state never attempts a dispatch tick.
See the [operator procedure](../../docs/hosted-dispatcher.md) for the
schedule, incident pauses, and behavior details.

The Sandbox SDK authenticates with the deployment's own OIDC identity inside
Vercel functions, so no `VERCEL_TOKEN` belongs on a hosted deployment either
way; see the dispatcher package's README for the dispatcher environment
variables and credential handling.
