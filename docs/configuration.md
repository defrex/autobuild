# Configuration reference

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`.
Here, `ab <command>` means the repository-installed CLI; run it as
`bun ab <command>`, for example `bun ab init`.

Autobuild reads one declarative `autobuild.toml` from the repository root.
Commands in the file are shell strings; the file itself is never evaluated as
code. A running dispatcher owns an accepted snapshot from the main checkout,
while scoped phase commands read the build worktree's branch-owned file.
Configuration changes therefore move through review like any other change and,
once merged, can be adopted by the running dispatcher.

This document covers the complete accepted TOML surface. Follow the
[installation and repository setup procedure](setup.md) for the supported local
versus Vercel decision flow, credential checklist, reproducible provisioning,
and sessionless `ab init --validate` readiness check. Examples labelled as
fragments are intended to be added to an existing file; the [complete
example](#complete-example) is valid on its own.

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind.

## `[store]`

<!-- configuration-reference:store -->

#### `store`

**TOML key:** `store`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Optional remote BuildStore connection. Credentials live outside TOML.

**Constraints:** None beyond the input type.

#### `store.url`

**TOML key:** `store.url`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Absolute HTTPS service base URL; loopback HTTP is allowed for development. No credentials, query or fragment. Trailing slashes are normalized.

**Constraints:** Absolute HTTPS service URL; loopback HTTP allowed. No credentials, query or fragment. Trailing slashes normalized.

<!-- configuration-reference:/store -->

Selection is explicit `--store` > nonblank `AB_STORE` > `[store] url` > the main
checkout's `.autobuild/`. A configured service without a user credential fails
with `ab connect` guidance. `AB_TOKEN` overrides the saved service/project
credential. See [connecting a project](hosted-service.md#connect-a-project).
Changing the store requires restarting dispatch.

## Hosted service and PostgreSQL BuildStore environment

The optional `@defrex/autobuild-hosted-store-service` and its
`@defrex/autobuild-postgres-store` adapter are configured entirely through the
environment. They are published to npm as separate packages alongside the
`@defrex/autobuild` CLI, so a CLI install never acquires the service,
PostgreSQL, or blob-provider dependencies; a project that embeds the adapter
or the service adds the package it needs (`bun add
@defrex/autobuild-postgres-store` or `bun add
@defrex/autobuild-hosted-store-service`). The cron-driven hosted dispatcher is
separately published as `@defrex/autobuild-hosted-dispatcher`; a deployment
opts into building by installing that package, and its `AB_DISPATCHER_*`
variables are documented in the [hosted-dispatcher runbook](hosted-dispatcher.md),
not here. The deployable web application still
runs from a release checkout: choose the compatible tag shown in
[GitHub Releases](https://github.com/defrex/autobuild/releases), clone that exact
revision into a dedicated checkout, and run the idempotent migration there:

```sh
git clone --depth 1 --branch v0.6.0 --single-branch https://github.com/defrex/autobuild.git autobuild-v0.6.0
cd autobuild-v0.6.0
bun install --frozen-lockfile
DATABASE_URL=postgres://… bun run postgres:migrate
```

Replace `v0.6.0` with the selected release tag. Schema diagnostics' root
`postgres:migrate` script is relative to that pinned checkout. A hosted build
can run the same step itself: `bun run deploy:build` — run from the hosted
store service package directory (`packages/hosted-store-service`), the Next.js
project directory — migrates against the
deployment's database URL, logs the host it prepared, and then builds the web
application, failing the build when no database URL is configured or the
schema is incompatible. The database
identity needs permission to create tables during migration and to select,
insert, and update those tables at runtime. The complete run, deployment, and
token procedure is in the [hosted service
guide](../packages/hosted-store-service/README.md); clients use the
separate signed-user token described by the [operator API](operator-api.md).

| Variable | Required when | Values / purpose |
|---|---|---|
| `AB_STORE_SECRET` | Hosted service | Nonblank HMAC signing secret. Service-side only; never give it to clients. |
| `AB_HOST` | Optional, ordinary Bun host | Bind hostname; defaults to `0.0.0.0`. Vercel supplies its own listener. |
| `PORT` | Optional, ordinary Bun host | Integer 1–65535; defaults to `3000`. Vercel supplies its own listener. |
| `AB_STORE` | Remote client | Hosted service base URL used by the kernel, phase commands, and dashboard. |
| `AB_TOKEN` | Authenticated remote client | Explicit project bearer credential override for CI; otherwise use ab connect. This is not the signing secret. |
| `BETTER_AUTH_SECRET` | Web dashboard | Independent server-only session secret with at least 32 high-entropy characters. |
| `BETTER_AUTH_URL` | Web dashboard | Exact HTTP(S) origin, without credentials or a path; HTTPS is mandatory in production. |
| `GITHUB_CLIENT_ID` | GitHub sign-in | OAuth application client id. |
| `GITHUB_CLIENT_SECRET` | GitHub sign-in | Server-only OAuth application secret. |
| `AB_WEB_AUTH_PROVIDERS` | Web dashboard | Comma-separated provider set; currently exactly `github`. |
| `AB_WEB_SUPER_USER_EMAILS` | Web dashboard | Nonempty comma-separated super-user emails; matching is case-insensitive. Ordinary users require organization membership. |
| `AB_WEB_REPOSITORIES` | Hosted service | Deprecated once-per-database bootstrap CSV for the durable project registry. Use owner commands thereafter; see [connected projects](setup.md#connected-projects). |

GitHub's callback is `{BETTER_AUTH_URL}/api/auth/callback/github`; the app needs
the `user:email` scope (or GitHub App read-only email permission). Sessions are
database-backed and represented in the browser only by an HTTP-only cookie.
Membership or super-user removal takes effect on the next web API request or MCP tool call. Never expose these
secrets, `AB_STORE_SECRET`, database/blob credentials, machine tokens, or OAuth
account tokens through a `NEXT_PUBLIC_` variable.

The following variables configure the service-side durable adapter (or a direct
use of `@defrex/autobuild-postgres-store`).

| Variable | Required when | Values / purpose |
|---|---|---|
| `DATABASE_URL` | Always, unless `AB_POSTGRES_URL` is set | Nonblank PostgreSQL connection URL under its conventional name, as Vercel's Neon and Postgres storage integrations inject it. |
| `AB_POSTGRES_URL` | Optional override | Explicit Autobuild-specific connection URL; a nonblank value wins over `DATABASE_URL`. No other ambient variable is consulted. |
| `AB_BLOB_BACKEND` | Always | `s3` or `vercel`. |
| `AB_BLOB_PREFIX` | Optional | Object pathname prefix; redundant `/` characters are normalized. |
| `AB_S3_BUCKET` | S3 | Bucket name. |
| `AB_S3_REGION` | S3 | S3 signing region. |
| `AB_S3_ENDPOINT` | Optional, S3 | Endpoint URL for an S3-compatible service. |
| `AB_S3_ACCESS_KEY_ID` | S3 | Explicit access key; ambient AWS credential lookup is not used. |
| `AB_S3_SECRET_ACCESS_KEY` | S3 | Explicit secret key. |
| `AB_S3_SESSION_TOKEN` | Optional, S3 | Explicit temporary-credential session token. |
| `AB_S3_FORCE_PATH_STYLE` | Optional, S3 | Exact boolean `true` or `false`. |
| `AB_VERCEL_BLOB_ACCESS` | Vercel | `public` or `private`. |
| `BLOB_READ_WRITE_TOKEN` | Vercel auth option | Blob read-write token. |
| `VERCEL_OIDC_TOKEN` | Vercel OIDC option | Must be paired with `BLOB_STORE_ID` when no read-write token is supplied. |
| `BLOB_STORE_ID` | Vercel OIDC option | Must be paired with `VERCEL_OIDC_TOKEN`. |

S3 identities need `GetObject` and `PutObject` on the bucket/prefix. The adapter
maps only a provider 404 to absence and propagates authorization/service errors.
Vercel object names are deterministic and overwritten idempotently.

## Strict parsing and validation

Parsing is strict. Unknown top-level keys or tables, unknown fields in a known
table, fields from the wrong step variant, malformed values, and dangling
command references are errors. The open maps are `[commands]`, `[roles]`,
`[workspace.config]`, `[workspace.config.runtimeProvisioning]`,
`[verify.<step>]`, and `[finalize.<step>]`. Autobuild
validates repository-defined command, role, and step entries.
`[workspace.config]` is plugin-owned and passed through unchanged for plugin
providers; the builtin `git-worktree` provider requires it to be empty, while
`vercel-sandbox` interprets it as a closed, typed table.
Every other known table is closed to unknown keys.

There are three validation layers:

1. TOML syntax and schema/cross-field validation happen while
   `autobuild.toml` is loaded. Errors start with the file path and either
   `TOML syntax error` or `invalid config`; schema errors then identify paths
   such as `verify.acceptance.skill` or `tickets.teamKey`.
2. Configured plugin modules are resolved from the repository, evaluated,
   manifest-validated, checked for plugin-API compatibility, and registered
   before production adapters, stores, claims, or runners are started.
3. Runtime/model compatibility is checked eagerly after the configured
   adapters are wired. Its separate `invalid runtime/model configuration`
   error reports every incompatible declared role before a build launches.

Run `ab dispatch --once` from the repository to exercise production loading
and adapter validation. It is a real dispatcher pass, not a read-only linter,
so run it only when one intake/janitor tick is acceptable.

TOML does not return to the root after entering a table. Put root scalars before
the first table header; otherwise a value such as `capacity` becomes an unknown
field in whichever table precedes it.

## Reloading a running dispatcher

A long-running `ab dispatch` watches the main checkout's `autobuild.toml` and
checks it before every dispatch tick. A valid save is adopted within that tick.
In origin mode (`ab dispatch --repository <origin>`, no checkout) the same
cadence reads `autobuild.toml` from the forge at the current `baseBranch`
instead: a push to the base branch is honored by a later tick without
restarting anything. Hot fields apply immediately; restart-classified fields
keep the startup-built adapters and file the existing restart-required notice
(a long-lived origin-mode watch picks them up on its next process restart;
the hosted cron entry point re-reads them on every invocation).
Each dispatch, build, check, or agent action captures the accepted configuration
snapshot at its start boundary: work already running is not interrupted, while
the next setup or pipeline step of the same in-flight build uses the new
snapshot. Raising capacity can fill the new slots immediately; lowering it
prevents new claims without terminating builds already above the limit. `ab
dispatch --once` performs one pass and does not watch or reload.

The sections `autobuild.toml` delivers to a build fall into three ownership
classes. **Build-owned** sections define the pipeline a build runs — `[verify]`
with `[verify.<step>]`, `[finalize]` with `[finalize.<step>]`, `[commands]`,
and `[workspace]` (provider and config, including `provisioning` and
`runtimeProvisioning`). They are pinned to the build's own branch: the
dispatcher reads them at the build's recorded base commit, or at its branch
head once the build has published commits, and records the exact commit in the
effective-config artifact metadata. In checkout mode the worktree read is the
exception: when it cannot be attributed to the branch-head commit — because
the worktree file has uncommitted edits, because the clean/dirty comparison
could not be performed (non-git workspace or a transient git error), or because
the branch head never carried the file — the deposit records the source
`worktree-dirty` with no commit. The build still runs the worktree bytes, but
provenance declines to attribute them to any commit. **Deployment-owned** sections — `[roles]`
(runtime, model, args, alternates, per-role `sessionBudgetSeconds`) and
`[policy]` — keep flowing live. **Dispatcher-owned** sections (`baseBranch`,
`capacity`, `ticketScanIntervalSeconds`, `forge`, `plugins`, `pr`, `tickets`, `orchestrator`) configure the
dispatcher itself and are never interpreted by the build runner.

Consequently, an accepted base-branch reload re-deposits only the
deployment-owned sections to active builds; it does not retarget an in-flight
build's verify universe, finalize steps, commands, or provisioning. A build
that receives a pipeline change in its checkout picks it up at the next
settled verify boundary. In-flight environments are never re-provisioned: a fresh build
from the new base is the path for a changed provisioning definition.

At every verify-cycle entry, after restack or reconcile settles, the runner
reads `autobuild.toml` from the execution checkout at resolved `HEAD` (including
detached integration heads). `verify.config-captured` cites an immutable
`verify-cycle-config` artifact revision, checkout head, build-owned content
identity and truthful source metadata. Dirty worktree bytes carry
`worktree-dirty` without a commit. A settled stage boundary rechecks the
build-owned sections and the known source commit's ancestry. A change or
non-ancestor source records `verify.config-superseded` and starts a fresh cycle
before constructing any further member. Already launched siblings settle first.
A waiting leaf with completed verification retains its receipts after a clean
rewrite when build-owned config is unchanged, even when the rewrite replaces
the pin commit's ancestry. Changed config still supersedes while waiting; a
future verification cycle always captures fresh config before running steps.
Old pass/skip receipts cannot satisfy that cycle, and supersession creates no
failure or failure-budget charge. Unchanged config on a descendant head retains
its pin; every new cycle still rereads the checkout. Read, parse and Git evidence
failures block verification as infrastructure failures. Recovery and readiness
read the capture's exact revision, so a concurrent deployment reload cannot
replace its build-owned sections. Historical streams capture before further
verification. Deployment-owned reloads remain live; environments are not
re-provisioned.

Every accepted revision is deposited verbatim as a `dispatcher-config`
repository artifact and referenced by a `dispatcher.config-reloaded` repository
event. The dashboard reports the reload and reprojects values such as capacity;
plain watch mode writes the reload notice to stdout. A missing or unreadable
file, invalid syntax or schema, or invalid runtime routing is a rejected
candidate: it cannot replace or partially modify the last valid snapshot. The
dispatcher keeps that snapshot active, reports an actionable notice in the
dashboard notice row or on plain-mode stderr, and suppresses repeats while the
same failure remains. Restoring `autobuild.toml` with valid configuration clears
the rejection and ordinary live reload resumes without a dispatcher restart.

Dispatcher merge readiness, startup resume, and execution recovery use the same pinned
commands, verify, and finalize configuration as the build runner. Missing pins retain
the legacy live-configuration fallback.

These fields hot-reload:

| Field or table | Boundary where a new value applies |
|---|---|
| `baseBranch` | Next dispatch or base fallback decision; existing `build.created` facts remain immutable. |
| `ticketScanIntervalSeconds` | Next tick; evaluates elapsed time against the new interval. |
| `capacity` | Next dispatcher tick. |
| `[pr]` | Next build creation. |
| `[landing]` (ordered `[[landing]]` rules) | Dispatcher-owned policy; next new readiness decision. Existing decisions retain their sampled rule. |
| `[commands]` | Next setup, verify check, or finalize check selected for a build whose OWN branch carries it. Dispatcher readiness, resume, and recovery use the same pin. A base-branch reload does not retarget an in-flight build. |
| `[verify]` and `[finalize]` | Next engine step selection for a build whose OWN branch carries it. Dispatcher readiness, resume, and recovery use the same pin. An approved plan's selection applies unless unknown names require default-all fallback, and a base-branch reload does not retarget an in-flight build. |
| `[workspace]` provider and config (including `provisioning`) | Next launch of a build whose OWN branch carries it. A base-branch reload never re-provisions an in-flight build. |
| `[roles]` | Next agent invocation for that role. Runtime, model, args, alternates, and the session budget are captured together and delivered live. |
| `[upgrade]` | Cancels preparation when disabled; automatic target checks every 60 seconds. |
| `[policy]` | Next policy, convergence, or agent-session boundary, delivered live. A running session keeps its captured budget. |
| `tickets.readyLabels`, `tickets.readyState`, `tickets.readyAssignee` | Next ready-ticket scan. |
| `tickets.triageState`, `tickets.proposalState` | Next dispatcher handback or harvest filing boundary. |

Adapter selectors and factory inputs are constructed once and require a
restart. A valid save may still apply its hot fields, but these changed paths
remain pinned to their startup values and are reported explicitly:

| Restart-required field | Reason |
|---|---|
| `store` | Store selection and project authority are fixed when dispatch starts. |
| `plugins` | Plugin modules and registration catalogs load before wiring. |
| `forge` | Selects the constructed Forge adapter. |
| `workspace.provider`, `workspace.config` | Select and configure the constructed workspace provider. |
| `tickets.source`, `tickets.teamKey`, `tickets.claimedState`, `tickets.createState`, `tickets.dir` | Select or configure the constructed TicketSource. |
| `orchestrator` | Tool availability and the dispatcher's sandbox idle settlement are startup-constructed. |

The dispatch process reads the main checkout because it owns repository intake.
Scoped phase commands still read the build worktree's `autobuild.toml`; this is
the existing build-context boundary and is not unified by hot reload.

Regenerate the schema-derived field blocks with `bun run docs:configuration`.
`bun run check` rejects drift or missing field descriptions. Prose outside the
generated markers is maintained by hand. Defaults below are parser input defaults;
resolver inheritance is described separately. Nested required fields are required
when their containing table or array entry is supplied.

## Root scalars

All root scalars are optional and receive defaults. They must appear before
any table header.

<!-- configuration-reference:root -->

#### `baseBranch`

**TOML key:** `baseBranch`

- **Type:** `string`
- **Default:** `"main"`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Branch used to cut builds, target PRs, and merge during reconciliation.

**Constraints:** minimum length 1

#### `capacity`

**TOML key:** `capacity`

- **Type:** `number`
- **Default:** `1`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Concurrent occupied slots for this repository. Paused and blocked work retains slots. Node reconcile and verification exclude their own blocked/paused descendants at admission; new claims use total occupancy. See [integration capacity](integration-tree.md).

**Constraints:** safe integer; > 0

#### `ticketScanIntervalSeconds`

**TOML key:** `ticketScanIntervalSeconds`

- **Type:** `number`
- **Default:** `60`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Ticket-source ready scan cadence; tick spacing is the effective minimum.

**Constraints:** safe integer; > 0

#### `forge`

**TOML key:** `forge`

- **Type:** `string`
- **Default:** `"github"`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Forge adapter name. Shipped values are `github` and `local-git`; configured plugins may register other names.

**Constraints:** forge adapter name must be nonblank

#### `plugins`

**TOML key:** `plugins`

- **Type:** `array of string`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Trusted Bun plugin modules loaded by dispatch, `ab ticket`, and scoped phase CLI processes.

**Constraints:** Exact module specifiers must be unique.; Each item: plugin module specifiers must be nonblank

<!-- configuration-reference:/root -->

Ticket-source ready scans run immediately when no completed measurement exists,
then every
`ticketScanIntervalSeconds` (default 60 seconds, a positive integer). Actual
tick spacing is the floor when the configured interval is shorter. A
same-repository `pr.merged`, `build.completed`, or `build.aborted` fact forces
another scan on the next tick; changed ready criteria also force a scan.
Housekeeping keeps its ordinary tick cadence. Between scans, queue depth and
standing diagnostics repeat the last completed measurement, including across
process restarts. Tickets groomed directly in the tracker are picked up within
one scan interval plus one tick when capacity permits. Observation while intake
is off shares the cadence; an observation measurement cannot suppress a fresh
admission scan when intake is enabled.

### Plugin modules

<!-- config-fragment:plugins -->
```toml
plugins = ["./plugins/company.ts", "@acme/autobuild-plugin"]
```

Repository-path specifiers (relative, absolute, and `file:`) resolve from the
root whose config is being read. In a scoped phase process that root is the
immutable build worktree. Bare npm package specifiers resolve first from the
consuming repository's main checkout and therefore use its installed
dependencies; a package the repository lacks then resolves from Autobuild's own
installation as a fallback. Install extensions in the consuming repository with
`bun add -d --exact @defrex/autobuild-<extension>`. A
repository copy always wins over an installed one. This package lookup remains
stable when a relocated local store places a linked worktree outside the
checkout. Dispatch and sessionless commands use the main checkout for both
repository roots. `ab plugin list` reports which root satisfied each package
(`from=repository` or `from=installation`). Missing packages fail loading;
Autobuild does not install them.

Every configured specifier string must be unique. An exact repeat fails schema
validation before any plugin resolves or evaluates; the diagnostic identifies
the repeated value and both list positions and asks you to remove or
deduplicate the entry. Distinct specifier strings remain separate declarations.
Each module must default-export a strict manifest with a plugin name, a semver
range in `apiVersion`, and optional `ticketSources`, `agentRuntimes`,
`workspaceProviders`, and `forges` factory maps. One manifest may contribute to
several ports.

Plugin modules execute in-process during `ab dispatch`, sessionless `ab ticket`
commands, and configured scoped phase CLI composition. They have the same trust
as repository-supplied commands;
there is no sandbox. A missing module, module
that throws, malformed manifest, incompatible API range, or adapter-name
collision fails startup before a ticket claim. Builtin names and names from
earlier configured plugins are reserved, and declaration order never permits
shadowing. A collision between distinct plugin declarations continues to name
the conflicting adapter and both owners.

Two transitional downgrade paths announce themselves instead of failing
startup (AUT-517). First, while the builtin hosts the `vercel-sandbox`
implementation, a configured plugin that re-registers that workspace-provider
name — `@defrex/autobuild-vercel-sandbox` is exactly such a plugin — is
skipped with a one-line notice and the builtin keeps serving the provider:

```text
plugin "autobuild-vercel-sandbox" declares only builtin workspace-provider registration(s) "vercel-sandbox"; skipping it — the builtin keeps serving the provider
```

The skip applies only when the manifest declares at least one registration,
only workspace-provider registrations, and every declared name collides with
a builtin registration; any other collision still throws. The rule keys on
builtin ownership, so it retires itself when the builtin is removed and a
second plugin registering the name collides and fails startup as always.
`ab plugin list` and `ab plugin doctor` show skipped modules as `SKIP` lines
and exit 0. Second, guest processes (build and harvest children,
`ab init`'s guest readiness probe, and scoped phase CLI commands) tolerate a
configured bare package specifier they cannot resolve — guests never
construct workspace providers, so a provider plugin they need not load is
skipped with a notice instead of failing the process:

```text
plugin module "@defrex/autobuild-vercel-sandbox" could not be resolved from repository "…" or installation "…"; guests never construct workspace providers, so the provider plugin is skipped here
```

Repository-path specifiers and every post-resolution failure (evaluation,
manifest, collision) stay fail-closed everywhere, including guests. The guest
readiness probe surfaces a resolution-stage skip in its `configuration and
plugins` check detail: the detail names the missing module (the skip notice
quoted above) and the remediation — add the package to the repository's
dependencies so it resolves from the repository install during
`commands.setup`.

Plugin authors import the stable surface from `@defrex/autobuild/plugin-sdk`, normally
with `import type`, and can develop against Autobuild as a dev/peer dependency
without adding a runtime Autobuild dependency to the plugin. That entry point
exports the manifest/factory types, port types, fake adapters, and reusable
TicketSource, AgentRunner, WorkspaceProvider, Forge, BuildStore, and BlobStore
contract suites. Adapter values may use the backward-compatible bare factory or
carry a contract fixture descriptor.
TicketSource adapters must populate the required `Ticket.resolved` boolean on
listReady, get, and create projections, using the same native lifecycle rules as
`dependencyStates`. Plugin authors upgrading older adapters must add this field;
ready-state membership does not imply that a ticket is unresolved. Dispatch
reuses these facts only within the current tick. Ticket sources may also declare
`requiredEnv`; the host checks every declared variable for a nonempty value
before invoking the adapter factory. Plugins using Forge abort-cleanup and
AgentRunner turn-cancellation capabilities introduced in API 1.2 should require
`^1.2.0`. The structured failure `cause` and provider-exhaustion contract
scenario were added in API 1.3; a runtime plugin that relies on them should
require `^1.3.0`. API 1.4 adds the optional `Ticket.creationKey` projection: a
ticket-source plugin should return its stable external create/adoption key from
create, get, and ready listings so dispatch can correlate Autobuild's durable
in-flight creations. Legacy tickets may omit it and remain dispatchable.
API 1.6 adds workspace-provider capability declarations: a
`workspaceProviders` registration may carry a `capabilities` object declaring
its `[workspace.config]` schema (or an outright refusal), required runtime
provisioning, supported forges, required environment groups (with per-site
messages), variables that must exist in the launcher process environment,
additional operator-sandbox forbidden variable names, HTTPS/token store
requirements, an origin validator, and a remote readiness validation for
`ab init --validate`. The host enforces every declared capability at its seam
without naming the provider; required environment belongs on
`capabilities.requiredEnv` (a descriptor-level `requiredEnv` is rejected at
manifest parse), and each `capabilities.requiredEnv` group must declare at
least one of `dispatchMessage` / `validationMessage` — a group with neither is
rejected at manifest parse, because the host would silently skip it at both
enforcement sites. API 1.7 extends the workspace-provider factory context with
the host-derived seams: `storeRef` and `delegateCredential` (guaranteed present under
`capabilities.storeRequirements`), `runtimeReferences`, and the checkout-less
`origin` and `remoteBranchHead` readers, all optional and ignored by factories
that do not read them. A plugin reading the new seams should require `^1.7.0`.

```ts
import type { AutobuildPluginManifest } from '@defrex/autobuild/plugin-sdk'

