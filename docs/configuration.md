# Configuration reference

Autobuild reads one declarative `autobuild.toml` from the repository root.
Commands in the file are shell strings; the file itself is never evaluated as
code. A running dispatcher owns an accepted snapshot from the main checkout,
while scoped phase commands read the build worktree's branch-owned file.
Configuration changes therefore move through review like any other change and,
once merged, can be adopted by the running dispatcher.

This document covers the complete accepted TOML surface. Examples labelled as
fragments are intended to be added to an existing file; the [complete
example](#complete-example) is valid on its own.

## PostgreSQL BuildStore environment

The optional `@autobuild/postgres-store` adapter is configured only through the
environment. It is distributed in Autobuild's GitHub releases rather than npm,
so an ordinary `autobuild` CLI install does not acquire its PostgreSQL or
blob-provider dependencies. Choose the adapter-compatible tag shown in
[GitHub Releases](https://github.com/defrex/autobuild/releases), clone that exact
revision into a dedicated checkout, and run the idempotent migration there:

```sh
git clone --depth 1 --branch v0.6.0 --single-branch https://github.com/defrex/autobuild.git autobuild-v0.6.0
cd autobuild-v0.6.0
bun install --frozen-lockfile
AB_POSTGRES_URL=postgres://… bun run postgres:migrate
```

Replace `v0.6.0` with the selected release tag. Schema diagnostics' root
`postgres:migrate` script is relative to that pinned checkout. The database
identity needs permission to create tables during migration and to select,
insert, and update those tables at runtime.

| Variable | Required when | Values / purpose |
|---|---|---|
| `AB_POSTGRES_URL` | Always | Nonblank PostgreSQL connection URL; this is the adapter's sole database input. |
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
`[workspace.config]`, `[verify.<step>]`, and `[finalize.<step>]`. Autobuild
validates the repository-defined command, role, and step entries.
`[workspace.config]` is instead plugin-owned and passed through unchanged to
the selected provider; the builtin `git-worktree` provider requires it to be
empty. Every other known table is closed to unknown keys.

There are three validation layers:

1. TOML syntax and schema/cross-field validation happen while
   `autobuild.toml` is loaded. Errors start with the file path and either
   `TOML syntax error` or `invalid config`; schema errors then identify paths
   such as `verify.e2e.skill` or `tickets.teamKey`.
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
Each dispatch, build, check, or agent action captures the accepted configuration
snapshot at its start boundary: work already running is not interrupted, while
the next setup or pipeline step of the same in-flight build uses the new
snapshot. Raising capacity can fill the new slots immediately; lowering it
prevents new claims without terminating builds already above the limit. `ab
dispatch --once` performs one pass and does not watch or reload.

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

These fields hot-reload:

| Field or table | Boundary where a new value applies |
|---|---|
| `baseBranch` | Next dispatch or base fallback decision; existing `build.created` facts remain immutable. |
| `capacity` | Next dispatcher tick. |
| `[pr]` | Next build creation. |
| `[commands]` | Next setup, verify check, or finalize check selected. |
| `[verify]` and `[finalize]` | Next engine step selection. An approved plan's stored verify selection remains authoritative. |
| `[roles]` | Next agent invocation for that role. Runtime, model, args, alternates, and the session budget are captured together. |
| `[policy]` | Next policy, convergence, or agent-session boundary. A running session keeps its captured budget. |
| `tickets.readyLabels`, `tickets.readyState` | Next ready-ticket scan. |
| `tickets.triageState`, `tickets.proposalState` | Next dispatcher handback or harvest filing boundary. |

Adapter selectors and factory inputs are constructed once and require a
restart. A valid save may still apply its hot fields, but these changed paths
remain pinned to their startup values and are reported explicitly:

| Restart-required field | Reason |
|---|---|
| `plugins` | Plugin modules and registration catalogs load before wiring. |
| `forge` | Selects the constructed Forge adapter. |
| `workspace.provider`, `workspace.config` | Select and configure the constructed workspace provider. |
| `tickets.source`, `tickets.teamKey`, `tickets.claimedState`, `tickets.createState`, `tickets.dir` | Select or configure the constructed TicketSource. |

The dispatch process reads the main checkout because it owns repository intake.
Scoped phase commands still read the build worktree's `autobuild.toml`; this is
the existing build-context boundary and is not unified by hot reload.

## Root scalars

All root scalars are optional and receive defaults. They must appear before
any table header.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `baseBranch` | `"main"` | nonempty string | Branch used to cut builds, target PRs, and merge during reconciliation. |
| `capacity` | `1` | positive integer | Maximum concurrent nonterminal builds for this repository. Paused and blocked builds still occupy capacity. |
| `forge` | `"github"` | nonblank string | Forge adapter name. Shipped values are `github` and `local-git`; configured plugins may register other names. |
| `plugins` | `[]` | array of unique nonblank module specifiers | Trusted Bun plugin modules loaded by dispatch, `ab ticket`, and scoped phase CLI processes. |

### Plugin modules

<!-- config-fragment:plugins -->
```toml
plugins = ["./plugins/company.ts", "@acme/autobuild-plugin"]
```

Repository-path specifiers (relative, absolute, and `file:`) resolve from the
root whose config is being read. In a scoped phase process that root is the
immutable build worktree. Bare npm package specifiers resolve from the consuming
repository's main checkout and therefore use its installed dependencies, not
Autobuild's own installation tree. This package lookup remains stable when a
relocated local store places a linked worktree outside the checkout. Dispatch
and sessionless commands use the main checkout for both roots. Missing packages
fail loading; Autobuild does not install them.

Every configured specifier string must be unique. An exact repeat fails schema
validation before any plugin resolves or evaluates; the diagnostic identifies
the repeated value and both list positions and tells the operator to remove or
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

Plugin authors import the stable surface from `autobuild/plugin-sdk`, normally
with `import type`, and can develop against Autobuild as a dev/peer dependency
without adding a runtime Autobuild dependency to the plugin. That entry point
exports the manifest/factory types, port types, fake adapters, and reusable
TicketSource, AgentRunner, WorkspaceProvider, Forge, BuildStore, and BlobStore
contract suites. Adapter values may use the backward-compatible bare factory or
carry a contract fixture descriptor. Ticket sources may also declare
`requiredEnv`; the host checks every declared variable for a nonempty value
before invoking the adapter factory. Plugins using Forge abort-cleanup and
AgentRunner turn-cancellation capabilities introduced in API 1.2 should require
`^1.2.0`. The structured failure `cause` and provider-exhaustion contract
scenario were added in API 1.3; a runtime plugin that relies on them should
require `^1.3.0`. API 1.4 adds the optional `Ticket.creationKey` projection: a
ticket-source plugin should return its stable external create/adoption key from
create, get, and ready listings so dispatch can correlate Autobuild's durable
in-flight creations. Legacy tickets may omit it and remain dispatchable.

```ts
import type { AutobuildPluginManifest } from 'autobuild/plugin-sdk'

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

Use the sessionless author/operator loop from the repository checkout:

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

## `[pr]`

Optional. Omitting the table leaves attachment hosting off; attached artifacts
still receive exact BuildStore download commands in the PR summary.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `imageHost` | omitted (off) | optional `[pr.imageHost]` table | Copy attached images to a temporary public review location so they can render inline. |

### `[pr.imageHost]`

This optional nested table selects the one shipped image-host adapter. If the
table exists, all three fields are required.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `provider` | — | required literal `"github-release"` | Select the GitHub release adapter. |
| `repository` | — | required exact nonblank `owner/repo` pair | Public repository containing the existing review release. |
| `releaseId` | — | required positive integer | Numeric id of an existing published, mutable release. |

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
the authoritative copies under the store's own retention policy.

## `[workspace]`

Optional. Omission preserves the shipped git-worktree behavior. The surrounding
table is strict; only the explicit nested `config` table is plugin-owned.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `provider` | `"git-worktree"` | nonblank builtin or plugin-registered name | Select the provider used for provisioning, recovery, PR epilogue working-directory calls, and release. |
| `config` | `{}` | nested open table; must be empty for `git-worktree` | Adapter-specific declarative configuration passed unchanged to the selected plugin factory. |

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
reaches the factory verbatim, including names such as `__proto__` that collide
with inherited object properties; the map has a null prototype, so reading an
undeclared key answers `undefined` rather than an inherited member. Factory
invocation is lazy: registering an unselected provider constructs nothing. An
unknown name fails before claims and lists every available builtin and plugin
provider.

Every provider must satisfy the exported `WorkspaceProvider` contract and
return a locally reachable absolute working-copy `path`. Its provider-scoped
`ref` need not be that path; both are retained as durable workspace evidence.
Remote sandbox execution, where build processes run off-host, is a separate
architecture and is not enabled by this selector.

## `[commands]`

An optional open map of repository-defined names to shell strings. Its default
is `{}`. `setup`, `lint`, `type-check`, and `test` are conventions, not fixed
schema fields.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `<name>` | — | nonempty key and nonempty shell string | Name a deterministic verb for setup or a check step. |

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

`[verify].steps` defines the configured universe and execution order. It is
optional and defaults to no verify phases. Every listed name needs one matching
subtable, and every named subtable must be listed; a defined-but-unlisted step
never silently disappears.

There are two strict step variants:

- `kind = "check"` runs a configured command directly and decides pass/fail
  from its exit status. It starts no agent session.
- `kind = "agent"` runs the exact configured skill, which terminates with an
  `ab verdict` of `pass`, `fail`, or `skip`.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `steps` | `[]` | array of nonempty step names | Canonical execution order. |
| `kind` | — | required `"check"` or `"agent"` | Select the strict step variant. |
| `command` | — | required for check; nonempty key in `[commands]` | Deterministic shell verb to run. Forbidden for agent steps. |
| `skill` | — | required for agent; nonempty string | Exact installed verifier skill. Forbidden for check steps. |
| `paths` | omitted (unconditional) | optional nonempty array of positive repository-relative globs | Apply only when at least one changed path matches. Available to both variants. |
| `always` | omitted (`false`) | optional boolean | `true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants. |

<!-- config-fragment:verify -->
```toml
[commands]
typecheck = "bun tsc --noEmit"

[verify]
steps = ["types", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.e2e]
kind = "agent"
skill = "verify-app-e2e" # repository-authored skill
paths = ["web/**", "src/routes/**"]
```

Autobuild does not ship a generic agent verifier. `verify-app-e2e` above is a
skill authored by the repository for its own running application.

Cross-field validation rejects:

- a listed step without its `[verify.<step>]` table;
- a named table not present in `steps`;
- a check whose command is absent from `[commands]`;
- fields from the other kind, unknown fields, and malformed selectors.

`always = true` does not make malformed `paths` acceptable: all supplied
selectors are validated even though the mandatory step will not use them for
applicability.

### Role routing for an agent verify step

An agent verify step selects `[roles.<step>]` by its **logical step name** —
the name in `[verify].steps`, not the skill it runs. This is the same rule an
agent finalize post-step follows.

<!-- config-fragment:verify-role -->
```toml
[verify]
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "verify-app-e2e" # repository-authored skill

[roles.e2e]        # the STEP name — not "verify-app-e2e"
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
verifySteps = ["types", "e2e"]
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

A passing check or agent advances to the next step. An agent failure requires
`ab verdict fail --report <file>`; the exact report is routed back to implement,
and the failure consumes the verify retry budget in
`policy.maxVerifyAttempts`. Check failures similarly retain command output as
the implementation feedback.

An agent may instead use `ab verdict skip --reason <text>` when the configured
judgment genuinely does not apply. The trimmed reason must be nonblank, and no
failure report is required. Plan and path exclusions are kernel-authored skips
with deterministic reasons. Every skip satisfies that one step and advances,
but remains distinct from a pass, does not mask another step's failure, and
does not consume the failure retry budget.

## `[finalize]` and `[finalize.<step>]`

`[finalize].steps` is an optional ordered list of post-PR actions and defaults
to `[]`. These run after the finalize agent writes the PR description and the
kernel opens the PR. Like verify, every listed name requires one matching table
and every table must be listed.

Finalize has a smaller strict union. Verify-only `paths` and `always` fields
are errors.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `steps` | `[]` | array of nonempty step names | Ordered post-PR actions. |
| `kind` | — | required `"check"` or `"agent"` | Select deterministic command or agent action. |
| `command` | — | required for check; nonempty key in `[commands]` | Run the mapped command with no agent session. |
| `skill` | — | required for agent; nonempty string | Exact installed skill; no prefix is inferred. |

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
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "verify-app-e2e" # repository-authored skill

[finalize]
steps = ["release-notes"]

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.e2e]              # verify STEP name — not "verify-app-e2e"
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

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `runtime` | inherited from required `[roles.default].runtime` | required on `default`; optional nonempty registered runtime name on children | Select an agent adapter. |
| `model` | inherited; otherwise selected runtime's own default | optional nonempty model id compatible with the resolved runtime | Select the exact model. Codex uses unqualified `gpt-*`; Pi ids are provider-qualified. |
| `args` | inherited; otherwise `[]` | optional array of nonempty strings; `[]` allowed | Ordered extra CLI argv tokens applied to every phase and tool-free one-shot invocation. A supplied list replaces, rather than unions with, the inherited list. |
| `extensions` | no effect | deprecated optional array of nonempty strings | Compatibility-only field. Dispatch warns for each declaring role; migrate explicit runtime options to `args`. |
| `sessionBudgetSeconds` | inherited; otherwise `[policy].sessionBudgetSeconds` | optional positive integer | Wall-clock budget for each build phase session routed through this logical role. One budget covers the primary and every alternate target. |
| `alternates` | inherited; otherwise `[]` | optional ordered array of strict `{ runtime?, model?, args?, extensions? }` entries; `[]` allowed | Failure-triggered execution targets. A role's list replaces the inherited list wholesale; each entry overlays that role's effective primary axes. `extensions` is accepted there only as the same deprecated no-op. |

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
without them, no operator-installed extension loads. A plugin may declare
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
Authentication, permission, and local runtime-configuration failures do not.
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
ignores cancellation is released when the deadline arrives. If operator abort
arrived first, that release stays an abort control outcome, starts no alternate,
and records no `phase.failed`. A typed terminal deposited before either boundary
remains authoritative. Agent finalize post-step expiry instead records that
failure-tolerant step as `ok = false` and files its follow-up observation.
Harvest sessions and direct verify/finalize check commands are not covered by
this setting.

## `[policy]`

Optional. Every field receives its own default. All are positive integers except
`harvestMaxDrift`, which is nonnegative so zero can disable that trigger.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `sessionBudgetSeconds` | `3600` | positive integer | Wall-clock bound for each build agent session unless its logical role overrides it. |
| `stallRounds` | `3` | positive integer | Escalate when the same review finding survives this many rounds. |
| `maxVerifyAttempts` | `3` | positive integer | Bound failure-driven verify → implement retry cycles. |
| `maxSetupAttempts` | `3` | positive integer | Bound consecutive workspace setup failures before human escalation. |
| `maxReconcileAttempts` | `3` | positive integer | Bound completed reconciles that leave the PR conflicted against an unchanged authoritative base. Moving-base races do not consume the bound. |
| `maxReviewRounds` | `6` | positive integer | Default bound for each plan/review and implement/review convergence loop. An operator may replace it for one parked build loop and current spec revision with `ab answer --review-round-ceiling`; other builds are unaffected. |
| `harvestThreshold` | `5` | positive integer | New unclaimed observation occurrences needed to start one harvest run. |
| `harvestMaxDrift` | `3` | nonnegative integer | Other builds merged after the oldest unclaimed observation needed to start a run; `0` disables drift. |

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

Required in practice: `readyState` deliberately has no default, so omitting the
table fails at `tickets.readyState` rather than allowing tickets from every
state. Within a present table, `source` and `readyState` are required.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `source` | — | required nonblank builtin or plugin registration name | Select the ticket adapter after configured plugins load. |
| `readyLabels` | source-aware | optional array of nonempty strings; `[]` allowed | Require every listed label in addition to the state gate. |
| `readyState` | — | required nonblank string | The one workflow state eligible for dispatch. |
| `teamKey` | — | required for Linear; forbidden for file; optional for plugins | Linear team key such as `"ENG"`, or an existing plugin config field. |
| `claimedState` | `"In Progress"` for Linear | optional nonempty string; forbidden for file; allowed for plugins | Workflow state entered when a ticket is claimed. |
| `createState` | provider default | optional nonempty string | Default state for newly created tickets when `ab ticket create` omits `--state`. |
| `triageState` | Linear: `"Backlog"`; file/plugin: `"Triage"` | optional nonempty string | State used for spec-gate bounces, aborts, and closed-unmerged PRs. |
| `proposalState` | the resolved `triageState` | optional nonempty string | State harvest files its synthesized proposals into. Setting it to `readyState` waives the human grooming gate, not dependency eligibility. |
| `dir` | file: selected local state root's `tickets/`; plugin: omitted | optional nonempty path; forbidden for Linear; allowed for plugins | Root containing file-source state directories, or an existing plugin config field. Relative file paths resolve from the repository. |

When `readyLabels` is absent, Linear uses `["autobuild"]`; file and plugin
sources use `[]`, meaning no host-imposed label gate. An explicit value always
wins. A nonempty list is
conjunctive: every configured label must be present. `readyState` remains
mandatory regardless of labels. Linear compares state and label names exactly
and case-sensitively. The file source accepts state names case-insensitively and
canonicalizes them to `triage/`, `ready/`, `doing/`, or `done/`.

Source-specific validation is strict:

- Linear requires `teamKey` and rejects `dir`.
- File rejects `teamKey` and `claimedState`; `dir` is optional.
- `createState`, `triageState`, and `proposalState` are valid for every source,
  but the named state must exist in that provider when used.
- Plugin sources receive the existing fields in this table unchanged and own
  any additional semantic validation. No untyped plugin-options table exists.

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
steps = ["types", "unit", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "verify-app-e2e" # repository-authored skill
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
maxSetupAttempts = 3
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
configures ticket workflow and environment-only credentials, arranges suitable
end-to-end verification (authoring a repository-owned agent verifier when
needed), and leaves one groomed dispatchable ticket.

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
installation. `ab upgrade` does not migrate or rewrite `autobuild.toml`; by
default it first updates a recognized Bun forge distribution and then merges
vendored skills from that distribution. For a local install, Bun may update the
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
leaves all upgrade-owned changes uncommitted for the operator. Skill-upgrade
results and the merge-derived exit status remain unchanged. Upgrade likewise
suppresses the whole commit and names why when any skill or Claude discovery
path conflicts, an owned path was already dirty, the target is not a Git
repository, HEAD/worktree identity changes, or Git is mid-merge, mid-rebase, or
mid-cherry-pick. If upgrade cannot snapshot the worktree's Git index, it warns
and declines to stage. A failed staging or commit attempt restores that exact
pre-attempt index and reports the original Git failure; merged worktree files
remain in place and the merge's exit status is unchanged. Upgrade never pushes
or rewrites history.

Autobuild now installs 11 skills; only `ab-spec`, `ab-tickets`, and `ab-guide`
are model-invocable. The setup reference is an ordinary support file in the
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

Four repository-wide operator choices intentionally live as facts in the
BuildStore repository journal, not in `autobuild.toml`. They are latest-write
wins, survive process restarts, and are sampled by every dispatcher on its
poll. Editing TOML cannot change them.

| Setting | Fresh-repository default | Controls | Scope |
|---|---:|---|---|
| Ticket intake | on | `ab dispatch --intake` / `--no-intake`; `i` on the dashboard's global row, and `p` (pause all) / `r` (resume all) on that row or their sessionless equivalents `ab pause --all` / `ab resume --all`, which turn intake off and on as part of quiescing the repository | When off, skip only new ticket list/claim/dispatch work. Janitor work, lease recovery, in-flight builds, and harvesting continue. Turning intake off does not hold builds the repository has already accepted — that is the repository pause below. |
| Repository pause | off | `p` (pause all) / `r` (resume all) on the dashboard's global row, or `ab pause --all` / `ab resume --all` | While on, the dashboard controls line shows `repository PAUSED`, and each held queued row shows `(held)` while retaining its literal `QUEUED` status. No dispatcher tick attaches a runner to such a build — recovery, startup resume, and the lease sweep all skip them. Running builds are parked by the per-build pauses the same command writes; the janitor still settles aborts and discards. |
| Claim-time auto-merge default | off | `ab dispatch --auto-merge` / `--no-auto-merge`; `m` on the global row | Seeds durable auto-merge intent only on builds claimed after the setting is enabled. Existing builds never change with the default. |
| Harvest gate | on | `h` on the dashboard's global row | Pauses or resumes repository observation harvesting. The header shows the kernel-acknowledged gate, not merely a pending keypress. |

The opposite flag forms for each dispatch setting are mutually exclusive.
Omitting both writes nothing and reuses the durable value. Per-build
pause/resume and auto-merge controls are separate facts and do not alter these
repository defaults. Pause all and resume all write two facts each — the
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
| `LINEAR_API_KEY` | Linear ticket source | Required and nonempty when `tickets.source = "linear"`; use a Linear personal API key. |
| `AB_STORE` | BuildStore selection | A local path or HTTP(S) remote-store URL. A command's explicit `--store` wins, then nonblank `AB_STORE`, then the main checkout's `.autobuild/`. Relative local paths resolve from the main checkout. |
| `AB_TOKEN` | Protected remote BuildStore | Bearer credential forwarded to a remote store. Empty means no token; nonempty token bytes are treated as opaque. |

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
identity tuple are runner-owned ambient authorization. Operators should not
set or copy them into `.env`; the runner stamps them for each session.

Forge and agent credentials remain adapter-owned. The `local-git` forge uses no
credentials or network access: it keeps durable PR records under private Git
refs, leaves each build at `refs/heads/ab/<slug>`, and squash-merges locally only
after auto-merge consent. The squash author and committer come from the
repository's ordinary Git identity, as resolved for a plain `git commit`; the
landing is always unsigned even when `commit.gpgsign` is enabled. If Git cannot
resolve that identity, the PR remains open and `ab build status <slug>` names
`user.name` / `user.email` setup commands; dispatcher ticks retry automatically
after the operator configures them. A dirty checked-out base does not by itself
block the landing: tracked and untracked work on paths untouched by the squash
survives.
If the squash would overwrite operator work, the PR remains open, `ab build
status <slug>` shows a path-bearing observation, and later dispatcher ticks retry
automatically after the operator commits, stashes, or discards the collision;
Autobuild never mutates that work. Inspect an open local change with `git diff
main...ab/<slug>`. It has no review web UI and no image-hosting capability; attached artifacts use
the existing text-download projection.

- for `forge = "github"`, authenticate GitHub CLI operations with `gh auth login`, and separately make
  sure the Git remote can fetch/push with the process's Git credentials;
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

### Reading an invalid-config error

Start with `ab dispatch --once` when a real single tick is safe. A syntax error
looks like:

```text
/path/to/autobuild.toml: TOML syntax error: ...
```

Fix TOML structure first. A schema failure starts with:

```text
/path/to/autobuild.toml: invalid config
  verify.e2e.skill: ...
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
