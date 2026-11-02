# Self-hosting the Autobuild service

> **Unsupported. Buyer beware.** Self-hosting the Autobuild service is not
> fully production-ready and is not a supported product path. Its packaging,
> environment variables and procedure may change without notice in any
> release. You run it at your own risk and pay its infrastructure costs.

This guide ships inside `@defrex/autobuild-hosted-store-service`. Every
deployment installs that package, so an agent working in the deployment folder
can read this file at
`node_modules/@defrex/autobuild-hosted-store-service/SELF-HOSTING.md`.

## What you deploy

The service hosts the BuildStore, hosted tickets, the operator dashboard,
sign-in and the MCP server on one origin. A deployment takes one of two shapes:

- **Store-only** (the default). The deployment holds state. Each project
  dispatches from its own machine or from an origin-mode dispatcher.
- **Dispatcher-enabled.** The deployment also owns the dispatch kernel. A
  per-minute cron calls `GET /api/dispatch`, which runs builds in Vercel
  Sandbox.

You need:

- Bun 1.4.x;
- a Vercel project (a per-minute dispatcher needs a paid plan; see
  [Vercel requirements](#vercel-requirements));
- a PostgreSQL database;
- a blob backend, either Vercel Blob or an S3-compatible bucket;
- a GitHub OAuth app for sign-in.

## Store-only deployment

The template is this package's `deployment/package.json` and
`deployment/vercel.json`, also on GitHub at
[`templates/hosted-service/`](https://github.com/defrex/autobuild/tree/main/templates/hosted-service).
Put them in their own folder, which can be a small Git repository of its own.
Replace `VERSION` with one exact Autobuild release. Every `@defrex/*` pin must
be that same exact release.

`package.json`:

```json
{
  "private": true,
  "scripts": {
    "build": "ab-hosted-service-build"
  },
  "dependencies": {
    "@defrex/autobuild-hosted-store-service": "VERSION",
    "@defrex/autobuild": "VERSION",
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

Run `bun install` and commit `bun.lock`. Add these entries to `.gitignore`:

```gitignore
node_modules/
.next/
.vercel/
app/
next.config.ts
next-env.d.ts
tsconfig.json
.autobuild-service-assets.json
# Dispatcher-enabled deployments only:
.autobuild-dist/
```

`ab-hosted-service-build` generates the application on every build. It stages
the Next.js `app/` tree, `next.config.ts`, `next-env.d.ts` and `tsconfig.json`
into the folder, and records their hashes in `.autobuild-service-assets.json`.
It refuses to overwrite a file it does not own or that was edited since it
wrote it, so do not edit the generated files. It then migrates PostgreSQL and
runs `next build`. The database and blob variables must therefore be set for
the build as well as at runtime.

A store-only deployment has no cron. Its `GET /api/dispatch` answers 503 with
`{"error":"dispatch runs elsewhere for this deployment"}`.

## Store-only and dispatcher-enabled compared

| | Store-only | Dispatcher-enabled |
| --- | --- | --- |
| Extra dependencies | none | `@defrex/autobuild-hosted-dispatcher`, `@defrex/autobuild-vercel-sandbox` |
| `GET /api/dispatch` | 503, dispatch runs elsewhere | runs one bounded dispatcher tick |
| Cron | none | one `crons` entry in `vercel.json` |
| Build | stage, migrate, `next build` | also packs the guest distribution and ships provider plugins |
| Variables | [service variables](#service-variables) | also the [dispatcher variables](#dispatcher-variables) |
| Who runs builds | each project's own dispatcher | this deployment |

## Dispatcher-enabled deployment

### Extra dependencies

Add the hosted dispatcher and the Vercel Sandbox provider plugin to the
template's `dependencies`, pinned to the same release:

```json
"@defrex/autobuild-hosted-dispatcher": "VERSION",
"@defrex/autobuild-vercel-sandbox": "VERSION"
```

Run `bun install` and commit `bun.lock`. With the dispatcher installed,
`ab-hosted-service-build` stages the real dispatch route. It runs
`ab-hosted-dispatcher pack-distribution` before `next build` and
`ab-hosted-dispatcher ship-deployment` after it. These commands put the guest
distribution archive, its manifest and the selected provider plugins into the
`/api/dispatch` function.

### Which provider plugins ship

The first rule that applies decides:

1. `ship-deployment --plugin NAME` flags. The template's build runs
   `ship-deployment` without flags, so this rule does not apply to it.
2. The deployment `package.json` field `"autobuild": { "plugins": [...] }`.
   An explicit `[]` ships none.
3. By default, each `dependencies` entry whose installed `package.json` peers
   on `@defrex/autobuild`, except Autobuild's own service packages.

With the template plus the two extra dependencies, rule 3 ships
`@defrex/autobuild-vercel-sandbox`. A selected plugin that is not installed,
does not bundle, or is not a valid plugin fails the build by name. See
[which provider plugins ship](https://github.com/defrex/autobuild/blob/main/packages/hosted-dispatcher/README.md#which-provider-plugins-ship)
for the full rule.

### Cron entry

Add a cron to the deployment's `vercel.json`, and leave the rest of the
template as it is:

```json
"crons": [{ "path": "/api/dispatch", "schedule": "* * * * *" }]
```

Vercel calls the path with `Authorization: Bearer <CRON_SECRET>`.

### Function duration and budget

The staged dispatch route declares `maxDuration = 300`. For a Next.js App
Router function, the duration comes from the route file. Each invocation
works for `AB_DISPATCHER_BUDGET_SECONDS` (default 240; the parser clamps it to
10–780). Keep the budget at least about 20 seconds below the function
duration so the response returns in time. With the 300 second route, leave the
budget unset or set it to at most about 280.

The route is a generated file that the builder will not let you edit, so an
installed deployment cannot raise the 300 second duration today, even on a
plan that allows longer functions. Work that does not finish in one invocation
resumes on the next tick.

### Check the endpoint

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://ORIGIN/api/dispatch
```

- 200 with `{"ok":true,"repositories":[...]}`: the tick ran, with one outcome
  per repository.
- 401: the bearer is missing or wrong.
- 403: `CRON_SECRET` is unset or blank, so the endpoint is disabled.
- 500: the dispatcher configuration is invalid. The message names the
  variable, never its value.

### Pausing

Remove the cron entry, or unset or rotate `CRON_SECRET`, to stop all
dispatch. To stop intake for one repository, turn it off from the dashboard.

## Vercel requirements

Autobuild needs only these things from Vercel: the environment variables
below, the cron, the function duration and, in a monorepo, the Root
Directory.

- **Cron.** Hobby projects can run a cron at most once a day, and a
  per-minute expression fails the deployment. A per-minute dispatcher needs a
  Pro or Enterprise plan. See
  [cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- **Function duration.** 300 seconds is Vercel's default and the Hobby
  maximum with fluid compute. See
  [configuring function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Environment variables

Every variable is server-only. Never give any of them a `NEXT_PUBLIC_` name.
Set the database and blob variables for the build environment as well as at
runtime.

### Service variables

Database:

- `AB_POSTGRES_URL` or `DATABASE_URL` (required): the PostgreSQL connection
  URL. `AB_POSTGRES_URL` wins when both are set. Build and runtime must use the
  same database.

Blob storage:

- `AB_BLOB_BACKEND` (required): `vercel` or `s3`.
- For `vercel`:
  - `AB_VERCEL_BLOB_ACCESS` (required): `public` or `private`.
  - `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` together with the function's
    `VERCEL_OIDC_TOKEN` (one of the two is required).
- For `s3`:
  - `AB_S3_BUCKET`, `AB_S3_REGION`, `AB_S3_ACCESS_KEY_ID` and
    `AB_S3_SECRET_ACCESS_KEY` (required).
  - `AB_S3_ENDPOINT` (optional): an S3-compatible endpoint.
  - `AB_S3_SESSION_TOKEN` (optional): temporary credentials.
  - `AB_S3_FORCE_PATH_STYLE` (optional): `true` or `false`.
- `AB_BLOB_PREFIX` (optional): a key prefix inside the store.
- `AB_ARTIFACT_RETENTION_MAX_REVISIONS` (optional): revisions kept per
  bounded artifact kind (default 200).

Service:

- `AB_STORE_SECRET` (required): signs machine tokens. Never give it to a
  dispatcher or a build agent.
- `AB_PROJECT_SECRETS_KEY` (optional): base64 of exactly 32 random bytes
  (`openssl rand -base64 32`). It is required before any project can save
  secrets, and it cannot be rotated. See
  [project-secret encryption](README.md#project-secret-encryption).

Web sign-in:

- `BETTER_AUTH_SECRET` (required): the session secret, at least 32
  high-entropy characters. Rotate it to end every browser session.
- `BETTER_AUTH_URL` (required): the exact public origin, such as
  `https://autobuild.example.com`.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (required): the GitHub OAuth
  app. Set its callback URL to `https://ORIGIN/api/auth/callback/github`.
- `AB_WEB_AUTH_PROVIDERS` (required): `github`.
- `AB_WEB_SUPER_USER_EMAILS` (required): comma-separated super-user emails.
  These people maintain the deployment.
- `AB_WEB_MCP_RESOURCE` (optional): the resource the MCP server binds tokens
  to. Defaults to `<BETTER_AUTH_URL>/mcp`.

Retired or deprecated:

- `AB_WEB_REPOSITORIES` is deprecated. It imports project registrations once
  per database and never again.
- `AB_WEB_ALLOWED_EMAILS` is refused at startup. Use `AB_WEB_SUPER_USER_EMAILS`.
- `AB_TICKET_BACKEND` and `LINEAR_API_KEY` are ignored. The service has no
  Linear backend.

Bare Bun only: outside Vercel, `bun run hosted-store` serves the machine
routes and reads `PORT` (default 3000) and `AB_HOST` (default `0.0.0.0`).

### Dispatcher variables

Set these only on a dispatcher-enabled deployment:

- `CRON_SECRET` (required): the cron bearer secret. Unset or blank disables the
  endpoint and dispatch placement.
- `AB_DISPATCHER_ORIGIN` (required): the deployment's public https origin.
  The kernel, the hosted ticket source and the guests use it as their store.
- `AB_DISPATCHER_REPOSITORIES` (optional): comma-separated repositories to
  serve, in order. Unset serves every registered project.
- `AB_DISPATCHER_BUDGET_SECONDS` (optional): the per-invocation work budget.
  See [function duration and budget](#function-duration-and-budget).
- `AB_DISPATCHER_TOKEN_TTL_SECONDS` (optional): the upper bound on a cron
  credential's lifetime (default 7 days, minimum 3600).
- `GITHUB_TOKEN` or `GH_TOKEN` (required unless every served repository has an
  override): the forge credential for pushes and pull requests. There is no
  gh CLI fallback.
- `AB_DISPATCHER_GITHUB_TOKENS` (optional): JSON mapping repositories to their
  own forge tokens.
- Runtime variables for build sessions, such as `AI_GATEWAY_API_KEY`: the
  dispatcher forwards them to guest sessions.
- `AB_DISTRIBUTION_ARCHIVE` (optional): an explicit guest archive path.
  Normally leave it unset; the build packs the archive.

Do not set `VERCEL_TOKEN`. The Sandbox SDK authenticates with the function's
own OIDC identity. See
[dispatcher environment variables](https://github.com/defrex/autobuild/blob/main/packages/hosted-dispatcher/README.md#dispatcher-environment-variables)
for full semantics.

## Deploying inside another monorepo

The folder can be a Bun workspace member of another project's repository:

1. Put the template folder at a path such as `apps/autobuild`, and list it in
   the root `package.json` `workspaces`.
2. Bun's isolated linker does not hoist the tooling `next build` loads, so the
   member's `package.json` also declares `typescript`, `@types/bun`,
   `@types/node`, `@types/react` and `@types/react-dom`. Use the versions in
   this package's own `package.json` `dependencies`.
3. Keep `vercel.json` in the folder. Run `bun install` at the workspace root
   and commit the root `bun.lock`.
4. In the Vercel project settings, set **Root Directory** to the folder
   (`apps/autobuild`).

The builder finds the workspace root and traces the build from there. A
dependency that is installed outside that root fails the build by name.

## Bring-up checks and the first project

1. `GET https://ORIGIN/health` answers once the deployment is live.
2. Sign in at `https://ORIGIN/sign-in` with a super-user GitHub account.
3. Register a project. From the project's checkout, run
   `ab connect https://ORIGIN` and approve it in the browser. With database
   access, you can instead run
   `ab-hosted-store projects add <origin> --user <identity>` from the
   deployment folder. See [connected projects](README.md#connected-projects)
   and the credential commands in this package's [README](README.md).
4. Create the first organization in the dashboard, then add members by email
   and assign projects to it. See
   [organization management](https://github.com/defrex/autobuild/blob/main/docs/operator-api.md#organization-management-browser).

## Upgrading

Bump every `@defrex/*` pin to the same new release, run `bun install`, commit
the lockfile and push. The next build migrates the database. Upgrade the
service before the projects connected to it.

## Further reading

- [This package's README](README.md): credentials, project administration and
  access.
- [Hosted dispatcher README](https://github.com/defrex/autobuild/blob/main/packages/hosted-dispatcher/README.md)
- [Remote store protocol](https://github.com/defrex/autobuild/blob/main/docs/remote-store-protocol.md)
- [Operator API](https://github.com/defrex/autobuild/blob/main/docs/operator-api.md)
- [Remote ticket protocol](https://github.com/defrex/autobuild/blob/main/docs/remote-ticket-protocol.md)
