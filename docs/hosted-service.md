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
    "@defrex/autobuild-hosted-store-service": "1.0.1",
    "@defrex/autobuild": "1.0.1",
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
- `AB_WEB_SUPER_USER_EMAILS`: comma-separated super-user emails. Other operators require organization membership.
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
project. Independent ticket policy selects lifecycle; `ab connect --tickets URL`
publishes it before dispatch. Older clients retain uploaded dispatcher configuration
as a fallback. See the [ticket protocol](remote-ticket-protocol.md). Projects using file,
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

## Local builds with hosted tickets

Hosted tickets do not require hosted builds. Set `[tickets] source = "hosted"`
and `teamKey = "ENG"`, then run `ab connect --tickets https://your-service.example`.
Approve the project in the browser. This saves a service-scoped credential and
`[tickets] url` while leaving `[store]` unchanged. Ticket commands work immediately,
before any dispatcher runs. `ab connect` reports every service and whether it serves
builds, tickets, or both. Use `ab disconnect --tickets` to revoke ticket access;
when services differ use `--builds` to select build access. Shared uses share one
credential, so disconnecting either shared use affects both.

Ticket URL selection is `[tickets] url`, then the selected build service (including
AB_STORE or a supported --store override). With local builds, `[tickets] url` is
required. Builds, events, artifacts, and harvest journals remain in the local store.
The service stores ticket records, project ticket policy, and restricted ticket
grants. Normal project clients synchronize current `[tickets]` policy before use;
failed synchronization fails the operation. Harvest grants can read and create;
phase grants can only read. Neither can change policy or access BuildStore routes.

New hosted policy defaults to `triage`, `ready`, `doing`, `done`, with creation and
harvest proposals in `triage`. Explicit state names preserve their spelling.
To retain earlier names configure `triageState = "Backlog"`,
`claimedState = "Doing"`, `doneState = "Done"`, and the desired `readyState`.
Existing ticket rows are never renamed. Older combined-service clients continue
using the uploaded dispatcher configuration until independent policy is published.

## Integration tree metadata

Hosted tickets store `kind` (`work` or `node`, default `work`) and optional
`target`, the canonical readable id of a node in the same project. Create accepts
both fields; update and guarded update preserve omitted fields and accept
`target: null` to clear an edge. Targets must exist and be nodes. Self-targets,
ancestor cycles, and demoting a node with targeting tickets (including completed
work) are rejected before any part of a mixed patch is written. Graph mutations
serialize per project in the same transaction as validation and revision checks.
Effective metadata changes increment the revision; equivalent aliases are no-ops.

Ticket responses include these fields only with `x-autobuild-ticket-tree: 1`.
This capability is independent of revision and comment capabilities and of the
client version. Without it, both fields are projected away, preserving historical
strict decoders. Current hosted clients send all three capability headers and
default absent kind to `work`. Unfiltered listing includes all ticket states and
empty nodes for `ab ticket tree`; dispatch and merge behavior are unchanged.

## Reading across upgrades

Within the advertised client compatibility window, readers with mixed-version
read support tolerate newer build and repository facts. Raw event endpoints
retain unknown types, payload fields and the producer's `compatibility`
metadata (`writerVersion` and `classification`). Known payload fields remain
validated. Adding an advisory field to an existing type is safe; a semantic
change that older kernels must respect requires a new decisive event type.

Named reduction responses retain exactly `{version, cursor, value}`. The
`x-autobuild-catalog-identity` response header identifies the backend's read
catalog independently of its package release and reducer version. Clients
accept an answer only when that identity, reducer version and finished shape
match their own; otherwise they replay raw events locally through the response
cursor. A missing header from an earlier service also triggers replay. A
service never invents an identity for a backend that supplies none. This keeps
released strict JSON decoders working without a new request capability.

Unknown advisory facts are counted and skipped. Unknown decisive facts defer
claiming, routing, merge and publication only for their build; status,
context and dashboards remain readable. One `build.compatibility-deferred`
attention fact per decisive boundary appears in the default `ab watch` stream.
Its diagnostic names unsupported types and producer releases: restart with a
build that understands those types. The type names matter even when both
processes report the same package version, as source builds may differ.
Legacy unknown facts lacking metadata are decisive and report that the writer
version is unavailable. Restarting with a reader that understands the facts
clears the guard through replay, without an escalation answer.

Caches are scoped to the reader's catalog. Replaying a reduction from an
unrecognized reducer version never overwrites its bytes; lower-version snapshot
writes cannot replace higher-version rows even at a later cursor. This
protects both upgrade directions. Readers predating this support still fail
closed; this guarantee does not widen the advertised client window.


The retired `AB_WEB_ALLOWED_EMAILS` variable is refused at startup, even if empty.
Replace it with `AB_WEB_SUPER_USER_EMAILS`; review the list because these identities
are deployment maintainers. Bootstrap the first organization through the
[browser management contract](operator-api.md#organization-management-browser),
then add members by email and assign legacy unassigned projects. Super users alone
create orgs, set or clear the single owner, and assign or move projects. Owners
manage their org's members. Removing the last membership or super-user designation
revokes human access on the next request without re-login; existing project
credentials remain valid until revoked.
