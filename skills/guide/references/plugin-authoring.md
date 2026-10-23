---
title: "Writing a plugin"
group: "guides"
description: "Build, contract-test, package, and publish an Autobuild infrastructure adapter."
label: "Plugins"
order: 7
---

# Writing a plugin

A plugin is a trusted Bun module, loaded in-process from the consuming repository, that connects Autobuild to another ticket tracker, agent runtime, workspace system or forge.

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`. Here, `ab <command>` means that repository-installed CLI, run as `bun ab <command>` (for example `bun ab init`).

**Definition of done for an adapter: the unchanged shared contract suite for its port passes.** Interface conformance or a clean `ab plugin doctor` alone is not certification.

## 1. Choose the port and preserve its semantics

Import public types only from `@defrex/autobuild/plugin-sdk`; package-internal module paths are not API.

| Port | Manifest map | Factory returns | Selected by |
|---|---|---|---|
| `ticket-source` | `ticketSources` | `TicketSource` | `[tickets].source` |
| `agent-runtime` | `agentRuntimes` | `RuntimeRegistration` | `[roles.*].runtime` |
| `workspace-provider` | `workspaceProviders` | `WorkspaceProvider` | `[workspace].provider` |
| `forge` | `forges` | `Forge` | root `forge` key |

All four manifest maps have production selectors. Omitted forge and workspace selectors keep the builtin `github` and `git-worktree` defaults; roles keep their normal runtime inheritance.

`BuildStore` and `BlobStore` contract types are exported for remote-server authors, but BuildStore is **not** an in-process manifest map: implement the language-neutral remote store protocol and run its conformance path instead. `TelemetrySource` is a frozen port type with no plugin registration surface in this release.

### `ticket-source`

Starts builds by listing, getting and claiming tickets, and receives comments, transitions, creates and updates. It owns:

- lifecycle names and dependency completion
- idempotent creation and a stable external creation-key projection
- partial-list diagnostics

It is never consulted mid-build and is not artifact storage.

### `agent-runtime`

Wrap an `AgentRunner` that supports:

- start, continue and end, with complete transcripts and usage
- per-turn environment refresh and cancellation; a cancelled turn keeps an endable handle for transcript deposition
- typed failures with verbatim messages, the retry-compatible `permanent` bit, and optional `cause: availability | exhaustion | credentials | configuration` routing evidence
- the distribution-managed `ab` launcher

Declare served model prefixes and a default. Optional tool-free `oneShot` is a capability beside the runner interface.

### `workspace-provider`

- Provision an absolute, writable working copy for the requested branch and return durable base evidence.
- Resume an intact branch non-destructively. Never silently re-cut resumed work from a newer base.
- Rematerialize a lost copy, and make release idempotent.
- Optional `provision.publication` supplies a durable confirmed SHA and known cache tips for authoritative readback and cache repair. Preserve unknown unpublished work.

### `forge`

- Implement kernel-owned regular pushes, idempotent PR opening, PR-state projection, gated and ungated auto-merge, head-guarded squash merge, and comments.
- Agents never receive forge credentials or push.
- API 1.2 adds optional idempotent `closePr` and `deleteBranch` for abort cleanup. `closePr` must preserve a racing merge. Without them, abort cleanup stays visibly pending.
- `prAttachments` is an optional image-hosting capability; without it, the text-only path must keep working.

### Reconcile rewrites

Reconcile requires the optional grouped `Forge.rewrite` capability:

1. Snapshot the actual build branch into a build-private ref.
2. Publish immutable exact-SHA refs under `refs/autobuild/archive/<slug>/<sha>`.
3. Replace the explicit branch, leased on an explicit expected remote head.

- Return `lease-mismatch` separately from transport, auth and policy failures.
- If the CAS succeeds but another writer advances the branch before readback, return `lease-mismatch` with `rewritten: true` and the observed `actual` head. The kernel records that write and retries the observed history without claiming completion.
- After an acknowledged replacement, reattach the matching detached workspace HEAD to the build branch so later implementation publication still works.
- Never overwrite unknown work or silently fall back to merging, ordinary pushes, archive branches or tags.
- Older forge plugins still load and get an actionable refusal at reconcile time.
- Remote workspace providers also need trusted `WorkspacePublication.rewrite` after guest execution teardown; ordinary `publish` cannot publish a restack.

### Publication readback

A publication succeeds only when an authoritative branch-head readback equals its frozen intended SHA, including recovery after a failed push. Unconfirmed candidate ancestry never proves publication.

- Ordinary `pushBranch(workspacePath, branch, sha?)` receives the frozen SHA from kernel callers and stays fast-forward only. Legacy callers may omit the SHA to select HEAD.
- Implement `confirmPublication` to inspect the authoritative head and refresh caches only on an exact SHA match. Kernel callers refuse adapters without it before attempting a push.
- Remote-backed local refs are caches: set them unconditionally after confirmation, fetching the advertised ref if objects are missing, without resetting checkout files. `localExpected` is historical input only.
- Local-git's shared ref database stays authoritative and keeps CAS.
- Hosted `WorkspacePublication` must provide authoritative `isPublished`, and confirm after writing as well as before retrying.
- Remote inspection must not resume a stopped guest or run commands in it. Refresh the guest cache inside trusted publication before stopping it. Missing inspection fails actionably.

### Forge failures and request accounting

Plugin API 1.8 adds optional forge failure classification. Import the runtime `ForgeFailure` constructor and `isForgeFailure`, plus the types `ForgeFailureDetails`, `ForgeRequestObserver` and `ForgeRequestContext`, from `@defrex/autobuild/plugin-sdk`.

```ts
// Rate limit, with a valid ISO reset timestamp:
throw new ForgeFailure(message, { kind: 'rate-limited', resetAt })
// Retryable transport error:
throw new ForgeFailure(message, { kind: 'transient', retry: 'retryable' })
```

- Ordinary policy and permission refusals remain deferrals; don't classify them.
- Never include credentials.
- The `forgeFailure: 'autobuild.forge-failure.v1'` discriminant and validated details work across separately loaded SDK copies.
- Arbitrary legacy errors are not classified automatically.

Optionally implement `Forge.observeRequests(observer): () => void`. Return a disposer, and call registered observers once per wire request, including failed requests and pagination.

- Pass `ForgeRequestContext` with the build slug when known, or `{}` when unknown. Capture attribution before awaiting transport; notify after the outcome is known.
- The host fills missing build attribution from its current build-scoped operation; otherwise the request is repository/unattributed.
- Credential discovery and skipped calls are not provider requests.

Optional `outcome` values:

| `outcome` | Request |
|---|---|
| `restPrimary` | REST HTTP response other than 304 |
| `restNotModified` | REST 304 |
| `graphql` | GraphQL call, including failures |
| omitted | network failure (no proven REST debit) |

```ts
observeRequests(observer: ForgeRequestObserver) {
  this.observers.add(observer)
  return () => { this.observers.delete(observer) }
}
// Capture context before awaiting the transport. After response/failure:
for (const observer of this.observers) {
  observer({ build: context.build, ...(outcome ? { outcome } : {}) })
}
```

Declare `apiVersion: '^1.8.0'` when using these capabilities. Compatible legacy 1.x plugins still load without observers and show unavailable counts.

### Read scopes

These forge optimizations don't change the plugin API version requirement:

- **`withReadScope(work)`** wraps a complete dispatcher tick, sharing promises and observations across builds, and tears down on rejection too. Keep concurrent operations outside the scope independent.
- **`primeNodeReads({workspacePath, parent, head, prNumber?})`** seeds opened-node facts. Non-cooldown failures produce a diagnostic and fall through to ordinary stage reads, preserving parent recovery when the previous parent disappeared.

Invalidate observations before writes, including uncertain writes and Git pushes. Acknowledgement and readiness reads must stay fresh. Branch and ref endpoints share normalized facts, never HTTP validators.

### API versions

A plugin that relies on a capability declares an `apiVersion` range containing its version (for example `^1.5.0`). Legacy plugins without the newer fields keep working.

- **1.2.** Forge `closePr` and `deleteBranch`, above.
- **1.3.** `AgentRunner` failure `cause` and the `exhaustion-failure` contract scenario. Without `cause`, `permanent: false` is eligible for a configured alternate and `permanent: true` stops the chain.
- **1.4.** Optional `Ticket.creationKey`: project the stable external create/adoption key from `create`, `get` and `listReady`. Autobuild uses it to correlate ready tickets with durable Harvest reservations while blocker recording is unfinished. Legacy tickets may omit it and dispatch normally.
- **1.5.** `path` is the path in the workspace environment; set optional `localPath` only when the dispatcher can reach that same working copy directly. Workspace-owned executors receive the durable provider locator as `BuildExecutionStart.workspaceRef`; local PID supervision stays host-owned.
- **1.7.** Workspace factory seams, in section 2.
- **1.8.** Forge failure classification and request observers, above.

## 2. Create a repository-local module

Start in the consuming repository:

```text
my-repository/
├── autobuild.toml
└── autobuild-plugin.ts
```

Use erased (`import type`) imports in production adapter code whenever the SDK symbols are only types:

```ts
import type {
  AutobuildPluginManifest,
  ForgePluginFactory,
} from '@defrex/autobuild/plugin-sdk'
import { AcmeForge } from '@acme/forge-client'

