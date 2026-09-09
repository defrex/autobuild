---
name: vercel-builds
description: Operate, diagnose, prove, or roll back this repository's remote Autobuild execution in Vercel Sandbox.
---

# Vercel builds

Use this runbook for this repository's Vercel Sandbox consumer configuration. The dispatcher,
kernel, hosted Store, ticket authority, Vercel authority, and GitHub publication authority stay
on the maintainer machine. Only build execution runs in the disposable guest.

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

Do not mark this section complete from configuration, mocks, or readiness alone. Record no secrets.

- Live ticket/build/PR: **pending**
- First Vercel execution/environment/session identity: **pending**
- Controlled deletion and same-slug replacement identity/event references: **pending**
- Replacement setup and applicable lint/types/unit verification: **pending**
- Terminal dashboard report and every inspected PNG artifact kind/revision: **pending**
- Web dashboard report and every inspected PNG artifact kind/revision: **pending**
- `finalize.completed`, publication SHAs, and open PR head including finalize: **pending**
- Original/replacement/completed sandbox absence plus `workspace.released` references: **pending**
