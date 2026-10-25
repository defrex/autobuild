---
title: Upgrading
group: reference
order: 17
description: "Update the pinned installation, preserve customization, and resume durable work."
---

# Upgrading

Autobuild is an exact pinned development dependency. Pin the release you intend and review manifest and lockfile together.

Build sessions now hydrate inputs under `.ab/<phase>/` (or `.ab/verify-<step>/`
and `.ab/finalize-<step>/`). Repository-authored skills must replace hardcoded
hydrated `.ab/<file>` paths with `$AB_CONTEXT_DIR/<file>`. Custom output scratch
may still live elsewhere under `.ab/`.

## Update the installation

Stop the dispatcher cleanly first and let its sessions drain or suspend. Your operator agent diagnoses the need; you manage the process.

From the project that owns the installation, replacing `VERSION`:

```sh
bun add -d --exact @defrex/autobuild@VERSION
bun ab upgrade --no-self-update
```

- **Self-update.** Plain `bun ab upgrade` updates a recognized installation on its distribution channel, then merges skills and applies supported migrations with the new distribution. An unsupported installation reports why it skipped. `--no-self-update` skips only the installation update.
- **Two scopes.** Package and lockfile changes belong to the project that owns the installation; skill merges and config migrations apply to the target repository, which can differ.

Check what upgrade committed, then review and commit the version bump.

## Review configuration and skills

Upgrade keeps your `autobuild.toml`; supported migrations may amend it.

- **Explicit merge policy:** a valid `merge` array stays byte-for-byte unchanged. A deprecated `landing` array is renamed to `merge`, preserving rule values, order and comments without reading the legacy journal. Declaring both keys is an error.
- **Absent merge policy:** upgrade reads the target repository's journal. Legacy ON becomes leaf auto; OFF or no fact becomes leaf consent; nodes get consent either way. If the journal is unavailable, restore access or configure policy deliberately, then retry.

Skills [merge three ways](skills.md#how-upgrades-preserve-customization), with validated agent resolutions for overlapping edits. An unresolved conflict leaves that file untouched while others advance. Read the [upgrade report](skills.md#how-upgrades-preserve-customization) and diff even after exit zero: content conflicts don't fail the command. A conflict-free upgrade makes a narrowly scoped local commit. With `--no-commit`, conflicts or unsafe Git state, edits stay uncommitted with an explanation; resolve the reported files and commit.

## Restart and resume

Restart with the upgraded repository-installed CLI:

```sh
bun ab dispatch
```

- **One writer.** Don't run old and new dispatchers at once.
- **Durable resume.** Work resumes from durable state after a clean stop. Restart doesn't answer escalations.
- **Old behavior.** Drain old work before switching if it must keep the old execution behavior; no claim-version switch preserves it.
- **Hosted services.** Upgrade the hosted service before its connected projects, within its compatibility window.

Read [Infrastructure seams](seams.md) and [Repository configuration](configuration-overview.md) before changing infrastructure or merge policy.
