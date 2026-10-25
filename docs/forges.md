---
title: "Forges"
group: "reference"
description: "Choose GitHub or local git and implement safe code publication and merge."
label: "Forges"
order: 9
---

# Forges

## Responsibility

The forge publishes code and represents pull requests.

- **The kernel owns the forge.** Pushes, PRs, comments, merge and merge happen in deterministic code.
- **Agents only commit locally.** They never push or see forge credentials.
- **Publication is exact.** The branch head read back from the forge must equal the intended SHA.

## Shipped adapters

### GitHub

The default, selected explicitly in this complete configuration:

<!-- seam-config:start -->
```toml
forge = "github"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Export a token for the dispatcher:

```sh
export GITHUB_TOKEN='<push-capable repository token>'
bun ab init --validate
```

Credential precedence:

1. `GITHUB_TOKEN`, if nonblank
2. `GH_TOKEN`, if nonblank
3. local `gh auth token` login, checkout-mode local workspaces only

Origin mode and Vercel Sandbox need an exported token. Never forward kernel credentials to guests; private cloning uses a separate read-only identity.

| Permission | Used for |
|---|---|
| Contents: write | publishing branches |
| Pull requests: write | opening and updating PRs |
| Metadata, Administration: read | readiness checks |

A classic token on a private repository needs the `repo` scope instead. Validation doesn't guarantee a merge: branch protection, required checks, merge settings and permissions can still defer merge.

### Local git

<!-- seam-config:start -->
```toml
forge = "local-git"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Needs only Git and a writable repository.

- **Pull requests** are JSON records under private `refs/autobuild/` refs, linking to local branch refs.
- **Publication** confirms the local branch; nothing is uploaded.
- **Merge** makes a head-guarded squash commit with compare-and-swap ref updates, waiting while the checked-out destination has unsafe local changes.

It can't serve remote sandboxes; use GitHub there.

## Writing your own

[Writing a plugin](plugin-authoring.md) covers the module, packaging and capability contract. For a forge:

1. Register a `ForgePluginFactory` in `forges`.
2. Expose a `ForgeContractFactory`.
3. Run the shared harness unchanged before dispatching:

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
- exact-SHA publication confirmation, never inferred from ancestry or a push response
- guarded merge and comments
- every capability it advertises

Reconciliation needs the optional `Forge.rewrite` group: immutable exact-SHA archives, branch snapshots and head-guarded replacement. Report lease mismatches separately and preserve unknown work. Without it, reconciliation fails with an actionable refusal, never an ordinary push.

Classify failures with `ForgeFailure` (API 1.8):

```ts
{ kind: 'rate-limited', resetAt }            // resetAt: a valid ISO timestamp
{ kind: 'transient', retry: 'retryable' }    // retryable transport failures
```

Ordinary policy or permission refusals stay deferrals.

Optional `observeRequests` observers count every wire request, including failures and pagination, attributed to a build when known, excluding skipped calls and credential discovery; no observer means "unknown", not zero. Keep tokens out of failures and telemetry.
