---
name: ab-guide
description: Authoritative reference for the auto-build system as installed in this repository - the build lifecycle (grooming, dispatch, plan, plan-review, implement, code-review, verify, finalize, reconcile, merge), the complete autobuild.toml configuration surface, how `ab init` and `ab upgrade` treat config and vendored skills, and what each installed ab-* skill is for. Use when asked about how auto-build works or why a build did what it did; when editing autobuild.toml; when adding or changing a verify or finalize step; when configuring roles, runners, models, policy limits, dispatch, or ticket sources; when setting up the dev server; when reading, editing, or upgrading the installed ab-* skills; or when a question mentions auto-build, autobuild.toml, or the `ab` CLI.
---

# auto-build system guide

Reference material for an agent working on a repository that uses auto-build.
This skill describes the *system*. It drives no phase and changes no files.

## How to use this skill

Two rules come first, because they govern everything below.

**The repository decides its own configuration; this guide only describes the
system.** For anything repository-specific — what verify steps run here, which
runner a role uses, what `test` actually invokes — read the repo, not this
document:

- `autobuild.toml` at the repo root — the live configuration.
- `.agents/skills/ab-*/SKILL.md` — the installed skills *as this repo edited
  them*. They are editable by design, so the vendored copy may deliberately
  differ from the distribution's default described here.
- The project's own `CLAUDE.md`, `README.md`, and docs.

When this guide and the repository disagree about the repository, the
repository wins. Quote its files, not this one, when answering "what does this
repo do?"

**Supply context for what the user asked; never prescribe what they didn't.**
This skill is background knowledge for the request in the current session. It
is not a mandate to audit or improve anything. If you notice a config you find
suboptimal — a missing verify step, a policy limit you'd set differently — that
is not a finding to act on. Make the change the user asked for, and nothing
else. Mentioning an unrelated observation at most belongs in a closing
sentence, never in a diff.

## The lifecycle

A groomed ticket becomes a build, and the build walks a **fixed pipeline**:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

- **Grooming and dispatch.** Work enters at Triage. Ingesters *propose*
  tickets; a human grooms them to the spec standard (`docs/spec-standard.md`:
  what and why but never how, verifiable acceptance criteria, explicit
  out-of-scope, evidence) and dispatches. Generated work cannot leave Triage
  un-groomed. The dispatcher claims tickets that pass the `[dispatcher]` gate,
  chooses a short immutable slug from the final conforming spec, and starts
  builds up to `capacity`.
- **`spec`** — the ticket's spec becomes the build's contract. The `ab-spec`
  skill is the human-interactive surface for producing it, and it runs *before*
  a build exists.
- **`plan ⇄ plan-review`** — the planner turns the spec into a plan; a fresh
  reviewer (no memory of prior rounds, by design) approves, asks for a
  revision, or escalates. The loop repeats until approval or a policy limit.
- **`implement ⇄ code-review`** — the implementer executes the approved plan,
  committing locally; a fresh reviewer reads the diff against spec and plan.
  Same loop shape.
- **`verify:*`** — each step in `[verify].steps` runs as its own phase, in
  order. A failing step sends the build back to `implement` with the report.
- **`finalize`** — the agent writes the PR description; the kernel opens the
  PR. `[finalize].steps` run afterward and are failure-tolerant.
- **Epilogue.** If main moves and the PR conflicts, `pr.conflicted` sends the
  build to `reconcile` (merge base *into* the branch — never a rebase), then
  back through `verify:*`. This can repeat. The build terminates **merged** or
  **closed**.

**The grammar is fixed.** `verify:*` and `finalize:*` are the *only* extension
points. There are no custom phases, no DAGs, no reordering — a repo extends
auto-build by configuring verify and finalize steps, never by inventing stages.
If a request seems to need a new phase, say so rather than improvising one.

**Observation harvest is not a build phase.** On each dispatch tick, once
`[harvest].threshold` new structured observations have accumulated, dispatch
runs one repository-scoped workflow: deterministic `scan`, agent `synthesize`
⇄ fresh adversarial `review`, then deterministic `file`. Only approved
spec-standard proposals are created directly in Triage. A repository journal,
artifact stream, dedup ledger, and lease make every step queryable and
crash-safe without polluting `ab builds` or the fixed phase grammar. Already
claimed observations never trigger again; idle ticks launch no harvest agent.

