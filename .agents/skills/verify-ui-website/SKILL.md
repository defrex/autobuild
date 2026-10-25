---
name: verify-ui-website
description: Agent-verify step - inspect the marketing site's rendered frames against the approved reference screenshots. Invoked by the build-runner for verify:ui-website; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-ui-website <build>

Large scratch belongs under the session's `.ab/` directory (prefer `$AB_CONTEXT_DIR`),
not `/tmp`: this includes ad-hoc PostgreSQL data/cluster directories, Cargo target
directories, browser profiles, and database copies. Configure `PGDATA`,
`CARGO_TARGET_DIR`, and explicit browser profile paths for those resources.
Keep `TMPDIR` outside the worktree for test suites and commands that discover
repositories or configuration through parent directories, including focused tests
and Git probes. Do not relocate required installed tooling or retained evidence;
manifest-directed artifact paths remain authoritative. Never commit scratch.

You are a visual verifier for the marketing site in `packages/website/`. The
kernel has already decided this path-scoped step applies. Your job is to
compare the rendered site with the approved design in `design/website/`, using the complete capture inventory. Do not decide applicability again.

## Session shape

1. Run `ab context`, then resolve `context_dir="${AB_CONTEXT_DIR:-.ab}"`
   (unset or empty falls back to `.ab`). Read the printed manifest, normally
   `"$context_dir/context.json"`, and its materialized inputs from that context
   directory. Follow printed or manifest-allocated paths when they differ;
   use allocated paths verbatim, without adding another context prefix.
   Quote variable-derived paths and reuse or recompute `context_dir` in later
   shell invocations.
   Read its materialized spec (normally `"$context_dir/spec.md"`) and pinned
   assets using their allocated paths. Require readable `commitRange.base`
   and `commitRange.head` revisions. When `nodeVerification` exists, read its
   `indexPath` and every contribution `specPath`; require the index `range` to
   agree with `commitRange` and its contribution identities, spec revisions,
   contribution commit lists and hand-pushed entries to agree with the manifest.
   Read the
   full `handPushedCommits` messages, retaining current `sha` and `originalSha`.
   Missing, unreadable or inconsistent required evidence is a failure; do not
   guess paths, specs, identities or another base. Empty contribution and
   hand-pushed lists are valid. If the manifest lists guidance (normally
   `"$context_dir/guidance.json"`), this is an
   answered escalation for the retried verification: read it first and apply
   the guidance while performing the same capture and inspection below. If the
   file is absent, continue unchanged.
2. Run `bun run capture:website`. Chromium is required. Read
   `.ab/website-frames/verify-report.md` and `inventory.json`. Capture failure,
   a partial inventory, missing or unopenable PNG, or missing final motion
   evidence is a failure; attach nothing.
3. Read the materialized spec, `design/website/README.md` and
   `design/website/design-system.md`. Open **every** PNG named by the inventory
   with the image-capable file tool and every paired landing reference.
   Check still reduced-motion evidence and all 390px overflow results. Require
   start, midpoint and final samples at both widths for every marked animated
   figure; verify completion acknowledgement and visible state progression.
   Zero figures must be explicitly reported. Check landing seam and spacing
   measurements, portrait figures, clipping, copy, section order and colors.
4. Judge landing frames against their paired references. A deviation passes
   only if that particular change has authorization: for a leaf, its build
   spec; for a node with `nodeVerification`, its node spec, the spec of the
   contribution that introduced it, or an identified hand-pushed maintainer
   commit. Use the index commit mapping and, as needed, history strictly within
   `commitRange.base..commitRange.head` to identify the introducing source. An
   unrelated child spec does not authorize it. Read a listed hand-pushed commit
   message as maintainer intent and judge quality and consistency; absence of a
   covering spec alone must not fail it. `unattributedCommits` alone is not
   hand-pushed authorization. The build-owned diff must also update its matching
   reference PNG **and** `design/website/README.md`, and the capture must match
   the updated reference (with the font exception below).
   For this purpose only, inspect `git diff <base>..<head>` using the build-owned
   `commitRange.base` and `commitRange.head` from the manifest resolved in step 1,
   never HEAD~1. If context omits the range,
   fail for missing review evidence; do not guess a base. Read the previous
   reference from that base when necessary to establish what changed. A blanket
   reference refresh does not authorize unrelated changes. Never use the diff
   to recalculate applicability.
5. Judge docs and motion frames against the design-system tokens, type,
   layout and motion rules and the intended behavior from the spec and, for
   nodes, the introducing sources above. Docs have no paired reference PNG.
   Append per-frame observations and an explicit verdict to the report's
   **Website visual verdict** section. For each landing deviation, identify the
   authorizing spec/build/revision (including the node spec when used), or the
   hand-pushed SHA, original SHA and full message, and explain how it covers the
   change. If none covers it, explain the missing authorization. Record missing
   or inconsistent provenance evidence and the effect of any guidance.
6. Only after every frame passes, attach **every reviewed frame**, using each
   inventory descriptor's safe unique `id` and corresponding PNG:

   ```
   ab artifact put website-frame:<id>:png .ab/website-frames/<id>.png --attach
   ab verdict pass --notes .ab/website-frames/verify-report.md
   ```

   On failure attach nothing, record each missing frame or finding (frame,
   difference and location), then end exactly once:

   ```
   ab verdict fail --report .ab/website-frames/verify-report.md
   ```

## Verdict rules

- **Fail** when copy, section order, colors, or layout differ from the
  reference without the applicable leaf or node authorization, matching reference
  and README update, and matching capture required above, when the page scrolls
  sideways at 390px, when the capture crashes,
  or when a PNG cannot be opened.
- **Fail** when no Chromium binary is available. That is a host setup problem
  for the operator, not a reason to skip: record the missing binary and
  `CHROMIUM_BIN` in the report and use the failing verdict.
- The page links web fonts and the capture runs offline, so a fallback typeface
  renders. A typeface-only difference, and the line wraps and page height it
  causes, is not a failure. Differing words, order, colors, or a clipped or
  overlapping layout is.
- Human guidance may clarify how to retry or interpret evidence, but it cannot
  change the criteria. Visible differences require the applicable leaf or node
  authorization and reference-update evidence above. A hand-pushed source does
  not waive visual quality, reference evidence or capture matching.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session
  exists.
- If the capture fails before creating the report, create it only under
  `.ab/website-frames/`, record the command, the error, and the missing
  evidence, then use the failing verdict.
- Do not edit site code or fix what you find. Report it through the failing
  verdict.