const createForge: ForgePluginFactory = ({ config, env, repoRoot }) => {
  const token = env.ACME_FORGE_TOKEN
  if (!token) throw new Error('ACME_FORGE_TOKEN is required')
  return new AcmeForge({ token, config, repoRoot })
}

export default {
  name: 'acme-forge',
  apiVersion: '^1.2.0',
  forges: { acme: createForge },
} satisfies AutobuildPluginManifest
```

### The manifest

Every module default-exports one strict `AutobuildPluginManifest`:

- **`name`** is a nonblank diagnostic and ownership identity. It need not equal the npm package name.
- **`apiVersion`** is a semver **range accepted by the plugin**, not the plugin's package version. Choose the narrowest range containing the host plugin API you ran contracts against. `ab plugin list` reports the declared range and host version; invalid or incompatible ranges fail loading.
- **Registration keys** are only `ticketSources`, `agentRuntimes`, `workspaceProviders` and `forges`. Unknown manifest fields fail validation.
- **Adapter names** are yours. Every declared name registers verbatim, including one like `__proto__`: declare that one computed, `{ ['__proto__']: factory }`, because a plain `__proto__:` key sets the prototype instead. Parsed maps have a null prototype, so an undeclared name reads as `undefined`. Blank or whitespace-only names are rejected, since configuration selects adapters by name.
- **Registrations** are a bare adapter factory, or `{ factory, contract: { factory, live? } }`. The first factory returns the adapter; the contract factory returns that port suite's fixture factory. Ticket-source descriptors may also declare a deduplicated `requiredEnv` list; the host rejects missing or empty credentials before invoking that selected factory.

### Factory context

Every adapter and contract factory receives `{ config, env, repoRoot }`: adapter-specific read-only `config`, the process `env`, and `repoRoot`, the absolute consuming-repository root.

| Port | `config` |
|---|---|
| ticket-source | the existing strict `[tickets]` fields; there is no untyped plugin-options table |
| workspace-provider | the open `[workspace.config]` table, the only place for adapter-owned settings |
| agent-runtime, forge | currently an empty object |

Workspace-provider factories also receive host-derived seams (API 1.7). Each is optional and absent when the host call site has no such value; a factory that ignores them changes nothing.

- **`storeRef`, `delegateCredential`.** A store URL and credential-exchange callback, guaranteed present when the registration declares `capabilities.storeRequirements`.
- **`runtimeReferences`.** The host's effective runtime routes; absent at call sites that reference no runtimes.
- **`origin`, `remoteBranchHead`.** Checkout-less readers; when absent, fall back to host `git` from `repoRoot`.

Remote workspace factories must call `delegateCredential(storeRef, undefined, target)` for per-resource grants before provisioning or launching guests. The callback keeps parent authority in host composition.

- `storeToken` is retired and never supplied; factory environments also exclude `AB_TOKEN`.
- Launch credentials travel through the separate transient execution-auth argument, never through serialized execution identity.
- Plugins that forwarded `storeToken` must migrate to this callback and fail closed if it is unavailable.

### Configure and resolve

Add the module specifier at the TOML root, before any table, and select the adapters the repository uses:

```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```

- Repository-path specifiers resolve from the config-bearing root, which is the immutable build worktree in scoped phases.
- npm package specifiers resolve from the consuming main checkout's installed dependencies first, then from the Autobuild installation the CLI runs from as a fallback.
- Install extensions in the consuming repository with `bun add -d --exact @defrex/autobuild-<extension>`; a repository copy wins over an installed one, and missing packages fail and are never installed automatically.
- Each specifier string must be unique. An exact repeat fails config validation before Bun resolves or evaluates any plugin, naming the repeated value and both list positions so the operator can remove or deduplicate it. Distinct specifiers stay separate declarations.

### Loading rules

- Modules load in declaration order. Registration is atomic per manifest.
- Resolution or evaluation failure, a missing or malformed default export, an incompatible API range, or a collision fails before any claims or builds.
- Builtin and earlier-plugin names can't be shadowed within one port. A collision between distinct plugins names the adapter and both owners. The same adapter name may exist on different ports.
- Plugins are trusted like configured shell commands: Bun evaluates them in-process with repository authority and no sandbox.

### Cached dispatcher generations

Inside a cached dispatcher generation, selection uses the same roots, but selected external plugin code and its installed dependency closure are copied into an immutable auxiliary snapshot.

- Native ESM, CommonJS `require`, delayed imports, export-from and module-anchored `createRequire` all resolve the core package to the same canonical frozen runtime, including SDK values and classes. There are no loader hooks or source transforms.
- Repo-path modules copy their literal import closure and literal `new URL(..., import.meta.url)` assets, not the checkout or its unused dev dependencies. Plugins with their own package boundary keep that package's assets and dependency graph.
- Package-relative assets stay beside copied modules. `import.meta.url` and filenames name the snapshot, while cwd and factory `repoRoot` remain the consuming checkout. Explicit absolute paths remain plugin-controlled external resources.
- Snapshots use neutral compiler boundaries, and cached Bun entrypoints pin the core config with `--no-install --tsconfig-override` before JavaScript runs. Autobuild-owned compiler chains can't escape the runtime; installed third-party development configs are preserved byte-for-byte.
- New selections can prepare new snapshots without changing the generation's core identity. Live plugin processes keep their core runtime independently of Store leases.
- Plugin-loading CLI calls reclaim dead auxiliary snapshots during the generation, so edits between phase commands don't accumulate checkout-sized copies.

Ordinary noncached consumers follow the separately loaded SDK compatibility rules in section 1.

## 3. Keep secrets out of source and config

- Never put credentials in `autobuild.toml`, the manifest, committed fixtures or contract output.
- Read them from the factory's `env` (for example `env.ACME_FORGE_TOKEN`) and document the required environment variables. Keep local values in ignored environment files or the process secret manager.
- Validate missing credentials when the selected adapter or live fixture is created, not at module top level, so registration stays lazy and diagnostics can inspect unrelated adapters.
- Ticket-source descriptors should declare `requiredEnv` so the host enforces credential names before invoking the factory. Other ports validate their environment in their factories.

## 4. Add the contract harness first

A contract-bearing registration looks like this:

```ts
const manifest = {
  name: 'acme',
  apiVersion: '^1.2.0',
  ticketSources: {
    acme: {
      factory: createAcmeTicketSource,
      contract: { factory: createAcmeTicketContract },
    },
  },
} satisfies AutobuildPluginManifest
```

The descriptor's factory returns a `TicketSourceContractFactory`, `AgentRunnerContractFactory`, `WorkspaceProviderContractFactory` or `ForgeContractFactory`, using the matching harness types from `@defrex/autobuild/plugin-sdk`. The host runs the unchanged shared suite; don't copy, wrap, skip or weaken its assertions.

Contract fixtures must:

- isolate resources (UUID-namespaced records, branches, PRs, sessions or workspaces)
- expose the independent controls and probes their harness type requires
- clean up in `cleanup`, even after an assertion failure
- make retries and release idempotent where the port requires it

A fixture that contacts a provider or mutates external resources must declare `contract: { factory, live: true }`. Autobuild refuses to launch it unless the operator opts in explicitly:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 ab plugin test forge acme
```

