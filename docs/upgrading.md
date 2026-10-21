---
title: Upgrading
group: reference
order: 10
description: "Update the pinned installation, preserve customization, and resume durable work."
---

# Upgrading

Autobuild is an exact pinned development dependency. Choose the intended released version and review the manifest and lockfile together.

## Update the installation

You stop the existing dispatcher cleanly and wait for its sessions to drain or suspend before updating its running installation. Your operator agent diagnoses the need and asks you to manage the process.

For an explicitly chosen version, run from the owning project. Replace `VERSION` with the exact released version you intend to install:

```sh
bun add -d --exact @defrex/autobuild@VERSION
bun ab upgrade --no-self-update
```

Alternatively, normal `bun ab upgrade` updates a recognized installation on its distribution channel, then continues with the updated distribution to merge skills and apply supported migrations. Unsupported installations report why self-update was skipped; inspect that output. `--no-self-update` skips only the installation update.

Package and lockfile changes belong to the project owning the installation. Skill merging and config migration apply to the target repository, which can differ. Review and commit the intended version bump; inspect what upgrade committed automatically before making another commit.

## Review configuration and skills

Upgrade preserves existing configuration rather than replacing `autobuild.toml` wholesale. Supported migrations can amend it. Explicit valid landing policy stays byte-for-byte unchanged. When policy is absent, upgrade reads the target repository's configured journal: legacy ON becomes leaf auto, OFF or no fact becomes leaf consent, and nodes use consent in either case. An unavailable journal requires restoring access or deliberately configuring policy before retrying. Read the [1.0 migration notes](migration-1.0.md) for all rules.

Skills compare live files, the pristine upstream baseline, and incoming defaults. Independent changes merge; overlapping edits can receive validated agent resolutions. Successful files advance pristine to incoming bytes. Unresolved conflicts leave affected live and pristine files unchanged while other files can advance. See [how upgrades preserve customization](skills.md#how-upgrades-preserve-customization).

Inspect the [upgrade report](skills.md#how-upgrades-preserve-customization) and diff even after exit zero: content conflicts alone do not fail the command. A conflict-free upgrade makes a narrowly scoped local commit by default. `--no-commit`, conflicts, or unsafe Git conditions leave edits uncommitted with an explanation. Resolve reported files deliberately and commit the reviewed result.

## Restart and resume

Restart your normal dispatcher with the upgraded repository-installed CLI (`bun ab dispatch`). Avoid simultaneous old and new writers. Durable state resumes work after a clean stop; restart does not answer escalations. Your operator agent should inspect attention separately.

Drain old work before switching versions if it must retain old execution behavior; there is no claim-version switch preserving all old behavior. Upgrade a hosted service before connected projects within its compatibility window. Consult the [migration notes](migration-1.0.md), [setup reference](setup.md), and [configuration reference](configuration.md) before changing infrastructure or landing policy.