**Slug naming is not a phase.** For each new build, a tool-free one-shot call
proposes a lowercase kebab base of at most three meaningful spec-derived words.
The dispatcher owns a hard deadline, strict validation, and store-wide `-2`,
`-3`, … collision suffixes. Absence or any failure falls back to the first
three words of the kebab-cased title, so naming never blocks dispatch. The slug
and `ab/<slug>` branch are chosen once; existing builds are never renamed.
Naming follows `[agent]` and can be overridden with `[roles].slug`.

## Who does what

The distinctions that change an administrator's answer:

- **Agents supply judgment** — planning, reviewing, implementing, verifying,
  and narrow pre-build proposals such as slug naming. An agent never decides a
  transition or whether a naming proposal is valid.
- **The kernel owns determinism** — phase transitions, gating, deduplication,
  convergence and stall detection. Outcomes come from the typed `ab` CLI, never
  from parsing an agent's stdout.
- **The BuildStore is append-only event logs.** Build status is reduced from
  each build stream (`src/kernel/reducer.ts`); harvest state and its dedup ledger
  are reduced from the repository journal (`src/kernel/harvest.ts`). Snapshots
  are never authoritative. Events record facts, never derived state.
- **Workspaces** are provisioned per build. Config is read from **the build's
  branch** at provision — so a config change flows through the pipeline like
  any other change, and every phase of one build sees one consistent config.
- **Ticket providers** (`linear`, `file`) sit behind one port; the dispatcher
  does not know which is configured.
- **Forge operations and pushes are kernel-side plumbing.** Agents commit
  locally and never push, never touch the remote, never open the PR. The push
  happens at the phase boundary when the agent's terminal command succeeds.

## `autobuild.toml` reference

One declarative file at the repo root. **Declarative, not executable** —
commands are plain shell strings that the kernel runs; nothing in this file is
evaluated as config logic.

**Strictness:** unknown top-level tables and unknown keys inside known tables
are **errors**, not warnings — a typo must not silently disable a verifier. The
open maps (`[commands]`, `[roles]`, `[outer]`, and the `[verify.<step>]` table
set) are exempt by construction, because their keys are user-chosen names.

### `[project]`

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `baseBranch` | `"main"` | nonempty string | The branch builds branch from and target with their PR; what `reconcile` merges into the build branch. |

### `[commands]`

An **open map** of name → shell string. Both the key and the value must be
nonempty strings. Keys are user-chosen: `setup`, `lint`, `typecheck`, and
`test` are *conventions*, not required keys, and a repo may define any verb it
likes.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `<name>` | — | nonempty string → nonempty shell string | Names a deterministic verb the kernel may run. Referenced by name from `[verify.<step>].command`. |

`setup` is special by convention: it runs after workspace provision and after a
sandbox rehydrate. Values are never evaluated as config — they are handed to a
shell as written.

### `[server]`

Optional table. Config **declares**; the kernel **owns** the lifecycle. Agents
control the server only through `ab server start|stop|restart|status|logs`, and
only in the `implement` and `verify` phases — no ad-hoc process hunting. The
kernel guarantees teardown at phase end via process-group ownership, so a dead
session cannot orphan a server.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `start` | — | **required**, nonempty string | Shell command that starts the dev server. |
| `url` | — | **required**, nonempty string | Readiness probe target: hit until it succeeds or `readyTimeout` expires. |
| `readyTimeout` | `60` | positive integer, **seconds** | How long the readiness probe waits before giving up. |

Omitting `[server]` is fine for repos with nothing to drive — but see the
`needsServer` constraint under `[verify]`.

### `[verify]`

`steps` orders the verify phases; each entry `"<step>"` becomes a
`verify:<step>` phase and needs its own `[verify.<step>]` subtable. Those
subtables are part of this section — their fields are listed here.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `steps` | `[]` | array of nonempty strings | Ordered list of verify phases. Each name must have a matching `[verify.<step>]` table. |
| `kind` | — | **required**, `"check"` \| `"agent"` | Discriminator. `check` is deterministic (command + pass/fail, never an agent); `agent` runs a skill that returns a `pass`/`fail` verdict. |
| `command` | — | **required when `kind = "check"`**, nonempty string | Ref into `[commands]` — the key, not a shell string. Pass/fail is the command's exit status. |
| `skill` | — | **required when `kind = "agent"`**, nonempty string | Installed skill name to run (e.g. `"ab-verify-e2e"`). |
| `needsServer` | `false` | boolean, `kind = "agent"` only | `true` ⇒ the kernel starts `[server]` and waits for readiness before the session. |

