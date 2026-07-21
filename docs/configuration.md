# Configuration reference

Autobuild reads one declarative `autobuild.toml` from the repository root. A
build freezes the file from its own branch when its workspace is provisioned,
so configuration changes travel through the same reviewed pipeline as code.
Commands are shell strings; the config itself is never executed as code.

Parsing is strict. Unknown top-level keys or tables, unknown fields inside a
known table, malformed step tables, and dangling command references are errors.
The removed `[project]`, `[dispatcher]`, `[harvest]`, and `[outer]` tables have
no aliases or migration behavior.

## Root scalars

Root scalars must come **before the first TOML table**. TOML assigns a key after
a table header to that table rather than returning to the root.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `baseBranch` | `"main"` | nonempty string | Branch builds start from, target in the forge, and merge during reconciliation. |
| `capacity` | `1` | positive integer | Maximum concurrent builds for this repository. |

## `[commands]`

An open map from a nonempty name to a nonempty shell command. Names are
repository-defined. `setup`, `lint`, `typecheck`, and `test` are conventions,
not reserved schema fields.

```toml
[commands]
setup = "bun install"
typecheck = "bun tsc --noEmit"
test = "bun test"
publish = "bun run publish"
```

`setup` runs after workspace provision and sandbox rehydration. Verify and
finalize check steps refer to command **names**, not inline shell strings.

## `[server]`

Optional. Configuration declares the process; the kernel owns its lifecycle.
Agents use `ab server start|stop|restart|status|logs`, never ad-hoc process
management.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `start` | — | required nonempty string | Dev-server shell command. |
| `url` | — | required nonempty string | Readiness probe URL. |
| `readyTimeout` | `60` | positive integer, seconds | Maximum readiness wait. |

A verify agent with `needsServer = true` requires this table.

## `[verify]` and `[verify.<step>]`

`[verify].steps` is the ordered configured universe. Every listed name requires
one matching subtable, and every subtable must be listed.

```toml
[verify]
steps = ["types", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true
paths = ["web/**", "src/routes/**"]
```

Shared and variant fields:

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `steps` | `[]` | array of nonempty names | Execution order. |
| `kind` | — | required `"check"` or `"agent"` | Selects deterministic command or agent judgment. |
| `command` | — | check only; key in `[commands]` | Shell command the kernel executes without an agent session. |
| `skill` | — | agent only; nonempty string | Exact installed verifier skill. |
| `needsServer` | `false` | agent only; boolean | Start `[server]` before the session and stop it afterward. |
| `paths` | — | nonempty positive repository-relative glob array | Run only when at least one changed path matches. |
| `always` | — | boolean | `true` makes the step unconditional and mandatory in plan selection. |

Checks pass or fail from exit status. Agent steps return `pass`, `fail`, or
`skip` through `ab verdict`. A failure routes back to implementation; a skip
satisfies only that step and records its reason.

### Plan selection

A plan can begin with strict TOML front matter selecting the complete optional
subset warranted by the spec:

```toml
+++
verifySteps = ["types", "e2e"]
+++
```

Missing front matter selects every configured step. An explicit empty list is
valid when no step has `always = true`. Selection order does not reorder config.
The exact completion approved by plan review is authoritative; reconciliation
reuses it.

### Path applicability

`paths` supports literals, `*`, `?`, and `**` only as a whole segment. Matching
is case-sensitive over Git-style `/` paths. Absolute paths, traversal, empty
segments, negation, escapes, character classes, braces, extglobs, and malformed
`**` are rejected.

The kernel evaluates plan selection before paths, immediately before each step,
against the build-owned diff. A miss starts no command, server, or session and
records a queryable skip. Git failures fail closed as infrastructure errors.
`always = true` overrides path gating.

## `[finalize]` and `[finalize.<step>]`

Finalize post-steps use the same ordered-name/table shape but a deliberately
smaller union. They do not support verify-only `paths`, `always`, or
`needsServer` fields.

```toml
[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"
```

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `steps` | `[]` | array of nonempty names | Ordered actions after the PR opens. |
| `kind` | — | required `"check"` or `"agent"` | Selects the action type. |
| `command` | — | check only; key in `[commands]` | Runs directly in the workspace with no agent session. |
| `skill` | — | agent only; nonempty string | Exact skill passed to the runtime; no prefix is inferred. |

