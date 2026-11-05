# `@defrex/autobuild-hosted-dispatcher`

The optional package that lets a hosted deployment own the dispatch kernel: a
cron-authenticated endpoint — `GET /api/dispatch` — runs one bounded dispatcher
tick per configured repository per invocation. It drives the same core
`abDispatch` entry point a local `ab dispatch --once --repository <origin>`
pass runs — claim, provision, launch, observe, settle, merge PRs, janitor,
lease sweep — and reuses `@defrex/autobuild-hosted-store-service`'s validated
store environment for the signing secret. See the
[self-hosting guide](https://github.com/defrex/autobuild/blob/main/packages/hosted-store-service/SELF-HOSTING.md#dispatcher-enabled-deployment)
for the schedule, function duration, and pausing. Self-hosting is unsupported
and buyer-beware.

A deployment opts into building by installing the package and mounting the
route: the Next.js app's `app/api/dispatch/route.ts` (in the hosted store
service package) imports `dispatcherEndpoint` from
`@defrex/autobuild-hosted-dispatcher/runtime` and keeps a module-scope
instance. A deployment that only hosts state does not install it and never
attempts a dispatch tick. The package peers on `@defrex/autobuild` (the core
it drives) and `@defrex/autobuild-hosted-store-service` (the environment
parser and types); a deployment that installs it adds
`bun add @defrex/autobuild-hosted-dispatcher`.

Besides the endpoint driver, the package owns the deploy-time
`ab-hosted-dispatcher` bin, also exported as
`@defrex/autobuild-hosted-dispatcher/bin`. A bundled deployment has neither
`bun` nor a source tree at runtime, so the build has to carry everything the
dispatch function installs and loads. The bin has two commands for that:

- `pack-distribution [--root DIR]`, run before `next build`, packs the installed
  `@defrex/autobuild` into `<root>/.autobuild-dist/autobuild-<version>.tgz`.
  It removes archives left over from other versions.
