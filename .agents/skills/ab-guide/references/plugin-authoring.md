---
title: "Writing a plugin"
group: "guides"
description: "Build, contract-test, package, and publish an Autobuild infrastructure adapter."
label: "Plugins"
order: 7
---

# Writing a plugin

A plugin is a trusted Bun module, loaded in-process from the consuming repository, that connects Autobuild to another ticket tracker, agent runtime, workspace system or forge.

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`; `ab <command>` below means `bun ab <command>` there.

**Definition of done for an adapter: the unchanged shared contract suite for its port passes.** Interface conformance or a clean `ab plugin doctor` is not enough.

## 1. Choose the port and preserve its semantics

Import public types only from `@defrex/autobuild/plugin-sdk`; internal module paths are not API.

| Port | Manifest map | Factory returns | Selected by |
|---|---|---|---|
| `ticket-source` | `ticketSources` | `TicketSource` | `[tickets].source` |
| `agent-runtime` | `agentRuntimes` | `RuntimeRegistration` | `[roles.*].runtime` |
| `workspace-provider` | `workspaceProviders` | `WorkspaceProvider` | `[workspace].provider` |
| `forge` | `forges` | `Forge` | root `forge` key |

All four manifest maps have production selectors. Omitted forge and workspace selectors default to builtin `github` and `git-worktree`; roles keep normal runtime inheritance.

`BuildStore` and `BlobStore` contract types are exported for remote-server authors, but BuildStore is **not** an in-process manifest map: implement the language-neutral remote store protocol and run its conformance path. The optional `BuildStore.getLatestArtifactMeta` capability must return only the latest metadata in constant-size reads without loading blob content or listing revisions; omit it when unsupported. `TelemetrySource` is a frozen port type with no plugin registration surface in this release.

### `ticket-source`

Lists, gets and claims tickets to start builds; receives comments, transitions, creates and updates. Owns lifecycle names, dependency completion, idempotent creation with a stable external creation-key projection, and partial-list diagnostics. Never consulted mid-build; not artifact storage.

### `agent-runtime`

Wrap an `AgentRunner` that supports:

- start, continue and end, with complete transcripts and usage
- per-turn environment refresh, and cancellation that keeps an endable handle for transcript deposition
- typed failures: verbatim message, retry-compatible `permanent` bit, optional `cause: availability | exhaustion | credentials | configuration` routing evidence
- the distribution-managed `ab` launcher

Declare served model prefixes and a default. Optional tool-free `oneShot` sits beside the runner interface.

### `workspace-provider`

- Provision an absolute, writable working copy for the requested branch; return durable base evidence.
- Resume an intact branch non-destructively, never silently re-cut from a newer base. Rematerialize a lost copy. Make release idempotent.
- Optional `provision.publication` supplies a durable confirmed SHA and known cache tips for authoritative readback and cache repair. Preserve unknown unpublished work.

### `forge`

- Kernel-owned regular pushes, idempotent PR opening, PR-state projection, gated and ungated auto-merge, head-guarded squash merge, and comments. Agents never receive forge credentials or push.
- API 1.2: optional idempotent `closePr` and `deleteBranch` for abort cleanup. `closePr` must preserve a racing merge. Without them, cleanup stays visibly pending.
- Optional `prAttachments` hosts images; the text-only path must work without it.

### Reconcile rewrites

Reconcile requires the optional grouped `Forge.rewrite` capability:

1. Snapshot the actual build branch into a build-private ref.
2. Publish immutable exact-SHA refs under `refs/autobuild/archive/<slug>/<sha>`.
3. Replace the explicit branch, leased on an explicit expected remote head.

- Return `lease-mismatch` separately from transport, auth and policy failures.
- If the CAS succeeds but another writer advances the branch before readback, return `lease-mismatch` with `rewritten: true` and the observed `actual` head. The kernel records the write and retries without claiming completion.
- After an acknowledged replacement, reattach the matching detached workspace HEAD to the build branch so later publication works.
- Never overwrite unknown work or fall back to merging, ordinary pushes, archive branches or tags.
- Older forge plugins still load; reconcile refuses them actionably.
- Remote workspace providers also need trusted `WorkspacePublication.rewrite` after guest teardown; ordinary `publish` can't publish a restack.

### Destination observation and ancestry

`remoteBranchSha(branch)` must read the authoritative forge branch. Its absence
or failure defers observation; there is no host-checkout fallback. The optional
`isCommitAncestor(ancestor, descendant)` compares immutable full OIDs: return
false only for a proven non-descendant, and throw for missing objects, transport,
authentication, malformed responses or rate limits. Missing capability withholds
new replay requiring proof. GitHub uses exact-SHA comparison; local-git requires
an explicit served `repoRoot`. Unknown ancestry never authorizes replay.

### Publication readback

Publication succeeds only when an authoritative branch-head readback equals the frozen intended SHA, including recovery after a failed push. Unconfirmed candidate ancestry never proves publication.

- `pushBranch(workspacePath, branch, sha?)` receives the frozen SHA from kernel callers and stays fast-forward only. Legacy callers may omit the SHA to select HEAD.
- `confirmPublication` inspects the authoritative head and refreshes caches only on an exact SHA match. Kernel callers refuse adapters lacking it before pushing.
- Remote-backed local refs are caches: set them unconditionally after confirmation, fetching the advertised ref if objects are missing, without resetting checkout files. `localExpected` is historical input only. Local-git's shared ref database stays authoritative and keeps CAS.
- Hosted `WorkspacePublication` must provide authoritative `isPublished`, and confirm after writing and before retrying.
- Remote inspection must not resume a stopped guest or run commands in it; refresh the guest cache inside trusted publication before stopping it. Missing inspection fails actionably.

### Forge failures and request accounting

API 1.8 adds optional forge failure classification. Import `ForgeFailure` and `isForgeFailure`, plus the types `ForgeFailureDetails`, `ForgeRequestObserver` and `ForgeRequestContext`, from `@defrex/autobuild/plugin-sdk`.

```ts
// Rate limit, with a valid ISO reset timestamp:
throw new ForgeFailure(message, { kind: 'rate-limited', resetAt })
// Retryable transport error:
throw new ForgeFailure(message, { kind: 'transient', retry: 'retryable' })
```

- Don't classify ordinary policy and permission refusals; they remain deferrals. Never include credentials.
- The `forgeFailure: 'autobuild.forge-failure.v1'` discriminant and validated details work across separately loaded SDK copies. Arbitrary legacy errors aren't classified.

Optional `Forge.observeRequests(observer): () => void` returns a disposer and calls each observer once per wire request, including failures and pagination.

- Pass `ForgeRequestContext` with the build slug, or `{}` when unknown; the host fills missing attribution from its current build-scoped operation, else the request is repository/unattributed. Capture context before awaiting transport; notify after the outcome.
- Credential discovery and skipped calls are not provider requests.

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

Declare `apiVersion: '^1.8.0'` for these capabilities. Legacy 1.x plugins load without observers and show unavailable counts.

### Read scopes

Forge optimizations that don't change the required plugin API version:

- **`withReadScope(work)`** wraps a dispatcher tick, sharing promises and observations across builds; tears down on rejection too. Operations outside the scope stay independent.
- **`primeNodeReads({workspacePath, parent, head, prNumber?})`** seeds opened-node facts. Non-cooldown failures emit a diagnostic and fall through to ordinary stage reads, preserving recovery when the previous parent disappeared.

Invalidate observations before writes, including uncertain writes and Git pushes. Acknowledgement and readiness reads stay fresh. Branch and ref endpoints share normalized facts, never HTTP validators.

### API versions

A plugin relying on a capability declares an `apiVersion` range containing its version (for example `^1.5.0`). Legacy plugins without newer fields keep working.

- **1.2** Forge `closePr` and `deleteBranch`.
- **1.3** `AgentRunner` failure `cause` and the `exhaustion-failure` contract scenario. Without `cause`, `permanent: false` is eligible for a configured alternate; `permanent: true` stops the chain.
- **1.4** Optional `Ticket.creationKey`: the stable external create/adoption key, projected from `create`, `get` and `listReady`, correlating ready tickets with durable Harvest reservations while blocker recording is unfinished. Legacy tickets may omit it.
- **1.5** `path` is the path in the workspace environment; set optional `localPath` only when the dispatcher can reach that same copy directly. Workspace-owned executors receive the durable provider locator as `BuildExecutionStart.workspaceRef`; local PID supervision stays host-owned.
- **1.7** Workspace factory seams.
- **1.8** Forge failure classification and request observers.
- **1.9** Optional native ticket-source paging (`listPage`); older sources retain operator slicing.

## 2. Create a repository-local module

```text
my-repository/
├── autobuild.toml
└── autobuild-plugin.ts
```

Use `import type` for SDK symbols that are only types:

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

- **`name`** Nonblank diagnostic and ownership identity; need not equal the npm package name.
- **`apiVersion`** A semver **range accepted by the plugin**, not its package version: the narrowest range containing the host plugin API you ran contracts against. `ab plugin list` reports it beside the host version; invalid or incompatible ranges fail loading.
- **Registration keys** Only `ticketSources`, `agentRuntimes`, `workspaceProviders` and `forges`; unknown fields fail validation.
- **Adapter names** Register verbatim. Declare `__proto__` computed, `{ ['__proto__']: factory }`; a plain `__proto__:` key sets the prototype. Parsed maps have a null prototype, so undeclared names read `undefined`. Blank or whitespace-only names are rejected.
- **Registrations** A bare adapter factory, or `{ factory, contract: { factory, live? } }` whose contract factory returns that port suite's fixture factory. Ticket-source descriptors may declare a deduplicated `requiredEnv` list; the host rejects missing or empty credentials before invoking the selected factory.

### Factory context

Every adapter and contract factory receives `{ config, env, repoRoot }`: read-only `config`, the process `env`, and `repoRoot`, the absolute consuming-repository root.

| Port | `config` |
|---|---|
| ticket-source | the existing strict `[tickets]` fields; no untyped plugin-options table |
| workspace-provider | the open `[workspace.config]` table, the only place for adapter-owned settings |
| agent-runtime, forge | an empty object |

Workspace-provider factories also receive optional host-derived seams (API 1.7), absent when the call site has none; ignoring them changes nothing.

- **`storeRef`, `delegateCredential`** Store URL and credential-exchange callback; guaranteed when the registration declares `capabilities.storeRequirements`.
- **`runtimeReferences`** The host's effective runtime routes.
- **`origin`, `remoteBranchHead`** Checkout-less readers; when absent, fall back to host `git` from `repoRoot`.

Remote workspace factories must call `delegateCredential(storeRef, undefined, target)` for per-resource grants before provisioning or launching guests; parent authority stays in host composition.

- `storeToken` is retired and never supplied; factory environments exclude `AB_TOKEN`. Plugins that forwarded it must migrate to the callback and fail closed without it.
- Launch credentials travel through the separate transient execution-auth argument, never serialized execution identity.

### Configure and resolve

List module specifiers at the TOML root, before any table, and select adapters:

```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```

- Repository-path specifiers resolve from the config-bearing root, which is the immutable build worktree in scoped phases.
- npm package specifiers resolve from the consuming main checkout's installed dependencies first, then from the Autobuild installation the CLI runs from.
- Install extensions in the consuming repository with `bun add -d --exact @defrex/autobuild-<extension>`; a repository copy wins over an installed one, and missing packages fail and are never installed automatically.
- Specifiers must be unique: an exact repeat fails config validation before any plugin loads, naming the value and both positions.

### Loading rules

- Modules load in declaration order; registration is atomic per manifest.
- Resolution or evaluation failure, a missing or malformed default export, an incompatible API range, or a collision fails before any claims or builds.
- Within one port, builtin and earlier-plugin names can't be shadowed; a collision names the adapter and both owners. Different ports may share a name.
- Plugins are trusted like configured shell commands: Bun evaluates them in-process with repository authority and no sandbox.

### Cached dispatcher generations

In a cached dispatcher generation, selection uses the same roots, but selected external plugin code and its installed dependency closure are copied into an immutable auxiliary snapshot.

- ESM, CommonJS `require`, delayed imports, export-from and module-anchored `createRequire` all resolve the core package, SDK values and classes included, to the same frozen runtime, without loader hooks or source transforms.
- Repo-path modules copy their literal import closure and literal `new URL(..., import.meta.url)` assets, not the checkout or unused dev dependencies. Packaged plugins keep their package's assets and dependency graph.
- Package-relative assets stay beside copied modules. `import.meta.url` and filenames name the snapshot; cwd and factory `repoRoot` remain the consuming checkout. Explicit absolute paths stay plugin-controlled external resources.
- Snapshots use neutral compiler boundaries; cached Bun entrypoints pin the core config with `--no-install --tsconfig-override`. Autobuild-owned compiler chains can't escape the runtime; installed third-party development configs are preserved byte-for-byte.
- New selections can prepare new snapshots without changing the generation's core identity. Live plugin processes keep their core runtime independently of Store leases.
- Plugin-loading CLI calls reclaim dead snapshots, so edits between phase commands don't pile up checkout-sized copies.

Noncached consumers follow the separately loaded SDK compatibility rules in section 1.

## 3. Keep secrets out of source and config

- Never put credentials in `autobuild.toml`, the manifest, committed fixtures or contract output.
- Read them from the factory's `env` (for example `env.ACME_FORGE_TOKEN`), document the required environment variables, and keep local values in ignored env files or a secret manager.
- Validate credentials when the selected adapter or live fixture is created, not at module top level, so registration stays lazy and diagnostics can inspect unrelated adapters. Ticket-source descriptors should declare `requiredEnv`; other ports check in their factories.

## 4. Add the contract harness first

A contract-bearing registration:

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

The contract factory returns a `TicketSourceContractFactory`, `AgentRunnerContractFactory`, `WorkspaceProviderContractFactory` or `ForgeContractFactory` (harness types from `@defrex/autobuild/plugin-sdk`). The host runs the unchanged shared suite; don't copy, wrap, skip or weaken its assertions.

Contract fixtures must:

- isolate resources (UUID-namespaced records, branches, PRs, sessions or workspaces)
- expose the independent controls and probes their harness type requires
- clean up in `cleanup`, even after an assertion failure
- make retries and release idempotent where the port requires it

A fixture that contacts a provider or mutates external resources must declare `contract: { factory, live: true }` and runs only with an explicit opt-in:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 ab plugin test forge acme
```

