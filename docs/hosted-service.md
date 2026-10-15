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
ticket-backend options, token minting, and optional MCP resource configuration.

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
