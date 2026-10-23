---
title: Troubleshooting
group: reference
order: 18
description: "Diagnose configuration, idle dispatch, authentication, stalled builds, and project selection."
---

# Troubleshooting

Start from the symptom and recorded state. Your operator agent inspects the CLI and suggests corrections; you manage dispatcher processes and credentials.

## Invalid configuration

**Symptom:** Startup reports a TOML syntax error, invalid config with field paths, or runtime-routing errors naming roles.

**Likely cause:** Malformed TOML, misplaced fields, inconsistent step definitions, or runtime/model settings inherited from `roles.default`.

**Fix:** Repair syntax first, then every named schema path in `autobuild.toml`. Check that listed steps have matching subtables and command names exist. Inspect merged default and child roles: each setting inherits independently. Use `bun ab models` or plugin documentation to select a supported model. `dispatch --once` can execute real work; use it only when a real tick is intended.

## tick: idle with expected work

**Symptom:** Plain dispatch prints `tick: idle` while you expect a ticket or harvest to start.

**Likely cause:** The pass took no action because admission or workflow gates remain closed.

**Fix:** Inspect `bun ab repository status`, `bun ab builds --queued`, and source tickets. Check intake, repository pause, the exact ready state, and all required labels. Check blockers and destination eligibility: the target node must be open and required changes present in the destination. Already-claimed tickets are excluded from new claims.

Compare actual execution occupancy with capacity. Ordinary paused or blocked work retains its slot, but idle collecting nodes consume no runner capacity. Node verification and reconciliation have special accounting for descendant-held slots. Resume a deliberately paused repository only when work should proceed.

For harvesting, inspect `bun ab harvest status`, the acknowledged harvest gate, and unclaimed observations. Triggers are `policy.harvestThreshold` observations or `policy.harvestMaxDrift` other merged builds since the oldest observation; zero disables drift. Harvest uses no build slot.

## Authentication failures

**Symptom:** Ticket requests, forge operations, agent launches, or hosted reads report missing credentials or rejection.

**Likely cause:** Credentials authorize different services and scopes.

**Fix:** Match the failing component:

- Linear: check `LINEAR_API_KEY`, the configured team, and workflow states. Correct the actual process environment or supported `.env` file.
- GitHub: run `gh auth status` and check repository permissions. Test Git remote fetch/push authentication separately.
- Agent providers: authenticate the runtime selected by the effective role. Install Codex and run `codex login` when its adapter diagnostic requires it; for Pi, verify provider login and the provider-qualified model. Permission, billing, and quota failures need provider-side correction.
- Hosted store: run `bun ab connect` to inspect service, project, and credential status. Reconnect on the affected host/user when saved credentials are missing or rejected. Check the effective store URL and `AB_STORE` or `AB_TOKEN` overrides; overrides can select another service or replace saved credentials. Build/session grants have narrower authority.

See [Build store](build-store.md#shipped-adapters) for saved credentials and store selection precedence. Keep secrets out of diagnostic reports.

## Stuck or wedged builds

**Symptom:** A build stays unchanged or stops advancing after an interruption.

**Likely cause:** It may be escalated, paused, waiting for landing gates, starting a runner, or recovering expired execution authority. A quiet log alone does not establish a crash.

**Fix:** Inspect `bun ab build status BUILD` and `bun ab builds --queued`. Read status, durable progress, and lease health independently. A held lease indicates live ownership; old progress means no recent recorded fact. An absent lease can mean startup. Expired leases on actionable work recover through the lease sweep; a merged or closed PR may instead await completion bookkeeping.

Use `bun ab resume BUILD` for a cleanly paused build. Use `bun ab answer BUILD "guidance"` for an open escalation, or choose the documented retry resolution when appropriate. Restart does not clear escalation gates. Terminal builds cannot restart; abort is irreversible. If process recovery is needed, you stop and drain the dispatcher cleanly, then restart it; your operator agent diagnoses and asks you to manage the process.

See [answering blocked builds](operating.md#answer-and-pause). Preserve event logs and let the kernel manage leases and recovery.

## Hosted project selection

**Symptom:** A project is missing from connected tools or the dashboard, or hosted dispatch ignores it despite valid credentials.

**Likely cause:** Registration, allowed-user access, project credentials, and dispatcher selection are separate gates.

**Fix:** Check the active PostgreSQL project registry. Existing build or ticket data does not register a project. Every allowlisted user sees all active entries; verify sign-in access separately from credentials. With deployment database credentials, an administrator can run `ab-hosted-store projects list`, `projects add`, or `projects remove`. Mutations require `--user IDENTITY` for declared attribution; project tokens cannot administer registrations.

Check `AB_DISPATCHER_REPOSITORIES` in the hosted dispatch environment. Unset, it selects all active registrations; an explicit ordered list is intersected with current registrations. A missing dashboard selection falls back to the first registered origin. Registry errors fail closed.
