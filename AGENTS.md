# Autobuild

`Autobuild` is an agent-driven software-development lifecycle system that takes a groomed ticket through planning, implementation, review, verification, PR creation, conflict reconciliation, and merge. Humans are involved only for grooming and escalations.

## Start here

- `SPEC.md` is the source of truth for the design and terminology. Sections are decided unless marked `[OPEN]`.
- `docs/architecture.md` maps the specification to the codebase.
- `rfcs/` holds proposals for major design changes. An RFC is not decided
  design: `SPEC.md` describes the running system until a ticket that builds
  an RFC section amends it.
- `README.md` sells the project to engineers evaluating it — see
  "What the README is for" before adding anything to it.
- `autobuild.toml` is this repository's declarative pipeline configuration.

## Product versus this repository's configuration

Autobuild builds itself, so every change here wears exactly one of two hats.
Sorting out which is a top-level concern for any ticket, spec, or request:

- **The product** — what ships to every user: `packages/core/src/`, `bin/`, the canonical
  skill defaults in `skills/`, `templates/`, `SPEC.md`, `README.md`, and
  `docs/`. Nothing here may encode this repository's specifics — its
  dashboard-capture evidence, its Linear team, its verify steps.
- **This repository's configuration** — how we run autobuild on autobuild:
  `autobuild.toml`, the vendored editable skills in `.agents/skills/ab-*`,
  and the repo-local tooling they invoke. Our own e2e evidence capture
  belongs here, not in the product.

The `ab-*` skill namespace is reserved for skills the product ships and
`ab init` vendors. A skill that exists only to operate this repository and
will never reach a user gets a plain unprefixed name — `release`, not
`ab-release`.

Decide which hat the work wears before planning it, and write specs that name
the hat explicitly. If it is still ambiguous when work starts, escalate —
`ab escalate` in a build, a question to the user in a session — rather than
guessing. The cost asymmetry is known from experience: a repo-specific
concern hardcoded into the product took a dedicated ticket to unwind
(AUT-78), while a clarifying question costs minutes.

## Vendored skills are self-contained

Canonical skills in `skills/` must remain usable after `ab init` without access
to an Autobuild source checkout. Shared Autobuild-owned supporting material
belongs under `skills/guide/references/`; another canonical skill links to it
through the installed sibling `../ab-guide/` tree. Do not require an installed
skill to consult `SPEC.md`, source-only documentation, or internal implementation
paths. References to the consuming repository's own files and to public external
resources remain appropriate when the task calls for them.

When adding or changing a skill reference, keep its installed path valid and
update the checked-in public/reference copies together. The self-containment
coverage must be able to prove that every required Autobuild-owned local
reference is delivered in the collective `ab-*` install tree.

A canonical skill exists in three places in this repository, and a feature
build advances all three in the same commit: the source in `skills/`, the
vendored copy in `.agents/skills/ab-*`, and the pristine copy in
`.agents/skills/.ab-pristine/ab-*`. The pristine tree is not reserved for
upgrade tooling. `tools/vendored-skills-sync.test.ts` holds every copy to byte
parity with the canonical install form with no exception list, so a plan that
excludes `.ab-pristine` from a skill change is wrong and will fail verify.

Installed skills are what consuming agents read when deciding how to work, so a
stale skill sentence misleads more than stale code. Any change that alters
product behavior must update every installed skill and `ab-guide` reference
that describes that behavior, in the same commit. Plans search `skills/` for
the changed concept and name each passage to revise or confirm. Plan and code
reviewers treat a missed passage as a blocking finding. Increment language
such as "currently", "in this increment", or "unchanged for now" is the usual
symptom: when a later ticket finishes the work, the sentence has to go. A
duplicated skill passage is also a trap, because one copy gets updated and the
other doesn't. AUT-883 exists because `ab-spec` kept telling agents node
tickets were intent-only after `ab-tickets` had been corrected.

## What the README is for