The logical step name selects `[roles.<step>]` for agent routing. Both kinds are
failure-tolerant: nonzero exits, execution/launch errors, and structured agent
failures record `ok = false` and a follow-up observation, then advance. They do
not fail an otherwise green build. Missing tables, orphan tables, and missing
command refs are config errors naming the step.

## `[roles]`

An open map from role name to independent runtime configuration axes. The
optional `default` entry is the raw inheritance base and is never itself a
phase.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `runtime` | wiring fallback | registered nonempty runtime name | Runtime adapter (`claude` and `pi` ship). |
| `model` | selected runtime's default | nonempty compatible model id | Exact model; Pi ids are provider-qualified. |
| `extensions` | hermetic | array of nonempty package selectors | Pi extension allowlist; a supplied list replaces the inherited list. |

Each field inherits independently from `[roles.default]`. A role's exact merged
runtime/model pair must be compatible; Autobuild never searches for another
runtime or substitutes a different model. Pipeline phase names and logical
verify/finalize step names are roles. Repository workflow roles include
`harvest` and `harvest-review`; `slug` and `upgrade` are tool-free one-shot
roles.

The old `[agent]` table is also removed; put those fields in
`[roles.default]`.

## `[policy]`

Every policy field is a positive integer.

| Field | Default | Purpose |
|---|---:|---|
| `stallRounds` | `3` | Escalate when one finding chain survives this many review rounds. |
| `maxVerifyAttempts` | `3` | Bound verify → implement retry cycles. |
| `maxReconcileAttempts` | `3` | Bound conflict-reconciliation cycles. |
| `maxReviewRounds` | `4` | Bound each producer/reviewer convergence loop. |
| `harvestThreshold` | `10` | New unclaimed observations required to start one repository harvest run. |

Harvest is back-pressure driven by `ab dispatch`, independent of build
`capacity`. At the threshold it claims the current accumulation as an immutable
snapshot. Its cross-process lease and fixed two-attempt recovery budget are not
additional config knobs.

## `[tickets]`

Required because `readyState` has no safe default.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `source` | — | required `"file"` or `"linear"` | Ticket adapter. |
| `readyState` | — | required nonblank string | Sole workflow-state dispatch gate. |
| `readyLabels` | source-aware | nonempty-string array; `[]` allowed | Additional all-of label gate. |
| `teamKey` | — | required for Linear; forbidden for file | Linear team key. |
| `claimedState` | — | Linear only | State entered on claim. |
| `createState` | provider default | nonempty string | State used for newly filed tickets. |
| `triageState` | provider default | nonempty string | State used for bounces, aborts, and closed-unmerged tickets. |
| `dir` | `.autobuild/tickets` | file only | Repository-relative file tracker root. |

When `readyLabels` is absent, Linear uses `["autobuild"]` and file uses no
label gate. Linear state matching is exact and case-sensitive. The file source
maps states to `triage/`, `ready/`, `doing/`, and `done/` directories and
canonicalizes case on input.

Set `LINEAR_API_KEY` in the environment (a local `.env` works); secrets never
belong in `autobuild.toml`.

## `[dashboardFrames]`

Optional and off by default. This temporary review-window feature copies PNGs
from a successful current-cycle `verify:dashboard` report to an existing public
GitHub release and embeds the public asset URLs in the PR summary.

| Field | Default | Constraints | Purpose |
|---|---:|---|---|
| `provider` | — | required literal `"github-release"` | Hosting adapter. |
| `repository` | — | required public `owner/repo` pair | Repository containing the release. |
| `releaseId` | — | required positive integer | Existing published, mutable release id. |

Autobuild creates no release or tag. The `gh` identity needs Contents write
permission. Hosted copies are deleted after `build.completed`; BuildStore
artifacts remain authoritative. Hosting failure files a follow-up and preserves
the text-frame PR comment without changing verification.

## Complete example

```toml
baseBranch = "main"
capacity = 2

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

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true
paths = ["web/**"]

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

[roles.code-review]
runtime = "pi"
model = "moonshotai/kimi-k3"

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 4
harvestThreshold = 10

[tickets]
source = "file"
readyState = "ready"
```

`ab init` creates a valid setup-only version and adds verify checks only for
recognized root `package.json` scripts. It never rewrites an existing config,
even with `--force`. This repository's [`autobuild.toml`](../autobuild.toml) is
a worked example of the same surface.
