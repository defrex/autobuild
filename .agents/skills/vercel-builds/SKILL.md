---
name: vercel-builds
description: Operate, diagnose, prove, or roll back this repository's remote Autobuild execution in Vercel Sandbox.
---

# Vercel builds

Use this runbook for this repository's Vercel Sandbox consumer configuration. The dispatcher,
kernel, hosted Store, ticket authority, Vercel authority, and GitHub publication authority stay
on the maintainer machine. Only build execution runs in the disposable guest.

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

Put credentials in the ignored dispatcher environment file or the maintainer's secret source,
never in tracked files. After changing that source, fully stop and restart the long-running
`ab dispatch` process (or refresh its service environment and restart it). Existing processes do
not acquire changed values. Never copy `~/.pi`, Claude login state, OAuth files, or secret values
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

## Return future builds to local execution

1. Stop ticket intake and stop the dispatcher. Let active remote builds settle, or explicitly
   abort them and wait for publication/cleanup; do not create competing local ownership.
2. Change `[workspace].provider` to `git-worktree` and remove only the Vercel-specific
   `[workspace.config]` and `[workspace.config.runtimeProvisioning.pi]` configuration.
3. Restore the prior subscription-backed routes: Pi OpenAI primary, Pi Kimi fallback, and the
   approved Claude Code runtime alternate, preserving each role's current preference order.
4. Run the focused config test after updating its intended local invariants, then `bun run check`,
   `bun run typecheck`, `bun run test`, and `ab init --validate` in the local environment.
5. Fully restart the dispatcher and verify repository status before resuming intake.

This rollback affects newly provisioned work only. Never migrate an already-running build between
workspace providers.

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
