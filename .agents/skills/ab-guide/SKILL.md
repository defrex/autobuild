---
name: ab-guide
description: Authoritative reference for the autobuild system as installed in this repository - the build lifecycle (grooming, dispatch, plan, plan-review, implement, code-review, verify, finalize, reconcile, merge), the complete autobuild.toml configuration surface, how `ab init` and `ab upgrade` treat config and vendored skills, and what each installed ab-* skill is for. Use when asked about how autobuild works or why a build did what it did; when editing autobuild.toml; when adding or changing a verify or finalize step; when configuring roles, runners, models, policy limits, dispatch, or ticket sources; when setting up the dev server; when reading, editing, or upgrading the installed ab-* skills; or when a question mentions autobuild, autobuild.toml, or the `ab` CLI.
---

# Autobuild system guide

Reference material for an agent working on a repository that uses autobuild.
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
  un-groomed. The dispatcher claims tickets that pass the `[tickets]` ready
  gate, chooses a short immutable slug from the final conforming spec, and
  starts builds up to `[dispatcher].capacity`.
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
  order. A failing step sends the build back to `implement` with the report;
  an explicit skip records why the step did not apply and advances.
- **`finalize`** — the agent writes the PR description; the kernel opens the
  PR. `[finalize].steps` run afterward and are failure-tolerant.
- **Epilogue.** If main moves and the PR conflicts, `pr.conflicted` sends the
  build to `reconcile` (merge base *into* the branch — never a rebase), then
  back through `verify:*`. This can repeat. The build terminates **merged** or
  **closed**.

**The grammar is fixed.** `verify:*` and `finalize:*` are the *only* extension
points. There are no custom phases, no DAGs, no reordering — a repo extends
autobuild by configuring verify and finalize steps, never by inventing stages.
If a request seems to need a new phase, say so rather than improvising one.

**Observation harvest is not a build phase.** On each dispatch tick, once
`[harvest].threshold` new structured observations have accumulated, dispatch
runs one repository-scoped workflow: deterministic `scan`, agent `synthesize`
⇄ fresh adversarial `review`, then deterministic `file`. Only approved
spec-standard proposals are created directly in Triage. A repository journal,
artifact stream, dedup ledger, and lease make every step queryable and
crash-safe without polluting `ab builds` or the fixed phase grammar. Claims
exclude observations until they are dispositioned or selectively released;
idle ticks launch no harvest agent. A non-retrying infrastructure failure parks
the same run at its durable
boundary. Before any new scan, dispatch automatically reopens that run at most
twice through durable request facts and the same `harvest.resumed`
acknowledgement used by manual resume. Claims, artifacts, attempts,
reservations, and filing facts stay intact, so completed work is not repeated.
After the bound, one atomic fact commits only classifiable filed creates,
still-valid frozen joins, and suppressions; missing creates, tombstone/unknown
joins, and otherwise unclassifiable members are released as pending. A rejected
store read remains retryable infrastructure, while successfully read malformed
content fails safe toward release. The same fact raises a human-attention
barrier. Acknowledging that barrier permits a future scan but never resurrects
the old run. Completed and deliberate escalated runs remain terminal.

**Slug naming is not a phase.** For each new build, a tool-free one-shot call
proposes a lowercase kebab base of at most three meaningful spec-derived words.
The dispatcher owns a hard deadline, strict validation, and store-wide `-2`,
`-3`, … collision suffixes. Absence or any failure falls back to the first
three words of the kebab-cased title, so naming never blocks dispatch. The slug
and `ab/<slug>` branch are chosen once; existing builds are never renamed.
Naming inherits `[roles.default]` and can be overridden by `[roles.slug]`.

## Who does what

The distinctions that change an administrator's answer:

- **Agents supply judgment** — planning, reviewing, implementing, verifying,
  and narrow pre-build proposals such as slug naming. An agent never decides a
  transition or whether a naming proposal is valid.
- **The kernel owns determinism** — phase transitions, gating, deduplication,
  convergence and stall detection. Outcomes come from the typed `ab` CLI, never
  from parsing an agent's stdout.
