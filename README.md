# auto-build

auto-build takes a groomed ticket to an open pull request. It plans the work,
implements it, reviews its own code, runs your verification steps, opens the
PR, and reconciles conflicts against your base branch — as a sequence of agent
sessions driven by deterministic code. Once the PR lands, it records the merge
and closes the build out.

**auto-build never bypasses your merge gates.** It opens PRs and watches them.
You can land one yourself or press `m` in the dispatch dashboard to request
GitHub-native squash auto-merge; required checks still decide when it lands,
and `m` cancels the request. The last word on what enters your base branch
stays with you.

**Who it's for:** maintainers of a repository who have a backlog of
well-understood, self-contained work and would rather review outcomes than
type them.

**What it addresses:** the gap between "an agent can write this code" and "this
change is planned, reviewed, verified, and on the record, ready for me to
land." Coding agents are good at the middle of that sentence and bad at the
ends. auto-build owns the ends: state lives in a typed, append-only event log,
phase transitions are code and not model judgment, and every build leaves a
queryable paper trail.

**What stays yours:** three things.

1. **Grooming** a ticket to [the spec standard](docs/spec-standard.md) — what
   and why, acceptance criteria, out of scope. auto-build never grooms its own
   work: a ticket becomes dispatchable only when it passes your ready gate —
   moved into `ready/` with the file tracker, or labelled `autobuild` on Linear
   — and that act is a human one.
2. **Answering escalations** — the questions a build parks on rather than
   deciding alone.
3. **Reviewing and choosing when to land the PR.** Merge it yourself, or opt a
   selected build into GitHub-native auto-merge from the dashboard.

---

## How a build flows

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

1. **spec** — the dispatcher claims a ready ticket (one that passes your ready
   gate), establishes the final conforming spec, and chooses the build's short
   immutable slug from it. The spec is the contract for everything downstream.
2. **plan ⇄ plan-review** — a planner writes an implementation plan; a
   reviewer approves it or sends it back with findings. The loop runs until
   approval or a policy limit.
3. **implement ⇄ code-review** — the same shape over commits: implement,
   review, revise. A finding that survives round after round escalates to you
   rather than looping forever.
4. **verify:\*** — your verification steps, in the order you declare them.
5. **finalize** — the agent writes the PR description and the kernel opens the
   PR. Then your optional `finalize:*` steps run (release notes, changelog, and
   so on). Those are failure-tolerant: a failed step files an observation, it
   does not kill a green build.
6. **epilogue** — with the PR open, the dispatcher watches it. A conflicted PR
   routes to `reconcile` and re-verifies; the build ends `merged` or `closed`.

The build grammar is fixed. Only `verify:*` and `finalize:*` are configurable,
and they are declared per-repo in `autobuild.toml`. Observation harvest is a
separate repository-scoped outer workflow owned by dispatch, not a build phase:
`scan → synthesize ⇄ review → file`. Verify steps come in two kinds:

- **`check`** — a deterministic shell command; pass/fail is its exit code.
- **`agent`** — a skill that runs and returns a `pass` or `fail` verdict.

---

## Status, integrations, and limitations

Read this section before the rest. It is the honest answer to "can I use this?"

