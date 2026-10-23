---
title: "Writing a plugin"
group: "guides"
description: "Build, contract-test, package, and publish an Autobuild infrastructure adapter."
label: "Plugins"
order: 7
---

# Writing a plugin

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`.
Here, `ab <command>` means the repository-installed CLI; run it as
`bun ab <command>`, for example `bun ab init`.

Use this reference when asked to connect Autobuild to another ticket tracker,
agent runtime, workspace system, or forge. A plugin is a trusted Bun module
loaded in-process from the consuming repository. **Definition of done for an
adapter: the unchanged shared contract suite for its port passes.** Interface
conformance or a successful `ab plugin doctor` alone is not certification.

## 1. Choose the port and preserve its semantics

Import public types only from `@defrex/autobuild/plugin-sdk`; package-internal module
paths are not API.

### `ticket-source`

Manifest map: `ticketSources`. Factory result: `TicketSource`.

Initiates a build by listing/getting/claiming tickets and receives comments/transitions/creates/updates. It owns lifecycle names, dependency completion, idempotent creation, stable external creation-key projection, and partial-list diagnostics. It is never consulted mid-build and is not artifact storage.

### `agent-runtime`

Manifest map: `agentRuntimes`. Factory result: `RuntimeRegistration`.

Wrap an `AgentRunner` that supports start/continue/end, complete transcripts and usage, per-turn environment refresh and cancellation, typed failures with verbatim messages, the retry-compatible `permanent` bit, and optional `cause: availability | exhaustion | credentials | configuration` routing evidence, plus the distribution-managed `ab` launcher. A cancelled turn must retain an endable handle for transcript deposition. Declare served model prefixes/default; optional tool-free `oneShot` is a capability beside the runner interface.

### `workspace-provider`

Manifest map: `workspaceProviders`. Factory result: `WorkspaceProvider`.

Provision an absolute, writable working copy for the requested branch, return durable base evidence, resume an intact branch non-destructively, rematerialize a lost copy, and make release idempotent. Never silently re-cut resumed work from a newer base. Optional `provision.publication` supplies a durable confirmed SHA and known cache tips for authoritative readback and cache repair; preserve unknown unpublished work.

### `forge`

Manifest map: `forges`. Factory result: `Forge`.

Implement kernel-owned regular pushes, idempotent PR opening, PR-state projection, gated/ungated auto-merge behavior, head-guarded squash merge, and comments. API 1.2 adds optional idempotent `closePr` and `deleteBranch` abort-cleanup capabilities; `closePr` must preserve a racing merge. Without them abort cleanup remains visibly pending. Agents never receive forge credentials or push. `prAttachments` is an optional image-hosting capability; absence must preserve the supported text-only path. Optional API 1.8 failure classification and request observers are described below.

### Shared capabilities and compatibility

Reconcile requires the optional grouped `Forge.rewrite` capability: snapshot the
actual build branch into a build-private ref, publish immutable exact-SHA refs
under `refs/autobuild/archive/<slug>/<sha>`, and replace the explicit branch with
an explicit expected remote head. Return `lease-mismatch` separately from
transport, auth and policy failures. If the CAS succeeds but another writer
advances it before readback, return `lease-mismatch` with `rewritten: true` and the
observed `actual` head. The kernel records that write and retries the observed
history without claiming completion. After an acknowledged replacement, reattach
the matching detached workspace HEAD to the build branch so later implementation
publication remains usable. Never overwrite unknown work or silently
fall back to merging, ordinary pushes, archive branches or tags. Older forge
plugins remain loadable and receive an actionable refusal at reconcile time.
Remote workspace providers additionally need trusted `WorkspacePublication.rewrite`
after guest execution teardown; ordinary `publish` cannot publish a restack.
Every publication succeeds only after authoritative branch-head readback equals
its frozen intended SHA, including recovery after a failed push. Remote-backed
local refs are caches: set them unconditionally after confirmation, fetching the
advertised ref if objects are missing, without resetting checkout files.
`localExpected` is historical input only. Local-git's shared ref database remains
authoritative and keeps CAS. Ordinary `pushBranch(workspacePath, branch, sha?)`
receives the frozen SHA from kernel callers and remains fast-forward only;
legacy callers may omit SHA to select HEAD. Implement `confirmPublication`
to inspect the authoritative head and refresh caches only on an exact SHA match;
kernel callers refuse adapters without it before attempting a push. Hosted `WorkspacePublication` must
provide authoritative `isPublished` and confirm after writing, as well as before
retrying. Remote inspection must not resume a stopped guest or run commands in
it: refresh the guest cache inside trusted publication before stopping it. Missing inspection fails actionably. Unconfirmed candidate ancestry
never proves publication.

Plugin API 1.3 adds the optional AgentRunner failure `cause` and the
`exhaustion-failure` shared-contract scenario. Legacy failures without `cause`
remain supported: `permanent: false` is eligible for a configured alternate,
while `permanent: true` stops the chain. A runtime plugin that emits/depends on
the richer cause should declare an API range containing `^1.3.0`.

Plugin API 1.4 adds optional `Ticket.creationKey`. Ticket-source plugins should
project the stable external create/adoption key from `create`, `get`, and
`listReady`; Autobuild uses it to correlate ready tickets with durable Harvest
reservations while blocker recording is unfinished. Legacy tickets may omit the
field and continue to dispatch normally. A plugin relying on this host gate
should declare an API range containing `^1.4.0`.

Plugin API 1.5 makes remote workspace locations explicit. `path` is the path in
the workspace environment; set optional `localPath` only when that same working
copy is directly reachable by the dispatcher. Workspace-owned executors receive
the durable provider locator as `BuildExecutionStart.workspaceRef`; local PID
supervision remains host-owned. A workspace plugin relying on these fields
should declare an API range containing `^1.5.0`.

Plugin API 1.8 adds optional forge failure classification and request accounting.
Import the runtime `ForgeFailure` constructor and `isForgeFailure`, plus types
`ForgeFailureDetails`, `ForgeRequestObserver`, and `ForgeRequestContext` from
`@defrex/autobuild/plugin-sdk`. Throw
`new ForgeFailure(message, { kind: 'rate-limited', resetAt })` with a valid ISO
reset timestamp, or `{ kind: 'transient', retry: 'retryable' }` for retryable
transport errors. Ordinary policy/permission refusals remain deferrals. Never
include credentials. The `forgeFailure: 'autobuild.forge-failure.v1'` discriminant
and validated details work across separately loaded SDK copies.

Optionally implement `Forge.observeRequests(observer): () => void`; return a
disposer and call registered observers once per wire request, including failed
requests and pagination. Pass `ForgeRequestContext` with the build slug when
known, or `{}` when unknown. Capture attribution before awaiting transport and
notify after its outcome is known. Optional `outcome` is `restPrimary` for REST
HTTP responses other than 304, `restNotModified` for REST 304, or `graphql` for
GraphQL calls (including failures). Network failures have no proven REST debit
and omit the category. The host fills missing build attribution from its
current build-scoped operation; otherwise the request is repository/unattributed.
Credential discovery and skipped calls are not provider requests. For example:

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

Optional `withReadScope(work)` wraps a complete dispatcher tick, sharing promises
and observations across builds, and tears down on rejection too. Keep concurrent
operations outside that scope independent. Optional `primeNodeReads({workspacePath,
parent, head, prNumber?})` seeds opened-node facts. Priming is an optimization:
non-cooldown failures produce a diagnostic and fall through to ordinary stage
reads, preserving parent recovery when the previous parent disappeared.
Neither capability changes the
plugin API version requirement. Invalidate observations before writes, including
uncertain writes and Git pushes; acknowledgement and readiness reads must stay
fresh. Branch and ref endpoints share normalized facts, never HTTP validators.

Declare `apiVersion: '^1.8.0'` when using these capabilities. Compatible legacy
1.x plugins still load without observers and show unavailable counts. Arbitrary
legacy errors are not classified automatically.

Plugin API 1.7 extends the workspace-provider factory context with the
host-derived seams a store-requiring remote provider needs. Workspace-provider
factories additionally receive `storeRef` and `delegateCredential` (guaranteed present
when the registration declares `capabilities.storeRequirements`),
`runtimeReferences` (the host's effective runtime routes; absent at call sites
that reference no runtimes), and the checkout-less `origin` and
`remoteBranchHead` readers (absent means fall back to host `git` from
`repoRoot`). All five are optional, and a factory that ignores them changes
nothing. A plugin reading the new seams should declare an API range containing
`^1.7.0`.

`BuildStore` and `BlobStore` contract types are exported for remote-server
authors, but BuildStore is **not** an in-process manifest map. Implement the
language-neutral remote store protocol and run its conformance path
instead. `TelemetrySource` is a frozen port type with no plugin registration
surface in this release.

All four manifest maps have production selectors. Use `[tickets].source` for a
ticket source, the root `forge` key for a forge, `[workspace].provider` for a
workspace provider, and `[roles.*].runtime` for an agent runtime. Omitted forge
and workspace selectors retain the builtin `github` and `git-worktree` defaults;
role inheritance retains its normal runtime fallback.

## 2. Create a repository-local module

Start in the consuming repository, for example:

```text
my-repository/
├── autobuild.toml
└── autobuild-plugin.ts
```

Use erased imports in real adapter production code whenever the SDK symbols are
only types:

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

Every module must default-export one strict `AutobuildPluginManifest`:

- `name` is a nonblank diagnostic/ownership identity; it need not equal the npm
  package name.
- `apiVersion` is a semver **range accepted by the plugin**, not the plugin's
  package version. Choose the narrowest range containing the host plugin API
  against which you ran contracts. `ab plugin list` reports the declared range
  and host version; invalid or incompatible ranges fail loading.
- The only registration keys are `ticketSources`, `agentRuntimes`,
  `workspaceProviders`, and `forges`. Unknown manifest fields fail validation.
  Adapter names are yours to choose: every declared name is registered
  verbatim, including one such as `__proto__` that collides with an inherited
  object property — declare that one computed, `{ ['__proto__']: factory }`,
  since a plain `__proto__:` key in an object literal sets the prototype
  instead of declaring an adapter. The parsed maps have a null prototype, so
  reading an undeclared name answers `undefined` rather than an inherited
  member. A blank or whitespace-only name is rejected: an adapter is selected
  from configuration by name.
- A registration may be a bare adapter factory, or
  `{ factory, contract: { factory, live? } }`. The first factory returns the
  adapter; the contract factory returns that port suite's fixture factory.
  Ticket-source descriptors may additionally declare a deduplicated
  `requiredEnv` list; the host rejects missing or empty credentials before
  invoking that selected factory.
- Every adapter and contract factory receives `{ config, env, repoRoot }`:
  adapter-specific read-only `config`, the process `env`, and `repoRoot` as the
  absolute consuming-repository root. Ticket sources receive the existing
  `[tickets]` fields, workspace providers receive `[workspace.config]`, and
  runtime and forge factories currently receive an empty `config` object.
  Workspace providers additionally receive the host-derived seams (API 1.7):
  `storeRef` and `delegateCredential` — guaranteed URL and exchange callback when the registration
  declares `capabilities.storeRequirements` — plus `runtimeReferences`,
  `origin`, and `remoteBranchHead`. Each seam is optional and absent when the
  host call site supplies no such value; absent `origin`/`remoteBranchHead`
  fall back to host `git` from `repoRoot`.

Add the module specifier at the TOML root, before any table. Repository-path
specifiers resolve from the config-bearing root, which is the immutable build
worktree in scoped phases. npm package specifiers resolve from the consuming
main checkout's installed dependencies first, then from the Autobuild
installation the CLI runs from as a fallback. Install extensions in the
consuming repository with `bun add -d --exact @defrex/autobuild-<extension>`;
a repository copy wins over an installed one, and missing packages fail and
are never installed automatically:

```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```

Inside a cached dispatcher generation, selection still uses those roots, but
selected external plugin code and its installed dependency closure are copied
into an immutable auxiliary snapshot. Native ESM, CommonJS `require`, delayed
imports, export-from and module-anchored `createRequire` all resolve the core
package to the same canonical frozen runtime, including SDK values and classes.
There are no loader hooks or source transforms. Repo-path modules in a consuming
repository use their literal import closure and literal `new URL(..., import.meta.url)`
assets, rather than copying the checkout or its unused dev dependencies. Plugins
with their own package boundary retain that package’s assets and dependency graph.
Package-relative assets remain
beside copied modules; `import.meta.url` and filenames name the snapshot, while
cwd and factory `repoRoot` remain the consuming checkout. Explicit absolute
paths remain plugin-controlled external resources.

Auxiliary snapshots use neutral compiler boundaries and cached Bun entrypoints
pin the core config with `--no-install --tsconfig-override` before JavaScript
runs. Autobuild-owned compiler chains cannot escape the runtime; installed
third-party development configs are preserved byte-for-byte. New selections
can prepare new snapshots without changing the generation's core identity.
Live plugin processes retain their core runtime independently of Store leases.
Plugin-loading CLI calls reclaim dead auxiliary snapshots during the generation,
so edits between phase commands do not accumulate checkout-sized copies.
Ordinary noncached consumers retain the separately loaded SDK compatibility
rules described above.

Each configured specifier string must be unique. An exact repeat fails config
validation before Bun resolves or evaluates any plugin, identifies the repeated
value and both list positions, and tells the operator to remove or deduplicate
the entry. Distinct specifiers remain separate declarations.

Select only the adapters the repository uses. Set `forge = "acme"` for the
example forge above; set `[tickets].source`, `[workspace].provider`, or a
`[roles.*].runtime` to the matching registration name for the other ports.
Ticket plugins receive the existing strict `[tickets]` fields—there is no
untyped plugin-options table. Workspace plugins put adapter-owned settings only
under the open `[workspace.config]` table.

Plugin modules load in declaration order. Resolution/evaluation failure, a
missing or malformed default export, incompatible API range, or collision
fails before claims/builds. Builtin and earlier-plugin names cannot be
shadowed within one port; a collision between distinct plugins identifies the
adapter and both owners. The same adapter name may exist on different ports.
Registration is atomic per manifest. Plugins are trusted like configured shell
commands: Bun evaluates them in-process with repository authority and no
sandbox.

## 3. Keep secrets out of source and config

Never put credentials in `autobuild.toml`, the manifest, committed fixtures, or
contract output. Read them from the factory's `env` (for example
`env.ACME_FORGE_TOKEN`) and document the required environment variables. Keep
local values in ignored environment files or the process secret manager.
Validate missing credentials when the selected adapter or live fixture is
created, not at module top level, so registration remains lazy and diagnostics
can inspect unrelated adapters. Ticket-source descriptors should declare
`requiredEnv` when the host can enforce the credential names before factory
invocation; other ports validate their environment in their factories.

## 4. Add the contract harness first

A contract-bearing registration has this shape:

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

The descriptor's factory returns a `TicketSourceContractFactory`,
`AgentRunnerContractFactory`, `WorkspaceProviderContractFactory`, or
`ForgeContractFactory` as appropriate. Use the matching harness types exported
by `@defrex/autobuild/plugin-sdk`. The host invokes the unchanged shared suite; do not
copy, wrap, skip, or weaken its assertions.

Contract fixtures must isolate resources (UUID-namespaced records, branches,
PRs, sessions, or workspaces), expose the independent controls/probes required
by their harness type, clean up in `cleanup` even after assertion failure, and
make retries/release idempotent where the port requires it. A fixture that
contacts a provider or mutates external resources must declare
`contract: { factory, live: true }`. Autobuild refuses to launch it unless the
operator explicitly sets:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 ab plugin test forge acme
```

