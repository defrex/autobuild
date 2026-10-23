---
title: "Forges"
group: "reference"
description: "Choose GitHub or local git and implement safe code publication and landing."
label: "Forges"
order: 9
---

# Forges

## Responsibility

The forge publishes code and represents pull requests. The kernel owns pushes, PR creation and state, comments, landing, and merge. Build agents commit locally; they never push or receive forge credentials. Publication succeeds only when authoritative branch-head readback equals the frozen intended SHA.

## Shipped adapters

### GitHub

GitHub is the default. This complete repository configuration selects it explicitly:

<!-- seam-config:start -->
```toml
forge = "github"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Supply authentication separately in the dispatcher's environment:

```sh
export GITHUB_TOKEN='<push-capable repository token>'
bun ab init --validate
```

Credential precedence is nonblank `GITHUB_TOKEN`, then `GH_TOKEN`, then the local `gh auth token` login. The last fallback is only available for checkout-mode local workspaces. Origin mode and Vercel Sandbox require an exported token. Keep kernel credentials out of guest-forwarded variables; private cloning uses a separate read-only identity.

The identity needs repository access, Contents:write for publication, and Pull requests:write for PR operations. Readiness inspection also needs Metadata:read and Administration:read (classic private-repository tokens use repo scope). Landing also depends on repository rules, required checks, merge settings, and the identity's permissions. Authentication alone does not promise permission to merge. Run the setup readiness checks (`bun ab init --validate`) before dispatch; branch protection can still defer a later landing.

### Local git

<!-- seam-config:start -->
```toml
forge = "local-git"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Local git needs an installed Git executable and writable repository, with no external forge credential. PR records and comments are JSON blobs under private `refs/autobuild/` refs in the shared git database; PR URLs refer to local branch refs. Publication confirms local branch identity rather than uploading to GitHub.

Landing uses a head-guarded squash commit and compare-and-swap ref updates. A checked-out destination must pass index/worktree safety checks; unsafe local changes defer landing. This adapter does not supply remote sandbox publication. Use GitHub for the supported remote arrangement.

## Writing your own

Follow [Writing a plugin](plugin-authoring.md) from a repository-local module through packaging. Register a `ForgePluginFactory` in `forges`, expose a `ForgeContractFactory`, and run `bun ab plugin test forge acme` against the unchanged shared harness before relying on dispatch:

<!-- seam-config:start -->
```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

Implement idempotent PR creation, exact-SHA confirmation, guarded landing, comments, and the adapter's advertised capabilities. Never infer publication from ancestry or a successful push response alone. Reconciliation requires the optional grouped `Forge.rewrite` capability: immutable exact-SHA archives, branch snapshots, and replacement guarded by the expected authoritative head. Report lease mismatches separately and preserve unknown work. Missing capabilities must fail safely with an actionable refusal, rather than falling back to an ordinary push.

API 1.8 exposes `ForgeFailure`: classify a rate limit with `{ kind: 'rate-limited', resetAt }` using a valid ISO reset timestamp, and retryable transport failures with `{ kind: 'transient', retry: 'retryable' }`. Ordinary policy or permission refusals remain deferrals. Optional `observeRequests` observers count each actual wire request, including failures and pagination, with build attribution when known; skipped calls and credential discovery are not requests. Omitted observers mean unavailable counts, not zero requests. Keep tokens out of failures and telemetry.

The shared plugin guide is the detailed capability contract.
