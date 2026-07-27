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
plugin), agent runtimes (Claude, Codex, Pi, or a configured plugin), the forge (GitHub
via `gh` or a configured plugin), workspaces, and the build store all sit behind
narrow interfaces. Trusted Bun plugins declared in `autobuild.toml` can register
third-party ticket, runtime, workspace, and forge adapters against the versioned
`autobuild/plugin-sdk` surface.

## Quickstart

You need [Bun](https://bun.sh), `git`, an authenticated
[`gh` CLI](https://cli.github.com) (`gh auth login`), and the local
prerequisites for the agent runtime you select: Claude Code, Codex CLI, or Pi.
Init suggests only runtimes whose executable and/or provider authentication is
usable on your machine.

<!-- release-install:start -->

```sh
bun add -g github:defrex/autobuild#v0.2.0
```

<!-- release-install:end -->

Then, from the repository you want built:

```sh
ab init
```

Runs a short setup survey, writes an explicit runtime default to
`autobuild.toml`, and vendors the `ab-*` agent skills — see the
[configuration reference](docs/configuration.md) for every option.

```sh
ab dispatch
```

Starts the dispatcher, with the live dashboard on a TTY.

In your selected coding agent, invoke the ticket-grooming skill:

```text
/ab-spec I want to build a feature!
```

The agent asks the questions needed to produce a quality ticket and adds it
directly to your ticketing system. Using the skill to create tickets then
largely becomes your input workflow.

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
