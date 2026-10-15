# Deploy a hosted service

A service hosts the BuildStore, tickets, dashboard, sign-in, and MCP endpoint.
The default deployment stores state while dispatch runs on another machine.
You need Bun 1.4.x, a Git repository, a Vercel project, PostgreSQL, a blob
backend, and a GitHub OAuth application.

Create a new directory containing these two files (also shipped in the hosted
package's `deployment/` directory and in `templates/hosted-service/`).

`package.json`:

```json
{
  "private": true,
  "scripts": {
    "build": "ab-hosted-service-build"
  },
  "dependencies": {
    "@defrex/autobuild-hosted-store-service": "0.11.0",
    "@defrex/autobuild": "0.11.0",
    "next": "16.1.6",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  }
}
```

`vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "installCommand": "bun install --frozen-lockfile",
  "buildCommand": "bun run build",
  "bunVersion": "1.4.x"
}
```

Run `bun install`, then commit both files and `bun.lock`. Add `.gitignore`
entries for `node_modules/`, `.next/`, `.vercel/`, `app/`, `next.config.ts`,
`next-env.d.ts`, `tsconfig.json`, and `.autobuild-service-assets.json`.
These application assets are generated during each build. Keep your own files
outside those names; the builder refuses to overwrite consumer-owned files.
Do not commit generated application sources or edit them to customize deployment.

Push the directory to your Git host. Import it in Vercel with the repository
root as Root Directory and Next.js as the framework. The checked-in platform
configuration installs the lockfile and runs `bun run build`. Each build stages
the installed package, runs its idempotent database migrations against the
configured database, then builds Next into the root `.next/`. Missing database
configuration, incompatible schema, or a failed migration stops the build.
Provide database access from the build environment as well as runtime.

## Environment

Set these server-side variables in every Vercel environment you deploy:

- `AB_POSTGRES_URL` or `DATABASE_URL`: PostgreSQL connection URL. The explicit
  `AB_POSTGRES_URL` takes precedence; use the same database at build and runtime.
- `AB_STORE_SECRET`: a high-entropy secret for machine token signing.
- `AB_BLOB_BACKEND=vercel` with `BLOB_READ_WRITE_TOKEN`, or `AB_BLOB_BACKEND=s3`
  with `AB_S3_BUCKET`, `AB_S3_REGION`, `AB_S3_ACCESS_KEY_ID`, and
  `AB_S3_SECRET_ACCESS_KEY` (and optional endpoint for compatible storage).
- `BETTER_AUTH_SECRET`: an independent high-entropy secret of at least 32 characters.
- `BETTER_AUTH_URL`: the exact production HTTPS origin, with no path.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: GitHub OAuth application credentials.
- `AB_WEB_AUTH_PROVIDERS=github`.
- `AB_WEB_ALLOWED_EMAILS`: comma-separated operator email allowlist.
- `AB_WEB_REPOSITORIES`: comma-separated repository origins visible to operators.

Register `https://YOUR_ORIGIN/api/auth/callback/github` as the GitHub callback
and allow read-only email access (`user:email`). Sign-in must use the configured
production origin. Do not expose secrets through `NEXT_PUBLIC_` variables.
See the [complete environment reference](configuration.md) for storage,
project ticket lifecycle, credential administration, and optional MCP resource configuration.

## Check the deployment

`GET /health` returns service and protocol versions. Open `/sign-in` and sign
in; `/` redirects unauthenticated browsers to sign-in. Machine routes
require a machine token; `/mcp` challenges an unauthenticated client with OAuth
resource metadata. Check both discovery documents:

```sh
curl https://YOUR_ORIGIN/.well-known/oauth-protected-resource
curl https://YOUR_ORIGIN/.well-known/oauth-authorization-server
```

The authorization-server document advertises a reachable `/api/auth/jwks`
URI and `/api/auth/mcp/register` dynamic registration endpoint. MCP clients
register with `redirect_uris` as an array of strings and
`token_endpoint_auth_method: "none"`; treat the returned `client_id` as opaque.
See [MCP](mcp.md) for authorization and client setup.

Without the optional hosted dispatcher installed, `GET /api/dispatch` returns
503 JSON: `{"error":"dispatch runs elsewhere for this deployment"}`. The
template has no cron and installs no dispatcher/provider package. Run dispatch
from a connected project or follow the separate, opt-in
[hosted dispatcher procedure](hosted-dispatcher.md), which retains its
source-checkout packaging and cron setup.

## Upgrade

Bump the exact hosted-service and core package pins in `package.json` to the
same new release, run `bun install` to refresh `bun.lock`, commit, and push.
Vercel's Git integration migrates and builds the pinned package automatically.
Upgrade the service **before connected projects**: that is the order expected
by the protocol compatibility window. No source extraction, patch application,
or manual production deployment is required.

## Hosted ticket projects and v1 migration

Hosted queues are partitioned by registered repository. Credentials select the
project, and its latest uploaded effective `[tickets]` configuration selects the
lifecycle; see the [ticket protocol](remote-ticket-protocol.md). If configuration
is unavailable, run that project's dispatcher to publish it. Projects using file,
Linear or another external source continue to access it directly through their
dispatcher. Service ticket surfaces refuse those projects with source feedback.
The service never connects to Linear.

The removed `AB_TICKET_BACKEND` and `LINEAR_API_KEY` settings are ignored for
all values, including blanks, with one startup message asking for removal.
The removed `AB_TICKET_TRIAGE_STATE`, `AB_TICKET_READY_STATE`,
`AB_TICKET_DOING_STATE` and `AB_TICKET_DONE_STATE` settings are ignored even if
malformed. Lifecycle now comes only from project configuration.

The environment-aware migration first imports `AB_WEB_REPOSITORIES` into the
registry once, including upgrades from released main schema v9 where registry
tables do not yet exist. This import and the main-schema promotion share the
ticket transaction: a stopped ticket migration rolls them back too. The owner
`projects add` and `tickets assign-team` commands can independently bootstrap
the registry while that old main marker remains, so recovery does not require
a successful ticket migration. If the retired environment is unavailable,
register the intended project with `ab-hosted-store projects add REPOSITORY
--user IDENTITY` before assigning its legacy team. Once the import succeeds,
later changes to the retired environment are ignored.

Fresh databases install ticket schema v2 directly. Existing team-keyed v1
queues migrate in one transaction. For each registered project, migration reads
the effective configuration selected by its latest dispatcher run and reloads,
including the actual immutable artifact bytes in blob storage. A legacy team
must have one claimant, or an explicit owner assignment. A registered project
with no dispatcher run or no selected effective-config reference makes no team
claim and does not block other projects. Unclaimed teams still stop unchanged.
When ownership must be inferred, a selected but missing, inaccessible or invalid
configuration fails closed with the project and remaining teams in the message.
Restore those bytes or explicitly assign every remaining legacy team, then
rerun; complete assignments to registered projects settle ownership without
reading unrelated configurations. Conflicting claimants and asset ownership
conflicts also stop without changing schema markers or tickets.
Historical ids, states, timestamps, blockers, comments and asset rows remain
unchanged. Review the named projects and resolve a shared legacy team locally:

```sh
ab-hosted-store tickets assign-team ENG https://github.com/acme/app --user owner@example.com
ab-postgres-store migrate
```

The assignment command works before the v2 migration succeeds and records the
actor in an append-only journal. The latest assignment moves the whole legacy
team once; it grants no future cross-project access. It must name a registered
project. Rerun migration after resolving every named team or configuration error.

For populated-v1 upgrades, both the owner migration CLI and `deploy:build` need
the same blob backend, access, credentials and `AB_BLOB_PREFIX` as the running
service: S3 bucket/region/credentials (and endpoint/path style when configured),
or Vercel access mode and token/OIDC store identity. The deployment build inherits
these variables and runs the environment-aware migration before Next build.
Missing blob configuration or denied reads stop deployment before Next builds;
diagnostics never print credentials. SQL-only fresh installs, empty-v1 upgrades
and already-v2 reruns do not open blob storage and keep their existing database
requirements. Migration reruns are idempotent.
