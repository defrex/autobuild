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

Every seam is an adapter: ticket sources (Linear or local files), agent
runtimes (Claude or Pi), the forge (GitHub via `gh`), workspaces, and the
build store all sit behind narrow interfaces. Trusted Bun plugins declared in
`autobuild.toml` can register third-party ticket, runtime, workspace, and forge
adapters against the versioned `autobuild/plugin-sdk` surface. Third-party
ticket sources are selectable for dispatch, harvest, completion, and every
`ab ticket` operation. The root `forge` setting and `[workspace].provider`
likewise select registered adapters (`github` and `git-worktree` by default);
agent-runtime selection will follow. BuildStore is deliberately excluded from
in-process plugins: its extension surface is the documented
[remote HTTP protocol](docs/remote-store-protocol.md), so an independent server
can use any language or storage.

Inspect and certify configured integrations from the repository root:

```sh
ab plugin list
ab plugin doctor
ab plugin test ticket-source jira
# Only for a manifest descriptor explicitly marked live:
AB_RUN_LIVE_PORT_CONTRACTS=1 ab plugin test forge gitlab
```

`list` shows builtin and plugin registrations, module resolution, API
compatibility, and contract availability. `doctor` reports every configured
module rather than stopping at the first failure. `test` runs the port's shared
Bun contract suite and returns its exact status; live fixtures never run without
the explicit environment opt-in.

## Quickstart

You need [Bun](https://bun.sh), `git`, and the
[`gh` CLI](https://cli.github.com) authenticated (`gh auth login`). Agent
sessions authenticate through the Claude Agent SDK's own credentials; add
`LINEAR_API_KEY` only if you use Linear tickets.

```sh
# No published package yet — link `ab` from a clone
git clone git@github.com:defrex/autobuild.git && cd autobuild
bun install && bun link
```

Then, from the repository you want built:

```sh
ab init
```

This writes `autobuild.toml` — with verify steps pre-filled from your
`package.json` scripts — and vendors the `ab-*` agent skills. The default
ticket source is a local file tracker in `.autobuild/tickets/`. See the
[configuration reference](docs/configuration.md) for the complete surface.

Write a ticket that says what and why, with acceptance criteria and an
out-of-scope list (the `/ab-spec` skill will interview you into one), then
mark it ready:

```sh
ab ticket create "Throttle repeated failed logins" --body spec.md
ab ticket move file-1 Ready
```

Start the dispatcher:

```sh
ab dispatch
```

On a TTY you get the dashboard above. The build plans, implements, reviews
its own code, verifies, and opens a PR. Review and merge it yourself — or
press `m` on the build row and let it land when your checks pass.

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
already filed. Proposals land in triage and never dispatch themselves: you
groom and ready them like any ticket you wrote yourself. Agents propose;
humans dispatch.

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

- **`p`** pauses or resumes the selected build. On a blocked build it opens a
  feedback field instead: answer the escalation — or just press Enter to
  retry — and the build picks the phase back up with your guidance.
- **`m`** toggles durable auto-merge consent for the selected build. Gated
  branches use GitHub-native auto-merge, so your required checks still decide
  when it lands.
- On the header row, **`p`** gates ticket intake, **`m`** sets the auto-merge
  default for newly claimed builds, and **`h`** gates harvesting — all
  repository-wide, all durable across restarts.

![Answering a blocked build's escalation from the
dashboard](docs/assets/headline-interactive.png)

Nothing about the dashboard is load-bearing — `ab builds`,
`ab build status <slug>`, and
`ab harvest status` project the same durable state as text or `--json`, so a
pipe or a script sees exactly what you do.

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
