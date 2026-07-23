# Configuration reference

Autobuild reads one declarative `autobuild.toml` from the repository root.
Commands in the file are shell strings; the file itself is never evaluated as
code. A build uses the configuration from its own branch when its workspace is
provisioned, so configuration changes move through review like any other
change.

This document covers the complete accepted TOML surface. Examples labelled as
fragments are intended to be added to an existing file; the [complete
example](#complete-example) is valid on its own.

## Strict parsing and validation

Parsing is strict. Unknown top-level keys or tables, unknown fields in a known
table, fields from the wrong step variant, malformed values, and dangling
command references are errors. The only open maps are `[commands]`, `[roles]`,
and the named `[verify.<step>]` and `[finalize.<step>]` tables. Their keys are
repository-defined, but every value inside them is still validated.

There are three validation layers:

1. TOML syntax and schema/cross-field validation happen while
   `autobuild.toml` is loaded. Errors start with the file path and either
   `TOML syntax error` or `invalid config`; schema errors then identify paths
   such as `verify.e2e.needsServer` or `tickets.teamKey`.
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

## Root scalars

All root scalars are optional and receive defaults. They must appear before
any table header.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `baseBranch` | `"main"` | nonempty string | Branch used to cut builds, target PRs, and merge during reconciliation. |
| `capacity` | `1` | positive integer | Maximum concurrent nonterminal builds for this repository. Paused and blocked builds still occupy capacity. |
| `forge` | `"github"` | nonblank string | Forge adapter name. Builtin `github` preserves existing behavior; configured plugins may register other names. |
| `plugins` | `[]` | array of nonblank module specifiers | Trusted Bun plugin modules loaded in declaration order at dispatcher startup and in scoped phase CLI processes. |

### Plugin modules

<!-- config-fragment:plugins -->
```toml
plugins = ["./plugins/company.ts", "@acme/autobuild-plugin"]
```

Relative paths and bare npm package specifiers are resolved as though imported
from the repository root. Package specifiers therefore use that repository's
installed dependencies, not Autobuild's own installation tree. Each module
must default-export a strict manifest with a plugin name, a semver range in
`apiVersion`, and optional `ticketSources`, `agentRuntimes`,
`workspaceProviders`, and `forges` factory maps. One manifest may contribute
to several ports.

Plugin modules execute in-process during `ab dispatch` and configured scoped
phase CLI composition and have the same trust as repository-supplied commands;
there is no sandbox. A missing module, module
that throws, malformed manifest, incompatible API range, or adapter-name
collision fails startup before a ticket claim. Builtin names and names from
earlier configured plugins are reserved, and declaration order never permits
shadowing.

Plugin authors import the stable surface from `autobuild/plugin-sdk`, normally
with `import type`, and can develop against Autobuild as a dev/peer dependency
without adding a runtime Autobuild dependency to the plugin. That entry point
exports the manifest/factory types, port types, fake adapters, and reusable
TicketSource, WorkspaceProvider, Forge, BuildStore, and BlobStore contract
suites. Forge selection is open: set the root `forge` scalar to a registered
name. Omission selects `github`. Ticket source, agent runtime, and workspace
selectors remain restricted to shipped builtins in this release.

A selected plugin forge factory receives an empty adapter-specific `config`
object, the process environment, and the absolute repository root. It is
invoked lazily after the complete plugin catalog has loaded and before the
production store is opened. Unknown names fail with the available forge list;
factory failures are contextualized with the adapter and plugin names. Scoped
build-session CLI processes repeat config/plugin loading from the build
worktree, so implement publication, finalization, reconciliation, late
attachment summaries, epilogue polling, and janitor operations all use the
same configured adapter name. The returned adapter is not wrapped: an absent
`prAttachments` capability intentionally selects text-only attachment summaries,
while a present capability serves upload and terminal reclamation.

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

## `[commands]`

An optional open map of repository-defined names to shell strings. Its default
is `{}`. `setup`, `lint`, `typecheck`, and `test` are conventions, not fixed
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
and after sandbox rehydration. Other names run only when referenced by a
configured check. A check's `command` value is the key in this map, not an
inline shell command. The kernel passes the mapped string to a shell as written.

## `[server]`

Optional. The table declares a development server; the kernel owns its process
group, readiness wait, and teardown. Agents control it only with
`ab server start|stop|restart|status|logs` during implement or verify.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `start` | — | required nonempty string | Shell command that starts the server. |
| `url` | — | required nonempty string | URL polled for readiness. |
| `readyTimeout` | `60` | positive integer, seconds | Maximum readiness wait before startup fails. |

An agent verifier with `needsServer = true` requires this table. The kernel
stops the managed server at phase end even if the session fails.

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
| `needsServer` | `false` | agent-only boolean | Start `[server]`, wait for readiness, then run the session. |
| `paths` | omitted (unconditional) | optional nonempty array of positive repository-relative globs | Apply only when at least one changed path matches. Available to both variants. |
| `always` | omitted (`false`) | optional boolean | `true` makes the step mandatory in plan selection and bypasses path gating. Available to both variants. |

<!-- config-fragment:verify -->
```toml
[commands]
typecheck = "bun tsc --noEmit"

[server]
start = "bun dev"
url = "http://localhost:3000"

[verify]
steps = ["types", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"
always = true

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true
paths = ["web/**", "src/routes/**"]
```

Cross-field validation rejects:

- a listed step without its `[verify.<step>]` table;
- a named table not present in `steps`;
- a check whose command is absent from `[commands]`;
- `needsServer = true` without `[server]`;
- fields from the other kind, unknown fields, and malformed selectors.

`always = true` does not make malformed `paths` acceptable: all supplied
selectors are validated even though the mandatory step will not use them for
applicability.

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
outcome. A selection exclusion or path miss starts no check, agent, or server.
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

Finalize has a smaller strict union. Verify-only `paths`, `always`, and
`needsServer` fields are errors.

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

The logical step name selects `[roles.<step>]` for an agent post-step. Both
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

An optional open map from a nonempty role name to three independently inherited
agent axes. The table defaults to `{}`. The reserved `default` entry is the raw
base for every other role and is never dispatched itself.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `runtime` | inherited; otherwise wiring fallback (`claude`) | optional nonempty registered runtime name | Select an agent adapter. |
| `model` | inherited; otherwise selected runtime's own default | optional nonempty model id compatible with the resolved runtime | Select the exact model. Pi ids are provider-qualified. |
| `extensions` | inherited; otherwise `[]` (hermetic) | optional array of nonempty strings; `[]` allowed | Pi package/extension allowlist. A supplied list replaces, rather than unions with, the inherited list. |

<!-- config-fragment:roles -->
```toml
[roles.default]
runtime = "claude"
extensions = []

[roles.plan]
extensions = ["subagents", "web-access"]

[roles.code-review]
runtime = "pi"
model = "kimi-coding/k3"
extensions = ["web-access"]
```

Inheritance is mechanical per field. For example, changing only a child
runtime does not discard a model inherited from `default`; the resulting exact
pair must be compatible. Autobuild never searches for a runtime that happens
to serve a configured model and never substitutes a different model to repair
an invalid pair. The only implicit fill is when neither the role nor `default`
names a model, in which case the selected runtime uses its own default.

Two runtimes ship: `claude` and `pi`. With no configured model, Claude uses
the SDK's built-in default and Pi uses `kimi-coding/k3`. Use
`ab models [query]` to find provider-qualified Pi model ids. Extension entries
match installed Pi package sources case-insensitively; runtimes without an
extension mechanism ignore this axis. Tool-free one-shot judgments disable
extensions even if their role grants them.

Core agent phases route by phase name (`plan`, `plan-review`, `implement`,
`code-review`, `finalize`, and `reconcile`). Agent verify sessions route by
their configured `skill` name; agent finalize post-steps route by logical step
name. Repository judgments use `harvest` and `harvest-review`; `slug` and
`upgrade` configure tool-free one-shot judgments. Arbitrary additional role
keys are accepted, but only a name selected by one of these routes affects a
session.

Resolver construction validates `default` and every declared role eagerly and
aggregates all unknown-runtime and incompatible-model problems. A deliberately
different reviewer model is valid and often useful; mixed models are not a
configuration inconsistency.

## `[policy]`

Optional. Every field is a positive integer and receives its own default.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `stallRounds` | `3` | positive integer | Escalate when the same review finding survives this many rounds. |
| `maxVerifyAttempts` | `3` | positive integer | Bound failure-driven verify → implement retry cycles. |
| `maxReconcileAttempts` | `3` | positive integer | Bound conflict-reconciliation cycles. |
| `maxReviewRounds` | `4` | positive integer | Bound each plan/review and implement/review convergence loop. |
| `harvestThreshold` | `5` | positive integer | New unclaimed observation occurrences needed to start one harvest run. |

Harvest is driven by observation back-pressure during dispatcher ticks, not a
wall clock, and is independent of build `capacity`. Its repository lease and
fixed per-run recovery budget are implementation invariants, not additional
configuration fields.

## `[tickets]`

Required in practice: `readyState` deliberately has no default, so omitting the
table fails at `tickets.readyState` rather than allowing tickets from every
state. Within a present table, `source` and `readyState` are required.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `source` | — | required `"file"` or `"linear"` | Select the ticket adapter. |
| `readyLabels` | source-aware | optional array of nonempty strings; `[]` allowed | Require every listed label in addition to the state gate. |
| `readyState` | — | required nonblank string | The one workflow state eligible for dispatch. |
| `teamKey` | — | required for Linear; forbidden for file; nonempty string | Linear team key such as `"ENG"`. |
| `claimedState` | `"In Progress"` for Linear | optional nonempty string; Linear only | Workflow state entered when a Linear issue is claimed. |
| `createState` | provider default | optional nonempty string | State used by newly created tickets. |
| `triageState` | Linear: `"Backlog"`; file: `"Triage"` | optional nonempty string | State used for spec-gate bounces, aborts, and closed-unmerged PRs. |
| `dir` | selected local state root's `tickets/` (normally `.autobuild/tickets`) | optional nonempty path; file only | Root containing the file source's state directories. Relative paths resolve from the repository; absolute paths are used as given. |

When `readyLabels` is absent, Linear uses `["autobuild"]`; the file source uses
`[]`, meaning no label gate. An explicit value always wins. A nonempty list is
conjunctive: every configured label must be present. `readyState` remains
mandatory regardless of labels. Linear compares state and label names exactly
and case-sensitively. The file source accepts state names case-insensitively and
canonicalizes them to `triage/`, `ready/`, `doing/`, or `done/`.

Source-specific validation is strict:

- Linear requires `teamKey` and rejects `dir`.
- File rejects `teamKey` and `claimedState`; `dir` is optional.
- `createState` and `triageState` are valid for either source, but the named
  state must exist in that provider when used.

For Linear, omitting `createState` lets the team's default state apply. For the
file source it defaults to `Triage`. An omitted Linear `triageState` uses
`Backlog`, because every team has it while the optional Linear triage feature
may be disabled. The file source uses `Triage`.

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

[pr.imageHost]
provider = "github-release"
repository = "acme/public-review-assets"
releaseId = 123456

[commands]
setup = "bun install"
typecheck = "bun tsc --noEmit"
test = "bun test"
publish = "bun run publish"

[server]
start = "bun dev"
url = "http://localhost:3000"
readyTimeout = 60

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
skill = "ab-verify-e2e"
needsServer = true
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
extensions = []

[roles.plan]
extensions = ["subagents", "web-access"]

[roles.code-review]
runtime = "pi"
model = "kimi-coding/k3"
extensions = ["web-access"]

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 4
harvestThreshold = 5

[tickets]
source = "file"
readyState = "ready"
readyLabels = []
createState = "Triage"
triageState = "Triage"
dir = "tickets"
```

This repository's [`autobuild.toml`](../autobuild.toml) is another worked
example.

## What `ab init` generates

On the first `ab init [target]`, when `autobuild.toml` is absent, Autobuild
renders a valid setup-oriented baseline with:

- `baseBranch = "main"` and `capacity = 1`;
- `setup = "bun install"` in `[commands]`;
- no verify or finalize steps unless recognized package scripts add checks;
- the default policy values above;
- a file ticket source with `readyState = "ready"`; and
- a `claude` default role with no configured model.

Only exact own keys in the root `package.json` `scripts` object are recognized:

| Package script | Generated command | Generated verify step |
|---|---|---|
| `lint` | `lint = "bun run lint"` | none; lint remains command-only |
| `type-check` | `typecheck = "bun run type-check"` | `types`, a check using `typecheck` |
| `test` | `test = "bun run test"` | `unit`, a check using `test` |

A missing package manifest or missing scripts adds nothing. Malformed JSON, an
unreadable manifest, or a recognized script whose value is not a nonempty
string fails with the manifest path instead of silently generating an
untruthful command.

The config rule is intentionally one-way: once `autobuild.toml` exists,
`ab init` does not inspect package scripts, reconcile generated fragments, or
overwrite the file. This remains true with `--force`; that flag can overwrite
locally edited vendored skills, never configuration. Later package-script
changes are manual configuration edits. Re-running init still maintains the
`.autobuild/` ignore rule and skill installation, while `ab upgrade` merges
vendored skills only.

## Durable settings outside TOML

Three repository-wide operator choices intentionally live as facts in the
BuildStore repository journal, not in `autobuild.toml`. They are latest-write
wins, survive process restarts, and are sampled by every dispatcher on its
poll. Editing TOML cannot change them.

| Setting | Fresh-repository default | Controls | Scope |
|---|---:|---|---|
| Ticket intake | on | `ab dispatch --intake` / `--no-intake`; `p` on the dashboard's global row | When off, skip only new ticket list/claim/dispatch work. Janitor work, lease recovery, in-flight builds, and harvesting continue. |
| Claim-time auto-merge default | off | `ab dispatch --auto-merge` / `--no-auto-merge`; `m` on the global row | Seeds durable auto-merge intent only on builds claimed after the setting is enabled. Existing builds never change with the default. |
| Harvest gate | on | `h` on the dashboard's global row | Pauses or resumes repository observation harvesting. The header shows the kernel-acknowledged gate, not merely a pending keypress. |

The opposite flag forms for each dispatch setting are mutually exclusive.
Omitting both writes nothing and reuses the durable value. Per-build
pause/resume and auto-merge controls are separate facts and do not alter these
repository defaults. The current release has no TOML field or standalone
sessionless command for the harvest gate; use the dashboard and inspect it with
`ab harvest status`.

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

Forge and agent credentials remain adapter-owned:

- authenticate GitHub CLI operations with `gh auth login`, and separately make
  sure the Git remote can fetch/push with the process's Git credentials;
- Claude sessions use the Claude Agent SDK's credentials;
- Pi sessions use Pi's provider authentication (for example `pi login` or the
  provider credentials Pi supports).

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
  verify.e2e.needsServer: ...
  tickets.teamKey: ...
```

Each indented path is independently actionable. Common causes are a root scalar
placed after a table, a misspelled strict field, a step listed without its
subtable (or vice versa), a check naming no `[commands]` key, a field used on
the wrong step kind, or source-specific ticket fields used together.

Runtime routing failures use a separate heading and list all bad roles. Check
the merged `default` plus child values, not just the child table: each axis
inherits independently. Confirm the runtime name is shipped and use
`ab models [query]` to choose a model family that runtime serves.

### `tick: idle` with expected work

In plain/non-TTY mode, `tick: idle` means the pass recorded no dispatcher
action. Check the gates in this order:

1. **Durable intake:** the dashboard header must show intake on, or explicitly
   run a future dispatcher with `--intake`. Intake off skips the ready scan
   even when tickets exist.
2. **Ready state:** the ticket must be in exactly `tickets.readyState`. Linear
   is case-sensitive; file tickets must physically be in the corresponding
   state directory.
3. **Labels:** the ticket must carry every effective `readyLabels` value,
   including Linear's default `autobuild` label when the field is omitted.
4. **Dependencies:** every `blockedBy` ticket must exist and be complete in the
   same source. Plain dispatch output reports unresolved ids and cycles.
5. **Capacity:** every nonterminal build for this repository—including paused
   and blocked builds—uses a slot. Inspect `ab builds --queued` and
   `ab build status <slug>` rather than looking only for a live process.
6. **Duplicate work:** a ready ticket already represented by an active build is
   deliberately excluded from the queue.

If the expected work is observation harvesting instead of a ticket, also check
the acknowledged harvest gate and whether at least `policy.harvestThreshold`
new unclaimed observations exist. Harvest does not consume build capacity.

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
  role. A 401/402/403, permission, quota, or billing rejection is treated as a
  permanent provider failure rather than retried indefinitely. For Pi, confirm
  the provider-qualified model and provider login.
- **Remote BuildStore:** confirm the effective `AB_STORE` URL and `AB_TOKEN`.
  A protected store reports 401 for a missing, invalid, or expired token and
  403 when the token is valid but scoped to another build/session.