Run the author loop from the consuming repository:

```sh
ab plugin list
ab plugin doctor
ab plugin test ticket-source acme
```

| Command | Does |
|---|---|
| `list` | shows builtins and configured registrations, provenance, module resolution, plugin API compatibility and contract availability |
| `doctor` | attempts every configured module and exits nonzero if any fail; checks loading and registration, not adapter semantics |
| `test` | runs Bun's unchanged suite for exactly one port and adapter, forwards per-test output, and returns its exit status |

Repeat after every adapter change. The adapter is done only when that suite is green, with the live opt-in when applicable.

## 5. Zero-network wiring walkthrough

This scratch example proves module resolution, manifest spelling, configuration and the TicketSource contract bridge without network access. It uses Autobuild's reference fake, so it is **only a wiring exercise**: certification means your real adapter's harness passes the same unchanged suite.

Create `autobuild-plugin.ts` with the exact block below.

<!-- plugin-authoring-walkthrough-module:start -->
```ts
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import type {
  AutobuildPluginManifest,
  TicketSourceContractFactory,
  TicketSourcePluginFactory,
} from '@defrex/autobuild/plugin-sdk'

const createSource: TicketSourcePluginFactory = () => new FakeTicketSource()

const ticketContract: TicketSourceContractFactory = async () => ({
  source: new FakeTicketSource([], {
    createState: 'Triage',
    doneState: 'Done',
  }),
  states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
  editableLabel: 'contract',
})

export default {
  name: 'walkthrough',
  apiVersion: '^1.2.0',
  ticketSources: {
    walkthrough: {
      factory: createSource,
      contract: { factory: () => ticketContract },
    },
  },
} satisfies AutobuildPluginManifest
```
<!-- plugin-authoring-walkthrough-module:end -->

