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

Project credentials are opaque `abp_1_<id>_<secret>` bearer values bound to one
registered normalized repository. The service stores only a SHA-256 digest of
the random secret, plus project, creator, creation time, last use, expiry and
revocation metadata. It checks credential status and project registration on
every request in a single database read, with no positive authentication cache
between requests. Last use is persisted at most once per 60 seconds and trails
actual use by at most 60 seconds; competing service instances share the database
cutoff. An authentication already in flight may finish during revocation.
Repository existence reads are reused only within one HTTP invocation; event
reads and mutation locks remain fresh. Revocation takes effect on the next request without affecting
other credentials. Unknown, expired or revoked credentials receive `401 auth`;
removed projects receive `403 auth` with `project not registered`.

The deployment owner runs these commands locally with database access:

```sh
ab-hosted-store credentials issue https://github.com/acme/app --user owner@example.com
ab-hosted-store credentials list https://github.com/acme/app
ab-hosted-store credentials revoke https://github.com/acme/app --id ID --user owner@example.com
```

Issue prints the secret once; list contains metadata only. Issue optionally
accepts `--ttl-seconds N` or `--expires-at ISO-8601`. For administrative/non-interactive issuance, set the returned token as
`AB_TOKEN`. Interactive project onboarding uses `ab connect <service-url>`;
it saves the credential outside the repository and commits no secret. Previous `AB_TOKEN` values and `mint operator` / `mint build` are
retired: the service responds that the credential format changed and points
to `credentials issue`. Supported old protocol shapes still work with a new
credential; protocol compatibility does not restore retired authentication.

`mint admin --ttl-seconds N` creates an explicit versioned, attributed owner
break-glass credential. It can cross project boundaries. Keep it owner-only:
never give it or `AB_STORE_SECRET` to a dispatcher or build agent.

See [remote store authority](../../docs/remote-store-protocol.md#7-authentication-and-project-authority),
[ticket admission](../../docs/remote-ticket-protocol.md) and
[operator delegation](../../docs/operator-api.md).

### Web/auth variables

- `BETTER_AUTH_SECRET`: separate 32+ character high-entropy session secret.
- `BETTER_AUTH_URL`: exact public origin (`http://localhost:3000` locally).
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: server-only OAuth app values.
- `AB_WEB_AUTH_PROVIDERS=github`: enabled provider set.
- `AB_WEB_SUPER_USER_EMAILS`: comma-separated, case-insensitive super-user email list.
- `AB_WEB_REPOSITORIES` (deprecated): optional once-per-database import of
  normalized repository origins. The durable registry is authoritative after
  import; edits and restarts never resurrect removed projects.
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

## Connected projects

Migrate PostgreSQL from the pinned release before deploying (`bun run
postgres:migrate`). The service keeps an independent, durable project registry;
existing build or ticket data does not register a project. An administrator
with deployment database credentials manages it without redeploying:

```sh
ab-hosted-store projects list
ab-hosted-store projects add https://github.com/owner/project --user owner@example.com
ab-hosted-store projects remove https://github.com/owner/project --user owner@example.com
```

From a source checkout, substitute `bun packages/hosted-store-service/src/bin.ts`
for `ab-hosted-store`. Configure `AB_POSTGRES_URL` or `DATABASE_URL` in that
process. Database possession grants administration; `--user` is declared audit
attribution, not a verified login. Ordinary project/store tokens cannot manage
registrations. Each entry records the normalized origin URL, addition time,
and adding identity. SSH git spellings normalize to HTTPS; local paths and
credential-bearing HTTPS URLs are rejected. Duplicate adds preserve metadata;
remove is idempotent, and re-adding records a fresh addition.

Super users can operate every registered project. Organization members can
operate only active projects assigned to their organizations; legacy unassigned
projects are visible only to super users. Membership is granted by normalized
email, including before first sign-in, and is rechecked on every request. The dashboard,
MCP discovery and calls, and every operator API route consult current
registration. Removal hides a project from all these surfaces and subsequent
hosted dispatcher invocations; builds, events, artifacts and tickets remain,
and re-registration restores access. Already-started work is not cancelled.
Machine credentials are bound to one registered project; removal immediately
refuses its credentials without deleting history.

Link directly to `/?repo=<URL-encoded normalized origin>`. The page selects the
first registered origin when the requested one is missing or removed, and an
empty registry shows no project data or controls. Registry errors fail closed;
there is no environment fallback on database failure.

`AB_WEB_REPOSITORIES` is deprecated. A nonempty CSV is imported exactly once per
database, on the first registry initialization with that variable configured,
with actor `system:AB_WEB_REPOSITORIES`. The import and durable marker commit
atomically across concurrent starts. An absent variable does not consume the
marker. Later restarts or edits to the variable never re-add removed projects;
use the owner commands for subsequent administration.

The hosted dispatcher queries current registrations on every authorized
invocation. With `AB_DISPATCHER_REPOSITORIES` unset, it serves all registered
projects; an explicit list preserves its order and is intersected with current
registration. An empty registry is a successful zero-project invocation.

Hosted tickets are scoped to the credential's registered project. Lifecycle
comes from that project's effective configuration; projects using external
trackers keep the connection in their dispatcher and receive source feedback
from service ticket surfaces. This service has no Linear backend.
`AB_TICKET_BACKEND` and `LINEAR_API_KEY` are ignored with one startup removal
message, and all `AB_TICKET_*_STATE` lifecycle variables are removed and ignored.
See [project ticket migration](../../docs/hosted-service.md#hosted-ticket-projects-and-v1-migration)
for atomic v1 upgrades, owner `tickets assign-team` recovery, and the blob
credentials/access/prefix required during populated-v1 deployment builds.


The retired `AB_WEB_ALLOWED_EMAILS` variable is refused at startup, even if empty.
Replace it with `AB_WEB_SUPER_USER_EMAILS`; review the list because these identities
are deployment maintainers. Bootstrap the first organization through the
[browser management contract](../../docs/operator-api.md#organization-management-browser),
then add members by email and assign legacy unassigned projects. Super users alone
create orgs, set or clear the single owner, and assign or move projects. Owners
manage their org's members. Removing the last membership or super-user designation
revokes human access on the next request without re-login; existing project
credentials remain valid until revoked.


## Project-secret encryption

Set `AB_PROJECT_SECRETS_KEY` in the service and cron deployment configuration to
base64 encoding of exactly 32 random bytes, generated with `openssl rand -base64 32`.
Keep it outside the database and source control, backed up with deployment secrets.
The adapter validates the key on use; a deployment verifier detects a different key
even for an empty project after the first write. Missing, malformed or wrong keys
fail secret writes and project resolution closed; metadata remains readable.
The key is never forwarded into kernel/child environments. Rotation is unsupported.
Refreshing provider kinds are internal integrations; this release has no real
OpenAI kind or sign-in endpoint. Static secrets use the connected owner's CLI.
