# Authoring Autobuild plugins

Use this reference when asked to connect Autobuild to another ticket tracker,
agent runtime, workspace system, or forge. A plugin is a trusted Bun module
loaded in-process from the consuming repository. **Definition of done for an
adapter: the unchanged shared contract suite for its port passes.** Interface
conformance or a successful `ab plugin doctor` alone is not certification.

## 1. Choose the port and preserve its semantics

Import public types only from `autobuild/plugin-sdk`; internal `src/` paths are
not API.

| CLI port | Manifest map | Factory result | Required semantics |
|---|---|---|---|
| `ticket-source` | `ticketSources` | `TicketSource` | Initiates a build by listing/getting/claiming tickets and receives comments/transitions/creates/updates. It owns lifecycle names, dependency completion, idempotent creation, and partial-list diagnostics. It is never consulted mid-build and is not artifact storage. |
| `agent-runtime` | `agentRuntimes` | `RuntimeRegistration` | Wrap an `AgentRunner` that supports start/continue/end, complete transcripts and usage, per-turn environment refresh, typed retryable/permanent failures, and the distribution-managed `ab` launcher. Declare served model prefixes/default; optional tool-free `oneShot` is a capability beside the frozen runner interface. |
| `workspace-provider` | `workspaceProviders` | `WorkspaceProvider` | Provision an absolute, writable working copy for the requested branch, return durable base evidence, resume an intact branch non-destructively, rematerialize a lost copy, and make release idempotent. Never silently re-cut resumed work from a newer base. |
| `forge` | `forges` | `Forge` | Implement kernel-owned regular pushes, idempotent PR opening, PR-state projection, gated/ungated auto-merge behavior, head-guarded squash merge, and comments. Agents never receive forge credentials or push. `prAttachments` is an optional image-hosting capability; absence must preserve the supported text-only path. |

`BuildStore` and `BlobStore` contract types are exported for remote-server
authors, but BuildStore is **not** an in-process manifest map. Implement the
language-neutral `docs/remote-store-protocol.md` shipped with Autobuild and run
its conformance path instead. `TelemetrySource` is a frozen port type
with no plugin registration surface in this release.

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
} from 'autobuild/plugin-sdk'
import { AcmeForge } from '@acme/forge-client'

const createForge: ForgePluginFactory = ({ config, env, repoRoot }) => {
  const token = env.ACME_FORGE_TOKEN
  if (!token) throw new Error('ACME_FORGE_TOKEN is required')
  return new AcmeForge({ token, config, repoRoot })
}

export default {
  name: 'acme-forge',
  apiVersion: '^1.1.0',
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

Add the module specifier at the TOML root, before any table. Relative paths and
npm package specifiers resolve from the consuming repository:

```toml
plugins = ["./autobuild-plugin.ts"]
forge = "acme"

[tickets]
source = "file"
readyState = "ready"
```

Select only the adapters the repository uses. Set `forge = "acme"` for the
example forge above; set `[tickets].source`, `[workspace].provider`, or a
`[roles.*].runtime` to the matching registration name for the other ports.
Ticket plugins receive the existing strict `[tickets]` fields—there is no
untyped plugin-options table. Workspace plugins put adapter-owned settings only
under the open `[workspace.config]` table.

Plugin modules load in declaration order. Resolution/evaluation failure, a
missing or malformed default export, incompatible API range, or collision
fails before claims/builds. Builtin and earlier-plugin names cannot be
shadowed within one port; the same adapter name may exist on different ports.
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
  apiVersion: '^1.1.0',
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
by `autobuild/plugin-sdk`. The host invokes the unchanged shared suite; do not
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
import { FakeTicketSource } from 'autobuild/plugin-sdk'
import type {
  AutobuildPluginManifest,
  TicketSourceContractFactory,
  TicketSourcePluginFactory,
} from 'autobuild/plugin-sdk'

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
  apiVersion: '^1.1.0',
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

A representative package manifest is:

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
  "devDependencies": { "autobuild": "^2.0.0", "typescript": "^7.0.0" },
  "peerDependencies": { "autobuild": "^2.0.0" },
  "peerDependenciesMeta": { "autobuild": { "optional": true } }
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
