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
   guest-forwarded variables such as `AI_GATEWAY_API_KEY`).
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
artifact per minute per repository; retention/pruning is not yet implemented.

## Sandbox authentication

Inside a Vercel function the Sandbox SDK authenticates with the deployment's
own OIDC identity (`VERCEL_OIDC_TOKEN` is injected automatically). No
long-lived `VERCEL_TOKEN` belongs on the service. Guests never receive a Vercel
token or forge credential; they authenticate to the Store with the short-TTL
deployment operator token the dispatcher mints for the tick
(`AB_DISPATCHER_TOKEN_TTL_SECONDS`, default 7 days — keep it longer than your
largest `timeoutSeconds` guest lifetime).