- **The BuildStore is append-only event logs.** Build status is reduced from
  each build stream (`src/kernel/reducer.ts`); dispatcher settings and harvest
  state are independently reduced from the repository journal
  (`src/kernel/dispatch-settings.ts`, `src/kernel/harvest.ts`). Snapshots are
  never authoritative. Events record facts, never derived state.
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
| `kind` | — | **required**, `"check"` \| `"agent"` | Discriminator. `check` is deterministic (command + pass/fail, never an agent); `agent` runs a skill that returns `pass`, `fail`, or `skip`. |
| `command` | — | **required when `kind = "check"`**, nonempty string | Ref into `[commands]` — the key, not a shell string. Pass/fail is the command's exit status. |
| `skill` | — | **required when `kind = "agent"`**, nonempty string | Installed skill name to run (e.g. `"ab-verify-e2e"`). |
| `needsServer` | `false` | boolean, `kind = "agent"` only | `true` ⇒ the kernel starts `[server]` and waits for readiness before the session. |
| `paths` | — | optional nonempty array of positive repository-relative globs | Makes either step kind apply when any changed path matches any selector. Omitted means unconditional. |
| `always` | — | optional boolean | `true` explicitly makes the step unconditional even when `paths` is present; `false` is equivalent to omission. |

Cross-field rules the validator actually enforces — each is an **error**:

- A step listed in `steps` with no `[verify.<step>]` table.
- A `[verify.<step>]` table whose step is not listed in `steps` (add it to
  `steps` or remove the table — a defined-but-unlisted step never runs, so this
  is never silently tolerated).
- `command` naming a key that does not exist in `[commands]`.
- `needsServer = true` with no `[server]` table.
- An empty or malformed `paths` list. Matching is case-sensitive over Git's
  `/`-separated paths; supported syntax is literals, `*`, `?`, and `**` only as
  a whole segment. Absolute/traversing/empty segments, negation, escapes,
  character classes, brace expansion, extglobs, and malformed `**` are errors.
  `always = true` does not hide selector errors.

The kernel evaluates `paths` immediately before the step against current
`HEAD`, relative to the initial branch-cut SHA or the refreshed base from the
latest completed reconcile. It uses a NUL-delimited, no-rename Git diff, so
adds/modifications/deletions and both rename sides participate. A reconcile
starts a fresh cycle and evaluation repeats; upstream-only merged paths are
excluded while build-owned resolutions remain visible. A miss starts no
command, agent, server, or session and records `skipped` with
`excluded by [verify.<step>].paths: no changed path matched <JSON paths>`.
Git/base failures fail closed as infrastructure rather than becoming skips.

Agent verifiers may also use `ab verdict pass`,
`ab verdict fail --report <file>`, or `ab verdict skip --reason <text>`. The
skip reason is required and
must be non-blank; no failure report is required. Either kind of skip satisfies
that step for the current cycle and advances, but it is not a pass and never
masks another step's failure. Only failures return the build to `implement` and
consume `[policy].maxVerifyAttempts`; skips retain the cycle's attempt number
without consuming that budget.

### `[finalize]`

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `steps` | `[]` | array of nonempty step names | Post-steps that run after the PR is opened. **Failure-tolerant**: a failed step files an observation and never fails a green build. |

### `[roles]`

An **open map** of role name → `{ runtime?, model?, extensions? }` on the three
agent configuration axes. The reserved optional `default` role is the raw
inheritance base for every other role and is **never dispatched as a phase**.
With no `[roles.default]`, the base is empty: sessions use the wiring-fallback
runtime (`claude`) and that runtime's built-in default model, with no
extensions. Two runtimes ship: **`claude`** (Claude models) and **`pi`** (SDK
mode; provider-qualified ids such as `openai-codex/gpt-5.6-sol` — `ab models
[query]` looks them up).

The pipeline resolves `plan`, `plan-review`, `implement`, and `code-review`,
plus each verify/finalize step by name. The repository workflow resolves
`harvest` and `harvest-review`. The pre-build `slug` role uses the same
runtime/model resolution for optional one-shot naming; it is not a pipeline
phase, its extension allowlist is not enabled, and it remains tool-free.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `runtime` | — | optional, nonempty string | Runtime for this role. A phase role that omits it inherits `[roles.default].runtime`; absent there too ⇒ the wiring fallback. Must name a registered runtime. |
| `model` | — | optional, nonempty string | Model for this role. A phase role that omits it inherits `[roles.default].model`; only when neither names a model does the merged runtime supply its own default. |
| `extensions` | — | optional, array of nonempty strings | Pi extension allowlist. Omitted ⇒ inherit `[roles.default].extensions`; absent there too ⇒ **hermetic**. A set list, including `[]`, replaces the default wholesale rather than unioning. Entries match installed package sources case-insensitively; runtimes without extensions ignore this axis. |

Inheritance is mechanical and **independent per field**: merge each phase role
over the raw `default` entry, then validate the exact merged runtime/model pair.
The named runtime must serve the named model. A model-only role never searches
for another runtime, and an incompatible inherited model is never replaced by
the selected runtime's default. The one implicit fill-in is benign: if neither
the phase role nor `default` names a model, the merged runtime uses its own
default model. Compatibility failures name the role, runtime, model, and served
model families; all problems in `default` and every declared role are
aggregated into one eager load-time failure before any build launches.

