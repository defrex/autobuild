---
name: build
description: Take a design at build/[feature]/design.md through plan → build → review → PR autonomously. If no design exists yet, writes a short one from your instructions and starts immediately — no /spec required for simple tasks. Infers the feature from the current branch's changes or your instructions. Launches bin/build.ts as a background OS process and reports status from state.json / build.log / NEEDS-INPUT.md.
argument-hint: "[feature-name] (optional)"
user-invocable: true
allowed-tools: Bash, Read, Write, Glob
---

# /build

Drive a design to a mergeable PR autonomously. The heavy lifting is a headless OS
process (`bun run bin/build.ts <feature>`) that survives independently of this
Claude Code session — launching it returns immediately and the build keeps running
even if the session ends.

This skill **resolves a feature, ensures a design exists, then launches and reports**.
All control flow (phase loops, harness routing, gates, escalation) lives in the
committed TypeScript orchestrator. See `build/build-flow/design.html` for the full design.

`/build` pairs with `/spec`: `/spec` is for designing a feature through conversation
before building. `/build` is for getting code shipped — if you've already approved a
`/spec` design it builds against it, and if you haven't it writes a short design from
your instructions and gets straight to work.

## Step 0 — Resolve the feature

Pick `FEATURE` (kebab-case), in priority order:

1. **Argument given** → use it verbatim.
2. **Your message describes what to build** (an instruction like "add a snooze button
   to todos") → derive a short, descriptive kebab-case name from it (e.g. `todo-snooze`).
   State the name you chose in one line so the user can correct it.
3. **Bare `/build` with no instruction** (checking in / resuming) → infer from existing
   work:
   - Enumerate candidate dirs that hold a design: `ls -d build/*/` and keep the ones
     containing a `design.md`.
   - If exactly one has a `design.md`, that's the feature.
   - If several do, narrow by the current branch name and changed paths
     (`git diff --name-only main...HEAD`, plus `git status --short`). Branch-name
     correspondence is the primary signal; treat weak path matches as inconclusive.
   - If you still can't confidently single one out, **stop and ask** which feature to
     build (list the candidates). Do not guess.

Let `DIR=build/$FEATURE`.

## Step 1 — Ensure a design exists

- **If `$DIR/NEEDS-INPUT.md` exists**, the previous run is **blocked on a human
  decision**. Read it, surface the blocker and the requested decision to the user, and
  stop — do not relaunch until they've resolved it and deleted the file. (See Step 4.)
- **If `$DIR/design.md` exists**, use it as the target (a human-approved `/spec` output,
  or one a prior `/build` wrote). Proceed to Step 2.
- **If `$DIR/design.md` does NOT exist**, write a **short** one from the user's
  instructions and proceed immediately — this is the no-`/spec`-needed path:
  1. Capture the user's intent faithfully and concisely. Size the doc to the task: a
     couple of sentences plus a short bullet list for something simple; only expand if
     the instruction itself carries real detail. Don't open a `/spec`-style
     conversation and don't pad with sections that add nothing.
  2. A minimal skeleton (drop any heading you have nothing to say under):

     ```md
     # [feature]

     ## Overview

     <one or two sentences: what to build and why, from the user's instruction>

     ## Notes

     - <any specific behavior, constraint, or file the user named>
     ```
  3. Write it to `$DIR/design.md`, then continue to Step 2.

  If the request is genuinely large or ambiguous, you may suggest the user run
  `/spec $FEATURE` first for a fuller design — but the default is to write the short
  design and build.

## Step 2 — Report existing status (if any)

If `$DIR/state.json` already exists, read it and report the current `phase`, `status`,
and `reviewRound`, plus the last ~20 lines of `$DIR/build.log`. This tells the user
where a prior run got to before you (re)launch.

## Step 3 — Launch in the background

Launch the orchestrator as a background process so it outlives the session:

```bash
bun run bin/build.ts "$FEATURE"
```

Run it with the Bash tool's background mode (`run_in_background: true`). Capture the
launch, then immediately report: "build started for `$FEATURE` — it runs headless to a
mergeable PR. Check back any time with `/build $FEATURE`."

Do **not** block waiting for it to finish. The orchestrator writes progress to
`$DIR/state.json` and `$DIR/build.log`; status is read from disk, not from the
launching process.

## Step 4 — Reporting status on a later invocation

When the user re-runs `/build $FEATURE` to check in:

1. Read `$DIR/state.json` → report `phase`, `status`, `reviewRound`.
2. Read the tail of `$DIR/build.log` → summarize what the latest phase did.
3. If `$DIR/NEEDS-INPUT.md` exists, the run **halted on a blocker**. Surface its
   contents prominently: the blocked phase, the reason, and what decision is needed.

   To resume: the user resolves the blocker (edits the relevant artifact in `$DIR/`,
   or writes their decision into `NEEDS-INPUT.md`), **deletes `NEEDS-INPUT.md`**, then
   re-runs `/build $FEATURE`. The orchestrator resumes from `state.json` — there is no
   separate resume path; resuming *is* re-running.
4. If `$DIR/observations.md` exists, mention how many out-of-scope notes the build
   agents jotted down (one `##` entry each) — a separate skill mines these into a
   backlog later. Don't act on them here.
5. If `status` is `done`, congratulate: the PR is mergeable and clean.

## Notes

- **Resumable state machine.** Every phase is a pure function of what's in `$DIR/` plus
  the repo. The pipeline is inspectable and resumable; the intermediate artifacts
  (`plan.md`, `plan-review.md`, `implementation.md`, `review/round-N.md`) are all files
  in the build dir.
- **Artifacts land in the PR automatically.** As the final action of a successful run,
  the orchestrator commits the whole `$DIR/` (including `build.log` and `state.json`) and
  pushes it to the PR branch — so a finished build leaves no uncommitted changes and the
  PR carries its own audit trail. The only exception is `$DIR/.build/` (transient runtime
  scratch: scoped MCP config, reviewer message buffer), which is gitignored. Because the
  commit must be the last write to the build dir, a push failure is reported on stderr
  rather than logged into `build.log`.
- **Out-of-scope observations.** The build and code-review phases append latent bugs,
  refactors, and tech debt they notice (but that don't belong in this feature) to
  `$DIR/observations.md` — an append-only backlog that never blocks the run. A separate
  skill mines it later; this skill only reports the count.
- **One worktree per run.** build operates on the current branch/worktree and does not
  manage worktrees — kick off each run in a dedicated worktree.
- **Harness routing** is configurable in `state.json` → `harnessMap` (default:
  claude/opus plans & builds, codex reviews).
- The orchestrator exits non-zero (code 2) when parked on a blocker, so a supervising
  process can notice; this skill detects the blocker via `NEEDS-INPUT.md`.
