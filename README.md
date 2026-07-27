<div align="center">

# Autobuild

**Tickets in, PRs out. No babysitting required.**

</div>

Every build runs headless, so ten tickets in flight cost the same 
attention as one. You groom tickets in, you review pull requests out. 
Agents do the work, and deterministic code keeps them honest.

![The autobuild dispatch dashboard with four builds in flight and an
observation harvest running](docs/assets/headline-wide.png)

## Groomed ticket in, reviewed PR out

Running several coding agents by hand doesn't scale well. Every session wants
prompts, permissions, and attention, and your focus becomes the ceiling.
With Autobuild, each build runs the whole loop headlessly and escalates only
when it is truly blocked. With attention off the critical path, throughput
is only limited by how fast you can write good tickets.

Headless is safe because the pipeline is deterministic code, not model
judgment. State lives in a typed, append-only event log, phase transitions
are owned by tested code, and every build leaves a queryable paper trail. Your
merge gates are never bypassed: a PR lands when your required checks and your
consent say it lands.

The loop also feeds itself. While building, agents record observations —
latent bugs, worthwhile refactors, follow-ups they noticed but rightly left
alone. A harvester distills them into proposed tickets and files them for
triage; approve one and it runs the same loop.

Every seam is an adapter: ticket sources (Linear, local files, or a configured
plugin), agent runtimes (Claude, Pi, or a configured plugin), the forge (GitHub
via `gh` or a configured plugin), workspaces, and the build store all sit behind
narrow interfaces. Trusted Bun plugins declared in `autobuild.toml` can register
third-party ticket, runtime, workspace, and forge adapters against the versioned
`autobuild/plugin-sdk` surface.

## Quickstart

