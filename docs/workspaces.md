---
title: "Workspaces"
group: "reference"
description: "Provision local git worktrees or Vercel Sandboxes, handle private repositories, and implement a workspace provider."
label: "Workspaces"
order: 15
---

# Workspaces

## Responsibility

A workspace provider provisions a writable working copy on the requested branch, records its base, resumes it and releases it; a remote provider can also supply execution and trusted publication. Agents commit locally. The kernel owns pushes, forge operations and lifecycle transitions; guests never get the host's publication authority.

## Shipped adapters

Install with `bun add -d --exact @defrex/autobuild`. Examples are complete `autobuild.toml` files; adapt commands, provider and model.

### Git worktree (`git-worktree`)

The default, for builds on your own machine. Needs Git, a writable repository and scratch location, and your runtime and check tools on the host. No workspace credential.

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

- **Isolation.** Each build gets its own directory and branch over the shared Git object database. Files are isolated; host processes, network and credentials aren't.
- **No options.** No `[workspace.config]` and no provisioning; system packages must already be on the host.
- **Resume.** Intact reprovision keeps uncommitted work; a lost directory is rebuilt from branch and publication evidence, never a newer base.
- **Release** is idempotent and removes the working copy, not the forge branch.

### Vercel Sandbox (`vercel-sandbox`)

Runs build-runners, agents and checks on remote machines. Install `@defrex/autobuild-vercel-sandbox`, register it in `plugins`, and commit your setup and configuration so remote clones see them. Requires:

- a remote store that speaks the remote BuildStore protocol over HTTPS
- an HTTPS `github.com/owner/repository` origin and `forge = "github"`
- a push-capable `GITHUB_TOKEN` or `GH_TOKEN` on the dispatcher (a `gh` login isn't enough)
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` on the dispatcher host

A short-lived `VERCEL_OIDC_TOKEN` (`vercel link`, `vercel env pull`) works only if it outlives the operation; long-running dispatchers need durable tokens. See [Vercel SDK authentication](https://vercel.com/docs/sandbox/sdk-reference).

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

Connect the project:

```sh
bun ab connect https://builds.example.com
```

Tickets and Store share a service here but are selected independently. The Pi route needs `AI_GATEWAY_API_KEY`; the pinned version illustrates reproducible provisioning, not a recommendation.

Sandbox preparation order:

1. checkout and pinned Bun verification
2. `provisioning` steps, in order, as root
3. dependencies
4. `runtimeProvisioning.<runtime>` installs
5. `commands.setup`

- **Runtimes.** Every primary and alternate runtime needs a pinned install and exact-version preflight, and gets only the credentials named in `environmentVariables`, except declared [accounts](configuration-overview.md#accounts), whose credentials remain on the host and are brokered by egress policy using guest placeholders.
- **Repetition.** New sandboxes repeat provisioning and preflights rerun before each build-runner; keep setup idempotent.
- **Validation.** `bun ab init --validate` runs named provisioning, setup, runtime and Store checks in a disposable environment, deletes it even on failure, and starts no build. For every declared account, including unused accounts, it runs a tool-free Claude Code model probe; these probes create no ordinary build phase or persistent agent session.
- **Lifetime.** `timeoutSeconds` bounds a sandbox; provider operations have their own timeouts. An intact sandbox resumes; an expired or lost one is rebuilt from durable workspace and publication evidence, losing unpublished work that lived only on it.

### Private repositories

The Sandbox example names a read-only clone identity. Set it on the dispatcher host, outside TOML:

```sh
export AB_GIT_READ_USER='x-access-token'
export AB_GIT_READ_TOKEN='<read-only repository token>'
```

- Use a repository-scoped read token, separate from the push identity. For a public clone, remove `gitUsernameEnv` and `gitPasswordEnv`.
- Autobuild passes these as the authenticated Git source for [Vercel private-repository cloning](https://vercel.com/kb/guide/sandbox-private-github-repositories); don't embed credentials in the origin URL.
- `environmentVariables` forwards legacy runtime API credentials; declared account credentials become placeholders even when listed here. Never forward `AB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, Vercel tokens or the clone token; Autobuild supplies scoped Store authority, keeps clone secrets out of guest commands, and publishes from the host.

## Writing your own

Implement `WorkspaceProvider`, register its factory in `workspaceProviders`, and select it with `workspace.provider`. Import from `@defrex/autobuild/plugin-sdk`; [Writing a plugin](plugin-authoring.md) covers loading, capabilities and publishing.

A provider must:

- return an absolute, writable path on the requested branch, with durable selected-base evidence
- preserve commits and uncommitted files on intact reprovision
- rematerialize a lost copy from surviving branch and publication evidence, not a moving base
- release idempotently
- never overwrite unknown unpublished work

Test with a `WorkspaceProviderContractFactory` returning a `WorkspaceProviderContractHarness` (provider, provision request, expected base, a real fixture file, cleanup). Run `describeWorkspaceProviderContract` unchanged, or expose the fixture in the plugin's contract descriptor:

```sh
bun ab plugin test workspace-provider acme
```

The suite certifies only the basic working copy. Remote execution adds trusted start/observe/stop, durable identity and recovery, readiness, credential delegation and publication readback; read the [shared remote capability requirements](plugin-authoring.md) first, and declare only what you implement:

- Publication reports confirmed SHA and cache tips and supports the required guarded rewrites.
- Store grants go through the host's `delegateCredential` callback; never serialize host tokens into execution identity.