Create `autobuild.toml`:

<!-- plugin-authoring-walkthrough-config:start -->
```toml
plugins = ["./autobuild-plugin.ts"]

[tickets]
source = "walkthrough"
readyState = "ready"
```
<!-- plugin-authoring-walkthrough-config:end -->

Then run:

```sh
ab init
ab plugin doctor
ab plugin list
ab plugin test ticket-source walkthrough
```

`ab init` preserves the existing config and vendors this guide. Doctor and list must show the `walkthrough` plugin and adapter, and the last command must exit zero after running the TicketSource contract tests.

## 6. Package and publish when reuse warrants it

A repository-local module needs no packaging. For an npm plugin, keep one public module and an ordinary test and typecheck setup:

```text
acme-autobuild-plugin/
├── src/index.ts
├── package.json
├── tsconfig.json
└── bun.lock
```

This representative manifest declares only the currently tested host release (`1.0.0-beta.2`). Widen that range only after running the unchanged contracts on each supported host.

```json
{
  "name": "@acme/autobuild-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "prepublishOnly": "bun run typecheck && bun test"
  },
  "devDependencies": { "@defrex/autobuild": "1.0.0-beta.2", "typescript": "5.9.3" },
  "peerDependencies": { "@defrex/autobuild": "1.0.0-beta.2" },
  "peerDependenciesMeta": { "@defrex/autobuild": { "optional": true } }
}
```

