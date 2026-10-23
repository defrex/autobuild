---
title: "Forges"
group: "reference"
description: "Choose GitHub or local git and implement safe code publication and landing."
label: "Forges"
order: 9
---

# Forges

## Responsibility

The forge publishes code and represents pull requests.

- **The kernel owns the forge.** Pushes, PR creation and state, comments, landing and merge all happen in deterministic code.
- **Agents only commit locally.** They never push and never see forge credentials.
- **Publication is exact.** It succeeds only when the branch head read back from the forge equals the SHA the kernel meant to publish.

## Shipped adapters

### GitHub

GitHub is the default; this complete configuration selects it explicitly:

<!-- seam-config:start -->
```toml
forge = "github"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Export a token in the dispatcher's environment:

```sh
export GITHUB_TOKEN='<push-capable repository token>'
bun ab init --validate
```

Autobuild uses the first credential it finds:

1. `GITHUB_TOKEN`, if nonblank
2. `GH_TOKEN`, if nonblank
3. your local `gh auth token` login, for checkout-mode local workspaces only

Origin mode and Vercel Sandbox need an exported token. Never forward kernel credentials to guests; private cloning uses a separate read-only identity.

| Permission | Used for |
|---|---|
| Contents: write | publishing branches |
| Pull requests: write | opening and updating PRs |
| Metadata: read, Administration: read | readiness checks |

A classic token on a private repository needs the `repo` scope instead.

Passing `bun ab init --validate` doesn't guarantee a merge: branch protection, required checks, merge settings and the identity's permissions can still defer a landing.

### Local git

<!-- seam-config:start -->
```toml
forge = "local-git"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Needs only Git and a writable repository; no forge service or credential.

- **Pull requests** are JSON records under private `refs/autobuild/` refs; PR URLs point at local branch refs.
- **Publication** confirms the local branch rather than uploading anywhere.
- **Landing** makes a head-guarded squash commit with compare-and-swap ref updates; it waits while the checked-out destination has unsafe local changes.

It can't serve remote sandboxes; use GitHub for remote builds.

## Writing your own

[Writing a plugin](plugin-authoring.md) covers the module, packaging and the detailed capability contract. For a forge:

1. Register a `ForgePluginFactory` in `forges`.
2. Expose a `ForgeContractFactory`.
3. Run the shared harness, unchanged, before relying on dispatch:

```sh
bun ab plugin test forge acme
```

Then select it:

<!-- seam-config:start -->
```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

An adapter must provide:

- idempotent PR creation
- exact-SHA publication confirmation, never inferred from ancestry or a successful push response
- guarded landing and comments
- every capability it advertises

Reconciliation needs the optional `Forge.rewrite` group: immutable exact-SHA archives, branch snapshots, and head-guarded replacement. Report lease mismatches separately and preserve unknown work. A missing capability fails with an actionable refusal, never an ordinary push.

Classify failures with `ForgeFailure` (API 1.8):

```ts
{ kind: 'rate-limited', resetAt }            // resetAt: a valid ISO timestamp
{ kind: 'transient', retry: 'retryable' }    // retryable transport failures
```

Ordinary policy or permission refusals stay deferrals.

Optional `observeRequests` observers count every wire request, failures and pagination included, attributed to a build when known. Skipped calls and credential discovery don't count; an omitted observer means "unknown", not zero. Keep tokens out of failures and telemetry.
