# `@defrex/autobuild-hosted-dispatcher`

The optional package that lets a hosted deployment own the dispatch kernel: a
cron-authenticated endpoint — `GET /api/dispatch` — runs one bounded dispatcher
tick per configured repository per invocation. It drives the same core
`abDispatch` entry point a local `ab dispatch --once --repository <origin>`
pass runs — claim, provision, launch, observe, settle, merge PRs, janitor,
lease sweep — and reuses `@defrex/autobuild-hosted-store-service`'s validated
store environment for the signing secret. See the
[operator procedure](../../docs/hosted-dispatcher.md) for the schedule,
incident pauses, and behavior details.

A deployment opts into building by installing the package and mounting the
route: `app/api/dispatch/route.ts` imports `dispatcherEndpoint` from
`@defrex/autobuild-hosted-dispatcher/runtime` and keeps a module-scope
instance. A deployment that only hosts state does not install it and never
attempts a dispatch tick. The package peers on `@defrex/autobuild` (the core
it drives) and `@defrex/autobuild-hosted-store-service` (the environment
parser and types); a deployment that installs it adds
`bun add @defrex/autobuild-hosted-dispatcher`.

Besides the endpoint driver, the package owns two deploy-time helpers:

- the `ab-hosted-dispatcher` bin with the `pack-distribution` command, which
  packs the running distribution into `<root>/.autobuild-dist/autobuild-<version>.tgz`
  during the deployment build (`deploy:build` runs it by path:
  `bun packages/hosted-dispatcher/src/bin.ts pack-distribution`); and
- the `ship-packed-distribution` trace helper
  (`bun packages/hosted-dispatcher/src/ship-packed-distribution.ts`), which
  appends that archive to the dispatch route's Next.js trace file so the
  function bundle carries it.

## Dispatcher environment variables

Dispatcher variables (server-only, like every secret; none reach the browser):

- `AB_DISPATCHER_ORIGIN`: the deployment's public origin, used as `AB_STORE`
  for the kernel, the hosted ticket source, and guests. Absolute http(s)
  origin; https required in production.
- `AB_DISPATCHER_REPOSITORIES`: comma-separated repositories the dispatcher
  serves, normalized `https://` identities exactly like `AB_WEB_REPOSITORIES`.
  When unset, the deployment's `AB_WEB_REPOSITORIES` set is used, so a
  deployment configures its repository set once.
- `AB_DISPATCHER_BUDGET_SECONDS`: per-invocation work budget (default 240,
  clamped 10–780); pair it with the route's `maxDuration` as described in the
  operator procedure.
- `AB_DISPATCHER_TOKEN_TTL_SECONDS`: the TTL of the per-tick deployment
  operator token minted for guests (default 604800 — 7 days; minimum 3600).
  It must outlive your largest guest `timeoutSeconds` (e.g. 14400).
- `CRON_SECRET`: the cron authorization shared secret. Unset or blank disables
  the endpoint entirely. It is never a signing input and is unrelated to
  `AB_STORE_SECRET`.
- `GITHUB_TOKEN` or `GH_TOKEN`: the shared forge credentials the kernel (and
  its publication settlement) use. They stay on the service; guests never
  receive one.
- `AB_DISPATCHER_GITHUB_TOKENS`: optional per-repository forge credential
  overrides — a JSON object mapping repository identities to GitHub token
  material, e.g.
  `{"https://github.com/acme/one":"github_pat_…","git@github.com:acme/two.git":"ghp_…"}`.
  Keys accept the same spellings as the repository set and must name a served
  repository; a repository with an override authenticates its dispatcher tick
  with that token (both `GITHUB_TOKEN` and `GH_TOKEN`), every other repository
  keeps the shared `GITHUB_TOKEN`/`GH_TOKEN`. Unset means shared-only, and a
  repository with neither fails its tick — origin-mode dispatch never uses the
  gh CLI login of whoever runs the service, unlike a local checkout-mode
  dispatcher. Tokens
  never appear in logs, responses, or artifacts; server-only like every secret
  above.
- Guest-forwarded variables such as `AI_GATEWAY_API_KEY` flow through from the
  service environment to the guest session untouched.
- `AB_DISTRIBUTION_ARCHIVE`: optional explicit path to the guest distribution
  archive. Unset, the kernel uses the archive
  `ab-hosted-dispatcher pack-distribution` wrote to `.autobuild-dist/` during
  the deployment build (required for a bundled deployment, which has no `bun`
  to pack with at runtime — see the operator procedure).

The Sandbox SDK authenticates with the deployment's own OIDC identity inside
Vercel functions (the `x-vercel-oidc-token` request header, forwarded to the
kernel as `VERCEL_OIDC_TOKEN` for the tick), so **no `VERCEL_TOKEN`
belongs on the service**. Each invocation deposits a
`dispatcher-effective-config` repository artifact and durable tick/run facts
under the `hosted-dispatcher-<uuid>` run id — the web dashboard shows hosted
activity exactly as it shows a local dispatcher. The repository journal's
events keep growing by roughly one tick per minute per repository (intentional);
the run/config artifacts themselves are retention-bounded — the store keeps the
latest 200 revisions per dispatcher artifact kind and prunes older revisions at
deposit time, overridable with `AB_ARTIFACT_RETENTION_MAX_REVISIONS`.