Author loop:

```sh
ab plugin list
ab plugin doctor
ab plugin test ticket-source acme
```

| Command | Does |
|---|---|
| `list` | builtins and configured registrations: provenance, resolution, API compatibility, contract availability |
| `doctor` | loads every configured module, nonzero if any fail; not a semantics check |
| `test` | runs the unchanged suite for one port and adapter, forwards per-test output, returns its exit status |

Repeat after every adapter change until the suite is green, with the live opt-in when applicable.

## 5. Zero-network wiring walkthrough

This scratch example proves module resolution, manifest spelling, configuration and the TicketSource contract bridge offline. It uses Autobuild's reference fake, so it is **only a wiring exercise**; your real adapter's harness must still pass the same suite.

Create `autobuild-plugin.ts`:

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

`ab init` keeps the existing config and vendors this guide. Doctor and list show the `walkthrough` plugin and adapter; the contract run exits zero.

## 6. Package and publish when reuse warrants it

A repository-local module needs no packaging. An npm plugin needs one public module plus ordinary test and typecheck setup:

```text
acme-autobuild-plugin/
├── src/index.ts
├── package.json
├── tsconfig.json
└── bun.lock
```

This manifest declares only the tested host release (`1.0.0-beta.2`); widen it only after the unchanged contracts pass on each added host.

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

