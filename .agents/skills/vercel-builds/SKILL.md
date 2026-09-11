---
name: vercel-builds
description: Operate, diagnose, prove, or roll back this repository's remote Autobuild execution in Vercel Sandbox.
---

# Vercel builds

Use this runbook for this repository's Vercel Sandbox consumer configuration. The hosted Store
(`autobuild-api`) runs the dispatch kernel: a once-per-minute Vercel Cron schedule invokes
`GET /api/dispatch` on the production deployment, and that endpoint runs one bounded dispatcher
tick per configured repository (claim, launch, observe, settle, PR open/merge, janitor) exactly
like a local `ab dispatch --once --repository <origin>` pass. Only build execution runs in the
disposable guest. The schedule requires the team's Pro plan or better — Hobby deployments
reject sub-daily cron expressions — and each invocation is a production-deployment GET
authenticated by the project's `CRON_SECRET`.

## Hosted dispatcher

One invocation runs one bounded dispatcher tick per configured repository. Invocations are
serialized by the durable repository supervisor lease, and every tick is durable under a
`hosted-dispatcher-<uuid>` run id, visible in the web dashboard's repository journal and the
operator API — exactly as a local dispatcher's activity is. Expect the journal to grow by
roughly one `dispatcher-effective-config` artifact per minute per repository; retention is not
yet implemented, so that growth is a documented property, not a fault. The full contract —
bounding, overlap, missed ticks, sandbox authentication — is documented in
[the hosted dispatcher procedure](../../../docs/hosted-dispatcher.md) and
[the hosted service README](../../../packages/hosted-store-service/README.md).

## Pausing and resuming

Resume by inverting whichever mechanism was used to pause:

1. **Disable the schedule.** Use the Vercel dashboard's "Disable Cron Jobs" button for the
   project, or remove the `crons` entry from `vercel.json` and redeploy. Vercel documents that
   instant rollbacks do **not** update active cron jobs — a rolled-back deployment keeps firing.
2. **Rotate `CRON_SECRET`.** Every scheduled call is rejected immediately (401) and does no
   work. Rotating the value requires a fresh deployment for the endpoint to accept the new
   secret.
3. **Soft stop.** Turn intake OFF through the operator API (`PUT
   /operator/v1/repos/{repo}/settings/intake` with `{"enabled": false}`) or the web dashboard.
   Running builds finish their current phases; no new ticket is claimed.

## Running a local dispatcher for diagnosis

For a clean diagnostic window, disable the cron first (above). Then run the local kernel
against the hosted Store: point `AB_STORE` at `https://autobuild-api.defrex.com`, set `AB_TOKEN`
to a scoped deployment operator token, and keep the local secrets in the ignored local
dispatcher environment file. A local dispatcher running while the cron is still enabled is
still safe — overlapping invocations yield on the repository supervisor lease, and the loser
records `dispatcher.tick-yielded` naming the holder. That event in the repository journal is
the tell that the hosted tick stood down. No second writer is possible.

Two operational facts carry over: changed secrets require a fresh deployment (hosted) or a
full local process restart (local) — existing processes never acquire changed values; and
never migrate a running build between workspace providers. Guests never receive Store, Vercel,
GitHub, or local OAuth secrets.

## Cutover (maintainer-owned)

One-time checklist for moving this repository's dispatcher to the hosted deployment, in this
order. Variable **names and required non-secret values** are given; every credential value is
maintainer-owned and never recorded here. Guests never receive `VERCEL_TOKEN` or machine
secrets, so steps 0–3 are deployment-side.

0. **Ground the plan tier — before merging the PR that carries `crons`.** With the maintainer's
   `VERCEL_TOKEN`, check the team's actual plan:

   ```sh
   curl -H "Authorization: Bearer $VERCEL_TOKEN" \
     "https://api.vercel.com/v2/teams?slug=<team-slug>"
   ```

   Read the documented `billing.plan` response property (`GET /v2/teams/<teamId>` works too),
   or read the team's plan on the dashboard's Billing page. It must read `pro` or
   `enterprise`; `hobby` rejects sub-daily cron expressions at deploy time. If it reads
   `hobby`, stop and escalate (or upgrade the plan) rather than merge a known-failing deploy.
1. **Set the missing project environment variables** on `autobuild-api` (production scope):
   `GITHUB_TOKEN` (or `GH_TOKEN`) and `AI_GATEWAY_API_KEY` are still only in the maintainer's
   local environment.
