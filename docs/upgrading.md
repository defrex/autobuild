---
title: Upgrading
group: reference
order: 17
description: "Update the pinned installation, preserve customization, and resume durable work."
---

# Upgrading

Autobuild is an exact pinned development dependency. Pick the released version you intend, and review the manifest and lockfile together.

## Update the installation

First, stop the dispatcher cleanly and let its sessions drain or suspend. Your operator agent diagnoses the need; you manage the process.

To install an exact version, run from the project that owns the installation, replacing `VERSION`:

```sh
bun add -d --exact @defrex/autobuild@VERSION
bun ab upgrade --no-self-update
```

- **Self-update.** Plain `bun ab upgrade` updates a recognized installation on its distribution channel, then uses the new distribution to merge skills and apply supported migrations. An unsupported installation reports why it skipped.
- **`--no-self-update`** skips only the installation update.
- **Two scopes.** Package and lockfile changes belong to the project that owns the installation. Skill merges and config migrations apply to the target repository, which can differ.

Review and commit the version bump. Check what upgrade committed automatically before you commit again.

## Review configuration and skills

Upgrade keeps your `autobuild.toml`; supported migrations may amend it.

- **Explicit landing policy.** A valid policy stays byte-for-byte unchanged.
- **Absent landing policy.** Upgrade reads the target repository's journal: legacy ON becomes leaf auto; OFF or no fact becomes leaf consent; nodes get consent either way. If the journal is unavailable, restore access or configure policy deliberately, then retry.

Skills [merge three ways](skills.md#how-upgrades-preserve-customization) between live files, the pristine baseline and incoming defaults. Overlapping edits can get validated agent resolutions. Each successful file advances pristine to the incoming bytes; an unresolved conflict leaves that file's live and pristine copies unchanged while other files advance.

Read the [upgrade report](skills.md#how-upgrades-preserve-customization) and the diff even after exit zero: content conflicts alone don't fail the command. A conflict-free upgrade makes a narrowly scoped local commit. With `--no-commit`, conflicts or unsafe Git state, edits stay uncommitted with an explanation; resolve the reported files and commit the result.

## Restart and resume

Restart your normal dispatcher with the upgraded repository-installed CLI:

```sh
bun ab dispatch
```

- **One writer.** Don't run old and new dispatchers at the same time.
- **Durable resume.** Work resumes from durable state after a clean stop. Restart doesn't answer escalations; your operator agent checks attention separately.
- **Old behavior.** Drain old work before switching if it must keep the old execution behavior. No claim-version switch preserves it.
- **Hosted services.** Upgrade the hosted service before its connected projects, within its compatibility window.

Read [Infrastructure seams](seams.md) and [Repository configuration](configuration-overview.md) before changing infrastructure or landing policy.