Cross-field rules the validator actually enforces — each is an **error**:

- A step listed in `steps` with no `[verify.<step>]` table.
- A `[verify.<step>]` table whose step is not listed in `steps` (add it to
  `steps` or remove the table — a defined-but-unlisted step never runs, so this
  is never silently tolerated).
- `command` naming a key that does not exist in `[commands]`.
- `needsServer = true` with no `[server]` table.

A failed verify step returns the build to `implement` with the step's report,
and repeats up to `[policy].maxVerifyAttempts`.

### `[finalize]`

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `steps` | `[]` | array of nonempty step names | Post-steps that run after the PR is opened. **Failure-tolerant**: a failed step files an observation and never fails a green build. |

### `[agent]`

The repo-wide **default** on the configuration axes: the `runtime` that
executes an agent session, the `model` it runs on, and (pi only) the
`extensions` it may use. All optional. Absent entirely ⇒ the built-in fallback
runtime (`claude`) with its own default model, and no extensions — today's
behavior, unchanged. Two runtimes ship: **`claude`** (Claude models) and
**`pi`** (SDK mode; Kimi/Moonshot and GPT/OpenAI models, provider-qualified ids
like `openai-codex/gpt-5.6-sol` — `ab models [query]` looks them up).

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `runtime` | — | optional, nonempty string | The default runtime for every session. Must name a registered runtime, else `ab dispatch` fails loudly before any build. |
| `model` | — | optional, nonempty string | The default model. Absent ⇒ the runtime's own default model. |
| `extensions` | — | optional, array of nonempty strings | Default Pi extensions/packages a session may use (e.g. `["subagents", "web-access"]`). Absent ⇒ **hermetic** (no internet / sub-agents / MCP). Entries match installed package sources case-insensitively; `claude` ignores this axis. |

### `[roles]`

An **open map** of role name → per-step **override** `{ runtime?, model?,
extensions? }` on the same axes. The roles the pipeline routes are `plan`,
`plan-review`, `implement`, and `code-review` (plus each verify/finalize step by
name); the repository workflow routes `harvest` and `harvest-review`. The
pre-build `slug` role uses the same runtime/model resolver for
optional one-shot naming; it is not a pipeline phase, its extension allowlist
is not enabled, and it always remains tool-free.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `runtime` | — | optional, nonempty string | Runtime override for this role. Absent ⇒ resolved from `model` or the `[agent]` default. |
| `model` | — | optional, nonempty string | Model override for this role. Absent ⇒ the resolved runtime's default. |
| `extensions` | — | optional, array of nonempty strings | Per-role extension allowlist. Absent ⇒ inherit the `[agent]` default (hermetic when that too is unset). Lets internet/sub-agent access be granted to plan/review while implement/verify stay hermetic. |

