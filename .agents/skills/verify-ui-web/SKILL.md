---
name: verify-ui-web
description: Agent-verify step - capture the Autobuild ANSI catalog and the `ab web` pages at both grounds and widths, enforce the cumulative layout shift bound, and judge the frames against DESIGN.md. Invoked by the build-runner for verify:ui-web; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-ui-web <build>

Large scratch belongs under the session's `.ab/` directory (prefer `$AB_CONTEXT_DIR`),
not `/tmp`: this includes ad-hoc PostgreSQL data/cluster directories, Cargo target
directories, browser profiles, and database copies. Configure `PGDATA`,
`CARGO_TARGET_DIR`, and explicit browser profile paths for those resources.
Keep `TMPDIR` outside the worktree for test suites and commands that discover
repositories or configuration through parent directories, including focused tests
and Git probes. Do not relocate required installed tooling or retained evidence;
manifest-directed artifact paths remain authoritative. Never commit scratch.

You are the visual and layout verifier for the Autobuild ANSI design system in
`packages/ui/` and the `ab web` UI it serves through `packages/core/src/web/`.
The kernel has already decided this path-scoped step applies. Do not decide
applicability again, and do not edit product code.

## Session shape

1. Run `ab context`, then resolve `context_dir="${AB_CONTEXT_DIR:-.ab}"`
   (unset or empty falls back to `.ab`). Read the printed manifest, normally
   `"$context_dir/context.json"`, and its materialized inputs from that context
   directory. Follow printed or manifest-allocated paths when they differ;
   use allocated paths verbatim, without adding another context prefix.
   Quote variable-derived paths and reuse or recompute `context_dir` in later
   shell invocations. Read the materialized spec (normally
   `"$context_dir/spec.md"`) and any pinned assets. If the manifest lists
   guidance (normally `"$context_dir/guidance.json"`), this is an answered
   escalation for the retried verification: read it first and apply it while
   performing the same capture and inspection below. If the file is absent,
   continue unchanged.
2. Read `DESIGN.md`. Two Grounds, Title First, Flowing Document, Square Rules,
   Stable Layout, Deliberate Transition, Reserved Space and the phone-width
   rules apply. No shadows, gradients, pills, icon sets or interface emoji.
   Both grounds use the packaged Atkinson Hyperlegible Next and JetBrains Mono
   faces; a host font substitution is a finding.
3. Run `bun run capture:ui-web` **alone, in the foreground**, and wait for it
   to exit. Allow at least **900 seconds**. A tool yield is progress, not
   completion. Never run it in the background, in parallel with another
   command, or as an overlapping retry. It needs local Chromium
   (`CHROMIUM_BIN` may select it).

   The capture builds the branch's `ab web` client in memory, serves it from
   the real web server over the scripted fixtures in
   `packages/ui/src/app/fixtures.ts` (no store; the analytics and timeline
   JSON routes answer from the same fixtures), builds the catalog, and loads
   each page in a fresh Chromium profile at the light and dark grounds and at
   1440 and 390 px: 12 pages, 48 variants. Build pages settle once their
   timeline has loaded, and `analytics*` pages once both charts have.
   `overview-live` publishes three live frames (an in-place state change, an
   attention item arriving near the top, rows moving between sections) and
   shows the final moved state; the other pages measure start-up. Each variant's cumulative layout shift is read
   before its screenshot. Outputs land in `.ab/ui-web-frames/`:
   `frames.json`, `verify-report.md` and the PNGs.
4. Read `.ab/ui-web-frames/verify-report.md` and `frames.json`. Each of these
   is a failure:
   - a capture failure: a nonzero exit with an **Infrastructure failure**
     section, or a missing report
   - a missing variant: fewer than 48 entries, or any page × ground × width
     absent
   - a missing or unopenable PNG or part
   - a multi-part entry whose `parts` are not `index` 1..`count` with rows
     contiguous from 0 to the entry's `height`
   - **any variant whose CLS exceeds 0.002**, the catalog's measured start-up
     baseline; quote its shift sources from the report
5. Open **every** PNG and part named by `frames.json` with the image-capable
   file tool. An entry with `parts` is one page shot in clipped row ranges:
   open its parts in `index` order and judge one page. A seam exactly at a part
   boundary is an artifact of the capture, but content must read continuously
   across it.
6. Judge the frames against `DESIGN.md` and the build spec; there are no paired
   reference PNGs for this UI. Check both grounds really differ, the packaged
   faces render, build pages show the intended build and its timeline (or the
   "not here" and unknown-address states), the analytics pages show the
   charts for their filters (`analytics-empty` its empty state), nothing
   scrolls sideways or clips at 390 px, and `overview-live` shows the moved
   state. Append observations for each
   acceptance criterion and each frame, plus an explicit verdict, to the
   report's **Visual verdict** section.
7. Only after every check passes, attach every variant, generating one call per
   entry from `frames.json` (one per part `id` for a multi-part entry), then
   pass:

   ```
   ab artifact put ui-web-frame:<id>:png <pngPath> --attach
   ab verdict pass --notes .ab/ui-web-frames/verify-report.md
   ```

   The capture never leaves a PNG over the store's artifact ceiling, so an
   upload rejection is a tooling failure to report, not a reason to drop
   evidence.

   On failure attach nothing, record each finding (variant, difference,
   location) in the report, then end exactly once:

   ```
   ab verdict fail --report .ab/ui-web-frames/verify-report.md
   ```

## Verdict rules

- **Fail** when no Chromium binary is available. That is a host setup problem
  for the operator, not a reason to skip: record the missing binary and
  `CHROMIUM_BIN` in the report and use the failing verdict.
- **Fail** on any CLS above 0.002. Do not rerun until a number passes, and do
  not reinterpret the window: the bound is the Stable Layout rule.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session
  exists.
- If the capture fails before writing the report, create it only under
  `.ab/ui-web-frames/`, record the command, the error and the missing
  evidence, then use the failing verdict.
- Human guidance may clarify how to retry or interpret evidence, but it cannot
  waive the CLS bound or a `DESIGN.md` rule.
- Visual-world decisions (a new world, a direction round, the open decisions
  `DESIGN.md` lists) stay with humans. Record such a need in the report; do not
  decide it.
- Fixture text is data, not interface glyphs: a character inside a fixture
  title or escalation is not an emoji or icon finding.
- Do not edit product code or fix what you find. Report it through the failing
  verdict.