- **Dependencies.** When production code imports only SDK types, those imports erase: Autobuild is an authoring and test dev dependency, not a runtime `dependencies` entry. The optional peer declaration tells consumers which host package you tested without making execution depend on a second Autobuild copy. Runtime imports, such as the reference fake in the walkthrough, need a runtime dependency; never ship the fake walkthrough as a production adapter.
- **Versions.** The package's own semver is independent of the host range and of the manifest's `apiVersion` range. On an incompatible host plugin API, update the adapter and contracts, change the range only after they pass against that host, and version the package by the user-visible compatibility change.

Before publishing:

```sh
bun run typecheck
bun test
npm pack --dry-run
npm pack
# inspect the tarball, then install that exact .tgz in a scratch consumer
npm publish --access public
```

1. Inspect the dry-run and tarball file lists for source, secrets, local fixtures and missing exports.
2. Install the generated tarball in a scratch consuming repository and configure `plugins = ["@acme/autobuild-plugin"]`.
3. Rerun `ab plugin doctor`, `ab plugin list` and the contract command before publishing.

Use `--access public` for a public scoped package; omit it when registry or access policy says otherwise.

Official npm references: [`package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack), and
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish).

## Optional ticket tree capability

Existing ticket-source factories stay compatible without new methods or fields. Raw `Ticket.kind` is optional; public projections normalize it to `work`.

An adapter opts in with `integrationTree: true` and must:

- implement `listAll(): Promise<TicketListing>` over every state, independently of ready filters, exhausting provider pagination and propagating infrastructure failures
- persist `kind?: 'work' | 'node'` and `target?: string | null` on drafts and updates: omitted preserves or defaults, explicit `work` resets kind, `null` clears target
- read targets as source-local canonical ticket ids
- validate same-source existence, node kind, self and ancestor cycles, corrupt chains, and demotion of a node with children before writing any mixed patch, including revision-checked writes
- expose kind and target in revisions

Don't opt in if the source can't preserve these semantics. Legacy sources receive ordinary CRUD unchanged, and the compatibility facade refuses metadata writes before legacy methods run. Unsupported sources should also refuse metadata explicitly at their own direct write boundary.