Mixing models across roles is **intentional**, not an inconsistency to clean
up: a reviewer that differs from the implementer catches more. The removed
legacy `[agent]` table is not an alias: config loading rejects it and directs
users to move its fields to `[roles.default]`.

### `[policy]`

Every field is a **positive integer**.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `stallRounds` | `3` | positive integer | The same finding surviving this many review rounds auto-escalates to a human — the anti-loop guard. |
| `maxVerifyAttempts` | `3` | positive integer | Caps the `verify → implement → verify` cycle before escalation. |
| `maxReconcileAttempts` | `3` | positive integer | Caps the epilogue's `pr.conflicted → reconcile` cycle before escalation. |
| `maxReviewRounds` | `4` | positive integer | `maxRounds` for the `plan ⇄ plan-review` and `implement ⇄ code-review` convergence loops. |

### `[dispatcher]`

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `capacity` | `1` | positive integer | Concurrent builds for this repo. |

Readiness is expressed in the ticket source's vocabulary, so its fields live
under `[tickets]`, not `[dispatcher]`.

### `[tickets]`

Names the TicketSource and owns its readiness/lifecycle state vocabulary.
Declarative only. The table is required: `readyState` has no default, and an
absent table fails clearly at `tickets.readyState` rather than making every
state eligible.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `source` | — | **required**, `"linear"` \| `"file"` | Which provider backs ticket reads, claims, and creation. |
| `readyLabels` | — (source-aware) | optional; array of nonempty strings | A ticket must carry **every** listed label to be dispatchable. `[]` = **no label gate**. Absent uses the source default below. |
| `readyState` | — | **required**, non-blank string | The one workflow state a ticket must sit in to be dispatchable. Linear matches exactly and case-sensitively; file canonicalizes it to a state directory (`ready` → `ready/`). There is no any-state mode. |
| `teamKey` | — | `source = "linear"` **only, required there**; nonempty string | The Linear team key (e.g. `"ENG"`). |
| `claimedState` | — | `source = "linear"` only; optional, nonempty string | Workflow state `claim()` moves an issue to when a build starts. |
| `createState` | — | optional, nonempty string | State new tickets are filed into. Absent = the provider's default (Linear: the team's default, e.g. Backlog; file: Triage). |
| `triageState` | — | optional, nonempty string | State the dispatcher hands tickets back to for human triage — spec-gate bounces, aborted builds, closed-unmerged PRs. Absent = the provider's default (Linear: Backlog; file: Triage). Must name a state the tracker actually has — a Linear team only has "Triage" when its triage feature is enabled. |
| `dir` | `.autobuild/tickets` | `source = "file"` **only**; optional, nonempty string | Root holding the state directories. Resolved relative to the repo. |

`readyLabels` is the only source-aware readiness default, resolved by
`readyCriteria` in `src/processes/dispatcher.ts`:

| `[tickets].source` | `readyLabels` absent |
|---|---|
| `"linear"` | `["autobuild"]` — the historical label narrowing |
| `"file"` | `[]` — no label narrowing; `readyState` selects the directory |

An explicit `readyLabels` value always wins for either source.

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
default. Harvest remains independent of build capacity and of repository
intake. Dispatch tracks the workflow in-flight without awaiting it on
watch ticks, so janitor/dispatch/input/SIGINT stay responsive; `--once` drains
it before exit. The repository lease remains the cross-process single-flight
gate. A fixed two-attempt automatic recovery budget applies before any new run;
it is deliberately not configurable and is separate from retry policy inside
one harvest step.

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
- Idempotently adds the exact `.autobuild/` rule to the target's `.gitignore`,
  preserving every existing byte/rule and handling a missing trailing newline.
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

## Local state and store selection

By default, each Git repository owns one self-contained state tree at
`<main-repo>/.autobuild/`:

- `autobuild.sqlite` — build records, event logs, and repository journals.
- `blobs/` — content-addressed artifacts.
- `worktrees/` — autobuild-created Git worktrees.
- `tickets/` — the default location for the `file` ticket source.

The main checkout comes from Git's absolute repository/worktree topology, not
blindly from the current worktree's top level or the parent of its Git common
directory. Commands run in an autobuild-created linked worktree therefore read
the main checkout's state and file tickets, while submodules and
separate-Git-dir checkouts keep distinct roots beneath their own working trees.
There is no home-directory fallback: a repository with no state tree starts
empty.