`README.md` is marketing material for engineers: enough to understand what
Autobuild does, see it working, and decide whether to start using it. Keep it
short and scannable. It is not the manual, and it is not where a feature gets
documented because the feature was just built.

Everything else has a different home:

- **Reference and operational detail** → `docs/`. The complete config surface,
  protocols, architecture — anything a user needs *after* deciding to adopt.
- **Anything primarily for agents** → the `ab-guide` skill, which is where
  agents look first.
- **Maintainer procedures for this repository** → a repo-local skill in
  `.agents/skills/`, unprefixed, with a matching `.claude/skills/` symlink.
  Cutting a release lives in the `release` skill, not in the README.

Do not expand the README with per-flag behavior, failure modes, CLI surface
that `ab help <command>` already covers, or maintainer-only procedures. When a
change produces new detail, decide which of those three homes it belongs in;
the README is the right answer only when a first-time reader needs it to
evaluate the project. Prefer a one-sentence description plus a link over a
paragraph.

## Core design rules

1. **Judgment in skills, determinism in code.** Agents plan and review; tested code owns state, transitions, gating, deduplication, and plumbing.
2. **Resumption comes from durable state.** Build state is reduced from a typed, append-only event log; snapshots are never authoritative.
3. **Ingesters propose, humans dispatch.** Generated work must be groomed before it can leave Triage, unless a repository waives that gate for its own harvest through `[tickets].proposalState`. This one keeps the gate.
4. **Every step leaves a queryable paper trail.** Build metadata and artifacts belong in the BuildStore, not in the repository.
5. **Processes communicate only through durable state.** No private channel between Autobuild processes — kernel to operator UI, parent to child, kernel to sandbox. Liveness may be observed; work done is known only by reading the log.

The fixed pipeline is:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

Only `verify:*` and `finalize:*` are configurable extension points. Agents interact with build state only through the typed `ab` CLI; never infer outcomes from agent stdout. Git pushes and forge operations are kernel-side plumbing.

## Store read cost is a correctness property

Flooding the database with reads is this project's most frequently recurring
production failure. Each wave fixed the surface that was flooding, and the
next wave came from a surface or an interaction nobody had budgeted:

- September 2026: web dashboard polls replayed the journal, about $2k of
  Neon egress.
- AUT-749: the interactive dashboard re-read the run tail every 500 ms.
- AUT-775: an unscoped `GET /builds` ran on every poll.
- AUT-1011: an older client rejected the server's reduced value and replayed
  the whole journal on every hot-upgrade probe, about 150 GB/day from one
  idle project.

Every change is held to these rules:

- **Recurring work has bounded cost.** Anything that runs per poll, tick,
  request, invocation, or process start must cost the same at 100 events and
  at 100,000, and must read zero event rows while nothing changes. A read whose
  cost grows with log length, build count, or project count is a bug, however
  fast it is today.
- **Full-log reads are for explicit history requests only.** Reading a build
  or repository log from the start is acceptable when an operator asked for
  history. It is never acceptable as a cold start, a fallback, a recovery path,
  or a cache miss on a recurring path.
- **The server's reduced value is canonical.** A remote client never rebuilds
  a value from the event log that the server already answered. When client
  and server cannot agree, the read fails with a typed error; it never falls
  back to downloading events.
- **Account for fresh processes and many projects.** A per-process cache does
  nothing for a process spawned on every poll. Multiply idle cost by hundreds
  of hosted projects, each pinned to its own release against a server deployed
  from main.

Plans name every recurring read they add or change, with its cost per
occurrence and how often it occurs. Plan and code reviewers treat an unbounded
recurring read, or a client-side reconstruction of server state, as a blocking
finding. Prove the bound by extending the existing in-memory read-budget
harnesses in `packages/core/src/testing/`, not with new suites, Postgres, or
long-running processes: every test runs on every build forever.

## The orchestrator is an external agent

