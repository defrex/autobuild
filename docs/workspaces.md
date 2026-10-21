---
title: "Workspaces"
group: "reference"
description: "Provision local git worktrees or Vercel Sandboxes, handle private repositories, and implement a workspace provider."
label: "Workspaces"
order: 15
---

# Workspaces

## Responsibility

A workspace provider provisions an absolute writable working copy on the requested branch, records the selected base, resumes work and releases resources. A remote provider can additionally supply execution and trusted publication capabilities. Guests do not decide lifecycle transitions or receive the host's publication authority. The kernel owns pushes and forge operations; agents commit locally.

## Shipped adapters

Install Autobuild with `bun add -d --exact @defrex/autobuild`. Config examples below are complete `autobuild.toml` files; adapt commands and provider/model choices to your repository before use.

### Git worktree (`git-worktree`)

Choose the default for builds on your own machine. It requires Git, a writable repository and scratch location, and the selected runtime/check tools on the host. No workspace-service credential is needed. Forge and runtime credentials are separate responsibilities.

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

Run `bun ab init`, install/authenticate your chosen runtime, and run `bun ab init --validate`. Use your actual dependency setup command. Each build has its own working directory and branch while sharing Git's object database with the source repository. This isolates files, not the host's processes, network or credentials. The provider takes no custom `[workspace.config]` options. System packages must already exist on the host; Sandbox provisioning commands do not run here.

Intact reprovision preserves the branch and uncommitted work. A lost working directory can be reconstructed from surviving branch/publication evidence; resumption must not silently reset the branch to a newer base. Release is idempotent and removes the working copy, not the forge's authoritative branch.

### Vercel Sandbox (`vercel-sandbox`)

Choose Sandbox when build runners, agents and checks should execute on independent remote machines. Install `@defrex/autobuild-vercel-sandbox` in the consuming project and register it in `plugins`. Commit your setup/configuration so remote clones can read it. This arrangement requires an HTTPS hosted BuildStore, an HTTPS `github.com/owner/repository` origin, `forge = "github"`, and dispatcher-side push-capable `GITHUB_TOKEN` or `GH_TOKEN`. A local gh login alone is insufficient for Sandbox publication.

Supply `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` on the dispatcher host. Alternatively use short-lived `VERCEL_OIDC_TOKEN` from a linked project (`vercel link`, `vercel env pull`); its lifetime must cover the operation, so durable token credentials suit a continuously running local dispatcher. See [Vercel SDK authentication](https://vercel.com/docs/sandbox/sdk-reference) and [repository setup](setup.md) for credential and readiness details.

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

Connect the project with `bun ab connect https://builds.example.com` and supply the registered team key. Hosted tickets and the BuildStore happen to share a service here; they remain independent selections. Export `AI_GATEWAY_API_KEY` for this illustrative Pi route and validate its model/account availability. The pinned runtime installation illustrates reproducible provisioning, not a recommendation to keep that version forever.

Ordered `provisioning` steps run as root after checkout and pinned Bun verification, before dependencies, runtime provisioning and `commands.setup`. Every selected primary and alternate runtime needs its own pinned `runtimeProvisioning.<runtime>` install and exact-version preflight. A local subscription login is not copied. Runtime provisioning receives only the credentials named in `environmentVariables`. Fresh and replacement sandboxes repeat provisioning; preflights run again before each build runner. Keep checkout setup idempotent.

Run `bun ab init --validate` before dispatch. It tests a disposable environment and deletes it even after failure, reports named provisioning/setup/runtime/Store checks, and starts no build or agent. Sandbox lifetime is bounded by `timeoutSeconds`; provider operations also have bounded timeouts. An intact environment resumes without discarding work. If it expires or is lost, recovery rematerializes from durable workspace/publication evidence; unpublished work that existed only on a destroyed machine cannot be recovered by a model. See [setup and recovery](setup.md) for readiness failures and lifecycle details.

### Private repositories

The Sandbox example names a separate read-only clone identity. Set its values outside TOML, on the dispatcher host:

```sh
export AB_GIT_READ_USER='x-access-token'
export AB_GIT_READ_TOKEN='<read-only repository token>'
```

Use a repository-scoped token with read access for cloning; keep the push-capable forge identity separate. Remove both `gitUsernameEnv` and `gitPasswordEnv` for a public clone. Autobuild resolves these environment names into the authenticated Git source supported by [Vercel private-repository cloning](https://vercel.com/kb/guide/sandbox-private-github-repositories); do not embed credentials in the origin URL.

Never put host Store, forge, Vercel or private-clone secrets in `environmentVariables`: that list is for runtime API credentials. Autobuild supplies scoped Store authority separately, keeps clone secrets out of guest commands, and publishes from the trusted host. Do not forward `AB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, Vercel tokens or the clone token to an agent.

## Writing your own

Implement `WorkspaceProvider`, register its factory in `workspaceProviders`, and select the registered name with `workspace.provider`. Import from `@defrex/autobuild/plugin-sdk`; follow [Writing a plugin](plugin-authoring.md) for module loading, capabilities, packaging and publishing.

Return an absolute writable requested-branch path and durable selected-base evidence. Intact reprovision must preserve commits and uncommitted files; lost-copy rematerialization must use surviving branch/publication evidence rather than cutting anew from a moving base. Make release idempotent. Never overwrite unknown unpublished work to make a cache match an assumption.

Provide a `WorkspaceProviderContractFactory` returning a `WorkspaceProviderContractHarness` with provider, provision request, expected base, a real fixture file and cleanup. Run `describeWorkspaceProviderContract` unchanged, or expose the fixture in the plugin's contract descriptor:

```sh
bun ab plugin test workspace-provider acme
```

That suite certifies the basic working-copy contract. Remote execution adds obligations: trusted execution start/observe/stop, durable identity and recovery, readiness, credential delegation and publication readback. Declare only capabilities you implement. Optional publication must report confirmed SHA/cache tips and support required guarded rewrites; use the host's `delegateCredential` callback for per-resource Store grants, never serialize host tokens into execution identity. See the [shared remote capability requirements](plugin-authoring.md) before claiming remote-execution support.