- **Dependencies.** Type-only SDK imports erase, so Autobuild is a dev dependency, not a runtime `dependencies` entry. The optional peer names the tested host without loading a second Autobuild copy. Runtime imports, such as the reference fake, need a runtime dependency; never ship the fake as a production adapter.
- **Versions.** Package semver is independent of the host range and `apiVersion`. On an incompatible host plugin API, update adapter and contracts, change the range once they pass, and version the package by the user-visible compatibility change.

Before publishing:

```sh
bun run typecheck
bun test
npm pack --dry-run
npm pack
# inspect the tarball, then install that exact .tgz in a scratch consumer
npm publish --access public
```

1. Check the dry-run and tarball file lists for source, secrets, local fixtures and missing exports.
2. Install the tarball in a scratch consuming repository with `plugins = ["@acme/autobuild-plugin"]`.
3. Rerun `ab plugin doctor`, `ab plugin list` and the contract command.

Drop `--access public` when the registry or access policy says otherwise.

Official npm references: [`package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack), and
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish).

## Optional ticket tree capability

Existing ticket sources stay compatible unchanged. Raw `Ticket.kind` is optional; public projections normalize it to `work`.

An adapter opts in with `integrationTree: true` and must:

- implement `listAll(): Promise<TicketListing>` over every state, ignoring ready filters, exhausting pagination and propagating infrastructure failures
- persist `kind?: 'work' | 'node'` and `target?: string | null` on drafts and updates: omitted preserves or defaults, explicit `work` resets kind, `null` clears target
- read targets as source-local canonical ticket ids
- before writing any mixed patch, including revision-checked writes, validate same-source existence, node kind, self and ancestor cycles, corrupt chains, and demotion of a node with children
- expose kind and target in revisions

Don't opt in unless the source preserves these semantics. Legacy sources get ordinary CRUD; the compatibility facade refuses metadata writes before legacy methods run, and unsupported sources should also refuse metadata at their own write boundary.

## Optional ticket paging capability

Native paging is an optional API 1.9 ticket-source capability:
`listPage?(criteria: TicketCriteria, page: TicketPage): Promise<TicketPageListing>`.
The SDK exports these types; the result is `TicketListing & { total: number }`.
Criteria retain state, labels (AND), and assignee semantics. The page has a
nonnegative integer `limit`, optional nonnegative integer `offset` (default 0),
and optional `order: 'oldest' | 'newest'` (default oldest). Newest reverses the
entire source order before offset and limit. Total counts all matches, even
with limit zero or an offset past the end. Records, diagnostics and errors
match the exhaustive listing. The shared `describeTicketSourceContract` suite
automatically compares declared native paging with full-read windows.

Only paged operator listings select this capability. Sources without it retain
the full-read/reverse/slice fallback; native errors propagate. Unpaged operator
listings, CLI ticket lists and dispatcher ready scans remain exhaustive through
`listReady`/`listAll`. The hosted PostgreSQL source counts matches without
bodies and reads only the SQL-bounded window. File, Linear and the remote
`HostedTicketSource` retain fallback; the POST list-ready protocol stays exhaustive.
