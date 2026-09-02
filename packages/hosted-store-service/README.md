# `@autobuild/hosted-store-service`

The optional hosted Autobuild service composes the remote BuildStore and the
full TicketSource HTTP protocol with `@autobuild/postgres-store`. The root
Next.js application mounts those machine protocols unchanged and serves the
cookie-authenticated operator dashboard on the same origin. `server.ts` remains
the named bare-Bun machine-service entrypoint for non-Next hosts.

## Configure and run locally

The service and PostgreSQL adapter are distributed in Autobuild's GitHub
releases rather than npm. Clone the compatible release tag and install it as
shown in the [complete environment reference](../../docs/configuration.md), then
migrate the database (the migration is idempotent):

```sh
AB_POSTGRES_URL=postgres://… bun run postgres:migrate
```

Set `AB_STORE_SECRET`, `AB_POSTGRES_URL`, one blob backend, and the web/auth
variables below in that pinned checkout. Register a GitHub OAuth app with
`http://localhost:3000/api/auth/callback/github` as its local callback, then run:

```sh
bun run dev
```

The GitHub app needs access to the user's primary email (`user:email`, or the
GitHub App equivalent read-only email permission). Open `http://localhost:3000`.
The browser receives only Better Auth's secure HTTP-only session cookie; it
never receives a store/operator token or a signing/provider secret. To run only
the legacy machine service use `bun run hosted-store`; `AB_HOST` defaults to
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
hosts. Team and claim/create policy arrive per request from repository config.
Run the migration before deployment; it adds separately versioned ticket and
Better Auth schemas without changing an existing BuildStore v1 marker. Startup
never creates or changes schema.

Each artifact is content-by-value and limited to **1,048,576 decoded bytes (1
MiB)**. Base64 and JSON make the HTTP body larger. A larger deposit receives a
JSON 413 error naming that ceiling and does not mutate the store.

## Deploy to Vercel

1. Import this repository and select its repository root as the project root.
2. Select Bun. The checked-in `vercel.json` pins Bun 1.4.x; use `bun run build`
   and the Next.js output. Pages and machine routes are one deployment.
3. Create a GitHub OAuth app whose callback is
   `https://YOUR_ORIGIN/api/auth/callback/github` and grant read-only email.
4. Add the store/database/blob variables and every web/auth variable below to
   each target environment. Generate an independent Better Auth secret with at
   least 32 high-entropy characters. `AB_HOST` and `PORT` are not needed.
5. Run `bun run postgres:migrate` against production before the first deploy,
   then deploy and verify `/health`, browser sign-in, an operator control, a
   ticket, and an artifact round-trip.

The shape follows Vercel's [Bun runtime](https://vercel.com/docs/functions/runtimes/bun).
The 1 MiB decoded ceiling leaves room for base64/JSON beneath Vercel Functions'
[4.5 MB request and response payload limit](https://vercel.com/docs/functions/limitations#request-body-size).

### Web/auth variables

- `BETTER_AUTH_SECRET`: separate 32+ character high-entropy session secret.
- `BETTER_AUTH_URL`: exact public origin (`http://localhost:3000` locally).
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: server-only OAuth app values.
- `AB_WEB_AUTH_PROVIDERS=github`: enabled provider set.
- `AB_WEB_ALLOWED_EMAILS`: comma-separated, case-insensitive operator allowlist.
- `AB_WEB_REPOSITORIES`: comma-separated repositories visible through the web gateway.

Removing an email blocks its next gateway request even if its database-backed
session has not expired. Rotate `BETTER_AUTH_SECRET` to end every browser
session. `AB_STORE_SECRET`, GitHub's client secret, PostgreSQL/blob credentials,
machine tokens, and OAuth account tokens are server-only and must never use a
`NEXT_PUBLIC_` name.

On another Bun-capable host, `bun run dev` or `bun run start` serves the full
application. `bun run hosted-store` serves machine routes only.
