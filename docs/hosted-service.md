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

## Connect a project

From a checkout with an origin remote, run `ab connect https://YOUR_ORIGIN`.
The CLI prints a verification URL and short code and attempts to open a browser.
Sign in as an allowed owner, check the full repository identity and code, and
approve or deny. Another device can open the printed URL, or visit `/connect`
and enter the code. Approval requires the web-enabled service origin; a
standalone machine-only listener cannot present browser consent. Requests
expire after ten minutes. Denial and timeout leave local configuration unchanged.

On approval the service registers the project and issues a project credential.
The CLI keeps it in `$XDG_CONFIG_HOME/autobuild/credentials` (or
`~/.config/autobuild/credentials`), keyed by normalized service and origin,
with directory mode 0700 and file mode 0600. Credentials never belong in the
repository. It adds the non-secret `[store] url` to `autobuild.toml` when
absent; review and commit that change yourself. An existing different URL
must be changed explicitly before connecting. Reconnecting replaces the saved
credential only after approval and revokes the previous credential.

All worktrees share the main checkout's configuration and the user's saved
credential. A service manager running as that user uses the same HOME and
XDG_CONFIG_HOME, with no AB_STORE or AB_TOKEN exports. A fresh clone with
committed store configuration but no saved credential fails with `ab connect`
guidance; it never silently creates local state. Run connect on each host/user.

`ab connect` without a URL reports service, project, and credential status:
accepted, rejected, missing, or unreachable. `ab disconnect` revokes the saved
credential remotely before removing it locally, keeping the project registered,
its data, and store configuration. A network/server failure retains the local
entry for retry; an already revoked credential can be removed. If saving a new
connection fails, the CLI cancels/revokes it and retains the previous entry.
If remote cleanup cannot be confirmed, check the printed credential id with
the owner's administrative tools before retrying.

Store selection is `--store` > nonblank `AB_STORE` > `[store] url` > the
main checkout's `.autobuild/`. `AB_TOKEN` overrides the exact service/project's
saved credential for CI and other non-interactive hosts. A service override
never borrows another service's credential. Build and harvest sessions keep
their explicit scoped authority.

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
