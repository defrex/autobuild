---
title: "Workspaces"
group: "reference"
description: "Provision local git worktrees or Vercel Sandboxes, handle private repositories, and implement a workspace provider."
label: "Workspaces"
order: 15
---

# Workspaces

## Responsibility

A workspace provider provisions an absolute, writable working copy on the requested branch, records the selected base, resumes work and releases resources. A remote provider can also supply execution and trusted publication.

- **Guests don't decide lifecycle transitions** or receive the host's publication authority.
- **The kernel owns pushes and forge operations;** agents commit locally.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Each example is a complete `autobuild.toml`; adapt its commands, provider and model to your repository.

### Git worktree (`git-worktree`)

The default, for builds on your own machine. It needs Git, a writable repository and scratch location, and your runtime and check tools on the host. No workspace credential is involved; forge and runtime credentials are separate.

<!-- seam-config:start -->
```toml
forge = "local-git"

[tickets]
source = "file"
readyState = "ready"

[commands]
setup = "bun install --frozen-lockfile"

[workspace]
provider = "git-worktree"
```
<!-- seam-config:end -->

Run `bun ab init`, install and authenticate your runtime, then run `bun ab init --validate`.

- **Isolation.** Each build has its own directory and branch, sharing the repository's Git object database. Files are isolated; the host's processes, network and credentials aren't.
- **No options.** It takes no `[workspace.config]`. System packages must already be on the host; Sandbox provisioning doesn't run here.
- **Resume.** Intact reprovision keeps the branch and uncommitted work. A lost working directory is rebuilt from surviving branch and publication evidence, never silently reset to a newer base.
- **Release** is idempotent and removes the working copy, not the forge's authoritative branch.

### Vercel Sandbox (`vercel-sandbox`)

Runs build-runners, agents and checks on independent remote machines. Install `@defrex/autobuild-vercel-sandbox`, register it in `plugins`, and commit your setup and configuration so remote clones can read them. It requires:

- an HTTPS hosted BuildStore
- an HTTPS `github.com/owner/repository` origin and `forge = "github"`
- a push-capable `GITHUB_TOKEN` or `GH_TOKEN` on the dispatcher; a local `gh` login isn't enough
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` on the dispatcher host

A short-lived `VERCEL_OIDC_TOKEN` from a linked project (`vercel link`, `vercel env pull`) works if it outlives the operation; a long-running dispatcher should use durable tokens. See [Vercel SDK authentication](https://vercel.com/docs/sandbox/sdk-reference).

<!-- seam-config:start -->
```toml
forge = "github"
plugins = ["@defrex/autobuild-vercel-sandbox"]

[store]
url = "https://builds.example.com"

[tickets]
source = "hosted"
teamKey = "ENG"

[commands]
setup = "bun install --frozen-lockfile"

[workspace]
provider = "vercel-sandbox"

[workspace.config]
image = "vercel/sandbox/universal:latest"
vcpus = 4
timeoutSeconds = 2700
environmentVariables = ["AI_GATEWAY_API_KEY"]
provisioning = [
  { name = "system-install", command = "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y jq" },
  { name = "system-preflight", command = "jq --version" },
]
gitUsernameEnv = "AB_GIT_READ_USER"
gitPasswordEnv = "AB_GIT_READ_TOKEN"

[workspace.config.runtimeProvisioning.pi]
install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"
preflight = "test \"$(pi --version)\" = \"0.84.4\" && pi update --models"

[roles.default]
runtime = "pi"
model = "vercel-ai-gateway/anthropic/claude-sonnet-4.6"
```
<!-- seam-config:end -->

Connect the project and supply the registered team key:

```sh
bun ab connect https://builds.example.com
```

Hosted tickets and the BuildStore share a service here but are independent selections. The Pi route needs `AI_GATEWAY_API_KEY` and an account that serves the model; the pinned version illustrates reproducible provisioning, not a recommendation.

Each sandbox prepares itself in this order:

1. checkout and pinned Bun verification
2. `provisioning` steps, in order, as root
3. dependencies
4. `runtimeProvisioning.<runtime>` installs
5. `commands.setup`

- **Runtimes.** Every selected primary and alternate runtime needs a pinned install and exact-version preflight. Local subscription logins aren't copied; runtime provisioning gets only the credentials named in `environmentVariables`.
- **Repetition.** Fresh and replacement sandboxes repeat provisioning, and preflights run again before each build-runner, so keep setup idempotent.
- **Validation.** `bun ab init --validate` tests a disposable environment, deletes it even on failure, and reports named provisioning, setup, runtime and Store checks. It starts no build or agent.
- **Lifetime.** `timeoutSeconds` bounds a sandbox; provider operations have their own timeouts. An intact sandbox resumes without losing work. An expired or lost one is rebuilt from durable workspace and publication evidence, but unpublished work that lived only on it is gone.

### Private repositories

The Sandbox example names a separate read-only clone identity. Set its values on the dispatcher host, outside TOML:

```sh
export AB_GIT_READ_USER='x-access-token'
export AB_GIT_READ_TOKEN='<read-only repository token>'
```

- Use a repository-scoped read token, separate from the push-capable forge identity. For a public clone, remove both `gitUsernameEnv` and `gitPasswordEnv`.
- Autobuild turns these into the authenticated Git source supported by [Vercel private-repository cloning](https://vercel.com/kb/guide/sandbox-private-github-repositories). Don't embed credentials in the origin URL.
- `environmentVariables` is only for runtime API credentials. Never forward `AB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, Vercel tokens or the clone token to an agent; Autobuild supplies scoped Store authority separately, keeps clone secrets out of guest commands, and publishes from the trusted host.

## Writing your own

Implement `WorkspaceProvider`, register its factory in `workspaceProviders`, and select it with `workspace.provider`. Import from `@defrex/autobuild/plugin-sdk`; [Writing a plugin](plugin-authoring.md) covers module loading, capabilities, packaging and publishing.

A provider must:

- return an absolute, writable path on the requested branch, with durable selected-base evidence
- preserve commits and uncommitted files on intact reprovision
- rematerialize a lost copy from surviving branch and publication evidence, not a fresh cut from a moving base
- release idempotently
- never overwrite unknown unpublished work to make a cache match an assumption

Test it with a `WorkspaceProviderContractFactory` returning a `WorkspaceProviderContractHarness`: provider, provision request, expected base, a real fixture file and cleanup. Run `describeWorkspaceProviderContract` unchanged, or expose the fixture in the plugin's contract descriptor:

```sh
bun ab plugin test workspace-provider acme
```

That suite certifies only the basic working copy. Remote execution adds trusted execution start/observe/stop, durable identity and recovery, readiness, credential delegation and publication readback; read the [shared remote capability requirements](plugin-authoring.md) before claiming it. Declare only capabilities you implement:

- Optional publication reports confirmed SHA and cache tips and supports the required guarded rewrites.
- Use the host's `delegateCredential` callback for per-resource Store grants; never serialize host tokens into execution identity.