Every command uses the same precedence: explicit `--store <ref>` > nonempty
`AB_STORE` > `<main-repo>/.autobuild`. Relative local overrides are normalized
against the main checkout. A local override relocates the whole state tree,
including `worktrees/` and default file tickets; an explicit `[tickets].dir`
remains repo-relative. An HTTP(S) URL still selects the remote store unchanged,
while worktrees and default file tickets remain under the repository-default
`.autobuild/` directory. The dispatcher passes its normalized selection to
every agent session as `AB_STORE`.

## Dispatch dashboard

On a TTY, `ab dispatch` renders one fixed interactive frame. Its first two
lines are the always-present process-global section: a selectable `Auto Build`
title with the repository basename, mode, capacity, active-build count,
`intake ON`/`intake OFF`, `auto merge default ON`/`auto merge default OFF`, and
`harvest ON`/`harvest OFF`, then one status slot. All three controls are durable
repository projections and converge across dispatchers on the existing poll;
harvest specifically reflects its acknowledged gate, not pending intent. Tick
counts, dependency diagnostics, parked-build notices,
harvest outcomes, action confirmations, and warnings replace that slot instead
of scrolling above the frame. A blank line separates the global section from
the first body row, and another separates the body from the legend or feedback
controls. The duplicate startup banner is suppressed; `--plain` and non-TTY
output remain line-oriented and unchanged. A satisfied verify skip carries the
literal `skipped` qualifier, so it remains distinct from a pass without color.

Up/Down moves without wrapping through global first, optional `Harvest` second,
then slug-sorted builds. Stable discriminated identity preserves selection
through repaint, re-sort, and row appearance/disappearance. The legend is
contextual: every row offers navigation and quit; global offers `h harvest
on/off`, `m auto-merge default`, and `p intake on/off`; `Harvest` offers
`p resume` for ordinary failure or `p acknowledge` for exhaustion/escalation
only when that action is available; builds offer `m auto-merge` and `p
pause/resume`. `m` on `Harvest` is an explanatory build-only no-op.

`--intake` and `--no-intake` are mutually exclusive durable repository setters.
Omitting both reuses stored state, falling back to ON only when no intake fact
exists. Global-row `p` re-reads current state and appends the opposite value.
Intake off skips only new ticket claims while janitor, stale-runner, harvest,
and in-flight work continue. Every dispatcher samples the current value on each
tick, so a change in one process gates all dispatchers for that repository.

`--auto-merge` and `--no-auto-merge` similarly set the durable repository
claim-time default; omission reuses stored state, falling back to OFF only when
no fact exists. The forms are mutually exclusive independently of the intake
pair. Global-row `m` re-reads current state, appends the opposite value, and
posts a dispatcher notice. When on, each fresh dispatcher claim records the
existing human-authored `build.auto-merge-requested` fact immediately after
`build.created` and before runner launch. The first visible build frame therefore
carries `auto merge`. This is a creation-time seed, not policy: changes never
touch existing builds, resumed/adopted logs or other creation paths never sample
it, and build-row `m` remains independent (a seeded build can be cancelled while
the global default stays on). Both repository settings are independently
last-write-wins by event sequence. They are stored in the BuildStore, not in
`autobuild.toml`; propagation uses polling, not a push channel.

Header `h` re-reads the repository journal and appends the existing human
pause/resume request. The newest pending command determines the next target, so
rapid presses issue opposing requests; the token changes only after the kernel's
`harvest.paused`/`harvest.resumed` acknowledgement.

`Harvest` uses the same marker, right-aligned status column, and status colors
as builds; its internal run id is not shown. It appears only for an open run or
unresolved failed/escalated attention. Completed runs, an idle paused
repository, acknowledged recovery exhaustion, and dismissed escalation have no
row. A paused open run freezes and reads `PAUSED`. Ordinary failure reads red
`FAILED`, marks the stopped step, shows automatic progress, and offers `p
resume`. Exhaustion remains red, says `recovery exhausted — human attention
required`, shows stopped step/pending count, and offers `p acknowledge`;
escalation also offers `p acknowledge`. A request awaiting acknowledgement has
no duplicate action. Row `p` never pauses the gate. When the gate is off it
writes nothing and directs the operator to global `h`; the eventual shared
resume acknowledgement intentionally also reopens ordinary failure or settles
attention. Exhaustion and escalation remain terminal. Escalation's row is
dismissed only by a post-terminal human resume request followed by its later
kernel acknowledgement, never by the request alone.