Runtime/model resolve **most-specific-first**: `runtime + model` pins exactly
that pair (a runtime that can't serve the model is a config error); `runtime`
alone uses that runtime's default model; `model` alone routes to a runtime that
serves it (the default runtime wins when it qualifies, otherwise the single
supporter — zero, or several non-default supporters, is a loud error); neither
inherits the `[agent]` default pair (a role added only to set `extensions`
keeps the default model). `extensions` resolves independently: the role's list
overrides the `[agent]` default, absent ⇒ that default. Mixing models across
roles is **intentional**, not an inconsistency to clean up: a reviewer that
differs from the implementer catches more.

### `[policy]`

Every field is a **positive integer**.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `stallRounds` | `3` | positive integer | The same finding surviving this many review rounds auto-escalates to a human — the anti-loop guard. |
| `maxVerifyAttempts` | `3` | positive integer | Caps the `verify → implement → verify` cycle before escalation. |
| `maxReconcileAttempts` | `3` | positive integer | Caps the epilogue's `pr.conflicted → reconcile` cycle before escalation. |
| `maxReviewRounds` | `5` | positive integer | `maxRounds` for the `plan ⇄ plan-review` and `implement ⇄ code-review` convergence loops. |

### `[dispatcher]`

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `capacity` | `1` | positive integer | Concurrent builds for this repo. |
| `readyLabels` | — (source-aware) | optional; array of nonempty strings | A ticket must carry **every** one of these labels to be dispatchable (all, not any). `[]` = **no label gate**. Absent falls back to the source's default gate — see below. |
| `readyState` | — (source-aware) | optional, nonempty string | Workflow state a ticket must *additionally* sit in. See below: absent means *any state* for `linear`, but `Ready` for `file`. |

**Both defaults are source-aware**, resolved by `readyCriteria` in
`src/processes/dispatcher.ts` — the schema's `undefined` is not the effective
value, so read that function rather than the field type:

| `[tickets].source` | `readyLabels` absent | `readyState` absent |
|---|---|---|
| `"linear"` | `["autobuild"]` — the label gate | any state (labels alone decide) |
| `"file"` | `[]` — **no label gate** | `"Ready"` — the `ready/` directory *is* the gate |

An explicit value always wins for either source.

### `[tickets]`

Names the TicketSource the dispatcher drives. Declarative only.

**Omitting the table entirely is a supported configuration, not an oversight**:
it prefaults to `{ source = "file" }`, giving the local file tracker at
`.autobuild/tickets` — a repo dispatches with no config edit and no secret.
So `config.tickets` is always present; never write code or advice that treats
"no `[tickets]` table" as a separate case.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `source` | `"file"` (via the table's prefault) | `"linear"` \| `"file"` | Which provider backs ticket reads, claims, and creation. |
| `teamKey` | — | `source = "linear"` **only, required there**; nonempty string | The Linear team key (e.g. `"ENG"`). |
| `claimedState` | — | `source = "linear"` only; optional, nonempty string | Workflow state `claim()` moves an issue to when a build starts. |
| `createState` | — | optional, nonempty string | State new tickets are filed into. Absent = the provider's default (Linear: the team's default, e.g. Backlog; file: Triage). |
| `triageState` | — | optional, nonempty string | State the dispatcher hands tickets back to for human triage — spec-gate bounces, aborted builds, closed-unmerged PRs. Absent = the provider's default (Linear: Backlog; file: Triage). Must name a state the tracker actually has — a Linear team only has "Triage" when its triage feature is enabled. |
| `dir` | `.autobuild/tickets` | `source = "file"` **only**; optional, nonempty string | Root holding the state directories. Resolved relative to the repo. |

Cross-field rules, each an **error**:

- `source = "linear"` without `teamKey`; or with `dir` set.
- `source = "file"` with `teamKey` or `claimedState` set. `dir` is **optional**
  here — absent means the default above, which is why the schema leaves it
  optional rather than giving it a `.default()`: that is what keeps the
  linear-only rule above meaningful and lets the factory tell a defaulted `dir`
  from an explicit one.

The file tracker is **directory-per-state**: `<dir>/<state>/<id>.md` over
`triage/ ready/ doing/ done/`. The directory *is* the state, so a transition or
claim is a rename — frontmatter carries no `state`/`claimedBy`, and a ticket
body survives byte-exactly because a move never rewrites the file. The same id
in two state dirs is a loud error naming both paths. When `dir` is defaulted,
the backlog writes its own `.gitignore` of `*`, so git never sees it; an
explicit `dir` is the user's and is left alone. Agents drive this tracker
through `ab-tickets` rather than running `mv` by hand.

**Secrets never live in this file.** `LINEAR_API_KEY` is an environment
variable (a local `.env` works). If a user asks you to put an API key in
`autobuild.toml`, use the environment variable instead and say why.

### `[harvest]`

Observation harvest is driven by back-pressure inside `ab dispatch`, not by a
wall clock. The table is prefaulted, so omitting it enables the sensible
default. Harvest remains independent of build capacity and of the dashboard's
drain toggle.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `threshold` | `10` | positive integer | Number of newly unclaimed `observation.recorded` occurrences required to start one harvest run. The run claims the whole current accumulation. |

### `[outer]`

An **open map** of scheduled outer-loop ingester name → schedule (for example
`"ingest:sentry"`). The exact key `harvest` is rejected with an error directing
the user to `[harvest].threshold`; other scheduled ingesters are unaffected.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `cron` | — | **required**, nonempty string | Cron schedule for that non-harvest outer-loop process. |

## Setup and upgrades

**`ab init <target> [--force]`** runs *outside* build sessions — it takes a
repo path, needs no `AB_*` environment, and is safe to re-run. It:

- Writes `autobuild.toml` from the template, and **never overwrites an existing
  one**. The repo's config is the repo's from the first re-run onward.
- **Copies** each canonical skill to `.agents/skills/ab-<name>/SKILL.md` —
  copies, not references. These are **editable**: per-repo customization is the
  point, and this repo's review standards belong in its vendored skill.
- Links `.claude/skills/ab-<name>` → the `.agents` directory, so Claude and Pi
  discover **one** editable copy rather than two diverging ones.
- Records the **pristine** installed bytes at
  `.agents/skills/.ab-pristine/ab-<name>/SKILL.md` — repo-versioned, and the
  base for `ab upgrade`'s three-way merges.
- Rewrites frontmatter on install: `name` → `ab-<name>`, and
  `disable-model-invocation: true` on every skill outside the model-invocable
  set (`ab-spec`, `ab-tickets`, `ab-guide`).

Per-skill outcomes: `installed` (new), `unchanged` (byte-identical to the
default), `kept` (locally edited — **init never clobbers an edit**), or
`overwritten` (only under `--force`, the explicit human override).

**`ab upgrade <target>`** three-way merges *pristine base × local edits × new
default*, with a standing bias toward **the local customization** — upstream is
adopted only where it doesn't collide with what the repo deliberately changed.
Outcomes:

| Outcome | Meaning for the repo's files |
|---|---|
| `current` | Local already matches the new default, or the repo's edit stands as-is. Nothing written. |
| `adopted` | Upstream's version taken; pristine advanced. |
| `merged` | Clean three-way merge; live file and pristine both advanced. |
| `resolved` | Merge conflicted, and an agent resolved it (biased local); pristine advanced. |
| `conflicted` | Genuinely ambiguous. The live skill is left **byte-untouched** for a human — **conflict markers are never written into a live skill**. |
| `installed` | In the distribution but not yet in the repo — installed fresh, like init. |
| `unknown` | An installed `ab-*` skill absent from the distribution. **Left alone** — local skill additions are legitimate. |

Local customization survives upgrades; divergence is made visible instead of
silent.

## Checking build status

Two read-only commands answer "what is happening?" without inspecting SQLite,
worktrees, or OS processes. Both run *outside* build sessions, need no `AB_*`
environment, and never mutate a build — they append no events, take no leases,
and are safe to run at any time.

**`ab builds`** summarizes this repository's builds, one row each. It reports
**active** builds by default — `running`, `paused`, `blocked` — because those
are the ones something can still be done about.

| Flag | Effect |
|---|---|
| `--queued` | Also include `queued` builds — dispatched but not yet attached to a runner. |
| `--all` | Every status, including `queued`, `done`, and `aborted`. Subsumes `--queued`. |
| `--json` | The projection as JSON: no ANSI, no prose. Use this when scripting or parsing. |
| `--store <ref>` | Read a different store — a path or an `http(s)` URL, same reference behavior `ab dispatch` takes. |

An empty result names the filter in effect, so "no active builds" means the
filter matched nothing, not that the command failed. Widen it with `--queued`
or `--all` before concluding a build doesn't exist.

**`ab build status <slug>`** details one build: unresolved escalations, open
sessions, verify progress for the current cycle, PR lifecycle, latest event,
heartbeat, and lease. `--events <n>` appends the newest `n` event envelopes in
chronological order — the fastest way to see what a build actually just did.

Verify progress covers the **current cycle** — the results since the latest
code-review approve or reconcile. Implement and reconcile change the code, so a
new cycle re-runs from the first step and earlier results describe code that no
longer exists. An empty step list next to `attempt 1` therefore means the cycle
restarted, not that verify never ran.
`--json` and `--store <ref>` work the same here.

Use `ab builds` to find the build; use `ab build status` to understand it.

**`ab harvest status [--events N] [--json] [--store <ref>]`** projects the
latest repository harvest run from the same journal the runner resumes. It
shows the claimed observation count, each scan/synthesize/review/file
occurrence and outcome, review rounds, filed ticket refs, and any escalation or
infrastructure failure. It is read-only and also reports an idle repository
that has never harvested. The dispatch dashboard shows the latest run as a
literal, non-color-only `HARVEST` step row; it is not selectable and build
pause/auto-merge controls can never target it.

### Lease health is not build status

These are **two independent axes**, and reading one as the other is the mistake
worth avoiding.

**Status** is reduced from the event log (§15.5) — authoritative, and the same
projection the engine itself routes on. **Lease health** comes from the mutable
lease columns (§15.2.6), because liveness is not an event: nothing appends when
a sandbox dies, so a build whose runner is gone still reduces to `running`
forever. That gap is exactly why the lease column is reported separately.

| Lease | Meaning |
|---|---|
| `held` | A live runner holds an unexpired lease. Work is genuinely in flight. |
| `expired` | The lease ran out — the runner is gone. `running` + `expired` is the **stale** case: the status is not lying, it simply has no "runner died" fact to record. The dispatcher's lease sweep is what re-attaches it. |
| `no-lease` | **Not necessarily dead.** A build that has not yet claimed its first lease reads this way, and the lease sweep deliberately grants an absent lease a first-claim grace window before acting. A freshly launched build is the common case — read it together with `updated`, not alone. |

So `running` + `held` is healthy; `running` + `expired` means wait for the
sweep, not that the build is progressing; and `no-lease` on a build updated
seconds ago is almost certainly a runner still starting up.

## The installed skills

Each is invoked as `ab-<name>`, with its editable copy at
`.agents/skills/ab-<name>/SKILL.md` (read that copy, not the distribution
default, when you need to know what this repo's version says).

| Skill | Place in the lifecycle | Purpose |
|---|---|---|
| `ab-spec` | Before a build exists | Design a feature spec-first through conversation, or flesh out a ticket to the spec standard. The human-interactive surface; takes a ticket, not a build slug. **Model-invocable.** |
| `ab-tickets` | Before a build exists | Drive this repo's local file tracker: create a ticket, report the backlog, groom or move one between `triage/ ready/ doing/ done/`. The agent-facing surface on the tracker — use it instead of `mv`. **Model-invocable.** |
| `ab-guide` | Outside the pipeline | This skill: reference for the lifecycle, config surface, setup/upgrade behavior, and the installed skills. **Model-invocable.** |
| `ab-harvest` | harvest `synthesize` step | Continue the producer across review rounds: cluster the claimed structured observations and author typed spec-standard create/join/suppress proposals. Runner-only. |
| `ab-harvest-review` | harvest `review` step | Fresh adversarial reviewer for proposal coverage, semantic dedup, spec quality, and evidence; returns `approve`/`revise`/`escalate`. Runner-only. |
| `ab-plan` | `plan` phase | Turn the spec into a plan another agent can implement without re-deriving the reasoning. Writes no product code. |
| `ab-plan-review` | `plan-review` phase | Fresh skeptic: review the plan against the spec, verdict `approve`/`revise`/`escalate`. |
| `ab-implement` | `implement` phase | Execute the approved plan as local commits plus deposited notes. Never pushes. |
| `ab-code-review` | `code-review` phase | Fresh skeptic: review the implementation diff against spec and plan, same verdict vocabulary. |
| `ab-verify-e2e` | a `verify:<step>` phase | **Sample** agent-verify skill: drive the running app and check acceptance criteria. Runs only if a `[verify.<step>]` table names it. |
| `ab-reconcile` | `reconcile` phase (epilogue) | Resolve a conflicted PR with one merge commit, base merged *into* the build branch. Never rebases. |
| `ab-finalize` | `finalize` phase | Write the PR description for a green build; the kernel opens the PR. |

Everything except `ab-spec`, `ab-tickets`, and `ab-guide` is **runner-invoked**
by the kernel and carries `disable-model-invocation: true` — do not invoke a
phase skill yourself, and do not remove that key to make one convenient to call.
A model starting a pipeline phase by pattern-matching a description is exactly
what the flag prevents. The three exceptions drive no phase, which is the
criterion for membership (§16.3): `ab-spec` and `ab-tickets` are the
human/agent-facing surfaces that run before a build exists, and `ab-guide` is
read-only reference material.
