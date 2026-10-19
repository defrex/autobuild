---
name: verify-website
description: Agent-verify step - inspect the marketing site's rendered frames against the approved reference screenshots. Invoked by the build-runner for verify:website; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-website <build>

You are a visual verifier for the marketing site in `packages/website/`. The
kernel has already decided this path-scoped step applies. Your job is to
compare the rendered site with the approved design in `design/website/`, using the complete capture inventory. Do not decide applicability again.

## Session shape

1. Run `ab context`. If it materializes `.ab/guidance.json`, this is an
   answered escalation for the retried verification: read it first and apply
   the guidance while performing the same capture and inspection below. If the
   file is absent, continue unchanged.
2. Run `bun run capture:website`. Chromium is required. Read
   `.ab/website-frames/verify-report.md` and `inventory.json`. Capture failure,
   a partial inventory, missing or unopenable PNG, or missing final motion
   evidence is a failure; attach nothing.
3. Read `.ab/spec.md`, `design/website/README.md` and
   `design/website/design-system.md`. Open **every** PNG named by the inventory
   with the image-capable file tool and every paired landing reference.
   Check still reduced-motion evidence and all 390px overflow results. Require
   start, midpoint and final samples at both widths for every marked animated
   figure; verify completion acknowledgement and visible state progression.
   Zero figures must be explicitly reported. Check landing seam and spacing
   measurements, portrait figures, clipping, copy, section order and colors.
4. Judge landing frames against their paired references. A deviation passes
   only if the build spec authorizes that particular change, the build-owned
   diff updates its matching reference PNG **and** `design/website/README.md`,
   and the capture matches the updated reference (with the font exception below).
   For this purpose only, inspect `git diff <base>..<head>` using the build-owned
   `commitRange.base` and `commitRange.head` from `.ab/context.json`, never HEAD~1. If context omits the range,
   fail for missing review evidence; do not guess a base. Read the previous
   reference from that base when necessary to establish what changed. A blanket
   reference refresh does not authorize unrelated changes. Never use the diff
   to recalculate applicability.
5. Judge docs and motion frames against the design-system tokens, type,
   layout and motion rules and the spec. Docs have no paired reference PNG.
   Append per-frame observations and an explicit verdict to the report's
   **Website visual verdict** section. Record the effect of any guidance.
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
  reference without the spec-authorized matching reference and README update above, when the page scrolls sideways at 390px, when the capture crashes,
  or when a PNG cannot be opened.
- **Fail** when no Chromium binary is available. That is a host setup problem
  for the operator, not a reason to skip: record the missing binary and
  `CHROMIUM_BIN` in the report and use the failing verdict.
- The page links web fonts and the capture runs offline, so a fallback typeface
  renders. A typeface-only difference, and the line wraps and page height it
  causes, is not a failure. Differing words, order, colors, or a clipped or
  overlapping layout is.
- Human guidance may clarify how to retry or interpret evidence, but it cannot
  change the criteria. Visible differences require the spec authorization and reference-update evidence above.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session
  exists.
- If the capture fails before creating the report, create it only under
  `.ab/website-frames/`, record the command, the error, and the missing
  evidence, then use the failing verdict.
- Do not edit site code or fix what you find. Report it through the failing
  verdict.