The orchestrator files tickets, watches builds, unblocks them, and drives
work to merge. It is a role an operator's own agent takes on, never something
Autobuild hosts or starts:

- **Locally**, it is any agent harness loaded at the repository root, driving
  Autobuild through the `ab` CLI (`ab watch` / `ab wait` to monitor, `ab answer`,
  `ab ticket`, and so on).
- **When the web server is configured**, it is any agent running anywhere,
  connected through the MCP connector and calling the operator tools.

In interactive sessions at the repository root, run the CLI from source as
`bun bin/ab.ts`, never a global `ab`. This checkout does not install `@defrex/autobuild` as a dependency, and a
global install can be a different version from the one the dispatcher runs.
That includes long-running `watch` and `wait` monitors.

Inside a build session, identified by nonblank `AB_BUILD` and `AB_SESSION`
environment variables, use plain `ab` on the runner-prepared `PATH`, never
`bun bin/ab.ts` from the worktree. This applies to context, artifacts, phase
terminals (`done` and `verdict`), observations, escalations, and permitted
status queries. The runner supplies its own distribution's launcher; a build
branch's CLI can lag the runner's event schema and fail to read its writes.

There is no orchestrator setup step, and no human has to start it. The embedded
hosted turn runner (AUT-342) is an abandoned direction, removed by AUT-658;
do not extend it, and do not cite SPEC §7.1.2 as current design.

## Self-hosting dispatcher updates

This repository's dispatcher runs in `source` mode. It polls authoritative
origin `main` immediately and every 60 seconds, prepares an immutable runtime
from the selected commit, and preflights compatibility before handing off.
Feature branches, checkout HEAD and local main do not select the upgrade target.
Not every merge changes packaged runtime content, so not every merge causes a
handoff. Old sessions drain while the successor dispatches; durable work
continues at phase boundaries on the accepted runtime. Preparation failures
retain the running generation and raise attention. Repeated successor failures
can roll back to the previous runtime and hold the failed target; inspect
repository status for failure and rollback evidence.

**One-time adoption:** after the hot-upgrade node lands, a maintainer must
restart once through the launcher entry below. Thereafter a manual restart is
needed for a launcher contract change, or when `[upgrade].automatic = false`
disables automatic upgrades. Ordinary kernel, event and reducer merges are
handled by automatic upgrades.

**Maintainers only:** stop the foreground launcher with Ctrl-C, or send SIGTERM
to its known process, and wait for graceful shutdown and drain to finish.
Then run `git pull` at the canonical main repository root and start again with
`bun tools/dispatcher-start.ts`, retaining your usual dispatch flags. This entry
uses the public binary's product launcher. Never pull the repository-root
checkout while the older dispatcher is still running. Never substitute a
force-kill for a clean stop. A clean stop suspends live sessions; restarting
resumes durable work without manually resetting or requeuing builds.

**Agent-safe read-only diagnosis (interactive repository-root sessions):** run
`bun bin/ab.ts repository status --json` and `bun tools/dispatcher-check.ts`.
The check reports the authoritative held generation's runtime version/commit,
upgrade mode, active handoffs (including a predecessor still draining), failure
and rollback history, and the effective rollback hold, alongside checkout HEAD
and local main. It compares the recorded current runtime commit and prints
useful diff/log commands. A difference alone does not require restart. Local
main need not equal remote main; checking remote freshness requires a fetch.

Local launch records under ignored `.autobuild/dispatcher-starts/` identify the
launcher ancestor, whose starting SHA is not the current generation's revision.
Process ancestry, boot and PID identity checks are separate diagnostic evidence.
Legacy starts without records, foreign hosts, or inaccessible process data make
that correlation unavailable without erasing a durably recorded held runtime.
An unrecorded runtime, unknown commit or missing Git object stays unknown; no
held dispatcher means no claim of a current generation. Concurrent generation
or upgrade changes request a retry. Launch records are local diagnostic evidence,
not product lifecycle state.