Run the author loop from the consuming repository:

```sh
ab plugin list
ab plugin doctor
ab plugin test ticket-source acme
```

- `list` shows builtins and configured registrations, provenance, module
  resolution, plugin API compatibility, and contract availability.
- `doctor` attempts every configured module and exits nonzero if any fail. It
  checks loading/registration, not adapter semantics.
- `test` launches Bun's unchanged suite for exactly one port/adapter, forwards
  per-test output, and returns its exit status.

Repeat after every adapter change. The adapter is done only when that command's
shared suite is green (with the explicit live opt-in when applicable).

## 5. Zero-network wiring walkthrough

This executable scratch example proves module resolution, manifest spelling,
configuration, and the TicketSource contract bridge without network access. It
uses Autobuild's reference fake and is **only a wiring exercise**. Replace the
fake and fixture with the real provider implementation; certification means the
real adapter's harness passes the same unchanged suite.

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

`ab init` preserves the existing config and vendors this guide. Doctor and list
must show the `walkthrough` plugin/adapter, and the final command must exit zero
with the TicketSource contract tests.

## 6. Package and publish when reuse warrants it

A repository-local module is the shortest path and needs no packaging. For an
npm plugin, keep one public module and an ordinary test/typecheck setup:

```text
acme-autobuild-plugin/
├── src/index.ts
├── package.json
├── tsconfig.json
└── bun.lock
```

