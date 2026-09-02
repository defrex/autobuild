# `@autobuild/hosted-store-service`

The optional hosted Autobuild store composes the remote HTTP protocol with
`@autobuild/postgres-store`. It is a host-neutral Fetch handler started by the
repository's root `server.ts`; Vercel and ordinary Bun hosts run the same code.

## Configure and run locally

The service and PostgreSQL adapter are distributed in Autobuild's GitHub
releases rather than npm. Clone the compatible release tag and install it as
shown in the [complete environment reference](../../docs/configuration.md), then
migrate the database (the migration is idempotent):

```sh
AB_POSTGRES_URL=postgres://… bun run postgres:migrate
```

Set `AB_STORE_SECRET`, `AB_POSTGRES_URL`, and one blob backend in that pinned
checkout. Then run:

```sh
bun run hosted-store
```

`AB_HOST` defaults to `0.0.0.0` and `PORT` defaults to `3000`. Check the public
endpoint with `curl http://localhost:3000/health`; it reports the Autobuild and
remote-protocol versions without opening the database. Clients use the deploy
URL and an offline-minted token:

```sh
export AB_STORE=https://store.example.com
export AB_TOKEN="$(AB_STORE_SECRET='…' bun packages/hosted-store-service/src/bin.ts mint admin --ttl-seconds 3600)"
ab dispatch
```

The same deployment also serves the versioned [operator API](../../docs/operator-api.md).
Mint an operator token whose signed identity is attributed to every control:

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

Each artifact is content-by-value and limited to **1,048,576 decoded bytes (1
MiB)**. Base64 and JSON make the HTTP body larger. A larger deposit receives a
JSON 413 error naming that ceiling and does not mutate the store.

## Deploy to Vercel

1. Import this repository and select its repository root as the project root.
2. Use the Bun preset. The checked-in `vercel.json` pins `bunVersion` to
   `1.4.x`; the root `server.ts` contains the one `Bun.serve()` entrypoint.
3. Add `AB_STORE_SECRET`, `AB_POSTGRES_URL`, and all variables for either the
   S3-compatible or Vercel Blob backend to every target environment. `AB_HOST`
   and `PORT` are for ordinary hosts and need not be set by Vercel.
4. Run the PostgreSQL migration against the production database before the
   first deployment, then deploy.
5. Verify `/health`, mint a short-lived admin token offline, and round-trip a 1
   MiB artifact from a client before directing dispatchers at the service.

The shape follows Vercel's [Bun runtime](https://vercel.com/docs/functions/runtimes/bun).
The 1 MiB decoded ceiling leaves room for base64/JSON beneath Vercel Functions'
[4.5 MB request and response payload limit](https://vercel.com/docs/functions/limitations#request-body-size).

On another Bun-capable host, set the same variables and run `bun run
hosted-store`; forward SIGTERM/SIGINT normally so Bun drains and exits. No
Vercel environment detection or `/api` adapter is involved.