- `ship-deployment [--root DIR] [--dist-dir DIR] [--plugin NAME]...`, run after
  `next build`, appends the archive and the distribution manifest to the
  `/api/dispatch` route's Next.js trace. It then stages the deployment's own
  Git (see [Shipped Git](#shipped-git)) and each selected provider plugin into
  the function bundle. It fails the build, naming the missing piece, when it
  cannot ship the archive, the manifest, Git or a selected plugin, and when the
  archive's version differs from the installed `@defrex/autobuild`.

The hosted store service's published `ab-hosted-service-build` runs both
commands automatically when this package is installed.

### Shipped Git

Node operations (snapshotting a node's parent, restacking, proving a change is
present, landing) run `git` on a bare clone inside the dispatch function. The
Vercel Function runtime has no `git`, so the deployment ships its own:
`ship-deployment` copies the build host's Git into `<root>/.autobuild-git/`
and adds it to the `/api/dispatch` bundle, about 55 MB. The tree is
self-contained: Git, its HTTPS remote helpers, the complete shared-library
closure including glibc and the dynamic loader, and a CA bundle.

- **Platform.** The target is `linux-x64`, and the build host must be one, as
  Vercel's build image is. On any other host `ship-deployment` fails, naming
  both platforms. It also fails when the host lacks `git`, `ldd`, Git's HTTPS
  helper or a CA bundle, or when a library cannot be resolved.
- **Proof at build time.** Every staged program is checked statically to load
  only from the tree. The build then runs the staged Git with an empty `PATH`,
  clones over HTTP on loopback, and fails if anything loaded from the build
  host. The build log reports the Git and glibc versions, the size Git adds
  and the dispatch function's total.
- **Runtime contract.** An x86_64 Linux kernel at least as new as the bundled
  glibc supports (recorded in the manifest, 3.2 for current glibc) and a
  writable `/tmp`. Each function instance copies the tree to a fixed
  `/tmp/abg…` path once before its first Git command.
- **Isolation.** Every kernel Git command of a tick runs the shipped Git with
  its own libraries, no system or global Git config, and HTTPS as the only
  transport, so it never starts a host program. The tick log line says
  `kernelGit=shipped:<version>`, or `kernelGit=host-path (<reason>)` when the
  tree could not be used.

If Git still cannot run, the dispatcher records one
`dispatcher.kernel-git-unavailable` repository event, node work waits, and
`dispatcher.kernel-git-recovered` closes the condition once a clone succeeds.

### Which provider plugins ship

The first of these rules that applies decides:

1. `ship-deployment --plugin NAME` flags.
2. The deployment `package.json` field `"autobuild": { "plugins": [...] }`.
   An explicit `[]` ships none.
3. By default, each entry of the deployment's `dependencies` whose installed
   `package.json` declares `@defrex/autobuild` in `peerDependencies`, as
   provider plugins do. The default skips Autobuild's own service packages:
   `@defrex/autobuild-hosted-store-service`,
   `@defrex/autobuild-hosted-dispatcher` and `@defrex/autobuild-postgres-store`.

Each selected package must be installed in the deployment and must bundle.
Its bundle must also evaluate to a valid plugin manifest. Any failure fails
the build, naming the package and the rule that selected it. The build
imports each bundle once to validate it, so top-level code in a plugin runs
during the build.

A plugin ships as a self-contained `bun build` bundle staged at
`node_modules/<plugin>` inside the installed `@defrex/autobuild` directory.
That is the first place the dispatch runtime looks when it resolves a plugin
from its installation. The deployment's own installed copy of the plugin is
never modified. A local build without `VERCEL` set removes the staged bundle
afterwards, so `node_modules` stays exactly as `bun install` left it.

## Dispatcher environment variables

Dispatcher variables (server-only, like every secret; none reach the browser):

- `AB_DISPATCHER_ORIGIN`: the deployment's public origin, used as `AB_STORE`
  for the kernel, the hosted ticket source, and guests. Absolute http(s)
  origin; https required in production.
- `AB_DISPATCHER_REPOSITORIES`: comma-separated repositories the dispatcher
  selects in configured order, intersected with the current durable project
  registry. When unset, every authorized invocation queries all active
  registrations. An empty registry is a successful zero-project tick. Removing
  a project stops subsequent ticks, without cancelling already-started work.
  Registry failures fail closed. Configure `AB_POSTGRES_URL` or `DATABASE_URL`;
  the registry pool is reused while membership is queried each invocation.
  Each invocation synchronizes durable placement for included and excluded
  registered projects before dispatch; a failed synchronization prevents that
  project's dispatch. Project reads publish the same selection before first cron.
  Unset or blank `CRON_SECRET` disables hosted responsibility; reads publish
  `hosted: false` without requiring an origin.
- `AB_DISPATCHER_BUDGET_SECONDS`: per-invocation work budget (default 240,
  clamped 10–780); pair it with the route's `maxDuration` as described in the
  [self-hosting guide](https://github.com/defrex/autobuild/blob/main/packages/hosted-store-service/SELF-HOSTING.md#function-duration-and-budget).
- `AB_DISPATCHER_TOKEN_TTL_SECONDS`: an upper bound on stored cron credential
  lifetime (default 604800 — 7 days; minimum 3600). Actual expiry is capped at
  the invocation deadline plus 60 seconds. Successful and failed ticks delete
  their exact credential; spawned builds and harvest use independent grants
  retired by durable lifecycle facts. Each served repository prunes at most
  100 expired/revoked dispatcher rows per tick. Legacy unexpired rows keep
  their existing expiry and drain afterward; owner credentials are unaffected.
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
  to pack with at runtime).

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

Manage projects through the deployment's database-authorized
`ab-hosted-store projects list|add|remove` commands (mutations require
`--user IDENTITY`); see [connected projects](https://github.com/defrex/autobuild/blob/main/packages/hosted-store-service/README.md#connected-projects).
Migrate PostgreSQL before deployment. Deprecated `AB_WEB_REPOSITORIES` seeds
registrations once per database, including standalone dispatcher deployments;
subsequent changes to it are not administration. Forge token override keys are
validated eagerly. In fallback mode a removed project's override is inert; an
explicit repository selection still rejects unknown keys.