**Maturity.** Version 2.0. The package is `private: true` and there is no
published distribution — see [Installation](#installation) below. Expect to be
an early adopter.

**Supported integrations.** This list is exhaustive, not illustrative:

| Seam | Supported today |
|---|---|
| Forge | **GitHub only**, through the `gh` CLI |
| Ticket source | **`linear` and `file` only** (no GitHub Issues) |
| Agent runtimes | **`claude`** (`@anthropic-ai/claude-agent-sdk`, Claude models) and **`pi`** (SDK mode, Kimi/Moonshot + GPT/OpenAI models) |
| Workspaces | git worktrees only |
| Store | local SQLite + blob directory; a remote HTTP store is wired through the `ab` binary |

**Prerequisites.**

- [Bun](https://bun.sh) — the runtime.
- `git`.
- The [`gh` CLI](https://cli.github.com), installed and authenticated
  (`gh auth login`). auto-build shells out to it for every forge operation and
  uses whatever credentials `gh` resolves.
- Credentials for the Claude Agent SDK. auto-build passes your environment
  through to the SDK and does not read any API key itself, so the SDK's own
  authentication applies — see the
  [Claude Agent SDK docs](https://docs.claude.com/en/api/agent-sdk/overview).
- A Linear API key, if you use the Linear ticket source (`LINEAR_API_KEY`).

**Limitations.** Each of these is current behavior, not a roadmap note:

- **No direct/admin merges.** The dashboard can request GitHub-native
  `--auto --squash`, but never uses `--admin` and never bypasses required
  checks. A build reaches `merged` only after GitHub reports that it landed.
- **One dispatcher per repository.** Ticket claiming is read-check-write; it is
  safe only under that rule.
- **Capacity is per-repo.** `[dispatcher].capacity` defaults to 1. There is no
  global cap across repos sharing a store.
- **`ab dispatch` must run from the repo root** — it reads `./autobuild.toml`.
- **Merged builds are terminal.** A fixup on merged work is a new ticket, never
  a reopened build.
- **Tickets that fail the spec gate are bounced back for human triage**,
  commented with what was missing. No build is created.
- **The dispatcher's `Done` state name is not configurable** via
  `autobuild.toml`. The triage hand-back state is — `[tickets].triageState`
  (default `Backlog` for Linear, `Triage` for the file tracker).
- **Worktrees always live under `~/.autobuild/worktrees`**, even when `--store`
  points somewhere else.

---

## Installation

> **Status: unresolved.** There is no supported way to install auto-build yet.
> The package is private and unpublished, and choosing a distribution mechanism
> is an open decision. This section will name a real command when there is one.

Everything below assumes you have a working **`ab` executable on your PATH**.
The binary is `bin/ab.ts`, declared as the `ab` bin in `package.json`; the same
executable serves operators and agents. How it gets onto your PATH is the part
that is unresolved.

---

## Set up a repository

### 1. Initialize

From the repository root:

```sh
ab init
```

`ab init [target] [--force]` writes, for the target repo (default: the current
directory):

- **`autobuild.toml`** from the template — **only if absent**. An existing
  config is never overwritten, not even with `--force`.
- **Per skill**, three things:
  - the live, editable copy at `.agents/skills/ab-<name>/SKILL.md`
  - a pristine record at `.agents/skills/.ab-pristine/ab-<name>/SKILL.md`
    (the merge base `ab upgrade` needs — commit it)
  - a relative directory symlink at `.claude/skills/ab-<name>` →
    `../../.agents/skills/ab-<name>`, so Claude discovers the one editable copy

Output is one line for the config and one per skill:

```text
autobuild.toml: written
ab-code-review: installed
ab-implement: installed
…
```

Config actions are `written` or `skipped`. Skill actions are `installed`,
`unchanged`, `kept`, or `overwritten`. **Local edits are never clobbered**: an
edited skill is reported `kept` unless you pass `--force`, which overwrites
edited skills (and only skills). `ab init` is idempotent — re-running it is
safe, and reports `skipped` / `unchanged`.

### 2. Configure `autobuild.toml`

The file is **strict**: an unknown table or an unknown key inside a known table
is an error, so a typo cannot silently disable a verifier.

| Table | What it does | Notable defaults |
|---|---|---|
| `[project]` | `baseBranch` — what PRs target | `"main"` |
| `[commands]` | Free-form map of verb → shell string. `setup` runs after provision and after a rehydrate; others are referenced by name from verify steps. | — |
| `[verify]` | `steps = [...]` — the ordered verify phases | `[]` |
| `[verify.<step>]` | `kind = "check"` needs `command` (a key in `[commands]`); `kind = "agent"` needs `skill`, optionally `needsServer` | `needsServer = false` |
| `[finalize]` | `steps = [...]` — optional post-PR steps, failure-tolerant | `[]` |
| `[agent]` | Repo-wide defaults for `runtime`, `model`, and the optional Pi `extensions` allowlist. | absent ⇒ the built-in fallback runtime + its own default model; extensions hermetic |
| `[roles]` | Role → per-step override `{ runtime?, model?, extensions? }`, most-specific-first (see below), including the optional pre-build `slug` naming role. Registered runtimes: `claude` (Claude models), `pi` (provider-qualified Kimi/GPT models). | — |
| `[policy]` | `stallRounds`, `maxVerifyAttempts`, `maxReconcileAttempts`, `maxReviewRounds` | `3`, `3`, `3`, `5` |
| `[dispatcher]` | `capacity`, optional `readyLabels`, **required `readyState`** | `1`; `readyState` names the single dispatchable state and has no default (see below) |
| `[server]` | Optional. `start` + `url` required; `readyTimeout` in seconds | `readyTimeout = 60` |
| `[tickets]` | Optional. Which ticket source to drive — see below | absent = the local file tracker at `.autobuild/tickets` |
| `[harvest]` | Observation-count back-pressure for the staged harvester: positive `threshold` | `threshold = 10` |
| `[outer]` | Map of other scheduled ingesters → `{ cron = "…" }`; the exact `harvest` key is rejected | — |

The generated template ships a working `[verify]` pair:

```toml
[verify]
steps = ["types", "unit"]

[verify.types]
kind = "check"
command = "typecheck"   # a key in [commands]

[verify.unit]
kind = "check"
command = "test"
```

**Runtime, model, and extensions — set once, override per step.** Every agent
session runs on a `runtime` (the adapter that executes it), a `model`, and — for
the `pi` runtime — an optional `extensions` allowlist of installed Pi packages
(e.g. `web-access`, `subagents`). Set the repo-wide default in `[agent]`,
override per step in `[roles]`. Extensions are **off by default** (hermetic):

```toml
[agent]
runtime = "claude"                                   # no model ⇒ the runtime's own default

[roles]
slug        = { model = "openai/gpt-5.6-sol" }                                      # optional pre-build naming override
code-review = { runtime = "pi", model = "moonshotai/kimi-k3", extensions = ["web-access"] }  # pinned pair + web grounding
plan        = { model = "openai/gpt-5.6-sol", extensions = ["subagents", "web-access"] }     # model only ⇒ pi; plus extensions
```

Grant `web-access`/`subagents` to plan and review so they can ground on real
docs and fan out sub-agents; leave `implement` and `verify` hermetic so nothing
external flows into committed code. `ab models [query]` looks up provider-qualified model ids.

Overrides resolve **most-specific-first**: `runtime + model` pins the pair
(a runtime that can't serve the model is a config error); `runtime` alone uses
that runtime's default model; `model` alone routes to a runtime that serves it
(the default runtime wins when it qualifies, otherwise the single supporter —
zero or several non-default supporters is a loud error); neither falls back to
the `[agent]` default. Two runtimes ship today: **`claude`** (Claude models)
and **`pi`** (Kimi/Moonshot and GPT/OpenAI models). The whole config is
resolved **before any build launches**, so a typo'd runtime fails loudly at
`ab dispatch`, never mid-build. Slug naming follows the `[agent]` default unless
`[roles].slug` overrides it. Only its runtime/model selection applies: naming is
a tool-free one-shot completion, not a pipeline phase or resumable session. A
runtime without that capability simply uses the deterministic title fallback.

### 3. Point at a ticket source and set up auth

The `[tickets]` table is what the dispatcher watches. It is **optional**, and
secrets never go in this file.

**The local file tracker (the default — no table, no config, no secret).** Omit
`[tickets]` entirely and you get a file tracker at `.autobuild/tickets`. That is
the zero-config path: a repo dispatches without you configuring a ticket source
at all.

The tracker is four state directories, and **a ticket's state is the directory
it sits in**:

```text
.autobuild/tickets/
  triage/   ready/   doing/   done/
```

`ls ready/` answers "what's dispatchable", and `mv triage/x.md ready/`
dispatches it. The defaulted directory writes a self-excluding `.gitignore`, so
it stays out of git on its own.

Tickets are `<id>.md` files with `+++`-fenced TOML frontmatter — `id`,
`title`, optional `labels`/`blockedBy`, and an internal harvest idempotency key
when applicable — followed by the body. There is **no `state`
field**: the directory is the state. The frontmatter is strict, so an unknown
key is a parse error. A dispatchable ticket at `.autobuild/tickets/ready/file-1.md`:

```markdown
+++
id = "file-1"
title = "Throttle repeated failed logins"
+++

## What and why
…

## Acceptance criteria
- …

## Out of scope
- …
```

`ab ticket create` names the files it writes `file-<n>.md` and files them into
`triage/`; hand-written tickets can use any id, as long as the filename matches
it. Claiming a ticket renames it into `doing/`.

To put the tracker somewhere else — note that an **explicit `dir` is your
directory**, so auto-build does not gitignore it for you:

```toml
[tickets]
source = "file"
dir = "tickets"          # optional; default ".autobuild/tickets"
createState = "Triage"   # optional; "Triage" is the default
triageState = "Triage"   # optional; "Triage" is the default
```

**Linear:**

```toml
[tickets]
source = "linear"
teamKey = "ENG"                # required
claimedState = "In Progress"   # optional; this is the adapter's default
createState = "Triage"         # optional; absent = the team's default state
triageState = "Backlog"        # optional; absent = "Backlog" — must name a state the team has
```

The API key comes from `LINEAR_API_KEY`, in your environment or a local `.env`.

**GitHub** auth is whatever `gh` resolves. There is no auto-build environment
variable for it.

### 4. Validate

```sh
ab dispatch --once
```

From the repo root. This loads and validates `autobuild.toml`, runs exactly one
tick, and exits:

```text
ab dispatch — one pass over /path/to/repo (capacity 1)
tick: idle
```

`tick: idle` is the correct, healthy output when nothing is ready. If the config
is wrong, you get a `invalid config` report naming each path instead — see
[Troubleshooting](#troubleshooting).

---

## Run a build

### The ticket

A dispatchable ticket must conform to [the spec standard](docs/spec-standard.md).
The dispatcher enforces a checkable core of it:

- a nonempty body
- a `## Acceptance criteria` heading (case-insensitive) with **at least one
  list item**
- an `## Out of scope` heading

A ticket that fails is transitioned back to Triage and commented with exactly
what was missing. No build is created — failure lands at the cheapest point.

### Grooming (your step)

The `ab-spec` skill is the conversational surface over the standard: it designs
a spec with you and files or updates the ticket.

It is one of three vendored skills a model may invoke on its own — the three
that drive **no** pipeline phase: `ab-spec` (the conversation that writes a spec
before a build exists), `ab-tickets` (drives the local file tracker — "move
ticket X to ready"), and `ab-guide` (read-only reference material about the
system). Every other `ab-*` skill is a phase skill, installed with
`disable-model-invocation: true` and invoked by the runner or by you — a model
must never start a pipeline phase by pattern-matching a description.

To file a groomed ticket by hand:

```sh
ab ticket create "Throttle repeated failed logins" --body spec.md --labels autobuild
# → ticket created: file:file-1 (Triage)
```

The output is `ticket created: <source>:<id> (<state>)`, plus the ticket URL
when the source provides one.

### The dispatcher

```sh
ab dispatch --once      # one pass, drain in-flight runners, exit
ab dispatch             # watch; default interval 10s, Ctrl-C to stop
ab dispatch --interval 30
ab dispatch --plain     # force line-oriented output, even on a TTY
```

On a TTY the dispatch dashboard is interactive and always shows its key legend:

| Key | Action |
|---|---|
| Up / Down | Move the slug-based build selection. Repaints and re-sorts keep the same build selected. |
| `m` | Toggle GitHub-native squash auto-merge for the selected build. Pre-PR intent is remembered; required checks are never bypassed. |
| `p` | Request pause, or resume an authoritatively paused build. The current agent step finishes before pause takes effect. |
| `d` | Toggle drain for this dispatcher process: stop claiming new tickets while janitor, stale-runner, and in-flight work continue. Restart resets drain off. |
| Ctrl-C | Stop and restore terminal input/cursor state. |

Rows show `auto off`, `auto requested`, `auto enabled`, or `auto cancelling`,
and the header shows `intake ON` or `intake DRAINED`. Pipes, redirects, and
`--plain` remain non-interactive and emit no terminal escapes.

Each tick runs in this order:

1. **janitor** — polls open PRs; applies outstanding native auto-merge intent,
   completes merged/closed builds, routes conflicted ones to `reconcile`, and
   cleans up aborted builds.
2. **startup resume** — first tick of an invocation only; attempts every
   current build. Later ticks preserve deliberate policy parks.
3. **lease sweep** — re-attaches runners to builds whose lease went stale.
4. **dispatch** — claims and launches new work (skipped while the interactive
   dispatcher is drained).
5. **harvest** — independently of build capacity and drain, count newly
   unclaimed structured observations. Below `[harvest].threshold`, do nothing.
   At the threshold, claim the accumulation and run one journaled
   scan/synthesize/review/file workflow. Approved proposals are created directly
   in Triage and are never dispatched by the harvester.

The dashboard renders the latest run as a literal `HARVEST` step row with
elapsed times. It is not selectable, so `p` and `m` still target build slugs
only. Use `ab harvest status --events 20` for its event-level paper trail.
Optional runtime/model overrides are `[roles].harvest` and
`[roles].harvest-review`; the producer continues across revision rounds and
each reviewer is fresh.

Dispatch gates a ticket in this order: **capacity** (blocked and paused builds
still hold a slot) → the **ready gate** (`readyLabels`, all of which must be
present, and `readyState`) → **claim-before-launch** → the **spec gate**.

After the final spec passes that gate, the selected runtime proposes one to
three meaningful lowercase kebab words from the whole spec. The dispatcher
strictly validates that base and checks every build in the store for collisions,
appending `-2`, `-3`, and so on outside the three-word limit. If naming is
unavailable, invalid, errors, or times out, dispatch still succeeds with the
first three words of the kebab-cased title (`build` when none remain). The slug
and branch `ab/<slug>` are chosen once; existing builds are never renamed.

> **`readyState` is required — it names the single workflow state a ticket must
> sit in to be dispatched.** There is no default and no "any state" mode:
> omitting it (or leaving it blank) is a config error, because without it every
> ticket from the source would be eligible in *any* state — including completed
> ones — which is exactly how a finished ticket could be built a second time.
> Both sources apply it:
>
> - **File tracker** — the state is a directory: `readyState = "ready"` gates on
>   the `ready/` directory, so `mv triage/x.md ready/` is the act that says
>   "build this." The name is canonicalized (`ready` → `ready/`).
> - **Linear** — name your own ready workflow state (matched **exactly and
>   case-sensitively**), e.g. `readyState = "Todo"`. A ticket is dispatchable
>   only while it sits in that state; `readyLabels` defaults to `["autobuild"]`,
>   so a ticket must carry the label **and** sit in `readyState`.
>
> `readyLabels` remains optional and narrows **on top of** `readyState`. With
> the file tracker, setting it means moving a ticket into `ready/` is no longer
> enough on its own. A wrong `readyState` fails quietly, not loudly: the config
> stays valid, nothing matches, and every tick just reports `tick: idle` — so
> for Linear, confirm the value is a real workflow-state name.
>
> **Rerunning a ticket:** a merged ticket leaves `readyState` (it moves to e.g.
> `Done` or the `done/` directory), so it stops being eligible. To build it
> again, move it back into the configured ready state — prior builds never
> permanently suppress it; the gate is the ticket's *current* state.

Each tick prints a report of its nonzero counters:

```text
tick: merged=1 dispatched=2
tick: idle          # every counter zero
```

Counters are `merged`, `closed`, `conflicted`, `abandoned`, `resumed`, `swept`,
`dispatched`, `authored`, `bounced`, `claimRaces`, `harvestStarted`,
`harvestResumed`, `harvestCompleted`, `harvestEscalated`, and `harvestFailed`.

---

## Command reference

### Operator commands

Run these yourself, from the repo root. They need no `AB_*` environment.

| Command | What it does |
|---|---|
| `ab init [target] [--force]` | Vendor the default `ab-*` skills and write `autobuild.toml`. `--force` overwrites edited skills only. |
| `ab upgrade [target]` | Three-way merge the vendored skills with the new defaults. See below. |
| `ab ticket create <title> --body <file> [--labels a,b]` | File a ticket to the configured `[tickets]` source. |
| `ab dispatch [--once] [--interval <s>] [--store <ref>] [--plain]` | Run the outer loop; a TTY gets the interactive selection/action dashboard. |
| `ab builds [--queued] [--all] [--json] [--store <ref>]` | List builds for this repository. Read-only. |
| `ab build status <slug> [--events <n>] [--json] [--store <ref>]` | Project one build's durable state. Read-only. |
| `ab harvest status [--events <n>] [--json] [--store <ref>]` | Project the latest repository harvest run, including steps, verdicts, filing, and failures. Read-only. |
| `ab help` | Print the command surface. |

### Agent build-session commands

Documented for transparency — **you do not run these by hand.** The build runner
launches each agent session with `AB_STORE`, `AB_BUILD`, `AB_PHASE`, and
`AB_SESSION` set, and these commands resolve everything from that environment.
Every phase ends with exactly one terminal command (`done`, `verdict`, or
`escalate`). Run one outside a session and it fails on the first missing
variable:

```text
AB_STORE is not set — expected the store URL or local path. The runner sets
ambient auth for every session (D8, SPEC §8.1).
```

| Command | What it does |
|---|---|
| `ab context [--json]` | Hydrate `.ab/` with the phase's inputs; print the manifest. |
| `ab artifact put <kind> <file>` | Deposit a versioned artifact; prints the assigned rev. |
| `ab artifact get <kind>[@rev]` | Fetch an artifact within the build (latest if `@rev` omitted). |
| `ab observe --kind <followup\|refactor\|latent-bug> [--files a,b] [--refs x,y] <summary>` | Record a structured observation. Not a terminal. |
| `ab server <start\|stop\|restart\|status\|logs> [n]` | Dev-server lifecycle, driven by `[server]`. |
| `ab done [--notes <file>]` | **Terminal.** Complete a producer phase. |
| `ab verdict <approve\|revise\|escalate\|pass\|fail> [--findings <json>] [--notes <file>] [--reason <text>] [--report <file>]` | **Terminal.** Complete a review or verify phase; the vocabulary is phase-dependent. |
| `ab escalate <question> [--refs a,b]` | **Terminal.** Park the build for human input. |

---

## `ab upgrade`

`ab upgrade [target]` upgrades **the vendored `ab-*` skills, and nothing else.**
It does **not** update the `ab` executable, your dependencies, or
`autobuild.toml`.

It three-way merges each skill with `git merge-file`:

- **base** — the pristine record in `.agents/skills/.ab-pristine/`
- **ours** — your live `.agents/skills/ab-<name>/SKILL.md`
- **theirs** — the new default

| Outcome | Meaning |
|---|---|
| `installed` | New skill in the distribution; installed fresh. |
| `current` | Upstream did not change; your file stands, edited or not. |
| `adopted` | No local edits; the new default was taken. |
| `merged` | Both changed and the three-way merge resolved cleanly; your edits and the new default are both in the result. |
| `conflicted` | Both changed the same lines. **Your local file is kept byte-for-byte** — no conflict markers are ever written into it. |
| `unknown` | An installed `ab-*` skill that is not in the distribution. Left alone; local additions are legitimate. |

`ab upgrade` never deletes anything.

**Resolving a conflict:** merge by hand against the pristine record —
`.agents/skills/.ab-pristine/ab-<name>/SKILL.md` holds the bytes you started
from. You only have to reconcile the **colliding** hunks: once the three-way
merge comes out clean, the next `ab upgrade` reports `merged` and advances the
pristine record. **Your unrelated local edits survive that** — you are not
choosing between your customizations and the upgrade, and you do not have to
make the file match either side in full.

---

## State, paths, and environment

### Build slugs

New builds get a one-to-three-word base chosen from the final spec, for example
`login-rate-limit`; a store collision becomes `login-rate-limit-2`. This short
slug is the stable identifier used by the dashboard, `ab` commands, runner
instances, worktree names, and the branch `ab/<slug>`. Builds created before
this rule retain their existing slugs and branches.

### Local state lives outside your repo

Under `~/.autobuild` by default:

| Path | Contents |
|---|---|
| `~/.autobuild/autobuild.sqlite` | Events and build records |
| `~/.autobuild/blobs/` | Content-addressed build and repository-journal artifact blobs |
| `~/.autobuild/worktrees/ab-<slug>/` | One git worktree per build. The branch is `ab/<slug>`; the directory name flattens it — every run of characters outside `[A-Za-z0-9._-]` becomes a `-`, so branch `ab/add-rate-limiting` lives at `worktrees/ab-add-rate-limiting/`. |

`ab dispatch --store <ref>` moves the store — a local path, or an
`http(s)://` remote store. It does **not** move the worktree root.

### Commit these

`ab init` does not touch your `.gitignore`; that is up to you.

- `autobuild.toml`
- `.agents/skills/ab-*/`
- `.agents/skills/.ab-pristine/` — **commit this.** It is `ab upgrade`'s merge
  base; without it, upgrade cannot tell your edits from an old default and will
  refuse to touch an edited skill.
- the `.claude/skills/ab-*` symlinks

### Keep uncommitted

- `.ab/` — per-phase agent scratch, disposable by construction
- `.autobuild/` — the default file tracker at `.autobuild/tickets` writes its
  own self-excluding `.gitignore`, so it stays out of git without your help.
  (An explicit `[tickets].dir` is *your* directory — auto-build does not
  gitignore it.) Also covers the store, if you point it into the repo for
  local dev.
- `*.local.db`
- `.env`

### Environment variables

**You set these:**

| Variable | When |
|---|---|
| `LINEAR_API_KEY` | `[tickets].source = "linear"` only |
| `AB_TOKEN` | Only when `--store` is a remote `http(s)://` store |

**The runner sets these** inside build sessions — you never set them by hand:
`AB_STORE`, `AB_BUILD`, `AB_PHASE` (`<phase>[@<round>]`; round defaults to 1),
`AB_SESSION`.

**`.env`:** the `ab` binary loads `<cwd>/.env` if it exists. `KEY=VALUE` lines,
`#` comments, an optional `export ` prefix, and one layer of matching quotes
stripped. **Real environment variables always win** over `.env` values, and a
missing file is a silent no-op.

---

## Troubleshooting

### `invalid config`

```text
autobuild.toml: invalid config
  verify.steps[0]: verify step "e2e" is listed in verify.steps but has no [verify.e2e] table — …
```

Each line is `  <path>: <message>`. Common causes:

- **Unknown table** — the message appends `— known tables: project, commands,
  server, verify, finalize, agent, roles, policy, dispatcher, tickets, harvest,
  outer`. Check
  for a typo; the file is strict on purpose.
- **A step with no table** — `verify step "<s>" is listed in verify.steps but
  has no [verify.<s>] table…`. Add the table, or drop the step.
- **A command that doesn't exist** — `[verify.<s>].command = "<c>" does not name
  a key in [commands]…`. The `command` field is a reference into `[commands]`,
  not a shell string.
- **`needsServer` with no server** — `[verify.<s>].needsServer = true requires a
  [server] table (start, url)…`. Add `[server]` or set `needsServer = false`.

### I never configured `[tickets]` — where are my tickets going?

To `.autobuild/tickets`. Omitting `[tickets]` is not an error: it selects the
local file tracker, which needs no config and no secret. Look for
`triage/ ready/ doing/ done/` there, and see
[Ticket source and authentication](#ticket-source-and-authentication).

### `<repo>/autobuild.toml: not found`

You are not at the repo root. `ab dispatch` and `ab ticket create` read
`./autobuild.toml`.

### `tick: idle`, but I have tickets waiting

`tick: idle` means no ticket passed the dispatch gates. There is no error,
because nothing failed — the gates just didn't match. Work down the gates:

- **`readyState`** (required) — the ticket's state must match it. With the
  **file tracker** the state is its directory, so `readyState = "ready"` means a
  ticket in `triage/` never dispatches until you `mv` it into `ready/`. With
  **Linear** the match is exact and case-sensitive, so a value that isn't a real
  workflow-state name silently matches nothing — confirm it against your team's
  workflow.
- **`readyLabels`** — unset means the ticket source's own default (Linear:
  `["autobuild"]`; file: none). If you set it, every listed label must *also* be
  present, on top of `readyState`.
- **`capacity`** — blocked and paused builds still hold their slots. At
  `capacity = 1`, one escalated build stalls all new dispatch.
- **The spec gate** — a ticket missing `## Acceptance criteria` (with a list
  item) or `## Out of scope` is bounced to Triage and commented; that shows up
  as `tick: bounced=1`, not `idle`.

### Authentication failures

- **`LINEAR_API_KEY is not set — expected a Linear personal API key…`** — export
  it or put it in a local `.env`.
- **`linear claim: HTTP 401`** — the key is set but wrong. There is no
  preflight, so a bad key surfaces on first use, mid-tick.
- **`[tickets].source = "linear" requires teamKey…`** — add `teamKey` to
  `[tickets]`.
- **GitHub** failures surface as raw `gh` stderr. Fix them with `gh auth login`.
- **`missing bearer token` / `invalid or expired token`** — a remote `--store`
  needs `AB_TOKEN`.

### `ab-<name>: conflicted` on upgrade

```text
ab-plan: conflicted — local edits collide with the new default; kept your local
file (merge by hand against .agents/skills/.ab-pristine/ab-plan/SKILL.md)
```

Nothing was clobbered and no markers were written. Merge by hand against the
pristine record, then re-run `ab upgrade`. If you see `no pristine record and
local differs from the new default`, the skill predates the pristine record —
merge by hand, or run `ab init --force` to take the default and discard your
edits.

### `AB_STORE is not set`

```text
AB_STORE is not set — expected the store URL or local path. The runner sets
ambient auth for every session (D8, SPEC §8.1).
```

You ran an agent build-session command by hand. `ab init`, `ab upgrade`,
`ab ticket`, `ab dispatch`, `ab builds`, `ab build status`, `ab harvest status`,
and `ab help` work outside a build or harvest session; the rest
resolve their identity from the `AB_*` variables the runner sets. Don't set them
yourself — there is nothing an operator needs from those commands.

---

## Contributing

- [`docs/architecture.md`](docs/architecture.md) — the codebase map, the seams,
  and the development commands.
- [`SPEC.md`](SPEC.md) — the source of truth for the design and terminology.
- [`docs/spec-standard.md`](docs/spec-standard.md) — the definition of a
  buildable ticket.
