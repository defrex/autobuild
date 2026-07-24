# Autobuild v2

`Autobuild` is an agent-driven software-development lifecycle system that takes a groomed ticket through planning, implementation, review, verification, PR creation, conflict reconciliation, and merge. Humans are involved only for grooming and escalations.

## Start here

- `SPEC.md` is the source of truth for the design and terminology. Sections are decided unless marked `[OPEN]`.
- `docs/architecture.md` maps the specification to the codebase.
- `README.md` is the user-facing guide: install, configure, operate.
- `autobuild.toml` is this repository's declarative pipeline configuration.

## Product versus this repository's configuration

Autobuild builds itself, so every change here wears exactly one of two hats.
Sorting out which is a top-level concern for any ticket, spec, or request:

- **The product** — what ships to every user: `src/`, `bin/`, the canonical
  skill defaults in `skills/`, `templates/`, `SPEC.md`, `README.md`, and
  `docs/`. Nothing here may encode this repository's specifics — its
  dashboard-capture evidence, its Linear team, its verify steps.
- **This repository's configuration** — how we run autobuild on autobuild:
  `autobuild.toml`, the vendored editable skills in `.agents/skills/ab-*`,
  and the repo-local tooling they invoke. Our own e2e evidence capture
  belongs here, not in the product.

Decide which hat the work wears before planning it, and write specs that name
the hat explicitly. If it is still ambiguous when work starts, escalate —
`ab escalate` in a build, a question to the user in a session — rather than
guessing. The cost asymmetry is known from experience: a repo-specific
concern hardcoded into the product took a dedicated ticket to unwind
(AUT-78), while a clarifying question costs minutes.

## Core design rules

1. **Judgment in skills, determinism in code.** Agents plan and review; tested code owns state, transitions, gating, deduplication, and plumbing.
2. **Resumption comes from durable state.** Build state is reduced from a typed, append-only event log; snapshots are never authoritative.
3. **Ingesters propose, humans dispatch.** Generated work must be groomed before it can leave Triage.
4. **Every step leaves a queryable paper trail.** Build metadata and artifacts belong in the BuildStore, not in the repository.

The fixed pipeline is:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

Only `verify:*` and `finalize:*` are configurable extension points. Agents interact with build state only through the typed `ab` CLI; never infer outcomes from agent stdout. Git pushes and forge operations are kernel-side plumbing.

## Codebase map

- `src/kernel/` — pure pipeline decisions, reducer, convergence/stall logic, server lifecycle.
- `src/events/` — event envelope, frozen payload schemas, actor and write validation.
- `src/store/` — BuildStore contract plus memory, local SQLite/blob, and remote HTTP implementations.
- `src/ports/` — swappable ticket, agent-runner, workspace, and forge adapters.
- `src/processes/` — crash-safe build runner and cron-friendly dispatcher/janitor.
- `src/cli/` and `bin/ab.ts` — the agent/store command channel and binary wiring.
- `skills/` — canonical phase skills vendored by `ab init` as namespaced `ab-*` skills.
- `docs/spec-standard.md` — minimum standard for dispatchable tickets.

## Development conventions

- Runtime/tooling: Bun, strict TypeScript ESM, Zod, Drizzle.
- Keep tests colocated as `*.test.ts`; integration scenarios are in `src/integration/`.
- Run `bun run check`, `bun test`, and `bun typecheck` before finishing changes.
- Preserve narrow port interfaces. New BuildStore adapters must pass the shared suite in `src/store/contract.ts`.
- Validate every event write and derive status through `src/kernel/reducer.ts`; events record facts, never derived state.
- Keep phase behavior centralized in `src/kernel/phases.ts` and deterministic transitions in `src/kernel/engine.ts`.
- Do not commit `.ab/`, `.autobuild/`, `.env`, build artifacts, or transcripts.