You need [Bun](https://bun.sh), `git`, an authenticated
[`gh` CLI](https://cli.github.com) (`gh auth login`), and a logged-in
[`claude` CLI](https://code.claude.com/docs/en/setup) — the default agent
runtime.

<!-- release-install:start -->

```sh
bun add -g github:defrex/autobuild#v0.2.0
```

<!-- release-install:end -->

Then, from the repository you want built:

```sh
ab init
```

Runs a short setup survey, writes `autobuild.toml`, and vendors the `ab-*`
agent skills — see the [configuration reference](docs/configuration.md) for
every option.

```sh
ab dispatch
```

Starts the dispatcher, with the live dashboard on a TTY.

Now ask your coding agent for `/ab-spec`. The vendored skill interviews you
into a conforming ticket and files it; the dispatcher claims it, and the build
plans, implements, reviews, verifies, and opens a PR for you to merge.

## How it works

Every build moves through the same fixed pipeline:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

1. **spec** — the dispatcher claims a ready ticket, establishes the final
   spec, and cuts a branch. The spec is the contract for everything after.
2. **plan ⇄ plan-review** — a planner writes an implementation plan; an
   independent reviewer approves it or sends it back with findings.
3. **implement ⇄ code-review** — the same shape over commits: implement,
   review, revise. A finding that survives round after round escalates to
   you instead of looping forever.
4. **verify:\*** — your verification steps, in the order you declare them:
   shell commands judged by exit code, or agent verifiers that return a
   verdict.
5. **finalize** — the PR opens with an agent-written description and a summary
   of explicitly attached evidence, then any post-PR steps you've configured
   (changelogs, release notes) run failure-tolerant. A content-producing step
   commits selected files locally; the runner extends the open PR branch with
   a regular push. A no-op adds no commit, and a publication failure becomes a
   follow-up observation rather than failing the green build. Agent verifiers
   attach an exact screenshot, trace, or other artifact with
   `ab artifact put <kind> <file> --attach`; the PR always gets a pinned
   retrieval command, and configured public image hosting can also render
   images inline.
6. **epilogue** — the dispatcher watches the open PR. Conflicts route back
   through reconcile and re-verify; the build ends `merged` or `closed`.

Each phase is an agent session, but the pipeline itself is not agentic:
agents never decide what phase comes next, and outcomes are never inferred
from what a model printed. Every phase reports through a typed CLI into an
append-only event log, and tested code decides the transition. That log is
the build — kill the process at any point and the dispatcher resumes from
durable state, and every decision along the way stays queryable after the
fact.

The pipeline grammar is fixed on purpose; `verify:*` and `finalize:*` are the
extension points, declared per-repo in `autobuild.toml`. Post-step agents may
commit locally but never push or call the forge; publication stays
kernel-owned. For the seams and the reasoning behind them, see
[`docs/architecture.md`](docs/architecture.md) and [`SPEC.md`](SPEC.md).

### Observation harvesting

Builds notice things they shouldn't fix. An implementer that spots a latent
bug, a worthwhile refactor, or a missing follow-up outside its spec records a
structured observation (`ab observe`) and moves on — the insight is kept, and
scope creep stays out of the PR.

Observations accumulate per repository, and once enough pile up the
dispatcher runs a separate outer workflow — scan → synthesize ⇄ review →
file — that distills them into proposed tickets, deduplicated against work
already filed. Proposals land in triage with the reserved
`autobuild:proposal` label and never dispatch themselves: the label means
observation harvest created the ticket for human triage, not that Autobuild has
groomed or claimed it. Autobuild does not use this label as a readiness gate or
remove it; it is distinct from any configured or historical `autobuild` ready
label. You groom and ready proposals like any ticket you wrote yourself. Agents
propose; humans dispatch.

## Operating it

The loop starts before the dispatcher: every build is only as good as its
ticket. The vendored `/ab-spec` skill is the grooming surface — it interviews
you from an idea to a conforming spec, or takes a ticket someone else filed
and tightens it until it meets
[the standard](docs/spec-standard.md) the build process expects. Groom the
ticket, mark it ready, and it's dispatchable.

From there, `ab dispatch` on a TTY is the whole cockpit. Every build in flight is a row —
pipeline position, elapsed time, PR state — and a handful of keys cover the
day-to-day:

- **Enter** drills into the selected build's status, pipeline, blockers, and
  agent sessions. Select a session and press **Enter** again to read its
  deposited transcript; **Escape** steps back from the transcript or build.
- **`p`** pauses or resumes the selected build. On a blocked build it opens a
  feedback field instead: answer the escalation — or just press Enter to
  retry — and the build picks the phase back up with your guidance.
- **`m`** toggles durable auto-merge consent for the selected build. Gated
  branches use GitHub-native auto-merge, so your required checks still decide
  when it lands.
- On the header row, **`i`** gates ticket intake, **`m`** sets the auto-merge
  default for newly claimed builds, and **`h`** gates harvesting — all
  repository-wide, all durable across restarts.

![Answering a blocked build's escalation from the
dashboard](docs/assets/headline-interactive.png)

Nothing about the dashboard is load-bearing — `ab builds`,
`ab build status <slug>`, and
`ab harvest status` project the same durable state as text or `--json`, so a
pipe or a script sees exactly what you do.

`ab --version` reports the installed package, commit, and plugin API versions
from any directory. `ab upgrade` moves a Bun installation to the latest GitHub
Release and merges the new distribution's skill defaults into the current
repository, preferring your local customizations; `ab help upgrade` covers
exact-version selection, merge-only operation, and how local and global
installs differ.

## Learn more

- [`docs/spec-standard.md`](docs/spec-standard.md) — what makes a ticket
  buildable: the standard every dispatched spec must meet.
- [`docs/configuration.md`](docs/configuration.md) — the complete strict
  `autobuild.toml` schema and examples.
- [`autobuild.toml`](autobuild.toml) — this repository's own pipeline
  configuration, as a worked example of the config surface.
- [`docs/architecture.md`](docs/architecture.md) — how the design maps to the
  codebase: kernel, ports, processes, and stores.
- [`docs/remote-store-protocol.md`](docs/remote-store-protocol.md) — the
  complete HTTP server contract and BuildStore conformance instructions.
- [`SPEC.md`](SPEC.md) — the source of truth for the design and its
  terminology.