A representative package manifest is shown below. This example declares only the
current tested host release (`1.0.0-beta.2`); widen that compatibility range only
after running the unchanged contracts on each supported host. The plugin package
version is independent of this host range and of the manifest API range:

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

When production code imports only SDK types, those imports erase: Autobuild is
an authoring/test dev dependency, not a runtime `dependencies` entry. An
optional peer declaration communicates tested host-package compatibility to
package consumers without making plugin execution depend on a second Autobuild
copy. Runtime imports (for example importing a reference fake in the scratch
walkthrough) are different and require a runtime dependency; do not ship the
fake walkthrough as a production adapter.

Keep the package's own semver independent from the manifest's `apiVersion`
range. On an incompatible host plugin API, update the adapter and contracts,
change the range only after they pass against that host, and release the
package version according to the user-visible compatibility change.

Before publishing:

```sh
bun run typecheck
bun test
npm pack --dry-run
npm pack
# inspect the tarball, then install that exact .tgz in a scratch consumer
npm publish --access public
```

Inspect the dry-run/tarball file list for source, secrets, local fixtures, and
missing exports. Install the generated tarball in a scratch consuming
repository, configure `plugins = ["@acme/autobuild-plugin"]`, and rerun
`ab plugin doctor`, `ab plugin list`, and the contract command before publish.
Use `--access public` for a public scoped package; omit it when registry/access
policy says otherwise.