A build with auto-merge off has no auto-merge token. Requested, enabled, and
cancelling states all read `auto merge`: cyan means requested locally but not
yet applied on GitHub, green means native auto-merge is enabled, and yellow
means cancellation is in flight. The token disappears when cancellation lands.

### Durable build controls: CLI and dashboard

The CLI and dashboard are two surfaces over the same store-backed control
operations. Use the CLI from a non-TTY, a script, or an assistant; use the
keys while watching the interactive dashboard. Both append human-authored facts
to the build's event log and apply the same write-time checks.

| Intent | CLI | Dashboard | Durable event(s) |
|---|---|---|---|
| Pause | `ab pause <slug> [--store <ref>]` | Select the build and press `p` while it is not paused or blocked. | `build.pause-requested` |
| Resume | `ab resume <slug> [--store <ref>]` | Select a paused build and press `p`. | `build.resume-requested` |
| Enable/disable auto-merge | `ab auto-merge <slug> on\|off [--store <ref>]` | Select the build and press `m` to toggle. | `build.auto-merge-requested` / `build.auto-merge-cancelled` |
| Answer blockers with guidance | `ab answer <slug> <text> [--store <ref>]` | Select a blocked build, press `p`, enter text, then Enter. | One `escalation.answered` with `resolution: guidance` per applicable blocker. |
| Retry blockers without guidance | `ab answer <slug> [--store <ref>]` | Open the same `p` field and press Enter empty or whitespace-only. | One `escalation.answered` with `resolution: retry` per applicable blocker. |
| Abort | `ab abort <slug> [--store <ref>]` | No key in this release. | `build.abort-requested` |

On the dashboard, `p` on a blocked build replaces the bottom legend with the
optional feedback field while the blocker stays visible. All printable keys
edit the field instead of triggering dashboard actions; Backspace deletes,
Enter submits, and Escape cancels.

`ab answer` answers every escalation that is open when the command runs,
regardless of `agent`, `stall`, or `policy` source. Its text is joined, trimmed,
and delivered as authoritative guidance. With no text (or only whitespace), it
requests a bare retry and supplies no agent guidance. The dashboard captures
the blocker ids when its field opens, then answers only those still open at
submission; Escape cancels without writing. If the build is also paused, both
surfaces append all answers first and `build.resume-requested` last. A plain
`ab resume` does not answer blockers; use `ab answer` for a blocked build.

Every command requires the target to exist in this repository and be active
(`running`, `paused`, or `blocked`); `ab answer` additionally requires an open
escalation. A stale, missing, queued, done, aborted, or unblocked target is an
error and gets no new event. Attribution uses `USER`, then `USERNAME`, then the
same stable fallback on both surfaces. All five commands run sessionless and
accept `--store <ref>` with the usual explicit flag > `AB_STORE` > repository
local precedence. If nonblank `AB_SESSION` and matching `AB_BUILD` identify the
caller's own phase build, the command refuses it; a phase cannot pause, resume,
auto-merge, answer, or abort itself.

These commands request normal kernel work; they do not wake a runner, operate
the forge, or bypass the lease sweep. Resume is therefore an attempt, not a
guarantee: if the condition still fails, a phase may raise a new escalation and
block again. A fresh `ab dispatch` still auto-retries only an all-policy
escalation set and never invents guidance.

Two asymmetries are intentional and explicit. Durable repository intake and the
claim-time auto-merge default have launch-flag setters and global-row toggles,
but no standalone sessionless control commands. Conversely, abort has a CLI
command but gains no TUI key in this release. Global-row `h` owns the durable harvest
gate. On the optional repository-scoped `Harvest` run row, `p` only resumes or
acknowledges the represented run; `m` remains an explanatory build-only no-op.

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
restarted, not that verify never ran. A skip renders as `SKIP` with its reason;
JSON exposes `outcome: "skipped"` and `reason`, never a synthetic pass.
`--json` and `--store <ref>` work the same here.

Use `ab builds` to find the build; use `ab build status` to understand it.

**`ab harvest status [--events N] [--json] [--store <ref>]`** projects the
durable repository gate and latest harvest run from the same journal the runner
resumes. It distinguishes recoverable from terminal, shows automatic
attempts/limit, stopped step/round, attention state, exact pending observation
and proposal keys, each workflow occurrence, review rounds, filed ticket refs,
and any escalation or infrastructure failure. It is read-only and also reports
an idle or paused repository with no run. The dispatch header always shows its
acknowledged `harvest ON/OFF` gate and global `h` controls it. The optional,
non-color-only `Harvest` row omits the internal run id and represents only an
open run or unresolved attention; its contextual `p` resumes or acknowledges
that run, and `m` remains the build-only no-op.

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
