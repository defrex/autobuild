<div align="center">

# Autobuild

**Tickets in, Product out.**

</div>

Autobuild runs coding agents through a fixed pipeline that plans, implements,
reviews, and verifies every ticket before it merges. You groom tickets in and
review pull requests out; agents do the work, and deterministic code keeps
them honest.

![The autobuild dispatch dashboard with four builds in flight, each partway
through the pipeline](docs/assets/headline-wide.png)

## Quickstart

You need [Bun](https://bun.sh), `git`, and the local prerequisites for the
agent runtime you select: Claude Code, Codex CLI, or Pi. The GitHub forge also
needs an authenticated [`gh` CLI](https://cli.github.com) or an exported
`GITHUB_TOKEN`/`GH_TOKEN`; the local-git forge needs no account or remote.

From the repository you want built, install Autobuild as a development dependency:

<!-- release-install:start -->

```sh
bun add -d --exact @defrex/autobuild@1.0.1
```

<!-- release-install:end -->

Without a `package.json`, installation creates `package.json` and `bun.lock`,
which should be committed, with `node_modules/` ignored.

Run the repository-installed CLI:

```sh
bun ab init
```

This vendors the editable `ab-*` skills, writes a stack-neutral config, and
hands repository-aware setup to a coding agent. The
[configuration reference](docs/configuration.md) covers every field. Then
start the dispatcher and its live dashboard:

```sh
bun ab dispatch
```

Then groom your first ticket in your coding agent:

```text
/ab-spec add a retry budget
```

The agent asks the questions needed to produce a buildable ticket and files it
in your tracker. From then on, that skill is how work goes in.

## How it works

Finite [integration trees](docs/integration-tree.md) collect related work before merging it under your chosen policy.

### Work tickets run the pipeline

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

Each work ticket moves through deterministic phases inside its own build-runner.
Every phase is a fresh agent session, with artifacts knitting them together.

1. **spec** — the dispatcher claims a ready ticket, establishes the final
   spec, and cuts a branch. The spec is the contract for everything after.
2. **plan ⇄ plan-review** — a planner writes an implementation plan; an
   independent reviewer approves it or sends it back with findings.
3. **implement ⇄ code-review** — the same shape over commits: implement,
   review, revise. A finding that survives round after round escalates to
   you instead of looping forever.
4. **verify:\*** — your verification steps, in the order you declare them:
   shell commands judged by exit code, or agent verifiers that return a
   verdict and can attach evidence such as screenshots.
5. **finalize** — the PR opens with an agent-written description and the
   attached evidence, then any post-PR steps you've configured (changelogs,
   release notes) run.
6. **epilogue** — the dispatcher watches the open PR. Conflicts route back
   through reconcile and re-verify; the build ends `merged` or `closed`.

### A dispatcher spawns builds

The dispatcher claims ready tickets and starts a build-runner for each.
Runners are isolated, and all state is logged. Agents never decide what phase
comes next, and outcomes are never inferred from what a model printed: every
phase reports through a typed CLI into the event log, and tested code decides
the transition. That log is the build. Kill the process at any point and the
dispatcher resumes from durable state.

The pipeline grammar is fixed on purpose; `verify:*` and `finalize:*` are the
extension points, declared per repository in `autobuild.toml`. For the seams
and the reasoning behind them, see [`docs/architecture.md`](docs/architecture.md)
and [`SPEC.md`](SPEC.md).

## All local, all remote, or anywhere between

Every seam is an adapter you can customize for your project. The build
pipeline stays the same.

| Seam       | Decides               | Adapters                                   |
| ---------- | --------------------- | ------------------------------------------ |
| tickets    | where work comes from | local files, Linear, hosted, plugin        |
| dispatcher | what starts builds    | local process, scheduled (hosted)          |
| workspace  | where a build runs    | git worktree, Vercel Sandbox, plugin       |
| runtime    | who does the thinking | Claude Code, Codex, Pi, plugin             |
| forge      | where code merges     | local git, GitHub, plugin                  |
| store      | where state lives     | SQLite, Postgres, any HTTP store           |
| operators  | how you watch         | terminal, web UI, MCP                      |

Plugins are trusted Bun modules declared in `autobuild.toml` against the
versioned `@defrex/autobuild/plugin-sdk`. Teams that want one durable store
across hosts can deploy the optional
[hosted service](packages/hosted-store-service/README.md), which adds a
browser dashboard, a [scheduled dispatcher](docs/hosted-dispatcher.md), an
[operator API](docs/operator-api.md), and an [MCP server](docs/mcp.md).


## Built for throughput, not latency

One build may take longer than a chat with an agent. The trade is far more
changes merging every day, with much greater reliability.

- **File it and walk away.** Nothing in the pipeline waits on you. You don't
  approve tool calls, paste errors back, or watch a terminal. A build
  escalates to you only when it is truly blocked.
- **As many builds as you can groom.** Builds run side by side, each in its
  own workspace, up to the limit you set. Your attention stops being the
  ceiling; how fast you can write good tickets becomes the limit.

Headless is safe because the pipeline is deterministic code, not model
judgment. State lives in a typed, append-only event log, phase transitions
are owned by tested code, and every build leaves a queryable paper trail. Your
merge gates are never bypassed: a PR merges when your required checks and your
consent say it merges.

## Let the queue fill itself

Once tickets are the interface, anything that can write a ticket can put work
in front of you.

Builds feed the queue themselves. An implementer that spots a latent bug, a
worthwhile refactor, or a missing follow-up outside its spec records an
observation (`ab observe`) and moves on: the insight is kept, and scope creep
stays out of the PR. Once enough pile up, the dispatcher distills them into
proposed tickets, deduplicated against work already filed, and by default
files them into triage. You groom them like any ticket you wrote yourself.
Agents propose; humans dispatch.

Support threads, meeting notes, and error telemetry can feed it the same way.
An agent with the `ab` CLI or the MCP server can file tickets and answer
routine escalations, leaving you only the real product calls.

## Learn more

- [autobuild.run](https://www.autobuild.run) — the project site.
- [`docs/spec-standard.md`](docs/spec-standard.md) — what makes a ticket
  buildable: the standard every dispatched spec must meet.
- [`docs/configuration.md`](docs/configuration.md) — the complete strict
  `autobuild.toml` schema and examples.
- [`autobuild.toml`](autobuild.toml) — this repository's own pipeline
  configuration, as a worked example of the config surface.
- [`docs/architecture.md`](docs/architecture.md) — how the design maps to the
  codebase: kernel, ports, processes, and stores.
- [`packages/postgres-store/README.md`](packages/postgres-store/README.md) —
  serverless PostgreSQL persistence with S3-compatible or Vercel Blob storage.
- [`docs/remote-store-protocol.md`](docs/remote-store-protocol.md) — the
  complete HTTP server contract and BuildStore conformance instructions.
- [`SPEC.md`](SPEC.md) — the source of truth for the design and its
  terminology.

## License

[Apache License 2.0](LICENSE).

Deploy your own store and dashboard with the [hosted service setup](docs/hosted-service.md).