Official npm references: [`package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack), and
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish).

Remote workspace factories must use `delegateCredential(storeRef, undefined,
target)` to obtain per-resource grants before provisioning or launching guests.
The callback keeps parent authority in host composition. `storeToken` is retired
and is never supplied; factory environments also exclude `AB_TOKEN`. Launch
credentials travel through the separate transient execution-auth argument, never
through serialized execution identity. Existing plugins that forwarded
`storeToken` must migrate to this callback and fail closed if it is unavailable.

## Optional ticket tree capability

Existing ticket-source factories remain compatible without new methods or fields.
Raw `Ticket.kind` is optional for source compatibility; public projections normalize
it to `work`. An adapter opts in with `integrationTree: true` and implements
`listAll(): Promise<TicketListing>` over every state, independently of ready filters.
It must persist `kind?: 'work' | 'node'` and `target?: string | null` on drafts
and updates: omitted preserves/defaults, explicit work resets kind, null clears
target. Read targets are source-local canonical ticket ids. Validate same-source
existence, node kind, self/ancestor cycles, corrupt chains and demotion with any
children before writing any mixed patch, including revision-checked writes.
Expose kind/target in revisions. Exhaust provider pagination and propagate
infrastructure failures. Do not opt in if the source cannot preserve these semantics.
Legacy sources receive ordinary CRUD unchanged; metadata writes are refused by
the compatibility facade before legacy methods run. Unsupported sources should
also refuse metadata explicitly at their own direct write boundary.