2. **Confirm the present ones, by name and required value**: `AB_STORE_SECRET` (set);
   `AB_TICKET_BACKEND` must read exactly `linear` — the parser default is `database`, and a
   deployment left at the default never serves the AUT team's Linear tickets; `LINEAR_API_KEY`
   (the Linear credential, already present); `CRON_SECRET`; `AB_DISPATCHER_ORIGIN`
   (`https://autobuild-api.defrex.com`); `AB_DISPATCHER_TOKEN_TTL_SECONDS` (the default
   604800 s must outlive the guest `timeoutSeconds` of 14400 s — it does).
3. **Pin the repository set to the host-independent identity**: `AB_WEB_REPOSITORIES` must
   contain exactly `https://github.com/defrex/autobuild` — the normalized https origin
   (`normalizeGitRemoteUrl` strips `.git`, lowercases the host, and maps ssh spellings to
   https), which is the Store's key for this repository and what the web dashboard lists.
   `AB_DISPATCHER_REPOSITORIES`, if set, must carry the same entry; unset, it inherits
   `AB_WEB_REPOSITORIES`. A stale checkout-path or ssh-spelled entry here is what would leave
   the dashboard listing the wrong identity. No `VERCEL_TOKEN` belongs on the service (the
   Sandbox SDK uses the deployment's OIDC identity).
4. **Merge → production deploy.** The deploy carries `crons`; the variables land before it, so
   the first scheduled ticks never answer 403-disabled.
5. **Verify the tick with the endpoint's real response shape**:

   ```sh
   curl -H "Authorization: Bearer $CRON_SECRET" \
     https://autobuild-api.defrex.com/api/dispatch
   ```

   must return
   `200 {"ok":true,"repositories":[{"repository":"https://github.com/defrex/autobuild","outcome":"ticked","runId":"hosted-dispatcher-…"}]}`
   — `outcome` is a per-repository field inside `repositories`; there is no top-level
   `outcome`. A per-repository `"outcome":"failed"` carries an `error` message that names
   variables, never values.
6. **Verify the dashboard identity (AC4)**: the web dashboard's repository list shows this
   repository under `https://github.com/defrex/autobuild`, and the repository journal shows
   `hosted-dispatcher-*` run ids.
7. **Harvest off — read before toggling** (the gate endpoint *flips*, it does not set):
   `GET /operator/v1/repos/{repo}/harvest/status` first; only if `paused` is `false` (the
   endpoint returns `HarvestStatusView`, whose pause field is `paused: boolean`, also surfaced
   as `status: 'paused'`), send `POST /operator/v1/repos/{repo}/harvest/control` with
   `{"action":"toggle-gate"}`; re-GET and confirm `paused: true`. If the status already reads
   `paused: true`, do nothing — an unconditional toggle would switch harvest ON, the exact
   state AC6 forbids.
8. **Stop the local dispatcher**: stop the local `ab-dispatch-kernel` and confirm with
   `ab builds --all --json` that nothing active remains local.
9. **Evidence run (AC2)**: move a ticket to Todo and watch it claim, build, publish, and merge
   in the dashboard with no `ab dispatch` process running anywhere; attach the build's event
   log and PR as the acceptance evidence.

**Harvest is off for this repository until harvest runs in a sandbox.** The paused gate is what
enforces this: the dispatcher's harvest trigger parks while the gate is paused
(`decideHarvestControl` → `park`), so the hosted cron never starts a harvest either.

## Harvest

Observation harvest is operational again in hosted mode (AUT-305): a threshold-triggered
harvest runs exactly like a build — the dispatcher provisions one disposable sandbox from the
remote base head through the same provisioning chain, the guest runs the unchanged harvest
kernel (scan → synthesize → review → file) with the configured role routing, and the
environment is released when the run completes, escalates, or exhausts recovery. No runtime is
invoked on the dispatcher host. Repositories on `git-worktree` keep running harvest locally and
are unaffected.

- Execution identity lives in repository events: `harvest.execution.started` records the
  provider, environment, session, and detached command; `harvest.execution.released` closes it
  with the snapshot purge outcome, and `harvest.started.environment` records where the run
  itself executed. The released fact's snapshot purge outcome proves the environment's absence
  from the Store without querying Vercel.
- Supervision is durable in the same way as builds: if the dispatcher invocation ends mid-run,
  the guest finishes its journal work, and a later invocation settles the environment from the
  execution facts plus provider liveness while the run resumes under the repository lease at
  the next threshold trigger.
- Filed proposals are identical in shape and idempotency to a locally run harvest — same
  creation keys, same reservations, same blocker provenance — because the guest runs the same
  kernel code.
- Observations queued during the hosted gap **are** processed by the first hosted harvest: the
  scan claims every unclaimed observation regardless of when it was queued, and a pre-gap open
  or parked run is resumed by the same resumed-execution path.

Inspect a hosted harvest with the repository journal:

```sh
ab repository status --json
ab harvest status --json
```

Compare `harvest.execution.started`/`.released` identities the same way build identities are
compared above; a started fact without a matching release means the environment still owes a
settlement pass (or the purge is retrying with `snapshots.outcome: "unknown"`).

## Non-secret prerequisites

Before starting intake or readiness validation, confirm all of the following without printing any
credential value:

- `origin` is an HTTPS `https://github.com/defrex/autobuild.git` URL. An SSH origin cannot be
  cloned by Vercel.
- `AB_STORE` is the hosted HTTPS Store and `AB_TOKEN` is scoped for this repository.
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` identify the intended team/project.
  The daemon requires this durable tuple; do not substitute an expiring `VERCEL_OIDC_TOKEN`.
- `GITHUB_TOKEN` can push the build branch and create or extend its PR. A keyring-only `gh` login
  is not available inside the publication path.
- `AI_GATEWAY_API_KEY` can use Vercel AI Gateway. It is the only authority forwarded through
  `[workspace.config].environmentVariables`; never forward Store, Vercel, GitHub, or local Pi
  OAuth/subscription state.
- For a private source repository only, configure dedicated read-only clone username/password
  variables through `gitUsernameEnv` and `gitPasswordEnv`. They must not reuse publication or
  provider credentials. This public repository does not need them.

Hosted credentials live in the Vercel project's environment variables (production scope,
server-only, never in tracked files, never under a `NEXT_PUBLIC_` name). The ignored local
dispatcher environment file applies only to locally-run dispatchers. A redeploy publishes
changed values to the hosted path — each cron invocation re-reads them, so no process restart
is needed there; a locally-run dispatcher still requires a full process restart after changing
its environment file. Never copy `~/.pi`, Claude login state, OAuth files, or secret values
into a sandbox.

## Preflight and diagnostics

Run presence-only checks, then exercise production validation:

```sh
git remote get-url origin
for name in AB_STORE AB_TOKEN VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_PROJECT_ID GITHUB_TOKEN AI_GATEWAY_API_KEY; do
  test -n "$(printenv "$name")" && printf '%s: set\n' "$name" || printf '%s: MISSING\n' "$name"
done
ab models vercel-ai-gateway
ab models vercel-ai-gateway --available
ab repository status --json
ab ticket list --state Todo --json
vercel whoami
vercel project inspect "$VERCEL_PROJECT_ID" --scope "$VERCEL_TEAM_ID"
ab init --validate
```

The validation report must name `vercel-sandbox`, Pi 0.84.4, all three configured gateway models,
`system-install`, `browser-smoke`, repository setup, and hosted Store access. It must also report
that its temporary readiness sandbox was released. A successful local parser test is not a
substitute for this provider call. In a guest or retained diagnostic shell, check
`pi --version`, `/usr/bin/google-chrome-stable --version`, and `fc-list | head` without exposing
environment values.

For a failed or recovering build, preserve the complete durable projection before acting:

```sh
ab builds --all --json
ab build status <slug> --events 200 --json
```

Inspect `infrastructure.failed`, `execution.started`, `workspace.provisioned`,
`workspace.released`, phase/session identities, lease state, verification events,
`finalize.completed`, and every `publication.requested` SHA. Compare those identities rather than
inferring execution from a process list. Escalate account, quota, Store/ticket, Gateway billing,
or GitHub permission failures with the exact missing variable or denied permission, never its
value.

If automatic cleanup fails, use the exact environment identity from durable events when querying
the Vercel team/project. Do not delete by a title prefix or guess. Confirm the original,
replacement, and completed environment identities are absent and retain the matching
`workspace.released` events. If an exact-name sandbox survives, stop intake and escalate for
provider cleanup rather than claiming completion.

## Snapshot cleanup

Snapshots are created automatically whenever a session stops, and deleting a sandbox does not
delete them: they keep incurring storage until deleted or expired. Autobuild bounds and purges
them itself:

- Every environment is created with `keepLastSnapshots: { count: 1, deleteEvicted: true }`, so a
  live environment holds at most the one snapshot resuming it needs — stops never accumulate one
  snapshot per stop.
- Releasing an environment stops it, purges every snapshot listed under its exact name, deletes
  it, and re-purges; the durable `infrastructure.cleanup-attempted` event then carries
  `snapshots: { outcome: "confirmed", deleted: N }`. That fact proves absence from the Store
  without querying Vercel. `outcome: "unknown"` with `cleanupPending: true` means the purge is
  retrying; a build is never failed or wedged by a snapshot cleanup problem.
- `ab init --validate` reports the readiness sandbox's purge count on its
  `Disposable environment: … (released; N snapshot(s) deleted)` line.

To audit or remediate leftovers for an exact environment identity (name and generation digest,
from `workspace.provisioned` events):

```sh
curl -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/sandboxes/snapshots?project=$VERCEL_PROJECT_ID&name=<environment>&teamId=$VERCEL_TEAM_ID"
```

Only entries with `status: "created"` hold storage; `deleted` and `failed` rows hold none. Remove
one with:

```sh
curl -X DELETE "https://api.vercel.com/v2/sandboxes/snapshots/<snapshotId>?teamId=$VERCEL_TEAM_ID"
```

Once the sandbox itself is deleted its name may no longer filter the listing. Then match each
snapshot's `sourceSessionId` against the session ids in `execution.started` events
(`ab build status <slug> --events 200 --json`) to attribute storage to a build before deleting it.

## Rollout evidence

Completed 2026-09-09 without recording secret values:

- Hosted ticket
  [AUT-295](https://linear.app/defrex/issue/AUT-295)
  drove build `vercel-recovery-probe-2` and merged
  [PR #290](https://github.com/defrex/autobuild/pull/290). The PR records only
  `docs/vercel-sandbox-rollout-probe.md`; its published head was
  `cb753c53ec91517af399ab5dbe757bb7e452cbd4`, merged to `main` as `4ee6110`.
- Store events 3/6 record the first Vercel environment
  `autobuild-vercel-recovery-probe-2-g0-7d86cfd3f8`, execution
  `aron-desktop-vercel-recovery-probe-2-inst_ec6a5ebd`, and session
  `sbx_mhFLmTOwKV0ueTpg6xB39jiVa15V`. Its controlled out-of-band deletion is confirmed absent by
  cleanup event 11 and release event 12. Events 13-16 record distinct replacement environment
  `autobuild-vercel-recovery-probe-2-g1-9f3ac1a661`, execution
  `aron-desktop-vercel-recovery-probe-2-inst_a42aaf87`, session
  `sbx_DpjC7lrD4siZHk47h4A9onWQEw66`, and reclamation of the same plan session/build rather than a
  duplicate owner.
- Events 105-140 provide the explicit interruption exercise later in the same slug: pause event
  116 stopped environment `g3-9a48247500`/session `sbx_EaWW1qKzcNLJ5ee81jd4QKBUSYBz`
  (exit 143), cleanup/release events 134-135 confirmed it gone, resume event 136 provisioned
  `g4-0d3d410af7`/session `sbx_DV6Hf60eTrtpIltYqeAIucaZGS4z`, and event 139 reclaimed the same
  implement session. Every generation reran production provisioning/setup before execution.
- The final replacement (`g7-73d99e606f`, execution `inst_7d9cea66`, session
  `sbx_SNdUbhCoNLnaJtU58M6EHWGb139y`; events 233-235) passed lint, types, unit, terminal dashboard,
  and web dashboard on first attempts (events 241, 243, 245, 258, and 282). Agent sessions used Pi
  with the configured Vercel AI Gateway models, including implement event 196, code review event
  237, visual verifier events 247/261, finalize event 285, and changelog event 295.
- Terminal visual evidence is `rollout-probe:terminal-report@4`; all inspected PNGs are
  `dashboard-frame:{headline-happy-wide,mixed-wide,mixed-narrow,unicode-transcript,resume-prompt}:png@4`
  from the remote manual exercise (designation events 197-202). The configured verifier retained
  its independent passing report `verify-report:dashboard@0` and the five PNGs at revision 5
  (events 248-258).
- Web visual evidence is `rollout-probe:web-report@4`; all 23 inspected PNGs use
  `web-dashboard-frame:<frame>:png`, designated by events 204-226 at revisions 3/4. The configured
  verifier independently passed and retained `verify-report:web-dashboard@0` plus all 23 PNGs at
  revisions 4/5 (events 262-282).
- Implement publication `cb753c5` is event 227. Finalize publication event 286 used that same head
  because the changelog agent required no additional diff; `finalize.completed` event 291 records
  open PR #290 at that head. Events 293-296 prove the changelog session completed in a fresh guest,
  and build completion event 302 records the eventual merge.
- Cleanup/release events 11-12, 61-62, 102-103, 134-135, 178-179, 189-190, 231-232, 289-290, and
  299-300 cover every environment `g0` through `g8` (the externally deleted `g0` was already
  absent; every other cleanup was confirmed). A post-completion Vercel API query by the exact
  `autobuild-vercel-recovery-probe-2-` name prefix returned no sandboxes. Readiness also released
  disposable environment `salmon-painful-spoonbill-fu5i8j` after acquisition, system/browser
  provisioning, setup, Pi/Gateway diagnostics, and hosted Store access all passed.
