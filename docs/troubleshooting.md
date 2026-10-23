---
title: Troubleshooting
group: reference
order: 18
description: "Diagnose configuration, idle dispatch, authentication, stalled builds, and project selection."
---

# Troubleshooting

Start from the symptom and the recorded state. Your operator agent inspects the CLI and suggests fixes; you manage dispatcher processes and credentials.

## Invalid configuration

**Symptom.** Startup reports a TOML syntax error, invalid config with field paths, or a runtime-routing error naming a role.

**Cause.** Malformed TOML, misplaced fields, inconsistent step definitions, or runtime and model settings inherited from `roles.default`.

**Fix**, in order:

1. Repair TOML syntax.
2. Fix every schema path the error names in `autobuild.toml`.
3. Check that each listed step has a matching subtable and that its command names exist.
4. Inspect the merged default and child roles. Each setting inherits independently.
5. Pick a supported model with `bun ab models` or the plugin's documentation.

```sh
bun ab models --available
bun ab init --validate
```

`bun ab dispatch --once` runs real work. Use it only when you intend a real tick.

## tick: idle with expected work

**Symptom.** Plain dispatch prints `tick: idle` while you expect a ticket or harvest to start.

**Cause.** An admission or workflow gate is still closed, so the pass took no action.

**Fix.** Inspect state, then check each gate:

```sh
bun ab repository status
bun ab builds --queued
bun ab harvest status
```

- **Intake and pause.** Intake is on and the repository isn't paused. Resume a deliberately paused repository only when work should proceed.
- **Ready state.** The ticket is in the exact ready state with every required label.
- **Blockers and destination.** Blockers are done, the target node is open, and required changes are present in the destination.
- **Claims.** Already-claimed tickets aren't reclaimed.
- **Capacity.** Compare actual occupancy with capacity. Paused or blocked work keeps its slot; idle collecting nodes take none. Node verification and reconciliation account specially for slots held by descendants.
- **Harvest.** Check the acknowledged harvest gate and unclaimed observations. Harvest triggers at `policy.harvestThreshold` observations, or at `policy.harvestMaxDrift` other merged builds since the oldest observation (zero disables drift). Harvest uses no build slot.

## Authentication failures

**Symptom.** Ticket requests, forge operations, agent launches or hosted reads report missing or rejected credentials.

**Cause.** Each service has its own credential and scope.

**Fix.** By component:

| Component | Check |
|---|---|
| Linear | `LINEAR_API_KEY`, the configured team and workflow states, in the actual process environment or supported `.env` file |
| GitHub | `gh auth status` and repository permissions; test Git remote fetch and push separately |
| Agent providers | The runtime of the effective role. Run `codex login` when the Codex diagnostic asks; for Pi, check provider login and the provider-qualified model |
| Hosted store | `bun ab connect` for service, project and credential status |

- **Provider refusals.** Permission, billing and quota failures need fixing on the provider side.
- **Hosted credentials.** Reconnect on the affected host and user when saved credentials are missing or rejected. `AB_STORE` and `AB_TOKEN` override the saved store URL and credential, so check them too. Build and session grants have narrower authority.

[Build store](build-store.md#shipped-adapters) covers saved credentials and store-selection precedence. Keep secrets out of diagnostic reports.

## Stuck or wedged builds

**Symptom.** A build stops advancing, often after an interruption.

**Cause.** It may be escalated, paused, waiting on landing gates, starting a runner, or recovering an expired lease. A quiet log alone doesn't mean a crash.

**Fix.** Inspect the build, then read status, progress and lease health separately:

```sh
bun ab build status my-build
bun ab builds --queued
```

- **Held lease.** Something owns the build live.
- **Old progress.** Nothing recent was recorded.
- **Absent lease.** Often a runner still starting.
- **Expired lease on actionable work.** The lease sweep recovers it. A merged or closed PR may instead be waiting on completion bookkeeping.

Then act:

| State | Action |
|---|---|
| Cleanly paused | `bun ab resume my-build` |
| Open escalation | `bun ab answer my-build "guidance"`, or a retry resolution from `bun ab help answer` |
| Process recovery needed | You stop and drain the dispatcher cleanly, then restart it |

- A restart doesn't clear escalation gates.
- Terminal builds can't restart, and abort is irreversible.
- Your operator agent diagnoses and asks you to manage the dispatcher process.

See [answering blocked builds](operating.md#answer-and-pause). Preserve event logs; let the kernel manage leases and recovery.

## Hosted project selection

**Symptom.** A project is missing from connected tools or the dashboard, or hosted dispatch ignores it despite valid credentials.

**Cause.** Registration, allowed-user access, project credentials and dispatcher selection are separate gates.

**Fix.** Check each gate:

- **Registration.** Check the active PostgreSQL project registry. Existing build or ticket data doesn't register a project.
- **Access.** Every allowlisted user sees all active entries. Verify sign-in access separately from credentials.
- **Administration.** With deployment database credentials, an administrator runs `ab-hosted-store projects list`, `projects add` or `projects remove`. Mutations require `--user IDENTITY` for attribution; project tokens can't administer registrations.
- **Dispatcher selection.** `AB_DISPATCHER_REPOSITORIES` in the hosted dispatch environment selects projects. Unset, it selects every active registration; an explicit ordered list is intersected with current registrations.
- **Dashboard fallback.** With no selection, the dashboard shows the first registered origin.

Registry errors fail closed.
