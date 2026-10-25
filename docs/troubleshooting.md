---
title: Troubleshooting
group: reference
order: 18
description: "Diagnose configuration, idle dispatch, authentication, stalled builds, and project selection."
---

# Troubleshooting

Start from the symptom and recorded state. Your operator agent inspects the CLI and suggests fixes; you manage dispatcher processes and credentials.

## Invalid configuration

**Symptom.** Startup reports a TOML syntax error, invalid config with field paths, or a runtime-routing error naming a role.

**Cause.** Malformed TOML, misplaced fields, inconsistent step definitions, or runtime and model settings inherited from `roles.default`.

**Fix**, in order:

1. Repair TOML syntax.
2. Fix every schema path the error names in `autobuild.toml`.
3. Give each listed step a matching subtable and existing command names.
4. Inspect the merged default and child roles; each setting inherits independently.
5. Pick a supported model with `bun ab models` or the plugin's documentation.

```sh
bun ab models --available
bun ab init --validate
```

`bun ab dispatch --once` runs real work; use it only for a real tick.

## tick: idle with expected work

**Symptom.** Plain dispatch prints `tick: idle` while you expect a ticket or harvest to start.

**Cause.** An admission or workflow gate is closed.

**Fix.** Inspect state, then check the gates:

```sh
bun ab repository status
bun ab builds --queued
bun ab harvest status
```

- **Intake and pause:** intake on, repository not paused. Resume a deliberately paused repository only when work should proceed.
- **Ready state:** ticket in the exact ready state with every required label.
- **Blockers and destination:** blockers done, target node open, required changes in the destination.
- **Claims:** claimed tickets aren't reclaimed.
- **Capacity:** paused or blocked work keeps its slot; idle collecting nodes take none. Node verification and reconciliation account specially for descendants' slots.
- **Harvest:** check the acknowledged harvest gate and unclaimed observations. Harvest triggers at `policy.harvestThreshold` observations, or `policy.harvestMaxDrift` other merged builds since the oldest observation (zero disables drift), and uses no build slot.

## Authentication failures

**Symptom.** Ticket requests, forge operations, agent launches or hosted reads report missing or rejected credentials. Each service has its own credential and scope.

| Component | Check |
|---|---|
| Linear | `LINEAR_API_KEY`, team and workflow states, in the actual process environment or supported `.env` |
| GitHub | `gh auth status` and repository permissions; test Git fetch and push separately |
| Agent providers | The effective role's runtime: `codex login` when the Codex diagnostic asks; for Pi, provider login and the provider-qualified model |
| Hosted store | `bun ab connect` for service, project and credential status |

- **Provider refusals.** Fix permission, billing and quota failures on the provider side.
- **Hosted credentials.** Reconnect on the affected host and user when saved credentials are missing or rejected. `AB_STORE` and `AB_TOKEN` override the saved store URL and credential. Build and session grants have narrower authority.

[Build store](build-store.md#shipped-adapters) covers saved credentials and store-selection precedence. Keep secrets out of diagnostic reports.

## Stuck or wedged builds

**Symptom.** A build stops advancing, often after an interruption.

**Cause.** Escalated, paused, waiting on merge gates, starting a runner, or recovering an expired lease. A quiet log isn't a crash.

**Fix.** Inspect the build, reading status, progress and lease health separately:

```sh
bun ab build status my-build
bun ab builds --queued
```

- **Held lease:** something owns the build live.
- **Old progress:** nothing recent was recorded.
- **Absent lease:** often a runner still starting.
- **Expired lease on actionable work:** the lease sweep recovers it. A merged or closed PR may instead be waiting on completion bookkeeping.

| State | Action |
|---|---|
| Cleanly paused | `bun ab resume my-build` |
| Open escalation | `bun ab answer my-build "guidance"`, or a retry resolution from `bun ab help answer` |
| Process recovery needed | You stop and drain the dispatcher cleanly, then restart it |

- A restart doesn't clear escalation gates.
- Terminal builds can't restart, and abort is irreversible.

See [answering blocked builds](operating.md#answer-and-pause). Preserve event logs; let the kernel manage leases and recovery.

## Hosted project selection

**Symptom.** A project is missing from connected tools or the dashboard, or hosted dispatch ignores it despite valid credentials.

**Cause.** Registration, allowed-user access, project credentials and dispatcher selection are separate gates.

- **Registration.** Check the active PostgreSQL project registry; build or ticket data doesn't register a project.
- **Access.** Super users see all active entries; members see only their organizations’ projects; verify sign-in separately from credentials.
- **Administration.** With deployment database credentials, an administrator runs `ab-hosted-store projects list`, `projects add` or `projects remove`. Mutations require `--user IDENTITY` for attribution; project tokens can't administer registrations.
- **Dispatcher selection.** `AB_DISPATCHER_REPOSITORIES` in the hosted dispatch environment selects projects: unset selects every active registration; an explicit ordered list is intersected with current registrations.
- **Dashboard fallback.** With no selection, the dashboard shows the first registered origin.

Registry errors fail closed.
