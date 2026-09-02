# Autobuild v2

`Autobuild` is an agent-driven software-development lifecycle system that takes a groomed ticket through planning, implementation, review, verification, PR creation, conflict reconciliation, and merge. Humans are involved only for grooming and escalations.

## Start here

- `SPEC.md` is the source of truth for the design and terminology. Sections are decided unless marked `[OPEN]`.
- `docs/architecture.md` maps the specification to the codebase.
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
3. **Ingesters propose, humans dispatch.** Generated work must be groomed before it can leave Triage, unless a repository waives that gate for its own harvest through `[tickets].proposalState` — as this one does.
4. **Every step leaves a queryable paper trail.** Build metadata and artifacts belong in the BuildStore, not in the repository.
5. **Processes communicate only through durable state.** No private channel between Autobuild processes — kernel to operator UI, parent to child, kernel to sandbox. Liveness may be observed; work done is known only by reading the log.

The fixed pipeline is:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

Only `verify:*` and `finalize:*` are configurable extension points. Agents interact with build state only through the typed `ab` CLI; never infer outcomes from agent stdout. Git pushes and forge operations are kernel-side plumbing.

## Development conventions

- Keep tests colocated as `*.test.ts`; integration scenarios are in `packages/core/src/integration/`.
- Run `bun run check`, `bun test`, and `bun typecheck` before finishing changes.
- Preserve narrow port interfaces. New BuildStore adapters must pass the shared suite in `packages/core/src/store/contract.ts`.
- Validate every event write and derive status through `packages/core/src/kernel/reducer.ts`; events record facts, never derived state.
- Keep phase behavior centralized in `packages/core/src/kernel/phases.ts` and deterministic transitions in `packages/core/src/kernel/engine.ts`.
- Do not commit `.ab/`, `.autobuild/`, `.env`, build artifacts, or transcripts.
