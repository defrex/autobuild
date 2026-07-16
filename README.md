# auto-build

auto-build takes a groomed ticket to an open pull request. It plans the work,
implements it, reviews its own code, runs your verification steps, opens the
PR, and reconciles conflicts against your base branch — as a sequence of agent
sessions driven by deterministic code. Once the PR lands, it records the merge
and closes the build out.

**auto-build does not merge your PRs.** It opens them and watches them; the
merge is yours (or your auto-merge rules'). The last word on what enters your
base branch stays with you.

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
   work: a ticket becomes dispatchable only once it carries your
   `[dispatcher].readyLabels`, and applying that label is a human act.
2. **Answering escalations** — the questions a build parks on rather than
   deciding alone.
3. **Reviewing and merging the PR.** auto-build opens it; you land it.

---

## How a build flows

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

1. **spec** — the dispatcher claims a ready ticket (one carrying your
   `readyLabels`) and imports its body as the build's spec. The spec is the
   contract for everything downstream.
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

The grammar is fixed. Only `verify:*` and `finalize:*` are configurable, and
they are declared per-repo in `autobuild.toml`. Verify steps come in two kinds:

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
| Agent runner | **`claude` only** (`@anthropic-ai/claude-agent-sdk`) |
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

- **auto-build never merges a PR.** It opens PRs and polls their state; a build
  reaches `merged` only after *you* (or an auto-merge rule) land it.
- **One dispatcher per repository.** Ticket claiming is read-check-write; it is
  safe only under that rule.
- **Capacity is per-repo.** `[dispatcher].capacity` defaults to 1. There is no
  global cap across repos sharing a store.
- **`ab dispatch` must run from the repo root** — it reads `./autobuild.toml`.
- **Merged builds are terminal.** A fixup on merged work is a new ticket, never
  a reopened build.
- **Tickets that fail the spec gate are bounced to Triage**, commented with
  what was missing. No build is created.
- **The dispatcher's `Triage`/`Done` state names are not configurable** via
  `autobuild.toml`.
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
| `[roles]` | Role → `{ runner, model? }`. Only `claude` is registered as a runner. | — |
| `[policy]` | `stallRounds`, `maxVerifyAttempts`, `maxReconcileAttempts`, `maxReviewRounds` | `3`, `3`, `3`, `5` |
| `[dispatcher]` | `capacity`, `readyLabels`, optional `readyState` | `1`, template sets `["autobuild"]` |
| `[server]` | Optional. `start` + `url` required; `readyTimeout` in seconds | `readyTimeout = 60` |
| `[tickets]` | Which ticket source to drive — see below | — |
| `[outer]` | Map of outer-loop process name → `{ cron = "…" }` | — |

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

### 3. Point at a ticket source and set up auth

The `[tickets]` table is what the dispatcher watches. Secrets never go in this
file.

**Linear:**

```toml
[tickets]
source = "linear"
teamKey = "ENG"                # required
claimedState = "In Progress"   # optional; this is the adapter's default
createState = "Triage"         # optional; absent = the team's default state
```

The API key comes from `LINEAR_API_KEY`, in your environment or a local `.env`.

**File-based** (no secret, useful for trying auto-build out):

```toml
[tickets]
source = "file"
dir = "tickets"          # required; resolved against the repo root
createState = "Triage"   # optional; "Triage" is the default
```

Tickets are `<id>.md` files with `+++`-fenced TOML frontmatter — `id`, `title`,
`state`, `labels`, and optionally `claimedBy` — followed by the body. A ticket
the dispatcher would pick up, at `tickets/file-1.md`:

```markdown
+++
id = "file-1"
title = "Throttle repeated failed logins"
state = "Ready"
labels = ["autobuild"]
+++

## What and why
…

## Acceptance criteria
- …

## Out of scope
- …
```

`ab ticket create` names the files it writes `file-<n>.md`; hand-written
tickets can use any id, as long as the filename matches it.

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
a spec with you and files or updates the ticket. It is the **only** vendored
skill a model may invoke on its own; every other `ab-*` skill is installed with
`disable-model-invocation: true` and is invoked by the runner or by you.

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
```

Each tick runs in this order:

1. **janitor** — polls open PRs; completes merged/closed builds, routes
   conflicted ones to `reconcile`, cleans up aborted builds.
2. **startup resume** — first tick of an invocation only; attempts every
   current build. Later ticks preserve deliberate policy parks.
3. **lease sweep** — re-attaches runners to builds whose lease went stale.
4. **dispatch** — claims and launches new work.

Dispatch gates a ticket in this order: **capacity** (blocked and paused builds
still hold a slot) → **`readyLabels`** (all must be present) and **`readyState`**
if set → **claim-before-launch** → the **spec gate**.

> **The label is the gate, not the state.** With the template's defaults
> (`readyLabels = ["autobuild"]`, `readyState` commented out), *any* ticket
> carrying the `autobuild` label is dispatchable no matter what state it sits
> in — including Triage. If you want a state gate too, set `readyState`. Treat
> applying the label as the act of saying "build this."

Each tick prints a report of its nonzero counters:

```text
tick: merged=1 dispatched=2
tick: idle          # every counter zero
```

Counters are `merged`, `closed`, `conflicted`, `abandoned`, `resumed`, `swept`,
`dispatched`, `authored`, `bounced`, and `claimRaces`.

---

## Command reference

### Operator commands

Run these yourself, from the repo root. They need no `AB_*` environment.

| Command | What it does |
|---|---|
| `ab init [target] [--force]` | Vendor the default `ab-*` skills and write `autobuild.toml`. `--force` overwrites edited skills only. |
| `ab upgrade [target]` | Three-way merge the vendored skills with the new defaults. See below. |
| `ab ticket create <title> --body <file> [--labels a,b]` | File a ticket to the configured `[tickets]` source. |
| `ab dispatch [--once] [--interval <s>] [--store <ref>]` | Run the outer loop for this repo. |
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
| `merged` | Both changed, but not in the same place; merged cleanly. |
| `conflicted` | Both changed the same lines. **Your local file is kept byte-for-byte** — no conflict markers are ever written into it. |
| `unknown` | An installed `ab-*` skill that is not in the distribution. Left alone; local additions are legitimate. |

`ab upgrade` never deletes anything.

**Resolving a conflict:** merge by hand against the pristine record —
`.agents/skills/.ab-pristine/ab-<name>/SKILL.md` holds the bytes you started
from. Upgrade keeps reporting `conflicted` on that skill until your live file
matches either the pristine record or the new default.

---

## State, paths, and environment

### Local state lives outside your repo

Under `~/.autobuild` by default:

| Path | Contents |
|---|---|
| `~/.autobuild/autobuild.sqlite` | Events and build records |
| `~/.autobuild/blobs/` | Content-addressed artifact blobs |
| `~/.autobuild/worktrees/<branch>/` | One git worktree per build; branches are `ab/<slug>` |

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
- `.autobuild/` — only if you point the store into the repo for local dev
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
  server, verify, finalize, roles, policy, dispatcher, tickets, outer`. Check
  for a typo; the file is strict on purpose.
- **A step with no table** — `verify step "<s>" is listed in verify.steps but
  has no [verify.<s>] table…`. Add the table, or drop the step.
- **A command that doesn't exist** — `[verify.<s>].command = "<c>" does not name
  a key in [commands]…`. The `command` field is a reference into `[commands]`,
  not a shell string.
- **`needsServer` with no server** — `[verify.<s>].needsServer = true requires a
  [server] table (start, url)…`. Add `[server]` or set `needsServer = false`.

### `autobuild.toml has no [tickets] table`

```text
autobuild.toml has no [tickets] table — 'ab dispatch' watches the configured
TicketSource for Ready tickets (§3.3); add [tickets] with source = "linear"
(teamKey = "…") or source = "file" (dir = "…")
```

The template ships `[tickets]` commented out. Uncomment and fill it in.
`ab ticket create` reports the same thing in its own words.

### `<repo>/autobuild.toml: not found`

You are not at the repo root. `ab dispatch` and `ab ticket create` read
`./autobuild.toml`.

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

You ran an agent build-session command by hand. Only `ab init`, `ab upgrade`,
`ab ticket`, `ab dispatch`, and `ab help` work outside a build session; the rest
resolve their identity from the `AB_*` variables the runner sets. Don't set them
yourself — there is nothing an operator needs from those commands.

---

## Contributing

- [`docs/architecture.md`](docs/architecture.md) — the codebase map, the seams,
  and the development commands.
- [`SPEC.md`](SPEC.md) — the source of truth for the design and terminology.
- [`docs/spec-standard.md`](docs/spec-standard.md) — the definition of a
  buildable ticket.