export default {
  name: 'acme-integrations',
  apiVersion: '^1.2.0',
  ticketSources: {
    jira: {
      requiredEnv: ['JIRA_TOKEN'],
      factory: ({ config, env, repoRoot }) => createJira(config, env, repoRoot),
      contract: {
        // Return the TicketSourceContractFactory consumed by the shared suite.
        factory: ({ env }) => makeJiraContractFactory(env),
        live: true,
      },
    },
  },
} satisfies AutobuildPluginManifest
```

Use the sessionless authoring loop from the repository checkout:

```sh
ab plugin list
ab plugin doctor
ab plugin test ticket-source jira
AB_RUN_LIVE_PORT_CONTRACTS=1 ab plugin test ticket-source jira
```

The four test port tokens are `ticket-source`, `agent-runtime`,
`workspace-provider`, and `forge`. `list` includes builtins and successful
plugin registrations with module, resolved path/kind, owner, API status, and
contract availability. `doctor` attempts every configured module in declaration
order, reports each resolution/evaluation/manifest/registration result, and
exits nonzero if any fail. Dispatch intentionally differs: it stops on the
first plugin failure before opening stores or claiming work. `test` invokes one
unchanged shared suite under `bun test`; Bun's per-test output and exit status
are authoritative. A missing `contract.factory` is an actionable error. A
`live = true` descriptor cannot launch or create its harness unless
`AB_RUN_LIVE_PORT_CONTRACTS=1` is explicitly set. Plugin authors should run the
corresponding contract suite against every adapter, including
`describeAgentRunnerContract` for each runtime.

Ticket-source, forge, workspace, and agent-runtime selection are open. Set
`[tickets].source`, the root `forge` scalar, `[workspace].provider`, or any
`[roles.*].runtime` to a registered name; omission selects the builtin defaults
where applicable. A selected plugin forge factory receives an empty
adapter-specific `config` object, while a workspace factory receives
`[workspace.config]`; both receive the process environment and absolute
repository root and are invoked lazily after the complete plugin catalog loads.
Unknown names fail with the available names for that port, and factory failures
are contextualized with the adapter and plugin names. Scoped build-session CLI
processes repeat forge config/plugin loading from the build worktree, so phase
terminal plumbing uses the same configured forge. The returned forge is not
wrapped: an absent `prAttachments` capability intentionally selects text-only
attachment summaries, while a present capability serves upload and terminal
reclamation.

Plugin runtimes receive empty adapter config, the process environment, and the
absolute repository root. They participate in the same eager exact-name,
model-family, and default-model role validation as builtins, and their
registration key is used for session event and transcript attribution. A
runtime's optional one-shot capability serves slug naming and lazy upgrade
conflict resolution; when absent, each caller retains its existing safe
fallback.

## `[[landing]]`

An ordered list of strict landing rules. Predicates within one rule are ANDed;
the first matching rule wins. Omitted predicates match everything. With no
matching rule, leaves default to `auto` and nodes to `consent`.

<!-- configuration-reference:landing -->

#### `landing`

**TOML key:** `landing`

- **Type:** `array of strict table`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Ordered landing rules; the first matching rule controls consent.

**Constraints:** None beyond the input type.

#### `landing[].into`

**TOML key:** `landing[].into`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Optional destination: `root`, any `node`, or an exact frozen destination node ticket id.

**Constraints:** into must be root, node, or a nonblank node ticket id

#### `landing[].from`

**TOML key:** `landing[].from`

- **Type:** `"leaf" | "node"`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Restrict this rule to one source build kind; omission matches all kinds.

**Constraints:** None beyond the input type.

#### `landing[].label`

**TOML key:** `landing[].label`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Optional exact, case-sensitive label on the source ticket. Blank labels are invalid.

**Constraints:** label must be nonblank (labels match exactly, including case)

#### `landing[].mode`

**TOML key:** `landing[].mode`

- **Type:** `"auto" | "consent"`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Choose automatic landing or require recorded consent.

**Constraints:** None beyond the input type.

<!-- configuration-reference:/landing -->

For example, put a rule with `into = "root"` and `mode = "consent"`
before a catch-all rule with `mode = "auto"` to request consent only at the
root. A catch-all placed first shadows every later rule. Specific-node rules
match the build's frozen destination, rather than the ticket's current parent.

A readiness decision retains the complete matched rule and index (or an explicit
default), source kind, destination and sampled labels. Later policy edits do not
rewrite this provenance. Landing policy belongs to the live dispatcher config;
it is excluded from pinned pipeline settings and integration verification inputs.
See [worked landing configurations and forge requirements](landing-policy.md),
[operating controls](#landing-policy), and
[migration from 0.x](migration-1.0.md).

## `[pr]`

Optional. Omitting the table leaves attachment hosting off; attached artifacts
still receive exact BuildStore download commands in the PR summary.

<!-- configuration-reference:pr -->

#### `pr`

**TOML key:** `pr`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Pull request review image hosting configuration.

**Constraints:** None beyond the input type.

#### `pr.imageHost`

**TOML key:** `pr.imageHost`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Copy attached images to a temporary public review location so they can render inline.

**Constraints:** None beyond the input type.

<!-- configuration-reference:/pr -->

### `[pr.imageHost]`

<!-- configuration-reference:pr-imageHost -->

#### `pr.imageHost.provider`

**TOML key:** `pr.imageHost.provider`

- **Type:** `"github-release"`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Select the GitHub release adapter.

**Constraints:** None beyond the input type.

#### `pr.imageHost.repository`

**TOML key:** `pr.imageHost.repository`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Public repository containing the existing review release.

**Constraints:** matches /^[^/\s]+\/[^/\s]+$/

#### `pr.imageHost.releaseId`

**TOML key:** `pr.imageHost.releaseId`

- **Type:** `number`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Numeric id of an existing published, mutable release.

**Constraints:** safe integer; > 0

<!-- configuration-reference:/pr-imageHost -->

This optional nested table selects the one shipped image-host adapter. If the
table exists, all three fields are required.


<!-- config-fragment:image-host -->
```toml
[pr.imageHost]
provider = "github-release"
repository = "acme/public-review-assets"
releaseId = 123456
```

Agents opt in one artifact at a time with
`ab artifact put <kind> <file> --attach`. Every designation remains available
through a pinned `ab artifact download <build> <kind>@<rev> --output <file>`
command. With an image host configured, only normalized `image/*` attachments
are copied and rendered inline; non-images remain text-download-only.

The repository must be public because GitHub renders release assets without
authentication. A private source repository can name a separate public asset
repository. Autobuild creates no repository, release, or tag. The release must
already be published and mutable, and the `gh` identity running Autobuild needs
Contents write permission there. Obtain a release's numeric id with, for
example:

```sh
gh api repos/acme/public-review-assets/releases/tags/review-window --jq .id
```

Configuring this table is an explicit temporary-public-disclosure opt-in.
Hosted copies are deleted after `build.completed`; failed deletions remain
durable and retry on later dispatcher ticks. Upload, target-validation, and
timeout failures create follow-up observations but preserve every text download
command and do not fail verification or finalize. BuildStore artifacts remain
the authoritative copies under the store's own retention policy — dispatcher
run/config artifact kinds keep their latest 200 revisions
(`AB_ARTIFACT_RETENTION_MAX_REVISIONS` overrides the bound); other kinds are
never pruned.

## `[workspace]`

Optional. Omission preserves the shipped git-worktree behavior. The surrounding
table is strict; only the explicit nested `config` table is plugin-owned.

<!-- configuration-reference:workspace -->

#### `workspace`

**TOML key:** `workspace`

- **Type:** `strict table`
- **Default:** `{} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Workspace provider selector and provider-specific configuration.

**Constraints:** None beyond the input type.

#### `workspace.provider`

**TOML key:** `workspace.provider`

- **Type:** `string`
- **Default:** `"git-worktree"`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Select the provider used for provisioning, recovery, PR epilogue working-directory calls, and release.

**Constraints:** [workspace].provider must be a nonblank provider name

#### `workspace.config`

**TOML key:** `workspace.config`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Adapter-specific declarative configuration passed unchanged to the selected plugin factory.

**Constraints:** Entry names: any; provider = "git-worktree": [workspace.config] is not supported by the builtin "git-worktree" provider — remove it or select a plugin workspace provider

#### `workspace.config.<name>`

**TOML key:** `workspace.config.<name>`

- **Type:** `plugin-owned TOML value`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Plugin-owned value passed through unchanged. Builtin providers validate their own declared schema.

**Constraints:** None beyond the input type.

<!-- configuration-reference:/workspace -->

<!-- config-fragment:workspace -->
```toml
[workspace]
provider = "company-container"

[workspace.config]
image = "ghcr.io/acme/build:bun"
writableCache = true
```

The builtin `git-worktree` provider needs no table and accepts no adapter
configuration. A plugin factory receives exactly `[workspace.config]`, the
process environment, and the absolute repository root. Every declared key
reaches the factory verbatim. Factory invocation is lazy; unknown names fail
before claims and list every available builtin and plugin provider.

### Vercel Sandbox

Remote execution is explicit and requires the hosted HTTPS BuildStore plus its
scoped token, an HTTPS `github.com/owner/repository` origin, `forge = "github"`,
and Vercel authentication. Use either `VERCEL_OIDC_TOKEN`, or all of
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. The dispatcher also
requires a push-capable `GITHUB_TOKEN` or `GH_TOKEN`; this is validated before
ready tickets are listed or claimed. Keyring-only `gh auth login` is not enough
because publication injects the credential through Vercel's network transform.

<!-- config-fragment:workspace-vercel -->
```toml
[workspace]
provider = "vercel-sandbox"

[workspace.config]
image = "vercel/sandbox/universal:latest"
vcpus = 4
timeoutSeconds = 2700
operationTimeoutMs = 30000
snapshotExpirationSeconds = 86400
region = "iad1"
failoverRegions = ["sfo1"]
environmentVariables = ["AI_GATEWAY_API_KEY"]
provisioning = [
  { name = "system-install", command = """apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y chromium""" },
  { name = "browser-smoke", command = "CHROMIUM_BIN=/usr/bin/chromium ./scripts/browser-smoke.sh" },
]
# Private repositories only:
gitUsernameEnv = "AB_GIT_READ_USER"
gitPasswordEnv = "AB_GIT_READ_TOKEN"

[workspace.config.runtimeProvisioning.pi]
install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"
preflight = "test \"$(pi --version)\" = \"0.84.4\" && pi update --models"
```

<!-- configuration-reference:workspace-vercel-sandbox -->

#### `workspace.config`

**TOML key:** `workspace.config`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Strict Vercel workspace provisioning configuration.

**Constraints:** Environment variable and failover region lists must be unique. Failovers exclude the primary region. Provisioning names must be unique. Clone credential names must be configured together, excluded from runtime environmentVariables, and separate from Forge and Vercel credentials.

#### `workspace.config.image`

**TOML key:** `workspace.config.image`

- **Type:** `string`
- **Default:** `"vercel/sandbox/universal:latest"`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Managed image used to provision the workspace.

**Constraints:** Autobuild Bun provisioning is validated only on the vercel/sandbox/universal managed image; use its bare name, a tag, or a sha256 digest containing exactly 64 lowercase hexadecimal characters

#### `workspace.config.vcpus`

**TOML key:** `workspace.config.vcpus`

- **Type:** `number`
- **Default:** `4`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Virtual CPUs allocated to each workspace; provider account limits may further restrict allocation.

**Constraints:** safe integer; ≥ 1; ≤ 32

#### `workspace.config.timeoutSeconds`

**TOML key:** `workspace.config.timeoutSeconds`

- **Type:** `number`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** VM/session lifetime in seconds and abrupt-orphan bound. Provider plan limits also apply.

**Constraints:** safe integer; ≥ 60; ≤ 86400

#### `workspace.config.operationTimeoutMs`

**TOML key:** `workspace.config.operationTimeoutMs`

- **Type:** `number`
- **Default:** `30000`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Deadline in milliseconds for each provider acknowledgement, independent of session lifetime.

**Constraints:** safe integer; ≥ 1000; ≤ 300000

#### `workspace.config.snapshotExpirationSeconds`

**TOML key:** `workspace.config.snapshotExpirationSeconds`

- **Type:** `number`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Snapshot expiration in seconds. Omission uses the provider expiration policy.

**Constraints:** safe integer; ≥ 300; ≤ 2592000

#### `workspace.config.region`

**TOML key:** `workspace.config.region`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Primary region; omission uses the provider region selection.

**Constraints:** minimum length 1

#### `workspace.config.failoverRegions`

**TOML key:** `workspace.config.failoverRegions`

- **Type:** `array of string`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Ordered alternative regions used if the primary region cannot provision a workspace.

**Constraints:** Each item: minimum length 1

#### `workspace.config.environmentVariables`

**TOML key:** `workspace.config.environmentVariables`

- **Type:** `array of string`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** unique API-credential variable names copied into runtime and agent/check commands

**Constraints:** Each item: matches /^[A-Za-z_][A-Za-z0-9_]*$/

#### `workspace.config.provisioning`

**TOML key:** `workspace.config.provisioning`

- **Type:** `array of strict table`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** ordered strict inline tables `{ name, command }`; names and commands are nonblank and names are unique

**Constraints:** None beyond the input type.

#### `workspace.config.provisioning[].name`

**TOML key:** `workspace.config.provisioning[].name`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Unique provisioning step name. Must contain a non-whitespace character.

**Constraints:** provisioning step name must be nonblank

#### `workspace.config.provisioning[].command`

**TOML key:** `workspace.config.provisioning[].command`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Shell command executed in declaration order during provisioning. Must contain a non-whitespace character.

**Constraints:** provisioning step command must be nonblank

#### `workspace.config.runtimeProvisioning`

**TOML key:** `workspace.config.runtimeProvisioning`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** open map keyed by every effective role/alternate runtime; each entry requires `install` and `preflight`

**Constraints:** Entry names: nonblank

#### `workspace.config.runtimeProvisioning.<name>`

**TOML key:** `workspace.config.runtimeProvisioning.<name>`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Installation and preflight commands for an effective runtime. Every effective role or alternate runtime must have an entry.

**Constraints:** None beyond the input type.

#### `workspace.config.runtimeProvisioning.<name>.install`

**TOML key:** `workspace.config.runtimeProvisioning.<name>.install`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** required nonblank shell command; use an immutable package version, digest, or commit

**Constraints:** install must be nonblank

#### `workspace.config.runtimeProvisioning.<name>.preflight`

**TOML key:** `workspace.config.runtimeProvisioning.<name>.preflight`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** required nonblank shell command; verify the expected executable and exact version

**Constraints:** preflight must be nonblank

#### `workspace.config.gitUsernameEnv`

**TOML key:** `workspace.config.gitUsernameEnv`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** optional variable name for the dedicated read-only clone username; requires `gitPasswordEnv`

**Constraints:** matches /^[A-Za-z_][A-Za-z0-9_]*$/

#### `workspace.config.gitPasswordEnv`

**TOML key:** `workspace.config.gitPasswordEnv`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** optional variable name for the dedicated read-only clone password; requires `gitUsernameEnv`

**Constraints:** matches /^[A-Za-z_][A-Za-z0-9_]*$/

<!-- configuration-reference:/workspace-vercel-sandbox -->

`snapshotExpirationSeconds` is a billing safety net: snapshot cleanup normally
purges on release, but a crash that loses the workspace before cleanup can
strand snapshots that hold billed storage until Vercel's 30-day default expiry.
A configured bound ages those stranded snapshots out instead. Omitting the key
keeps today's behavior (the provider default), and `0` ("no expiration") is
rejected because never-expiring snapshots would contradict the setting's
purpose.

Each `[workspace.config.runtimeProvisioning.<runtime>]` entry is strict:


Runtime names are not a built-in enum. Plugin registrations work with the same
map, for example `[workspace.config.runtimeProvisioning.opencode]` with a pinned
plugin-owned install command and its executable/version preflight.

The built-in adapter supports only Vercel's
`vercel/sandbox/universal` managed image, selected by its bare/default name, a
tag, or a digest. Other managed images and arbitrary VCR images are rejected at
configuration load because their package tools, libc/CPU, and filesystem
contract have not been validated. The universal image must retain working
Node/npm, `sh`, and the ordinary writable filesystem layout. Autobuild does not
rely on image-preinstalled Bun: on each fresh sandbox it uses npm to install the
pinned `bun@1.4.0` package under `/opt/autobuild-runtime`, verifies that exact
executable with `--version`, and uses it for Autobuild and Bun-lockfile
dependency installation. Package-registry network access is therefore required
during provisioning. The child launch prepends the adapter-owned Bun directory
to `PATH`, so setup, checks, agents, and their descendants resolve the same Bun.

`provisioning` is repository-owned declarative data; Autobuild never evaluates
configuration as code. After pinned Bun is verified, each command runs serially
as `sh -c <command>` with provider `sudo: true` and
`/vercel/sandbox/workspace` as its working directory. Distribution installation,
lockfile dependency bootstrap, `[commands].setup`, and every agent session occur
after these system steps. Put system packages here, not in repeated setup.
Commands that need a browser should set the repository-controlled location,
for example `CHROMIUM_BIN=/usr/bin/chromium bun test`; the example's checked-in
`scripts/browser-smoke.sh` must start a local dev server, launch
`"$CHROMIUM_BIN" --headless` against it in the same guest, verify the rendered
page, and exit nonzero on failure.

The private-repository token must grant repository contents read and no
contents write. It must be distinct from Forge and Vercel credentials and may
not also appear in `environmentVariables`. Autobuild gives its firewall broker
only exact upload-pack GET/POST matchers, scrubs origin credentials, credential
helpers, and extra headers after clone, and gives normal sessions no Forge
credential. After Bun verification, every declared system step runs before the
Autobuild distribution and dependency bootstrap. Then runtime provisioning runs
each referenced runtime's `install` and `preflight` commands in sorted
runtime-name order from the checkout. Only `environmentVariables` values enter
runtime commands. The same sequence runs in fresh readiness sandboxes and every
replacement sandbox. Provisioning writes its readiness marker only after all
scrubbing, Bun verification, system steps, distribution installation,
dependency bootstrap, and runtime preflights complete; distribution
packing/install disables package lifecycle scripts so
checkout-only hooks such as Husky are not provisioning dependencies. A Bun
install or verification failure identifies the configured image and expected
universal-image capabilities, deletes the partial environment, and leaves no
readiness marker. A retry also deletes any named sandbox without that marker
instead of adopting partial setup. The installed distribution's identity — package version, remote-store
protocol version and SHA256 of the exact installed archive — is recorded in the guest's
`/opt/autobuild/.distribution-version` marker; a reused sandbox whose marker
no longer matches the identity the current system would deliver is refreshed
by reinstalling the archive before reuse, so an upgraded dispatcher retrofits
its persistent guests. Cached registry generations deliver their own manifest
version’s validated GitHub release asset, resolved on first guest use and cached
separately from the normalized host archive. Local launches need no asset fetch; source generations deliver exact packed source bytes (see "Guest distribution version selection and delivery"
in docs/setup.md for the release-and-upgrade delivery path and the hosted
store's supported client window). Immediately
before every build-child launch, the adapter verifies the
provisioned absolute Bun executable and every referenced runtime again. A
failure names the runtime, selecting role/alternate, stage, and provisioning
field, launches no child, and asks you to fix/reprovision. This
fails closed for stale marked snapshots. Runtime installation is deliberately
separate from `[commands].setup`, which starts inside the runner and cannot make
the runtime available before the first agent session. Branch publication is
requested durably, then performed by the
local supervisor only after the remote command exits, the VM is stopped, and
the execution lease is released. The supervisor uses a narrow credential
transform for a fixed non-force push and verifies the remote head before
recording completion; PR API work stays local. If that acknowledgement is lost
after the push lands, the next launch observes the exact remote branch head and
records the missing completion before allowing a replacement phase to run. If
the commit is absent, release of the old workspace abandons its request and the
replacement reruns the phase. Before every guest runner launch, the provider
reasserts the normal receive-pack-free policy, so a failed policy
restore cannot expose publication authority to later setup or plugin code.
Ordinary completion deletes the sandbox.

A Vercel VM is disposable, not durable build state. Every execution records its
Autobuild instance, deterministic sandbox name, and Vercel session id. After a
lease expires, recovery first stops/deletes the exact old name and confirms its
absence; only then does it provision the next generation. An interrupted create
is retried with the same deterministic generation/name, so an unknown response
cannot fan out duplicate VMs. Recovery uses the published build branch when it
exists and otherwise the original recorded branch-cut SHA, never a newly moved
base. Setup reruns and open sessions are reclaimed by the normal durable
protocol. Uncommitted files and `.ab` scratch may be lost; Store events/artifacts
and published Git checkpoints remain authoritative.

Paused and policy-blocked builds release their sandbox after the execution
lease expires. Resume creates a replacement and reruns setup. Graceful shutdown
bounds stop/delete calls by `operationTimeoutMs`; an unknown acknowledgement
keeps ownership fenced until lease expiry and is retried visibly. After abrupt
supervisor loss, Vercel's configured `timeoutSeconds` bounds orphan compute, and
the next dispatcher waits for lease expiry before exact-name cleanup. Provider
quota/vCPU/duration messages are retained verbatim in infrastructure events and
status output. A failed system step records its name, exact shell command, exit
status, labeled stdout and stderr, and `ab init --validate` remediation. It never
writes the marker or launches setup/an agent; the partial sandbox is deleted.
The existing `infrastructure.failed` stream exposes the diagnostic in `ab
status` and both dashboards, consumes `maxInfrastructureAttempts`, and raises
one setup-targeted escalation when exhausted. If cleanup also fails, both the
step output and cleanup uncertainty remain durable instead of hiding the root
cause. A marked sandbox does not repeat provisioning; every replacement/new
generation does.

The representative actual-provider check is opt-in and must point at an
independent consuming repository whose `autobuild.toml` selects the universal
image above, contains one ready ticket, and declares the `system-install` and
`browser-smoke` provisioning steps shown above. The checked-in browser smoke
must use `CHROMIUM_BIN`, serve a page, render it with headless Chromium in the
same guest, and fail if any stage fails. With hosted Store, Vercel, GitHub,
and configured agent-runtime credentials available, run:

```sh
AB_RUN_VERCEL_SANDBOX_LIVE=1 \
AB_VERCEL_SANDBOX_LIVE_REPO=/absolute/path/to/consumer \
AB_STORE=https://store.example AB_TOKEN=… \
bun test packages/core/src/scenarios/vercel-sandbox.live.test.ts
```

The suite first runs `ab init` readiness validation through the production
adapter: it creates an unnamed fresh sandbox, reports both named provisioning
steps, accepts the structured guest probe marker, and verifies deletion by
querying that exact sandbox identity. A separate
case runs a complete child-driven build to publish and finalize, then requests
cleanup and verifies sandbox deletion. It does not demonstrate support for other
Vercel images or package managers.

Vercel workspaces return an absolute guest `path` plus an opaque sandbox-name
`ref`; they omit dispatcher-local path evidence. Branch config, relative/package
plugins, installed skills, setup, runtimes, checks, and phase CLI commands all
resolve in the guest checkout. Only names in `environmentVariables` plus scoped `AB_STORE`/`AB_TOKEN` enter
commands—dispatcher environment variables are never copied wholesale. Pi in a
sandbox should use an API-key provider such as `vercel-ai-gateway/...` with
`AI_GATEWAY_API_KEY`; never copy dispatcher `~/.pi` state, OAuth refresh tokens,
or attempt an interactive login. The same API-key-only rule applies to Codex,
Claude Code, and plugin runtimes.

The opt-in live lifecycle suite is
`packages/core/src/scenarios/vercel-sandbox.live.test.ts`. Set
`AB_RUN_VERCEL_SANDBOX_LIVE=1`, `AB_VERCEL_SANDBOX_LIVE_REPO` to an independent
checkout with a ready file ticket and this provider configuration, plus the
hosted Store, Vercel, runtime, and GitHub credentials above. Its readiness case
creates and probes a fresh sandbox, parses the guest marker, and confirms
deletion by exact identity. Separately, its interruption case deletes the first
build sandbox while its durable execution identity is live, waits through the
lease fence, and asserts a distinct replacement sandbox/session identity,
successful continuation, and final provider cleanup. The suite is credentialed,
long-running, and mutates the configured test repository/Store; it is skipped
unless the opt-in flag is set.

## `[commands]`

An optional open map of repository-defined names to shell strings. Its default
is `{}`. `setup`, `lint`, `type-check`, and `test` are conventions, not fixed
schema fields.

<!-- configuration-reference:commands -->

#### `commands`

**TOML key:** `commands`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Named shell commands used by setup and deterministic checks.

**Constraints:** Entry names: nonempty

#### `commands.<name>`

**TOML key:** `commands.<name>`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Named deterministic shell command.

**Constraints:** minimum length 1

<!-- configuration-reference:/commands -->

<!-- config-fragment:commands -->
```toml
[commands]
setup = "bun install"
typecheck = "bun tsc --noEmit"
test = "bun test"
publish = "bun run publish"
```

`setup` is special by convention: the kernel runs it after workspace provision
and after sandbox rehydration. A failure is recorded durably with its command,
exit status, attempt, and output. Retries are bounded by
`policy.maxSetupAttempts`; exhaustion blocks on a human-answerable setup
escalation without creating a phase or verification result. A later successful
attachment clears the current error projection. Other names run only when
referenced by a configured check. A check's `command` value is the key in this
map, not an inline shell command. The kernel passes the mapped string to a shell
as written.

## `[verify]` and `[verify.<step>]`

Post-reconcile verification defaults to enabled: `[verify].afterReconcile = true`.
Set it to `false` to retain pre-reconcile verification and skip all steps after
reconciliation. An optional boolean `[verify.<step>].afterReconcile` overrides
the repository setting in either direction; overrides require a configured step.
For example, set `afterReconcile = false` in `[verify]` and
`afterReconcile = true` in `[verify.types]` to keep only that step re-running.

The kernel freezes the resolved ordered policy in
`verify.reconcile-policy-captured` at the next engine action after reconcile
completion. A cycle already started keeps its policy through recovery.
Configuration supersession starts a fresh cycle and captures a new policy for
its configured universe, retaining the original reconcile identity. Historical cycles already started
without a captured policy retain the rerun-all behavior. Initial verification
and verification after subsequent code review always use ordinary applicability.
Policy exclusion precedes plan selection and paths, including `always = true`.
Enabled steps still follow plan selection and path rules. Excluded steps record
`verify.completed` with outcome `skipped`, `skipCause = "post-reconcile-policy"`,
and a reason naming the setting. Dashboards and PR summaries call this
"skipped by post-reconcile policy"; it is never a pass. Forge-side required
checks and branch protections still gate merge. For excluded steps, merged code
is not re-verified, so breakage that only exists in the combination can land.


`[verify].steps` defines the configured universe and execution order. It is
optional and defaults to no verify phases. Every listed name needs one matching
subtable, and every named subtable must be listed; a defined-but-unlisted step
never silently disappears.

There are two strict step variants:

- `kind = "check"` runs a configured command directly and decides pass/fail
  from its exit status. It starts no agent session.
- `kind = "agent"` runs the exact configured skill, which terminates with an
  `ab verdict` of `pass`, `fail`, or `skip`.

<!-- configuration-reference:verify -->

#### `verify`

**TOML key:** `verify`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Ordered verification steps and applicability rules. Step names use ASCII letters, digits, ., _ and -; exactly . and .. are forbidden.

**Constraints:** None beyond the input type.

#### `verify.steps`

**TOML key:** `verify.steps`

- **Type:** `array of (string | array of string)`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Ordered verify stages: a name is a singleton stage; a nonempty array runs its members concurrently. Names must be unique within and across stages. Names contain only ASCII letters, digits, ., _ and -, excluding "." and "..". Every listed step must have a table and every table must be listed.

**Constraints:** Each name is nonempty; each grouped stage contains at least one nonempty name. Names must be unique within and across stages.

#### `verify.afterReconcile`

**TOML key:** `verify.afterReconcile`

- **Type:** `boolean`
- **Default:** `true`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Whether verification runs after reconciliation. A step override takes precedence.

**Constraints:** None beyond the input type.

#### `verify.<step>`

**TOML key:** `verify.<step>`

- **Type:** `strict table | strict table`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Named step. Select exactly one strict variant using kind; command belongs only to check, skill only to agent.

**Constraints:** None beyond the input type.

#### `verify.<step>.kind` (kind = "check")

**TOML key:** `verify.<step>.kind`

- **Type:** `"check"`
- **Default:** `omitted`
- **Required:** Required when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Select the strict step variant. Fields from another variant are rejected.

**Constraints:** None beyond the input type.

#### `verify.<step>.command` (kind = "check")

**TOML key:** `verify.<step>.command`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Name of an existing command in [commands]; required for check steps and forbidden for agent steps.

**Constraints:** minimum length 1

#### `verify.<step>.failFast` (kind = "check")

**TOML key:** `verify.<step>.failFast`

- **Type:** `boolean`
- **Default:** `false (omission is preserved)`
- **Required:** Optional when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Cancel unfinished members of this stage when this step fails. Defaults to false.

**Constraints:** None beyond the input type.

#### `verify.<step>.afterReconcile` (kind = "check")

**TOML key:** `verify.<step>.afterReconcile`

- **Type:** `boolean`
- **Default:** `omitted`
- **Required:** Optional when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Step override wins over `[verify].afterReconcile`; false skips this step after reconciliation only.

**Constraints:** None beyond the input type.

#### `verify.<step>.paths` (kind = "check")

**TOML key:** `verify.<step>.paths`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Apply only when at least one changed path matches. Available to both variants.

**Constraints:** minimum length 1; Each item: Positive repository-relative globs with literal characters, *, ?, and whole-segment ** only. No NUL, absolute paths, backslashes, negation, empty or traversal segments, character classes, brace expansion or extglobs.

#### `verify.<step>.always` (kind = "check")

**TOML key:** `verify.<step>.always`

- **Type:** `boolean`
- **Default:** `omitted`
- **Required:** Optional when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** `true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants.

**Constraints:** None beyond the input type.

#### `verify.<step>.kind` (kind = "agent")

**TOML key:** `verify.<step>.kind`

- **Type:** `"agent"`
- **Default:** `omitted`
- **Required:** Required when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Select the strict step variant. Fields from another variant are rejected.

**Constraints:** None beyond the input type.

#### `verify.<step>.skill` (kind = "agent")

**TOML key:** `verify.<step>.skill`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Exact installed skill name; required for agent steps and forbidden for check steps.

**Constraints:** minimum length 1

#### `verify.<step>.failFast` (kind = "agent")

**TOML key:** `verify.<step>.failFast`

- **Type:** `boolean`
- **Default:** `false (omission is preserved)`
- **Required:** Optional when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Cancel unfinished members of this stage when this step fails. Defaults to false.

**Constraints:** None beyond the input type.

#### `verify.<step>.afterReconcile` (kind = "agent")

**TOML key:** `verify.<step>.afterReconcile`

- **Type:** `boolean`
- **Default:** `omitted`
- **Required:** Optional when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Step override wins over `[verify].afterReconcile`; false skips this step after reconciliation only.

**Constraints:** None beyond the input type.

#### `verify.<step>.paths` (kind = "agent")

**TOML key:** `verify.<step>.paths`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Apply only when at least one changed path matches. Available to both variants.

**Constraints:** minimum length 1; Each item: Positive repository-relative globs with literal characters, *, ?, and whole-segment ** only. No NUL, absolute paths, backslashes, negation, empty or traversal segments, character classes, brace expansion or extglobs.

#### `verify.<step>.always` (kind = "agent")

**TOML key:** `verify.<step>.always`

- **Type:** `boolean`
- **Default:** `omitted`
- **Required:** Optional when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** `true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants.

**Constraints:** None beyond the input type.

<!-- configuration-reference:/verify -->

<!-- config-fragment:verify -->
```toml
[commands]
typecheck = "bun tsc --noEmit"

[verify]
steps = ["types", "acceptance"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill
paths = ["web/**", "src/routes/**"]
```

Autobuild does not ship a generic agent verifier. `verify-acceptance` above is a
skill authored by the repository for its own running application.

Cross-field validation rejects:

- a listed step without its `[verify.<step>]` table;
- a named table not present in `steps`;
- a check whose command is absent from `[commands]`;
- fields from the other kind, unknown fields, and malformed selectors.

`always = true` does not make malformed `paths` acceptable: all supplied
selectors are validated even though the mandatory step will not use them for
applicability.

In node `verify:*` context, `nodeVerification` in the manifest identifies the frozen
`range`, `indexPath`, `contributions`, `handPushedCommits` and `unattributedCommits`. Each contribution
has `build`, its stored `ticket` identity at preparation, `spec: {kind: 'spec', rev}`,
`specPath` and `commits`. The JSON index repeats this metadata and adds the
exhaustive ordered `commits: [{sha, build?}]` mapping. Paths are workspace-relative
and reflect scratch allocation, including legacy tracked-file collisions.
Contribution specs normally live at `$AB_CONTEXT_DIR/contributions/<build>/spec.md`; the index
normally lives at `$AB_CONTEXT_DIR/node-verification.json`. These files are marked `derived`
in `materialized`, with their source build and revision recorded in the metadata.

Membership comes from build identity trailers on every commit reachable in the
frozen parent-to-head range, including earlier cycles and merge side history.
The dispatcher gathers contributor material with repository authority before
launching verification. Specs use the event-authorized revision at preparation,
never an unsanctioned latest deposit or mutable ticket body. Unknown identities,
ambiguous or invalid trailers, and missing source data prevent preparation.
A versioned node-owned `node-verification-context` artifact is deposited atomically
with `integration.prepared`, which cites its exact revision. Hydration reads that
citation and validates the prepared input's cycle and range without contributor
reads or Git provenance discovery; session and build scope permissions remain
unchanged. Concurrent verifiers and resumed sessions share the frozen inputs;
a new cycle collects fresh contributor identities and specs. Missing, corrupt or
mismatched prepared inputs fail hydration without publishing a manifest.
Historical agent cycles without a citation require a new prepared cycle;
check-only cycles require no contributor input. Commits without a build trailer are
listed as unattributed, a mechanical absence of a trailer rather than an authorization verdict.
`handPushedCommits: [{sha, originalSha, message}]` identifies node-owned hand-pushed
commits in the frozen range. Ownership uses the durable first-parent contribution
boundary; inherited and merge-side history are not automatically owned. Confirmed
rewrite aliases preserve original identity, and `message` is the full commit message.
These messages express maintainer-authorized intent: judge quality and consistency;
never fail these commits solely for lacking a covering spec.
Other node changes are authorized when the node spec or the spec of the contribution
that introduced it covers it; use the commit mapping to find that spec.
Leaf verification omits node provenance.

### Role routing for an agent verify step

An agent verify step selects `[roles.<step>]` by its **logical step name** —
the name in `[verify].steps`, not the skill it runs. This is the same rule an
agent finalize post-step follows.

<!-- config-fragment:verify-role -->
```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill

[roles.acceptance]        # the STEP name — not "verify-acceptance"
runtime = "pi"
model = "openai-codex/gpt-5.6-sol"
```

The step's configured skill name remains a deprecated alias for existing
configurations and will be removed in a future release. It is consulted only
when `[roles.<step>]` is undeclared, so the step name always wins when both are
present, and `ab dispatch` reports the alias with the step name to rename it to.

### Plan-selected steps

A plan may open with strict TOML front matter naming the complete set of
optional verification warranted by that plan:

<!-- plan-front-matter -->
```toml
+++
verifySteps = ["types", "acceptance"]
+++
```

No opening metadata selects every configured step, preserving older plans. An
explicit `verifySteps = []` selects none and is valid only when no configured
step has `always = true`. Names must be known, nonempty, unpadded, and unique.
Unknown names, duplicate names, malformed metadata, or omission of a mandatory
step make the planner's `ab done` fail before `plan.completed` is recorded.

The list is a set: its written order never reorders execution. The selected
steps are stored in `[verify].steps` order from the exact plan completion later
approved by plan review. A spec restart replaces the selection with the newly
approved plan; reconciliation reuses it.

If the approved selection later names any step absent from the cycle's pinned
configured universe, the entire selection falls back to all configured optional
steps. The kernel records one observation per cycle and plan revision naming
the unknown steps. Mandatory steps, path applicability and post-reconcile policy
still apply. A valid selection continues to skip genuinely omitted optional
steps. Strict validation when depositing a new plan is unchanged.

For each step the kernel evaluates approved-plan selection first, then path
applicability. Exclusion by either mechanism records a queryable `skipped`
outcome. A selection exclusion or path miss starts no check or agent.
An `always = true` step cannot be excluded by the plan and runs regardless of
its `paths` value.

### Path applicability

Selectors are case-sensitive over Git's `/`-separated repository-relative
paths. Supported syntax is literal characters, `*`, `?`, and `**` only as a
complete path segment. The following are rejected: absolute paths, `.` or `..`
traversal segments, empty segments, NUL bytes, negation,
backslashes/escapes, character classes, brace expansion, extglobs, and `**`
embedded in another segment. Selectors and changed paths use any-match
semantics.

Immediately before a selected conditional step, the runner performs a
NUL-delimited, no-rename Git name diff from the initial branch-cut SHA to the
current `HEAD`. Adds, modifications, deletions, and both sides of a rename can
therefore make a step apply. After a completed reconcile, the refreshed base
becomes the diff base: upstream-only paths merged from the base are excluded,
while build-owned changes and conflict resolutions remain visible. A Git or
base-resolution failure is an infrastructure failure, never a permissive skip.

### Pass, fail, and skip

A passing check or agent satisfies its member of the current stage. The next
stage starts only after every member has passed or been skipped; finalize
starts after the last stage is satisfied.

By default, a failure lets the stage's other members finish before routing the
build to implement once with every failed member's report. Later stages do not
run. An agent failure requires `ab verdict fail --report <file>`; check failures
retain command output as implementation feedback. A failed cycle consumes one
unit of the `policy.maxVerifyAttempts` retry budget, regardless of how many
members failed.

If a member configured with `failFast = true` fails, unfinished siblings are
cancelled instead. Members that already reached an outcome keep it. Cancelled
members are listed as not run, with their cancellation cause, in implement's
context; cancellation does not satisfy a verification gate. See
[verification outcomes](verification.md#steps-and-outcomes) for cancellation,
escalation and recovery details.

An agent may instead use `ab verdict skip --reason <text>` when the configured
judgment genuinely does not apply. The trimmed reason must be nonblank, and no
failure report is required. Plan and path exclusions are kernel-authored skips
with deterministic reasons. Every skip satisfies only that member of the stage
and remains distinct from a pass. It does not mask another member's failure or
consume the failure retry budget; advancement still requires the whole stage
to pass or skip.

## `[finalize]` and `[finalize.<step>]`

`[finalize].steps` is an optional ordered list of post-PR actions and defaults
to `[]`. These run after the finalize agent writes the PR description and the
kernel opens the PR. Like verify, every listed name requires one matching table
and every table must be listed.

Finalize has a smaller strict union. Verify-only `paths` and `always` fields
are errors.

<!-- configuration-reference:finalize -->

#### `finalize`

**TOML key:** `finalize`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Ordered post-PR steps. Failures are recorded without blocking the PR. Step names use ASCII letters, digits, ., _ and -; exactly . and .. are forbidden.

**Constraints:** None beyond the input type.

#### `finalize.steps`

**TOML key:** `finalize.steps`

- **Type:** `array of string`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Ordered names of the configured step tables. Names contain only ASCII letters, digits, ., _ and -, excluding "." and "..". Every listed step must have a table and every table must be listed.

**Constraints:** Each item: minimum length 1

#### `finalize.<step>`

**TOML key:** `finalize.<step>`

- **Type:** `strict table | strict table`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Named step. Select exactly one strict variant using kind; command belongs only to check, skill only to agent.

**Constraints:** None beyond the input type.

#### `finalize.<step>.kind` (kind = "check")

**TOML key:** `finalize.<step>.kind`

- **Type:** `"check"`
- **Default:** `omitted`
- **Required:** Required when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Select the strict step variant. Fields from another variant are rejected.

**Constraints:** None beyond the input type.

#### `finalize.<step>.command` (kind = "check")

**TOML key:** `finalize.<step>.command`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required when kind = "check"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Name of an existing command in [commands]; required for check steps and forbidden for agent steps.

**Constraints:** minimum length 1

#### `finalize.<step>.kind` (kind = "agent")

**TOML key:** `finalize.<step>.kind`

- **Type:** `"agent"`
- **Default:** `omitted`
- **Required:** Required when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Select the strict step variant. Fields from another variant are rejected.

**Constraints:** None beyond the input type.

#### `finalize.<step>.skill` (kind = "agent")

**TOML key:** `finalize.<step>.skill`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required when kind = "agent"
- **Reload:** Hot: next dispatcher action captures the accepted value. Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch. A running invocation keeps its captured values.

**Description:** Exact installed skill name; required for agent steps and forbidden for check steps.

**Constraints:** minimum length 1

<!-- configuration-reference:/finalize -->

<!-- config-fragment:finalize -->
```toml
[commands]
publish = "bun run publish"

[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"
```

The logical step name selects `[roles.<step>]` for an agent post-step — the
same rule an agent verify step follows, so one convention covers both:

<!-- config-fragment:finalize-role -->
```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill

[finalize]
steps = ["release-notes"]

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.acceptance]              # verify STEP name — not "verify-acceptance"
runtime = "pi"

[roles.release-notes]    # finalize step name
runtime = "pi"
```

For an agent *verify* step, the step's configured skill name remains a
deprecated alias for existing configurations and will be removed in a future
release. Finalize has never had such an alias.

Both
kinds are failure-tolerant: nonzero commands, launch/execution errors, and
structured agent failures record `ok = false` plus a follow-up observation,
then the sequence continues. A post-step cannot turn an otherwise green build
red.

A content-producing step selects and commits only its intended files locally
and must leave a clean worktree. The runner proves the last published head is
an ancestor, then performs a regular non-force push through the Forge port to
extend the open PR branch. Agents never push. An unchanged `HEAD` creates and
pushes no commit. Dirty output, rewritten history, Git errors, and publication
failures become failure-tolerant follow-up observations.

## `[roles]`

An open map from a nonempty role name to three primary agent axes, one
wall-clock session budget, and an ordered alternate list. All five live fields
inherit independently. The reserved
`default` entry is required to name a runtime, is the raw base for every other
role, and is never dispatched itself. Missing it fails eagerly before any
session starts, with a copyable table and all registered runtime names.

<!-- configuration-reference:roles -->

#### `roles`

**TOML key:** `roles`

- **Type:** `table`
- **Default:** `{} (input supplied on omission)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Named agent roles. The reserved default role provides inherited runtime axes.

**Constraints:** Entry names: nonempty

#### `roles.<name>`

**TOML key:** `roles.<name>`

- **Type:** `strict table`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Named role inheriting each omitted axis from roles.default. The default role must name a registered runtime.

**Constraints:** None beyond the input type.

#### `roles.<name>.runtime`

**TOML key:** `roles.<name>.runtime`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Select an agent adapter.

**Constraints:** minimum length 1; Required on roles.default by runtime resolution; other roles inherit it. Must name a registered runtime.

#### `roles.<name>.model`

**TOML key:** `roles.<name>.model`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Select the exact model. Codex uses unqualified `gpt-*`; Pi ids are provider-qualified.

**Constraints:** minimum length 1; Omission inherits the base model, otherwise uses the selected runtime default. Must be compatible with that runtime.

#### `roles.<name>.args`

**TOML key:** `roles.<name>.args`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Ordered extra CLI argv tokens applied to every phase and tool-free one-shot invocation. A supplied list replaces, rather than unions with, the inherited list.

**Constraints:** Omission inherits the base list, otherwise resolves to an empty list; an explicit list replaces it.; Each item: minimum length 1

#### `roles.<name>.extensions`

**TOML key:** `roles.<name>.extensions`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Compatibility-only field. Dispatch warns for each declaring role; migrate explicit runtime options to `args`.

**Constraints:** Each item: minimum length 1

#### `roles.<name>.sessionBudgetSeconds`

**TOML key:** `roles.<name>.sessionBudgetSeconds`

- **Type:** `number`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Active-time budget for each build phase session routed through this logical role. Suspended intervals are excluded; native continuation retains the original ceiling and accumulated active time. One budget covers the primary and every alternate target.

**Constraints:** safe integer; > 0; Omission inherits roles.default.sessionBudgetSeconds, otherwise policy.sessionBudgetSeconds.

#### `roles.<name>.alternates`

**TOML key:** `roles.<name>.alternates`

- **Type:** `array of strict table`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Failure-triggered execution targets (provider failures and a runtime whose CLI is not installed). A role's list replaces the inherited list wholesale; each entry overlays that role's effective primary axes. `extensions` is accepted there only as the same deprecated no-op.

**Constraints:** Omission inherits the base alternate list, otherwise resolves to an empty list; each alternate overlays the resolved primary axes.

#### `roles.<name>.alternates[].runtime`

**TOML key:** `roles.<name>.alternates[].runtime`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Select an agent adapter.

**Constraints:** minimum length 1; Required on roles.default by runtime resolution; other roles inherit it. Must name a registered runtime.

#### `roles.<name>.alternates[].model`

**TOML key:** `roles.<name>.alternates[].model`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Select the exact model. Codex uses unqualified `gpt-*`; Pi ids are provider-qualified.

**Constraints:** minimum length 1; Omission inherits the base model, otherwise uses the selected runtime default. Must be compatible with that runtime.

#### `roles.<name>.alternates[].args`

**TOML key:** `roles.<name>.alternates[].args`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Ordered extra CLI argv tokens applied to every phase and tool-free one-shot invocation. A supplied list replaces, rather than unions with, the inherited list.

**Constraints:** Each item: minimum length 1

#### `roles.<name>.alternates[].extensions`

**TOML key:** `roles.<name>.alternates[].extensions`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Compatibility-only field. Dispatch warns for each declaring role; migrate explicit runtime options to `args`.

**Constraints:** Each item: minimum length 1

<!-- configuration-reference:/roles -->

<!-- config-fragment:roles -->
```toml
[roles.default]
runtime = "claude"
args = []
alternates = [
  { runtime = "pi", model = "openai-codex/gpt-5.6-sol", args = ["--extension", "./tools/pi.js"] },
]

[roles.plan]
args = ["--effort", "high"]
alternates = [] # replace the inherited list for this role

[roles.code-review]
runtime = "pi"
model = "kimi-coding/k3"
args = ["--extension", "./tools/web-access.js"]
sessionBudgetSeconds = 7200
```

Inheritance is mechanical per field. For example, changing only a child
runtime does not discard a model inherited from `default`; the resulting exact
pair must be compatible. Autobuild never searches for a runtime that happens
to serve a configured model and never substitutes a different model to repair
an invalid pair. The only implicit fill is when neither the role nor `default`
names a model, in which case the selected runtime uses its own default. Every
alternate overlays that concrete role's effective primary runtime, model, and
args, then undergoes the same exact-pair validation. Each configured string is
one argv token; Autobuild does not shell-expand it. The narrow rejected set is
derived from the model and machine-readable protocol options each adapter emits:
Claude rejects `-p`/`--print`, `--output-format`, and `--model`; Codex rejects
`--json` and `--model`/`-m`; Pi rejects `--mode` and `--model`. Claude and Codex
also reject a standalone `--` because Autobuild owns and appends that structural
separator immediately before their positional prompt. Those option spellings,
`--option=value` forms, compact documented short aliases, and the exact affected
prompt separator join the eager aggregated startup error with a
role/runtime-specific diagnostic. Every other option passes through without
Autobuild validation, including sandbox, approval, session, tool, skill,
thinking, extension, lifecycle, unknown options, and arguments that merely
contain two hyphens, even when they supplement another occurrence emitted by the
adapter. Unknown fields,
runtimes, and incompatible models in any indexed entry join the aggregated
eager startup error; they never first surface during an outage.

Three runtimes ship: `claude`, `codex`, and `pi`; `ab plugin list` projects all
three as builtin agent runtimes, and trusted plugins may register additional
names. The `pi` runtime requires a locally installed Pi CLI version 0.84.3 or
newer and uses that installation's login and model catalog through headless RPC;
Autobuild does not install Pi. `ab init` reports a missing or older executable
as unusable, and `pi` must be logged in for every configured model. `ab models`
lists this local catalog, while `ab models --available` limits it to models with
configured credentials. Builtin and plugin runtimes use the same exact-pair
validation and event attribution. With no configured model, the selected runtime uses its declared
default when present: Claude and Codex delegate to their local CLI's selected
default, while Pi declares `kimi-coding/k3`. Codex accepts unqualified `gpt-*`
ids. Pi ids remain provider-qualified—including the independent
`openai-codex/*` route—and `ab models [query]` looks them up. Pi always passes
`--no-extensions` to disable ambient package discovery and loads the Autobuild
bridge explicitly. Repeatable `--extension <path>` tokens in `args` supplement
that setup and expose every tool registered by that explicitly loaded extension;
without them, no user-installed extension loads. A plugin may declare
optional tool-free one-shot completion for `slug` and `upgrade`; absence keeps
each caller's existing fail-safe behavior. Role `args` apply to those one-shots
too. Effective arguments are recorded on session-start facts.

The injected Codex protocol/contract suite is deterministic and credential-free:
`bun test packages/core/src/ports/runner/codex.test.ts`. An authenticated local smoke run is
opt-in:
`AB_RUN_LIVE_PORT_CONTRACTS=1 AB_CODEX_CONTRACT_MODEL=gpt-… bun test packages/core/src/ports/runner/codex.live.test.ts`.

Core agent phases route by phase name (`plan`, `plan-review`, `implement`,
`code-review`, `finalize`, and `reconcile`). Agent verify steps and agent
finalize post-steps both route by their logical step name. The verify step's
configured skill name remains a deprecated alias for existing configurations
and will be removed in a future release. Repository judgments use `harvest` and
`harvest-review`; `slug` and `upgrade` configure tool-free one-shot judgments.
Arbitrary additional role keys are accepted, but only a name selected by one of
these routes affects a session.

A declared key that no route requests is resolved and validated like any other,
and then never used — `ab dispatch` reports it at startup, naming the key and
the keys valid for this configuration, and reports a deprecated skill-name key
with the step name to rename it to. Both stay warnings; neither blocks a
session or changes which runtime and model run. `kind = "check"` steps start no
session and so are not a route: naming a role after one does not make it
consumed. It is reported only when that check step is its sole apparent route —
a check step named `plan` leaves `[roles.plan]` consumed by the core `plan`
phase, and nothing is reported.

Resolver construction validates `default`, every declared role, and every
alternate eagerly and aggregates all unknown-runtime and incompatible-model
problems. Unknown-runtime diagnostics list every builtin and materialized
plugin runtime. A deliberately different reviewer model is valid and often
useful; mixed models are not a configuration inconsistency.

Each session attempt starts with its role's primary. Overload, rate limits, 5xx,
timeout, transport, unknown provider failures, and quota/usage/billing
exhaustion try alternates in declaration order inside that same phase attempt.
Authentication, permission, and local runtime-configuration failures do not, with one exception: a runtime whose CLI executable is not installed is skipped like any other eligible failure, so the phase runs on the first declared target whose CLI is present. An unsupported installed version is still a stopping configuration failure. If no target's CLI is installed, the chain ends in one non-retried `configuration` failure carrying the last target's missing-CLI message. The remote provisioning preflight stays fail-closed: a missing runtime there is a provisioning defect.
Each target gets a separate session and transcript; a continuation that moves
to another target starts fresh from durable context and cannot inherit the
failed provider's conversation. Selection is not sticky: the next phase, next
review-loop continuation, and next attempt begin at the primary again.

Trying alternates does not consume additional phase attempts. Only an exhausted
or non-eligible chain writes `phase.failed`; its final failure controls retry
policy, so final quota/usage/billing exhaustion parks immediately while a final
availability failure consumes one existing bounded attempt. `session.started`
records each selected runtime/model and substitution cause, and an exhausted
failure records every tried target and verbatim error for policy escalation.
The chain applies to core phases, agent verify/finalize steps, and Harvest.
Tool-free one-shot completions such as slug and upgrade use only the primary.

For build sessions, the kernel starts the captured role budget after the durable
`session.started` event. Expiry aborts and ends the session best-effort, drops
producer continuation state, and records `phase.failed` with
`phase session budget expired after <seconds> seconds`. It does not select an
alternate because it is kernel policy, not a provider failure. The ordinary
phase-attempt guard retries from the primary and raises an answerable policy
escalation when exhausted. Operator cancellation does not disable the captured
deadline: a cooperative adapter still returns promptly, while an adapter that
ignores cancellation is released when the deadline arrives. If your agent aborts
arrived first, that release stays an abort control outcome, starts no alternate,
and records no `phase.failed`. A typed terminal deposited before either boundary
remains authoritative. Agent finalize post-step expiry instead records that
failure-tolerant step as `ok = false` and files its follow-up observation.
Harvest sessions and direct verify/finalize check commands are not covered by
this setting.

## `[policy]`

Optional. Every field receives its own default. All are positive integers except
`harvestMaxDrift`, which is nonnegative so zero can disable that trigger.

<!-- configuration-reference:policy -->

#### `policy`

**TOML key:** `policy`

- **Type:** `strict table`
- **Default:** `{} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Lifecycle budgets, retries, convergence and harvest limits.

**Constraints:** None beyond the input type.

#### `policy.upgradeDrainSeconds`

**TOML key:** `policy.upgradeDrainSeconds`

- **Type:** `number`
- **Default:** `900`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Deadline for a retiring generation, relative to handoff start; hot-reloaded during drain.

**Constraints:** safe integer; > 0

#### `policy.sessionBudgetSeconds`

**TOML key:** `policy.sessionBudgetSeconds`

- **Type:** `number`
- **Default:** `3600`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Active-time bound for each build agent session unless its logical role overrides it. Native continuation retains the original ceiling; suspension does not consume it.

**Constraints:** safe integer; > 0

#### `policy.stallRounds`

**TOML key:** `policy.stallRounds`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Escalate when the same review finding survives this many rounds.

**Constraints:** safe integer; > 0

#### `policy.maxVerifyAttempts`

**TOML key:** `policy.maxVerifyAttempts`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Bound failure-driven verify → implement retry cycles.

**Constraints:** safe integer; > 0

#### `policy.maxDispatchAttempts`

**TOML key:** `policy.maxDispatchAttempts`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Bound consecutive dispatch failures before human escalation.

**Constraints:** safe integer; > 0

#### `policy.maxSetupAttempts`

**TOML key:** `policy.maxSetupAttempts`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Bound consecutive workspace setup failures before human escalation.

**Constraints:** safe integer; > 0

#### `policy.maxInfrastructureAttempts`

**TOML key:** `policy.maxInfrastructureAttempts`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Bound consecutive provision/start/wait/cleanup failures before a setup-targeted policy escalation; a human `retry` answer re-arms this budget.

**Constraints:** safe integer; > 0

#### `policy.maxReconcileAttempts`

**TOML key:** `policy.maxReconcileAttempts`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Bound completed reconciles that leave the PR conflicted against an unchanged authoritative base. Moving-base races do not consume the bound.

**Constraints:** safe integer; > 0

#### `policy.maxReviewRounds`

**TOML key:** `policy.maxReviewRounds`

- **Type:** `number`
- **Default:** `6`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Default bound for each plan/review and implement/review convergence loop. Your agent may replace it for one parked build loop and current spec revision with `ab answer --review-round-ceiling`; other builds are unaffected.

**Constraints:** safe integer; > 0

#### `policy.harvestThreshold`

**TOML key:** `policy.harvestThreshold`

- **Type:** `number`
- **Default:** `5`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** New unclaimed observation occurrences needed to start one harvest run.

**Constraints:** safe integer; > 0

#### `policy.janitorFailureAttentionSeconds`

**TOML key:** `policy.janitorFailureAttentionSeconds`

- **Type:** `number`
- **Default:** `600`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Consecutive janitor failure duration before build attention.

**Constraints:** safe integer; > 0

#### `policy.nodeIdleAfterSeconds`

**TOML key:** `policy.nodeIdleAfterSeconds`

- **Type:** `number`
- **Default:** `600`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Quiet period before opened integration nodes enter idle polling.

**Constraints:** safe integer; > 0

#### `policy.nodeIdlePollSeconds`

**TOML key:** `policy.nodeIdlePollSeconds`

- **Type:** `number`
- **Default:** `120`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Interval between idle node checks; durable activity wakes the next tick.

**Constraints:** safe integer; > 0

#### `policy.janitorBackoffMaxSeconds`

**TOML key:** `policy.janitorBackoffMaxSeconds`

- **Type:** `number`
- **Default:** `300`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Cap on exponential janitor retry delay, starting at 30 seconds.

**Constraints:** safe integer; > 0

#### `policy.harvestMaxDrift`

**TOML key:** `policy.harvestMaxDrift`

- **Type:** `number`
- **Default:** `3`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Other builds merged after the oldest unclaimed observation needed to start a run; `0` disables drift.

**Constraints:** safe integer; ≥ 0

<!-- configuration-reference:/policy -->

Dispatch failures share a `[policy].maxDispatchAttempts` budget (default 3) across
create, workspace, spec, comment, and launch stages. Exhaustion raises one
`dispatch-failure-limit` policy escalation naming the latest stage and error,
and parks dispatch until answered. Both bare `ab answer <slug>` retries and
text guidance grant a fresh budget; abort does not. Confirmed runner attachment
clears the streak. Recovery-provider workspace failures belong exclusively to
the infrastructure budget. Exhaustion is repaired from durable facts on restart
before further dispatch work.

The dispatcher also applies a fixed, non-configurable limit of three consecutive
executions that complete normally with exit code zero and no durable build
progress. Execution start/end, runner attachment and workspace lifecycle
bookkeeping do not count as progress. Pipeline, session, spec, publication/PR,
observation and acknowledged operator facts reset the streak; infrastructure,
budget and provider failures do not consume the allowance and retain their own
retry limits. Before a fourth actionable launch, the dispatcher raises one
setup-targeted `execution-no-progress` policy escalation naming the count and
the next action it expected the runner to take. Waiting, paused and terminal
builds are left parked, and pending operator commands remain executable.
Answering that escalation with guidance or a bare `ab answer <slug>` retry grants
three fresh executions. The guard is derived from durable facts, including on
supervisor restart, and uses the ordinary watch, dashboard and operator API
attention paths.

For each repeat conflict, Autobuild compares the base merged by the most recent
completed reconcile with a fresh authoritative base snapshot. An advanced base
proves the attempt lost a race and permits another reconcile regardless of the
attempt high-water. An unchanged base consumes `maxReconcileAttempts` and
escalates when the bound is exhausted. Every current policy escalation carries
a closed `policyCause`; reconcile no-progress uses `reconcile-no-progress`,
while `round` remains occurrence scope. Answering a runner-failure cause re-arms
only its matching phase and round. The phase-level `verify-failure-limit` cause
explicitly re-arms all rounds for its verify target, while
`reconcile-no-progress` and the setup-only cause reset no phase-runner failures.
The closed cause map forces every future policy condition to choose one of these
semantics instead of inheriting behavior from a missing `round`. Runner failures
while checking progress or refreshing the base therefore remain counted after a
roundless no-progress answer. If the unchanged-base bound is already exhausted,
Autobuild raises the matching no-progress escalation before starting another
reconcile. Cause-less historical raises retain their former round-shaped reset
behavior, and roundless policy/reconcile raises retain their former no-progress
meaning, on replay without migration. Post-reconcile verification still runs in
full and remains independently bounded by `maxVerifyAttempts`.

Harvest is driven by repository pressure during dispatcher ticks, not a wall
clock, and is independent of build `capacity`. A run starts when observation
count reaches `harvestThreshold` **or** drift reaches `harvestMaxDrift`. Drift
uses the oldest unclaimed observation, counts only later same-repository
`pr.merged` facts from other builds, and ignores aborted and closed-unmerged
builds. Whichever trigger fires, Harvest claims the complete current
accumulation and records `count`, `drift`, or `both` on the durable start fact.
The dashboard header reports
`queue <depth> | active <current>/<limit> | observations <current>/<limit>`.
The observation current value is the unclaimed occurrence count and its limit is
`policy.harvestThreshold`. The interactive frontend refreshes that display-only
count directly from the BuildStore, retains the last successful value with a
diagnostic after a failed refresh, and appends no transport event. The separate
`policy.harvestMaxDrift` trigger is configured here but is not shown in the
header. The repository lease and fixed per-run recovery budget are implementation
invariants, not additional configuration fields.

## `[tickets]`

### Ticket kind and target metadata

`kind` and `target` are fields on individual tickets, not `[tickets]` TOML keys.
`kind` defaults to `work`; `node` creates a finite integration point. Omitted
`target` means the configured `baseBranch` root. A target must be a same-source
node ticket id. `ab ticket update <id> --target <node-id>` changes it;
`--no-target` clears it and `--kind work` resets kind. Omitted update fields
preserve values. Claimed work targets cannot change: abort and re-dispatch.
Open nodes can reparent under the guarded protocol, revoking land consent.

File tickets persist the fields in frontmatter; hosted tickets store them with
project-scoped transactional validation. Linear maps kind to the exact `node`
label and target to a parent carrying that label. Ordinary grouping parents do
not impose targets; explicit clear removes the parent relation. Node demotion
with targeting children and cycles are refused regardless of child state.
See [integration trees](integration-tree.md) for admission, lifecycle and commands.

### Source configuration

To move an existing project between sources, follow the
[ticket migration procedure](ticket-migration.md).

Required in practice: `readyState` deliberately has no default, so omitting the
table fails at `tickets.readyState` rather than allowing tickets from every
state. Within a present table, `source` is required; hosted tickets default `readyState` to `ready`. Other sources require it.

<!-- configuration-reference:tickets -->

#### `tickets`

**TOML key:** `tickets`

- **Type:** `strict table`
- **Default:** `{"source":"file"} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Mixed: see individual fields for dispatcher reload behavior. A running invocation keeps its captured values.

**Description:** Ticket source and lifecycle vocabulary. Omitting the table supplies source=file but still requires readyState.

**Constraints:** readyState is required except for hosted, whose omitted value resolves to ready. url is forbidden for file and linear; hosted URLs must be absolute HTTPS (loopback HTTP allowed), without credentials, query or fragment, and are normalized.

#### `tickets.url`

**TOML key:** `tickets.url`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Ticket service independent of [store] url and AB_STORE. Required with local builds.

**Constraints:** Forbidden for file and linear. Hosted omission uses the selected remote BuildStore URL; with a local BuildStore an explicit hosted URL is required.

#### `tickets.source`

**TOML key:** `tickets.source`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Select the ticket adapter after configured plugins load.

**Constraints:** [tickets].source must be a nonblank builtin or plugin ticket source name

#### `tickets.readyLabels`

**TOML key:** `tickets.readyLabels`

- **Type:** `array of string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Require every listed label in addition to the state gate.

**Constraints:** Omission uses source readiness defaults (Linear: autobuild label; file: none). Explicit [] disables label gating.; Each item: minimum length 1

#### `tickets.readyState`

**TOML key:** `tickets.readyState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required unless source = "hosted"; hosted omission resolves to "ready".
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** The one workflow state eligible for dispatch.

**Constraints:** [tickets].readyState must not be blank — name the one workflow state a ticket must sit in to be dispatched (e.g. "ready").

#### `tickets.readyAssignee`

**TOML key:** `tickets.readyAssignee`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Require the ticket to be assigned to one Linear user, in addition to the state and label gates.

**Constraints:** [tickets].readyAssignee must be "me" (the owner of the API key) or a user email address (e.g. "person@example.com"); Allowed only for linear.

#### `tickets.teamKey`

**TOML key:** `tickets.teamKey`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Required for linear and hosted; forbidden for file; optional for plugins.
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Backend team key such as `"ENG"`, or an existing plugin config field.

**Constraints:** minimum length 1

#### `tickets.claimedState`

**TOML key:** `tickets.claimedState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Workflow state entered when a ticket is claimed.

**Constraints:** minimum length 1; state must be nonblank; Forbidden for file. Resolution uses In Progress for direct Linear, doing for hosted.

#### `tickets.doneState`

**TOML key:** `tickets.doneState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Project completion state and merged-ticket transition.

**Constraints:** minimum length 1; state must be nonblank; Hosted resolution uses done when omitted.

#### `tickets.createState`

**TOML key:** `tickets.createState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Default state for newly created tickets when `ab ticket create` omits `--state`.

**Constraints:** minimum length 1; state must be nonblank; Omission uses the source creation state (Linear team default; file Triage).

#### `tickets.triageState`

**TOML key:** `tickets.triageState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** State used for spec-gate bounces, aborts, and closed-unmerged PRs.

**Constraints:** minimum length 1; state must be nonblank; Omission resolves to Backlog for Linear, triage for hosted, Triage for file/plugin sources.

#### `tickets.proposalState`

**TOML key:** `tickets.proposalState`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** State harvest files its synthesized proposals into. Setting it to `readyState` waives the human grooming gate, not dependency eligibility.

**Constraints:** minimum length 1; state must be nonblank; Omission uses the resolved triageState.

#### `tickets.dir`

**TOML key:** `tickets.dir`

- **Type:** `string`
- **Default:** `omitted`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Root containing file-source state directories, or an existing plugin config field. Relative file paths resolve from the repository.

**Constraints:** minimum length 1; Forbidden for linear and hosted. File omission resolves to the selected local state root tickets directory; plugin omission remains omitted.

<!-- configuration-reference:/tickets -->

`readyAssignee = "me"` resolves to the Linear user who owns `LINEAR_API_KEY`,
so one committed value makes each person's local dispatcher take only the work
assigned to them; an email names a specific user, for a shared or bot key. The
gate is conjunctive with `readyState` and `readyLabels`, and a ticket with no
assignee is never ready while it is set. It applies to every ready surface
(dispatch, the queued count, and `ab ticket list` without filters); blockers
still prevent claim. It is empty or blank, or neither `"me"` nor an email,
fails validation. `ab init --validate` prints the user the gate resolves to and
fails when an email matches no workspace user. The field reloads without a
restart.

When `readyLabels` is absent, direct Linear uses `["autobuild"]`; hosted, file,
and plugin sources use `[]`, meaning no host-imposed label gate. An explicit value always
wins. A nonempty list is
conjunctive: every configured label must be present. `readyState` remains
mandatory regardless of labels (hosted defaults to `ready`). Linear compares state and label names exactly
and case-sensitively. The file source matches state names case-insensitively against the directories
under the tracker root: the four lifecycle directories (`triage/`, `ready/`,
`doing/`, `done/`, always present) plus any directory the repository adds, such
as `icebox/`. A name matching no directory is an error listing those that
exist, so creating a state stays an explicit act: `ab ticket state create <name>
[--about <text>]` makes one, and `ab ticket states` lists every state with its
roles, ticket count, and purpose. A purpose is stored as a one-line `.about` file
inside the state directory, so it travels with a git-tracked `dir` and is never
read as a ticket. `createState`, `readyState`,
`triageState`, and `proposalState` may each name any existing directory;
`ab ticket list` with no filter still lists only `readyState`.

Source-specific validation is strict:

- Linear and hosted require `teamKey` and reject `dir`.
- File rejects `teamKey` and `claimedState`; `dir` is optional.
- `createState`, `triageState`, and `proposalState` are valid for every source,
  but the named state must exist in that provider when used.
- Plugin sources receive the existing fields in this table unchanged and own
  any additional semantic validation. No untyped plugin-options table exists.

Hosted states are durable service data scoped to a project. `ab ticket states`
lists configured lifecycle roles first, then custom states alphabetically, with
counts and optional purposes. `ab ticket state create <name> [--about <text>]`
adds a state using the file source's lowercase name grammar. Hosted duplicates
in any letter case are refused; file creation remains idempotent. Configured
names always exist, preserve their spelling, and remain custom states after
removal from config. Any existing state supports ticket create, move, and list;
unknown names report the available states. Purposes must be one nonblank line.

For Linear, omitting `createState` lets the team's default state apply. For the
file source it defaults to `Triage`. A caller may override that default for one
create with `ab ticket create --state <state>`; the value is passed unchanged to
the selected source, which owns its workflow vocabulary and rejects unknown
states before creating anything. An omitted Linear `triageState` uses `Backlog`,
because every team has it while the optional Linear triage feature may be
disabled. The file source uses `Triage`.

`proposalState` names the one state observation harvest files proposals into,
and defaults to the resolved `triageState` — proposals wait for a human, which
is the grooming gate the pipeline is built around. Naming `readyState` here
waives that gate for this repository: every proposal the harvest loop approves
enters the ordinary dispatch eligibility checks without being read, protected
by that loop's own review and by the spec gate at dispatch. The producer and
reviewer see scan-time existence and resolution for every distinct ticket that
originated a claimed observation. Approved creates may carry evidence-backed
source-local `blockedBy` ids for other prerequisites. Immediately before create,
harvest refreshes declared ids and matching-source origins through the selected
TicketSource. Unknown declared ids fail; missing or resolved origins are dropped;
still-unresolved origins are deduplicated into `blockedBy` automatically.
Harvest status and the filing report distinguish declared blockers from those
derived from originating tickets. An unresolved harvested blocker still
prevents claim until the source reports completion or the relationship is
deliberately removed. It is a separate field precisely so
the waiver stays narrow. Redirecting `triageState` instead would also send
spec-gate bounces, aborts, and closed-unmerged PRs into the ready state, where
a bounced ticket is reclaimed and bounced again on every tick.

The default file directory follows a selected local `AB_STORE` root and writes
its own self-excluding `.gitignore`. An explicitly configured `dir` belongs to
the repository owner and is not automatically ignored.

<!-- config-fragment:linear-tickets -->
```toml
[tickets]
source = "linear"
teamKey = "ENG"
readyState = "Todo"
readyLabels = ["autobuild"]
claimedState = "In Progress"
createState = "Backlog"
triageState = "Backlog"
```

Linear credentials do not belong in this table. Set `LINEAR_API_KEY` in the
environment or local `.env` file described below.

[Linear's request budget](https://linear.app/developers/rate-limiting) is shared
by every dispatcher and `ab ticket` command using the API key, and by other keys
belonging to the same authenticated user. A rate-limited ready scan or dependency
read fails the evaluation tick without new intake claims or synthetic
dependency-blocked counts. That source instance suppresses requests until the
reported reset time; the next call then runs normally. Missing, invalid or expired
reset headers use a conservative 60-second cooldown. Cooldowns are local to the
instance: processes and restarts do not coordinate their budgets.

For a hosted backend, repository policy remains local while credentials remain
at the service:

<!-- config-fragment:hosted-tickets -->
```toml
[tickets]
source = "hosted"
teamKey = "ENG"
readyState = "Ready"
readyLabels = []
claimedState = "Doing"
createState = "Triage"
triageState = "Triage"
```

Set `AB_STORE` to the service's HTTP(S) URL and `AB_TOKEN` to a stored credential
for that registered project (`credentials issue REPOSITORY --user IDENTITY`). The same source-agnostic wiring powers dispatch, harvest, ticket-aware
skills, and all seven command families: `ab ticket create`, `update`, `block`,
`unblock`, `list`, `show`, and `move`. See the
[hosted ticket protocol](remote-ticket-protocol.md). Tickets are partitioned by
the credential's registered project; lifecycle comes from its latest effective
configuration. The service has no Linear backend and refuses ticket operations
for projects using external sources. Direct Linear remains dispatcher-side.

When filing dependent tickets into the ready state, follow the
[safe blocker-filing workflow](ticket-dependencies.md). Direct Linear
creates the issue before recording its blockers, so `create --blocked-by` is not
an atomic publication guarantee. Stage outside ready, verify the relationships,
then move to the intended ready state last.

A plugin registration is selected the same way. `ab dispatch` and every
`ab ticket` subcommand load the plugin and route through that source. Within a
dispatch process, one selected instance serves dependencies, claim/projections,
harvest filing, and janitor completion. Unknown names fail with the available
builtin and loaded plugin names. Missing descriptor credentials name both the
source and each variable.

<!-- config-fragment:plugin-tickets -->
```toml
plugins = ["./plugins/company.ts"]

[tickets]
source = "company"
readyState = "Ready"
claimedState = "Doing"
createState = "Triage"
triageState = "Triage"
```

Set `COMPANY_TICKET_TOKEN` in the environment, never in this table.

## `[orchestrator]`

Enables the credential-free per-owner sandbox environments driven by external
operators through `sandbox.*`, archive cleanup and dispatcher idle settlement.
Autobuild does not host an operator agent. The table is closed to unknown keys
and restart-classified as a whole. The removed runner keys `model`,
`invocationBudgetSeconds`, `approvals` and `wake` are rejected with a diagnostic;
existing effective-config artifacts remain readable without changing stored bytes.

<!-- configuration-reference:orchestrator -->

#### `orchestrator`

**TOML key:** `orchestrator`

- **Type:** `strict table`
- **Default:** `{} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Operator-agent sandbox settings. This table does not start or host an operator agent.

**Constraints:** None beyond the input type.

#### `orchestrator.enabled`

**TOML key:** `orchestrator.enabled`

- **Type:** `boolean`
- **Default:** `false`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Enables externally driven sandbox tools, archive cleanup and dispatcher idle settlement. Operators run in external agent harnesses.

**Constraints:** None beyond the input type.

#### `orchestrator.sandbox`

**TOML key:** `orchestrator.sandbox`

- **Type:** `strict table`
- **Default:** `{} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Sandbox behavior knobs.

**Constraints:** None beyond the input type.

#### `orchestrator.sandbox.idleMinutes`

**TOML key:** `orchestrator.sandbox.idleMinutes`

- **Type:** `number`
- **Default:** `30`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Minutes without a sandbox tool call after which the dispatcher tick's janitor stops the environment, keeping its snapshot; the next tool call resumes it.

**Constraints:** safe integer; > 0

#### `orchestrator.sandbox.environmentVariables`

**TOML key:** `orchestrator.sandbox.environmentVariables`

- **Type:** `array of string`
- **Default:** `[]`
- **Required:** Optional
- **Reload:** Dispatcher restart required; startup adapters retain their configuration. A running invocation keeps its captured values.

**Description:** Names of non-secret host variables forwarded into the sandbox — the only non-toolchain environment it ever sees, during provisioning/setup and tool exec/start alike. Unset means none.

**Constraints:** When enabled, forwarding store, forge, ticket-provider, model or Vercel credentials, or builtin-provider forbidden names, is rejected.; Each item: minimum length 1

<!-- configuration-reference:/orchestrator -->

`[orchestrator.sandbox]` fields:


The credential-free rule is structural: the environment receives no store,
forge, ticket-provider, or model credential, and naming any of `AB_STORE`,
`AB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`, `VERCEL_OIDC_TOKEN`,
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, or `AI_GATEWAY_API_KEY`
in `environmentVariables` is a config error. The typed operator tools remain
the only route to build state from inside the sandbox. A workspace-provider
plugin can declare additional forbidden names via its registration's
`capabilities.sandboxForbiddenEnv`; those are enforced at the post-load seams
(provider construction and `ab init --validate`) rather than at config parse,
because plugins are not loaded when configuration is parsed — a deliberate
deferral, not an oversight. Concretely, the shared names above are rejected
when the config is parsed, plugin-declared extras are rejected when the
provider is constructed (dispatch and `ab mcp`), and `ab init --validate`
re-checks both sets after plugins load, before any infrastructure is
provisioned. Tool bounds:
`sandbox.exec` waits at most 300 seconds; stdout and stderr are each truncated
at 65,536 bytes with a `[truncated by autobuild: output exceeded 65536 bytes]`
marker; `sandbox.reset` and archiving your last session are
destructive (reset re-provisions from the current base head); there is at most
one environment per user and repository.

<!-- config-fragment:orchestrator -->
```toml
[orchestrator]
enabled = true

[orchestrator.sandbox]
idleMinutes = 30
environmentVariables = ["MY_TOOL_CONFIG"]
```

Set `MY_TOOL_CONFIG` in the host environment of the `ab mcp` process; a missing
value fails the tool call that needs it, named as a typed `environment` error.

Hosted sandbox tools compose their backend from the deposited effective config
and the authenticated request's credentials. The request's
`x-vercel-oidc-token` authenticates the Sandbox SDK; an explicit
`VERCEL_OIDC_TOKEN` takes precedence, or the durable
`VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` triple needs no header.
Archive cleanup uses the same request credential threading. Provider or forge
construction failures degrade sandbox tools only, with a diagnostic. Guests
receive no credential. The dispatcher retains idle settlement but never
constructs a turn runner. Tools stay gated by `[orchestrator].enabled` and the
registry's closed-table filtering; external harnesses own approvals.

## Complete example

The following deliberately exercises every fixed table and both verify/finalize
step variants. Replace commands, paths, roles, and ticket states with values
that exist in your repository and providers.

<!-- complete-config -->
```toml
baseBranch = "main"
capacity = 2
forge = "github"
plugins = ["./plugins/company.ts", "@acme/autobuild-plugin"]

[workspace]
provider = "company-container"

[workspace.config]
image = "ghcr.io/acme/build:bun"

[pr.imageHost]
provider = "github-release"
repository = "acme/public-review-assets"
releaseId = 123456

[commands]
setup = "bun install"
typecheck = "bun tsc --noEmit"
test = "bun test"
publish = "bun run publish"

[verify]
steps = ["types", "unit", "acceptance"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.unit]
kind = "check"
command = "test"

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill
paths = ["web/**", "src/routes/**"]

[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.default]
runtime = "claude"
args = []

[roles.plan]
args = ["--effort", "high"]

[roles.code-review]
runtime = "pi"
model = "kimi-coding/k3"
args = ["--extension", "./tools/web-access.js"]
sessionBudgetSeconds = 7200

[policy]
sessionBudgetSeconds = 3600
stallRounds = 3
maxVerifyAttempts = 3
maxDispatchAttempts = 3
maxSetupAttempts = 3
maxInfrastructureAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 6
harvestThreshold = 5
harvestMaxDrift = 3

[tickets]
source = "file"
readyState = "ready"
readyLabels = []
createState = "Triage"
triageState = "Triage"
proposalState = "Triage"
dir = "tickets"
```

This repository's [`autobuild.toml`](../autobuild.toml) is another worked
example.

## What `ab init` generates

On the first `ab init [target]`, when `autobuild.toml` is absent, Autobuild
writes a valid stack-neutral skeleton. Deterministic init code does not inspect
package manifests, infer commands, or ask a fixed adapter survey. It vendors the
editable skills, records their pristine bases, updates `.gitignore`, and probes
every registered runtime for executable/authentication usability.

Init reports every probe result and chooses a setup launcher from the fixed
product preference `claude`, then `codex`, then `pi`. That choice only starts
setup; the temporary `[roles.default].runtime` skeleton value does not constrain
the role runtimes or models the setup agent ultimately configures. When a
shipped runtime is usable, no Claude discovery conflict remains, and both stdin
and stdout are attached to a TTY, init starts the selected coding-agent CLI in
the target repository with a short prompt pointing to the locally editable
`.agents/skills/ab-guide/references/setup.md` guide reference. The user can
answer its repository- and team-specific questions directly. When launched,
the child exit status is init's exit status, and the direct handoff creates no
build or BuildStore data.

When no discovery conflict exists but no shipped runtime is usable or either
terminal stream is non-interactive, init still completes deterministic
installation and exits successfully. It prints the same setup pointer prompt verbatim
with instructions to run it in a coding agent; unusable runtime reports include
their reasons. The setup agent reads the installed guide reference, derives
commands and verification from the actual repository, chooses pipeline roles,
configures ticket workflow and environment-only credentials, arranges
an acceptance check through a repository-owned agent verify skill in every
repository. Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite. It completes `bun ab init --validate`, fixing failures and reviewing
warnings. You then start `bun ab dispatch` and open your operator agent with
`ab-operate` loaded to create and groom the first ticket, then check operator presence
before taking the role. An existing operator picks up ready work.

After installation, init reports `autobuild.toml: written|skipped`, counts all
skill outcomes, names attention-worthy local edits, and prints runtime probe
results. A distinct real `.claude/skills/ab-*` directory is an actionable
discovery conflict rather than an alias: init processes every skill, summarizes
all such conflicts with move/remove guidance, skips the setup handoff, and exits
1. Redirected/non-TTY output is plain text.

The generated file is an active-only, schema-valid skeleton. It writes
`baseBranch = "main"`, `capacity = 4`, empty `[commands]`, empty verify and
finalize step arrays, all six default policy values, a valid local file-ticket
gate, and the selected setup runtime as a temporary explicit role default. It
contains no setup command, package-manager command, language assumption, or
repository-derived value. Therefore repositories containing only `package.json`
or only `Cargo.toml` receive byte-identical config on the same machine.

The config rule is intentionally one-way: once `autobuild.toml` exists,
`ab init` does not reconcile or overwrite the file. This remains true with
`--force`; that flag can overwrite locally edited vendored skills, never
configuration. The setup prompt instead asks the agent to review and improve
the existing config.

Re-running init still maintains the `.autobuild/` ignore rule and skill
installation. `ab upgrade` migrates an absent landing policy from the target
repository journal; explicit landing arrays are preserved. See
[migration from 0.x](migration-1.0.md). By default it first updates a recognized
Bun installation — from the npm registry
for a registry install, or from GitHub Releases for a `github:` install — and
then merges vendored skills from that distribution. For a local install, Bun may update the
*owning* project's Autobuild dependency in `package.json` and `bun.lock`; this
package-manager side effect is separate from target-repository configuration.
Use `ab upgrade --no-self-update` for merge-only behavior.

By default, upgrade makes one local commit on the target's current HEAD after a
successful merge. It stages only paths it owns: each reported skill's canonical
`.agents` tree, `.ab-pristine` record, and `.claude` discovery path, plus the
target repository's `package.json` and `bun.lock` when this run's local Bun
self-update wrote them. A global Bun update changes no target path, and a no-op
skill merge creates no commit. Additions, modifications, links, and deletions
are included. The message identifies `ab upgrade` and pairs every skill whose
bytes changed with its reported outcome; unrelated staged, unstaged, and
untracked work remains untouched.

Use `ab upgrade --no-commit` to leave all output uncommitted for manual review.
The flag is forwarded when self-update hands off to the replacement binary, and
the default path likewise carries its pre-update Git baseline through that
handoff. If a replacement child receives the handoff marker without that
baseline — possible when an older parent launches a newer child — it suppresses
the entire automatic commit, names the cross-version compatibility reason, and
leaves all upgrade-owned changes uncommitted for you. Skill-upgrade
results and the merge-derived exit status remain unchanged. Upgrade likewise
suppresses the whole commit and names why when any skill or Claude discovery
path conflicts, an owned path was already dirty, the target is not a Git
repository, HEAD/worktree identity changes, or Git is mid-merge, mid-rebase, or
mid-cherry-pick. If upgrade cannot snapshot the worktree's Git index, it warns
and declines to stage. A failed staging or commit attempt restores that exact
pre-attempt index and reports the original Git failure; merged worktree files
remain in place and the merge's exit status is unchanged. Upgrade never pushes
or rewrites history.

Autobuild now installs 12 skills; only `ab-spec`, `ab-tickets`, `ab-guide`,
and `ab-operate` are model-invocable. The setup reference is an ordinary support file in the
editable/pristine `ab-guide` tree and participates in the same three-way
upgrade merge as every other vendored file.

Upgrade has two one-time retirement classifications for the former
`ab-setup` and `ab-verify-e2e` defaults. `removed` means pristine provenance
existed and either the unreferenced live tree matched it and was removed with
its owned discovery link, or the canonical live tree was already missing and
upgrade cleared provenance plus any owned dangling link. `kept` normally means
the tree was customized, still configured, or could not be proved safe to
remove; upgrade preserves it and clears obsolete pristine ownership. It also
means an otherwise removable canonical tree was deleted while a user-owned
`.claude/skills/<name>` discovery entry — a distinct real directory or foreign
symlink — was preserved byte-for-byte and remains discoverable. For a symlink,
its link text and target are unchanged. That entry enters the ordinary
structured discovery conflict report, so upgrade exits nonzero. A same-named
repository-authored skill with no pristine provenance is never removed, and a
second upgrade neither recreates a dangling link nor resurrects or re-reports
either retirement.

## Durable settings outside TOML

Three repository-wide choices intentionally live as facts in the
BuildStore repository journal, not in `autobuild.toml`. They are latest-write
wins, survive process restarts, and are sampled by every dispatcher on its
poll. Editing TOML cannot change them.

| Setting | Fresh-repository default | Controls | Scope |
|---|---:|---|---|
| Ticket intake | on | `ab dispatch --intake` / `--no-intake`; `i` on the dashboard's global row, and `p` (pause all) / `r` (resume all) on that row or their sessionless equivalents `ab pause --all` / `ab resume --all`, which turn intake off and on as part of quiescing the repository | When off, skip only new ticket list/claim/dispatch work. Janitor work, lease recovery, in-flight builds, and harvesting continue. Turning intake off does not hold builds the repository has already accepted — that is the repository pause below. |
| Repository pause | off | `p` (pause all) / `r` (resume all) on the dashboard's global row, or `ab pause --all` / `ab resume --all` | While on, the dashboard controls line shows `repository PAUSED`, and each held queued row shows `(held)` while retaining its literal `QUEUED` status. No dispatcher tick attaches a runner to such a build — recovery, startup resume, and the lease sweep all skip them. Running builds are parked by the per-build pauses the same command writes; the janitor still settles aborts and discards. |
| Harvest gate | on | `h` on the dashboard's global row | Pauses or resumes repository observation harvesting. The header shows the kernel-acknowledged gate, not merely a pending keypress. |

The opposite flag forms for each dispatch setting are mutually exclusive.
Omitting both writes nothing and reuses the durable value. Per-build
pause/resume and landing controls are separate facts and do not alter these
repository settings; landing authorization follows `[[landing]]`. Pause all and
resume all write two facts each — the
repository pause first, then intake — so a partial failure still leaves the
repository at least as quiesced as asked; `ab pause --all` reports on stderr
which of them landed when a walk stops partway. The current release has no TOML
field for either the harvest gate or the repository pause, and no command that
sets the repository pause on its own without also moving intake; inspect the
harvest gate with `ab harvest status`.

## Environment and credentials

Secrets and store selection accompany the file through environment variables:

| Variable | Used for | Notes |
|---|---|---|
| `LINEAR_API_KEY` | Direct Linear ticket source | Required and nonempty when `tickets.source = "linear"`; never used by the hosted service. |
| `AB_STORE` | BuildStore and hosted ticket selection | A local path or HTTP(S) remote-store URL. Hosted tickets use this only when `[tickets] url` is absent; local builds with hosted tickets require `[tickets] url`. A command's explicit `--store` wins for BuildStore selection, then nonblank `AB_STORE`, then `[store] url`, then the main checkout's `.autobuild/`. Relative local paths resolve from the main checkout. |
| `AB_TOKEN` | Protected remote BuildStore and hosted tickets | Bearer credential forwarded to the service. Hosted tickets require a stored credential for a registered project. Owner admin is an explicit break-glass exception. Empty means no token; nonempty token bytes are treated as opaque. |

A local store selection relocates the state database, blobs, worktrees, and the
default file-ticket directory together. With a remote store, Git worktrees and
default file tickets remain under the repository's local `.autobuild/` root.
An explicitly configured `tickets.dir` remains independent and resolves as
described in its field row.

The `ab` binary loads exactly `<cwd>/.env` before routing a command. Its minimal
parser accepts `KEY=VALUE`, an optional `export ` prefix, full-line `#`
comments, and matching single or double quotes around the entire value. It
trims surrounding whitespace, keeps additional `=` characters in values, does
not perform interpolation or escape processing, and silently skips malformed
lines. A missing or unreadable file is a no-op. Any key already present in the
real process environment—even an empty string—wins over `.env`.

Variables such as `AB_BUILD`, `AB_PHASE`, `AB_SESSION`, and the harvest-session
identity tuple are runner-owned ambient authorization. You should not
set or copy them into `.env`; the runner stamps them for each session.

Forge and agent credentials remain adapter-owned. The `local-git` forge uses no
credentials or network access: it keeps durable PR records under private Git
refs, leaves each work build at `refs/heads/ab/<slug>`, and lands root leaves by
squash under the recorded landing authorization. Node landings use guarded
fast-forwards; see [landing methods](landing-policy.md#landing-methods).
The squash author and committer come from the
repository's ordinary Git identity, as resolved for a plain `git commit`; the
landing is always unsigned even when `commit.gpgsign` is enabled. If Git cannot
resolve that identity, the PR remains open and `ab build status <slug>` names
`user.name` / `user.email` setup commands; dispatcher ticks retry automatically
after you configure them. A dirty checked-out base does not by itself
block the landing: tracked and untracked work on paths untouched by the squash
survives.
If the squash would overwrite your work, the PR remains open, `ab build
status <slug>` shows a path-bearing observation, and later dispatcher ticks retry
automatically after you commit, stash, or discard the collision;
Autobuild never mutates that work. Inspect an open local change with `git diff
main...ab/<slug>`. It has no review web UI and no image-hosting capability; attached artifacts use
the existing text-download projection.

- for `forge = "github"`, either export a `GITHUB_TOKEN` or `GH_TOKEN` or run `gh auth login`:
  the kernel speaks the GitHub REST API directly, taking `GITHUB_TOKEN`, then `GH_TOKEN`, then the
  gh CLI's stored login (`gh auth token`) — so a local dispatcher needs only the gh login, while a
  host without gh (hosted or sandboxed dispatchers) must export a token. Separately make sure the
  Git remote can fetch/push with the process's Git credentials;
- Claude sessions invoke the local `claude` CLI and use its configured login;
  install Claude Code, launch `claude`, and complete login before dispatching;
- Codex sessions invoke the local `codex` CLI and use its configured login;
  install Codex, run `codex login`, and complete authentication before
  dispatching;
- Pi sessions use Pi's provider authentication: start `pi` and run `/login`
  inside the interactive session, or, for non-interactive use, supply the
  provider credentials Pi supports (such as provider API keys in the environment).

No provider API key, GitHub token, or remote-store bearer token belongs in
`autobuild.toml`.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for symptom-led diagnosis and recovery.

### Reading an invalid-config error

Start with `ab dispatch --once` when a real single tick is safe. A syntax error
looks like:

```text
/path/to/autobuild.toml: TOML syntax error: ...
```

Fix TOML structure first. A schema failure starts with:

```text
/path/to/autobuild.toml: invalid config
  verify.acceptance.skill: ...
  tickets.teamKey: ...
```

Each indented path is independently actionable. Common causes are a root scalar
placed after a table, a misspelled strict field, a step listed without its
subtable (or vice versa), a check naming no `[commands]` key, a field used on
the wrong step kind, or source-specific ticket fields used together.

Runtime routing failures use a separate heading and list all bad roles. Check
the merged `default` plus child values, not just the child table: each axis
inherits independently. Confirm the runtime name is shipped or registered by a configured plugin and
use `ab models [query]` (or the plugin's documentation) to choose a model family
that runtime serves.

### `tick: idle` with expected work

In plain/non-TTY mode, `tick: idle` means the pass recorded no dispatcher
action. Check the gates in this order:

1. **Durable intake:** the dashboard header must show intake on, or explicitly
   run a future dispatcher with `--intake`. Intake off skips the ready scan
   even when tickets exist.
2. **Repository pause:** a pause all holds every queued build, so the dashboard
   controls line shows `repository PAUSED` and an existing held build shows
   `(held)` beside its literal `QUEUED` status. Intake off alone shows neither
   pause indication. `r` on the dashboard's global row or `ab resume --all`
   releases the hold and restores intake.
3. **Ready state:** the ticket must be in exactly `tickets.readyState`. Linear
   is case-sensitive; file tickets must physically be in the corresponding
   state directory.
4. **Labels:** the ticket must carry every effective `readyLabels` value,
   including Linear's default `autobuild` label when the field is omitted.
5. **Dependencies:** every `blockedBy` ticket must exist and be complete in the
   same source. This includes harvest proposals filed directly into the ready
   state. Plain dispatch output reports unresolved ids and cycles.
6. **Capacity:** every nonterminal build for this repository—including paused
   and blocked builds—uses a slot. Inspect `ab builds --queued` and
   `ab build status <slug>` rather than looking only for a live process.
7. **Duplicate work:** a ready ticket already represented by an active build is
   deliberately excluded from the queue.

If the expected work is observation harvesting instead of a ticket, check the
acknowledged harvest gate, the dashboard's unclaimed `observations` count, and
the configured triggers. Harvest starts when `policy.harvestThreshold`
unclaimed observations exist or when `policy.harvestMaxDrift` other builds have
merged since the oldest one; a drift limit of zero disables the second
condition. The header shows count pressure against `harvestThreshold`; drift
progress is not shown. Harvest does not consume build capacity.

### Authentication failures

- **Linear:** `LINEAR_API_KEY is not set` means the selected source was wired
  without a nonempty key. Set it in the real environment or `<cwd>/.env` and
  rerun. For API rejections, verify the personal key, `teamKey`, and that every
  configured workflow state exists in that team.
- **GitHub and Git:** run `gh auth status` for PR, auto-merge, and release API
  calls; verify repository permissions and separately test the Git remote's
  fetch/push credentials. Image hosting additionally requires a public host
  repository, an existing published mutable release, the numeric release id,
  and Contents write permission.
- **Agent runtime/provider:** authenticate the runtime selected by the merged
  role. A missing Codex adapter diagnostic names both `codex runtime` and the
  `codex` executable; install it and run `codex login`. A 401/402/403,
  permission, quota, or billing rejection is treated as a permanent provider
  failure rather than retried indefinitely. For Pi, confirm the
  provider-qualified model and provider login.
- **Remote BuildStore:** confirm the effective `AB_STORE` URL and `AB_TOKEN`.
  A protected store reports 401 for a missing, invalid, or expired token and
  403 when the token is valid but scoped to another build/session.

### Hosted project selection

The durable PostgreSQL project registry controls dashboard, MCP and operator
API access. Super users see every active entry; members see only their organizations’ projects. Administer it with
`ab-hosted-store projects list|add|remove` using deployment database credentials;
mutations require `--user IDENTITY` for declared attribution. See
[connected projects](setup.md#connected-projects) for migration and retention.
`AB_DISPATCHER_REPOSITORIES` optionally selects an ordered subset of current
registrations. When unset, each authorized tick queries all active entries.
Removed credential override keys are inert in dynamic mode; explicit-list
configuration still rejects unknown override keys.

## Hosted service client compatibility

A service accepts stable and prerelease clients from its own `major.minor`
release line and the two preceding minor lines in the same major. A major starts a new family:
X.0 accepts only X.0, X.1 accepts X.0/X.1, and X.2 onward accepts three lines.
Patch versions are interchangeable in both directions and must never change
the protocol. Upgrade the service first, then projects independently within
its window. Supported release lines retain their wire handlers and known
protocol identities; an unknown protocol is refused independently of version.
Stable and prerelease service and client identities share their numeric major/minor
line. Malformed or missing identities, build metadata (`+…`), prefixes and
whitespace are refused with HTTP 409.
A newer client is told to upgrade the service; a client below the window is
told to upgrade the project's Autobuild. Diagnostics name the service version
and supported range.

Unauthenticated `GET /health` publishes `ok`, `autobuildVersion`,
`protocolVersion`, and `supportedClientRange: { minVersion, maxVersionExclusive }`.
Range endpoints remain stable versions. The range is inclusive at the minimum
and exclusive at the maximum; a 0.11.x
service publishes `>=0.9.0 <0.12.0`. Health needs no credentials, version
headers, or available backend.

Remote workspace factories must use `delegateCredential(storeRef, undefined,
target)` to obtain per-resource grants before provisioning or launching guests.
The callback keeps parent authority in host composition. `storeToken` is retired
and is never supplied; factory environments also exclude `AB_TOKEN`. Launch
credentials travel through the separate transient execution-auth argument, never
through serialized execution identity. Existing plugins that forwarded
`storeToken` must migrate to this callback and fail closed if it is unavailable.

## Landing policy

The [`[[landing]]` table](#landing) defines ordered authorization rules and
readiness provenance. See [landing policy](landing-policy.md) for examples,
merge methods and forge capability requirements.

`ab hold <slug>` durably suppresses landing and revokes previous consent, even
before readiness. `ab land <slug>` requires readiness, clears hold, and consents
to this build/node landing into its effective destination. Consent survives head
replacement, restacking, verification and re-finalization until another hold or
completion. Accepted node reparenting revokes consent; holds survive.
It is consent to the landing, not approval of an immutable diff.
Commands and acknowledgements are sequence-correlated; hold acknowledgement
requires confirmed native cancellation, while land acknowledgement accepts
consent without claiming that merge gates passed. The same actions are available
through the MCP/operator build-control tools. The terminal uses `l` for land and
`o` for hold on the selected landing. The hosted web app offers **Land** and
**Hold** on a landing awaiting consent, with the same durable acknowledgements
and merge gates. It does not provide a landing-policy editor.

The repository auto-merge default and its fan-out are retired. Historical events
still replay; explicit old per-build commands map to consent/hold until a new
landing command supersedes them, while old default seeds confer no consent.
`ab upgrade` samples the target repository's configured journal and writes leaf
auto for old ON, leaf consent for old OFF (including no fact), and node consent
in either case. Explicit landing arrays remain byte-for-byte unchanged. Missing
configuration or unavailable journals fail with recovery guidance. Fresh init
uses the no-rules fallback.

Native auto-merge is reconciled on every janitor poll against durable desired
landing state. It is disabled while held, unauthorized, unready, or replacement
publication is pending or just completed; enabling binds to the current head
through the forge's expected-head guard. Every replacement publication confirms
cancellation first, and its first following poll re-reads and reconciles native
state before other build actions. Native receipts bind to exact candidates;
consent does not. A stale enable completing after cancellation is repaired by
poll reconciliation. This is an explicitly bounded failure model: native merge
is used only behind a merge-blocking gate, and checks on a replacement head must
take far longer than one poll interval, allowing cancellation before they pass.
There is no durable native-effect reservation protocol. An undesired forge
landing is classified from the kernel's last durable native application state, without changing provider contracts. A confirmed disabled
state with no enable in flight or indeterminate means a deliberate human forge
landing, which supplies consent. Record whether it overrode a hold: an unheld
human landing needs no attention from your agent; overriding a hold is informational.
If native auto-merge was armed, or an enable was in flight or indeterminate,
record a possible stale-enable landing as contrary to policy and notify your agent
attention. Autobuild never rewrites the target to undo either outcome. Merge
gates and the serialized node-writer publication rules remain authoritative.
### Failure budgets and own-build read deferrals

For leaves, `policy.maxVerifyAttempts` counts distinct failed logical verify cycles after
the latest spec revision. Passing and skipped cycles, including target movement
through restack or reconcile, consume zero. Cycle identifiers remain monotonic;
pass, pass, pass, fail at cycle 4 spends one failure. Duplicate completion
evidence for a failed cycle does not charge it twice.

Classified session deferrals consume no phase failures. Unsupported decisive
facts retain the mixed-version wait gate and durable compatibility diagnostic.
When the scoped `ab context` initial own-build read fails, the CLI best-effort
writes `session.build-read-failed` with exact session, phase, round, operation
`context`, reason `own-build-read`, and diagnostic. A valid terminal from that
session wins if the agent recovers. Otherwise settlement records `phase.deferred`
and `phase.deferral-escalated`, immediately projecting ordinary blocked attention.
The raise cites `own-build-read:<evidenceSeq>`; replay repairs either settlement
crash gap before launching another agent. An `escalation.answered` retry or
guidance authorizes one fresh session without resetting genuine phase failures;
a new classified failure parks again. There are zero automatic paid retries
after this deferral. If evidence cannot be written, ordinary recovery applies;
agent output and `no-terminal` alone never classify a read failure.

Ordinary silence, provider failures and session timeouts retain the runner's
phase failure limit (`BuildRunnerOpts.maxPhaseAttempts`, default 2). This is
an internal runner option, not an accepted `[policy]` TOML key. Reconcile
execution and unchanged-base progress budgets retain their existing accounting.

Default `ab watch` and `ab wait --for attention` include
`phase.deferral-escalated`; explicit event filters replace the default set.

## Integration verification attention

A failed node verification cycle records `integration.verification-failed` with its prepared cycle id, failed steps, exact head and parent, and guidance to file a repair child targeting the node. The kernel reports durable failed receipts; dispatcher housekeeping recovers missing reports for the current cycle using a per-cycle CAS guard. Superseded cycles are never backfilled with repair instructions: recovery requires the latest prepared cycle to match the node’s observed head and parent. This fact is decisive evidence and bookkeeping, and does not change verification or leaf routing.

Default `ab watch` includes this event. Watch cursors deliver each failed cycle once and baseline failures when first armed; reconcile build status after arming. `ab wait --for attention` also detects a current failed node cycle before the report is written. Historical facts remain queryable after repair without retaining current attention. Explicit event globs and existing stored wake choices are preserved.

## Immutable dispatcher generations

Resident checkout dispatch runs from an immutable generation snapshot under the
main checkout's `.autobuild/runtime/` cache. Configuration and plugin selection
still use the checkout. A launcher freezes the currently installed distribution
and production dependencies offline; all later local runners and agent CLIs use
that same snapshot. Automatic adoption is enabled by default through `[upgrade]`
below; a manual restart is required when automatic upgrades are disabled or the
launcher contract changes. `--once`, origin mode and hosted cron retain their
direct execution paths.

## `[upgrade]`

`[upgrade]` is a strict, hot-reloaded table:

<!-- configuration-reference:upgrade -->

#### `upgrade`

**TOML key:** `upgrade`

- **Type:** `strict table`
- **Default:** `{} (input supplied on omission; nested defaults apply)`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Automatic dispatcher runtime target checks and adoption.

**Constraints:** None beyond the input type.

#### `upgrade.automatic`

**TOML key:** `upgrade.automatic`

- **Type:** `boolean`
- **Default:** `true`
- **Required:** Optional
- **Reload:** Hot: next dispatcher action captures the accepted value. A running invocation keeps its captured values.

**Description:** Check and adopt changed runtime targets automatically.

**Constraints:** None beyond the input type.

<!-- configuration-reference:/upgrade -->


<!-- config-fragment -->
```toml
[upgrade]
automatic = true
```

`automatic` defaults to true, including for older saved configuration. Resident
checkout dispatchers check immediately and every **60 seconds**, independently
of ticket scans. A dependency or devDependency declaration of
`@defrex/autobuild` on the authoritative forge base branch selects **pinned**
mode. Manifest and `bun.lock` must agree at the same commit. Working-tree pins,
feature branches and stale tracking refs never select a runtime. Unsupported or
missing declared-dependency metadata raises attention rather than switching modes.
Without a declaration, **installed** mode rereads the original installation
pathname across handoffs. A launch from a source root sharing the dispatched
repository's Git common directory selects **source** mode first. The launcher
freezes that eligibility and the initial packaged-content baseline across
successors; changing the operator checkout cannot change what a generation runs.
Source targets use the forge-authoritative base commit. Installation exports that
exact commit into private cache staging, requires the committed Bun lock, and runs
`bun install --frozen-lockfile --ignore-scripts --no-progress`. The immutable
cached distribution records that commit and follows normal cache pruning.

Source equality compares actual packed contents and production-reachable lock
records, including nested dependencies, rather than version or SHA. An excluded
RFC, website or test change does not hand off; documentation included by the
package's files rules does. Unrelated workspace lock records do not trigger an
upgrade. Unsupported reachable dependency metadata raises attention.

A successor first validates configuration and the actual selected store without
starting repository work or terminal input/output. Provider compatibility evidence
chooses drain when sharing is safe and cutover otherwise. SQLite compares its
untouched catalog with target requirements; HTTP uses the live service's client
and protocol admission. Missing evidence chooses cutover. A target outside the hosted client overlap
window also requires cutover; target admission and successful protocol writes
are still mandatory. Cutover never makes a rejected target runnable. Successful durable
protocol writes are also required: a service that admits the client but rejects
a new yield fact fails preflight, leaving the predecessor active with target and
reason in repository attention. Failed targets are not retried every tick; a change in selected-store compatibility
evidence allows the normal target-check cadence to retry.

Local harvest suspends durably before repository lease release on handoff or
clean stop. The next generation resumes eligible native sessions with fresh
logical credentials, or records a reasoned `harvest.session.resume-fallback`
and starts fresh. Orderly suspension spends no recovery attempt; real crashes
retain recovery accounting.

The predecessor serializes acceptance with ticks and launch admission, joins
repository-owned harvest and provisioning work, and records the exact local
executions, start time and deadline. Its terminal frontend removes and joins
input/render work before acknowledging terminal release. Only after that durable
acknowledgement and a successful repository lease claim may the successor draw
or consume input. Only the successor ticks, claims, runs janitor/harvest and
launches runners. Execution leases remain with existing local runners; remote
executions detach immediately. Their exact instances and recorded guest runtimes
are captured separately on `dispatcher.handoff-started.remoteBuilds`. This
authorization work survives local retirement completion and late attachment;
it never adds to local drain counts or delays predecessor exit. Guests retain
their leases and heartbeats and request neutral relaunch after their current
phase completes. The successor re-attaches with refreshed guest bytes.

A draining predecessor supervises its captured local executions until they settle
or `policy.upgradeDrainSeconds` (900 seconds by default) elapses. The deadline
tracks accepted live policy changes relative to the original start. Remaining
local sessions suspend through the normal durable native-resume path before
process-group cleanup. Cutover uses this suspension path immediately and waits
for predecessor stop before takeover. Retirement completion records drained and
suspended counts separately from takeover. A successor reconstructs unfinished
retirement from execution leases and durable build facts after predecessor death.
An unrelated dispatcher taking the lease still causes ordinary supersession and
teardown.

With rollback-capable launcher and generation peers, three failed successor exits
within ten minutes of the original durable takeover restore the immediately previous
cached runtime. The first two failures restart the same runtime without repeating
preflight. Preflight failures never count; outside that window ordinary failure
exit behavior applies. Rollback goes back one runtime only. The launcher opens no
store: it passes a validated, versioned recovery context to the restored generation,
which records `dispatcher.runtime-rolled-back` under repository authority and holds
the failed target for that launcher lineage. Store compatibility changes, resolution
errors and disabling/re-enabling upgrades do not clear this hold. A successfully
resolved different target records `dispatcher.rollback-hold-cleared`; a fresh operator
launch starts a new lineage. Both previous and held runtimes remain protected from
cache pruning. Existing phase executions keep their leases and continue on the
restored runtime at the next boundary; unreadable decisive facts defer a build with
attention before any action. Peers without negotiated rollback capability retain
existing failure behavior and report that capable runtimes are required.

Repository status exposes per-run resolved target, handoff and failure details.
`dispatcher.upgrade-target-resolved` records the first successful resolution and
later changed observations, including equal-content advances. Its source mode,
base and target SHA remain visible separately from the running commit and earlier
handoff/failure facts. Repeated identical polls append no resolution facts.

Repository status exposes both generations, mode, takeover, outstanding draining executions and deadline, plus per-run target and failure details. Upgrade
failure is repository attention, naming the target and reason. Resolution/install
failure leaves the running generation active and suppresses the same failed input
until target or selected-store compatibility evidence changes or a fresh operator launch. Unrelated base advances do not
retry failed installs. Operator stop always wins over replacement startup.

Set `automatic = false` to cancel pending preparation and retain manual restart
behavior. A launcher contract change also requires a manual restart. A legacy v1 launcher
without overlap supervision requires restart before another automatic adoption. `--once`,
origin/hosted dispatch and direct development presentation modes do not auto-upgrade.
`ab upgrade` still updates the pin/installation and merges skills locally, commits
when eligible, and never pushes. Pinned dispatchers follow after that commit
reaches the base branch; installed-mode dispatchers follow their replaced install.
Source-mode dispatchers follow changes to packaged inputs merged to the base,
including shipped canonical skills, without a version bump.


The retired `AB_WEB_ALLOWED_EMAILS` variable is refused at startup, even if empty.
Replace it with `AB_WEB_SUPER_USER_EMAILS`; review the list because these identities
are deployment maintainers. Bootstrap the first organization through the
[browser management contract](operator-api.md#organization-management-browser),
then add members by email and assign legacy unassigned projects. Super users alone
create orgs, set or clear the single owner, and assign or move projects. Owners
manage their org's members. Removing the last membership or super-user designation
revokes human access on the next request without re-login; existing project
credentials remain valid until revoked.
