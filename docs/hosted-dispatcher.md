# The hosted dispatcher

The optional [hosted service](../packages/hosted-store-service/README.md) can
own the dispatch kernel. One authenticated HTTP endpoint — `GET /api/dispatch`
— runs, for each configured repository, one bounded origin-mode dispatcher
tick: the kernel claims ready tickets, provisions and launches sandboxes,
observes running builds, settles publications, opens and merges PRs, and runs
the janitor, exactly as a local `ab dispatch --once --repository <origin>`
pass does. The schedule is what you attach to that endpoint (Vercel Cron calls
it once a minute by default), so builds no longer depend on a maintainer's
machine.

## Enabling the schedule

1. Deploy the hosted service with the dispatcher variables from
   [its README](../packages/hosted-store-service/README.md#hosted-dispatcher)
   — `AB_DISPATCHER_ORIGIN`, the repository set, `CRON_SECRET`, and the forge
   credentials the kernel needs (`GITHUB_TOKEN` or `GH_TOKEN`, plus any
   guest-forwarded variables such as `AI_GATEWAY_API_KEY`). A deployment
   serving repositories across GitHub identities configures per-repository
   tokens with `AB_DISPATCHER_GITHUB_TOKENS`; repositories without an
   override keep using the shared credential.
2. Schedule the route by adding a `crons` entry to the deployment's
   `vercel.json` and redeploying. Vercel issues a plain GET with
   `Authorization: Bearer <CRON_SECRET>` once per minute:

   ```json
   {
     "crons": [{ "path": "/api/dispatch", "schedule": "* * * * *" }]
   }
   ```

3. Verify: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_ORIGIN/api/dispatch`
   returns `200 {"ok":true,"repositories":[{"repository":"…","outcome":"ticked","runId":"hosted-dispatcher-…"}]}`.
   Unauthenticated or wrongly authorized calls are rejected (401) and do no
   work; a deployment without `CRON_SECRET` answers 403 with the endpoint
   disabled. One repository's failure never prevents another's tick.

## Shipping the guest distribution

Every sandbox installs the Autobuild distribution the launching dispatcher
runs. A local dispatcher packs it from its source checkout with `bun pm pack`;
a bundled deployment has neither `bun` nor a source tree at runtime, so it
must pack the archive while both exist — in its build step — and carry it into
the function bundle:

```json
{ "scripts": { "deploy:build": "bun packages/hosted-store-service/src/bin.ts pack-distribution && bun run postgres:migrate && bun run build && bun tools/ship-packed-distribution.ts" } }
```

`pack-distribution` writes `.autobuild-dist/autobuild-<version>.tgz` under the
distribution root (`--root DIR` overrides). The Next.js config's
`outputFileTracingIncludes: { '/api/dispatch': ['./.autobuild-dist/**'] }`
records the intent to include that directory in the cron route's bundle, but
Next 16's default Turbopack builds never apply `outputFileTracingIncludes`
(only webpack builds do), so a deployment cannot rely on the config alone. The
autobuild-api pipeline therefore ends `deploy:build` with a post-build trace
step (`bun tools/ship-packed-distribution.ts`) that appends the archive to the
dispatch route's `route.js.nft.json` — the trace file Vercel's Next builder
consumes when assembling the function bundle — and fails the deploy loudly if
nothing was packed or the trace file is missing. A deployment using this
pipeline cannot ship without the archive; deployments that skip both packing
and the trace step still fail at runtime.

At runtime the kernel takes, in order: `AB_DISTRIBUTION_ARCHIVE` (an explicit
archive path), the single archive under `.autobuild-dist/` of the
distribution root or working directory, a source checkout packed on the spot,
and finally the running version's published GitHub release asset. A tick that
reports `Executable not found in $PATH: "bun"` during `provision` is a
deployment that skipped the pack step (or, outside this pipeline, the trace
step that ships the archive).

## Bounding the invocation

The endpoint is pinned to `maxDuration = 300` seconds (Vercel Pro's default
function duration). `AB_DISPATCHER_BUDGET_SECONDS` (default 240) bounds the
kernel's work inside that: an already-expired budget skips the tick, a budget
reached mid-drain stops awaiting running builds, and a repository whose budget
no longer covers a minimum-remaining floor is answered as `skipped`. Unfinished
work resumes on the next invocation: guests keep running while the supervising
function detaches, and the next tick settles their completion from the Store
plus provider liveness. Raise `maxDuration` and the budget **together** (e.g.
`"maxDuration": 800` with a budget of 780 — the parser clamps 10–780); keep the
budget at least ~20 s below the function duration so the response always
returns.

## Overlap and missed ticks

Invocations are serialized by the durable repository supervisor lease: a second
overlapping invocation yields (it records `dispatcher.tick-yielded` naming the
holder in the repository journal and performs no claims, launches, or
publications), and the loser's response still answers 200. A missed or late
invocation is never incorrect: a build whose guest finished while no invocation
ran is settled — completion facts, lease, publication — by the next
invocation's settlement stage, and a build whose sandbox timed out is recovered
by the lease sweep as with any dispatcher.

## Pausing during an incident

- **Stop the schedule**: remove the `crons` entry (or disable the cron in the
  Vercel dashboard) and redeploy.
- **Revoke the credential**: rotate `CRON_SECRET` — every in-flight schedule
  call starts answering 401.
- **Soft stop**: turn repository intake OFF (operator API `PUT
  /operator/v1/repos/{repo}/settings/intake` with `{"enabled": false}`, or the
  web dashboard) — running builds finish their current phases but no new ticket
  is claimed. A repository-wide or per-build pause holds queued work the same
  way and takes effect on the next invocation.

## Observing the hosted dispatcher

Every invocation is durable: tick reports
(`dispatcher.tick-started`/`-completed`/`-yielded`), run boundaries
(`dispatcher.run-started`/`-stopped`), and a per-minute
`dispatcher-effective-config` artifact deposit all carry the
`hosted-dispatcher-<uuid>` run id, so the web dashboard's repository journal
and the operator API show hosted activity exactly as they show a local
dispatcher. Expect the repository journal to grow by roughly one config
artifact per minute per repository; the dispatcher run/config artifacts
themselves are retention-bounded (see below), while the journal's events keep
accumulating by design.

### Runtime logs

Every invocation also writes to the deployment's runtime logs (Vercel's
**Logs** tab, or `vercel logs`), which is where to look first when the journal
shows no hosted activity at all — a rejected or misconfigured invocation never
reaches the journal. Every line starts with `hosted-dispatcher <invocation id>`
so one invocation's lines can be filtered together:

- the request line (`GET /api/dispatch agent="vercel-cron/1.0"`) — the user
  agent tells a cron call apart from an operator's curl;
- `rejected 401|403|405 <kind>: <reason>` at error level, with whether the
  authorization header was absent or present-but-wrong (never its value);
- `500 configuration invalid: <error>` naming the offending variable;
- `tick start repositories=N budgetSeconds=S origin=…`, then per repository
  `tick run=hosted-dispatcher-…`, `ticked … ms=…`, `skipped`, or
  `failed … : <error with stack>` at error level, then
  `tick complete ticked=… failed=… skipped=…` and `200 ok ms=…`;
- the kernel's own report lines (the same lines `ab dispatch --plain` prints
  locally) prefixed `<repository> [kernel]`, warnings at error level.

Secrets, forge tokens, and minted guest tokens never appear in any line.

## Artifact retention

Dispatcher-generated run/config artifacts — the repository-scoped
`dispatcher-effective-config` and `dispatcher-config` kinds and the
build-scoped `build-runner-effective-config` kind — keep the **latest 200
revisions per kind** (per repository, respectively per build). When a new
revision of one of these kinds is deposited, the store prunes the older
revisions past the bound at deposit time, inside the same transaction.
Events and journal entries are never pruned, so historical event payloads may
reference a pruned revision; the current run's snapshot is always among the
newest deposits and stays retrievable, and every existing read surface
(latest-by-default artifact reads, listings) works unchanged. The bound is
overridable per deployment with `AB_ARTIFACT_RETENTION_MAX_REVISIONS` (a
positive integer; see the store environment documentation). All other
artifact kinds (build logs, `pr-description`, phase artifacts) are not
subject to retention.

## Sandbox authentication

Inside a Vercel Function the Sandbox SDK authenticates with the deployment's
own OIDC identity: Vercel hands each invocation its token on the
`x-vercel-oidc-token` request header (not as a `VERCEL_OIDC_TOKEN` environment
variable), and the endpoint passes it to the kernel under that name for the
duration of the tick. The tick log line reports which credential the kernel
presents (`sandboxAuth=oidc-header`, `oidc-env`, `token`, or `none`); `none`
means the project has OIDC federation disabled (Settings → Security). No
long-lived `VERCEL_TOKEN` belongs on the service. Guests never receive a Vercel
token or forge credential; they authenticate to the Store with the short-TTL
deployment operator token the dispatcher mints for the tick
(`AB_DISPATCHER_TOKEN_TTL_SECONDS`, default 7 days — keep it longer than your
largest `timeoutSeconds` guest lifetime).