Orchestrating agents diagnose and report attention or a required maintainer
restart, following the installed `ab-operate` Boundaries section. They never
run the start entry, `ab dispatch`, dispatcher stop/start/restart commands, or
dispatcher signals themselves. An agent may read or fetch as authorized; it
must never pull the live root checkout or manage its process. Implementation
and verification of this tooling must not restart the live dispatcher.

## Development conventions

- Keep tests colocated as `*.test.ts`. Unit tests never need a database; a test that does is an integration test named `*.integration.test.ts`, run by `bun run test:integration` with `AB_POSTGRES_TEST_URL` set and skipped by `bun run test`. In-memory end-to-end scenarios are in `packages/core/src/scenarios/`.
- Run `bun run check`, `bun run check:build`, `bun run test`, and `bun typecheck` before finishing changes.
- Preserve narrow port interfaces. New BuildStore adapters must pass the shared suite in `packages/core/src/store/contract.ts`.
- Validate every event write and derive status through `packages/core/src/kernel/reducer.ts`; events record facts, never derived state.
- Keep phase behavior centralized in `packages/core/src/kernel/phases.ts` and deterministic transitions in `packages/core/src/kernel/engine.ts`.
- Do not commit `.ab/`, `.autobuild/`, `.env`, build artifacts, or transcripts.

## Working on the dashboards

Two frontends read the same event log: the terminal dashboard in
`packages/core/src/cli/dashboard/` and the operator web app in
`packages/hosted-store-service/app/`. Both are
product code, and the web app has a recorded design system. Any change under
`packages/hosted-store-service/app/**` is design work as well as engineering work:

- **Invoke the `impeccable` skill before editing UI.** Run
  `.agents/skills/impeccable/scripts/impeccable context --target <file>` from
  the repository root (`.claude/skills/impeccable` is the same skill for the
  Claude harness). It loads `PRODUCT.md`, `DESIGN.md`, and the surface brief;
  follow its directives and load `reference/craft-floor.md` before writing UI
  code. Use its refinement commands (`polish`, `adapt`, `harden`, `clarify`,
  `critique`, `audit`) as the task calls for them.
- **`DESIGN.md` is the visual authority.** Extend the recorded system through
  the tokens in `packages/hosted-store-service/app/globals.css`, the typography, structural rules, and named rules in `DESIGN.md`. Never
  add a shadow, a gradient, an icon set, or an emoji glyph.
- **Visual-world changes are human decisions.** Replacing the recorded world,
  running a direction round, or opening a decision page (`shape` of a new
  surface, `bolder`, `overdrive`, `live`, or a redesign) needs a human at the
  table and is never done inside an unattended build. Record the need with
  `ab observe` or stop with `ab escalate`. The open decisions listed in
  `DESIGN.md` (page numbers) stay open until a human closes them in a ticket.
- **Prove it with pixels.** `bun run capture:web-dashboard` renders the real
  views over the scripted dispatch models and screenshots them with a local
  Chromium into `.ab/web-dashboard-frames/`; open every PNG before finishing.
  The `ui-app` verify step runs the same capture through the
  repository-local `verify-ui-app` skill for any build that touches
  `packages/hosted-store-service/app/**`. The terminal dashboard keeps its own `ui-tui` step and
  `readme-headline` check.
- **Parity is the vocabulary, not the pixels.** A change to what a row says
  belongs in the shared projection under `packages/core/src/cli/dashboard/`,
  never in one frontend alone; presentation may differ, terms may not.

Design tickets name the surface and the states they touch, cite the `DESIGN.md`
rule they extend, and say which open decision, if any, a human has already
made. Live sign-in works only on the production origin, so review evidence
comes from the capture, not from a preview deploy.

## Documentation verification selection

Plans with explicit `verifySteps` selections must retain `docs` whenever product
paths change, and conservatively when uncertain. Omit selection frontmatter to
keep all configured steps as the safe default. The repository's path rules skip
`docs` for configuration-only changes.
