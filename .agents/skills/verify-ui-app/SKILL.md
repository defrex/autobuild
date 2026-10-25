---
name: verify-ui-app
description: Agent-verify step - inspect the operator web app's rendered frames as colour images. Invoked by the build-runner for verify:ui-app; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-ui-app <build>

The kernel selected this path-scoped step. Inspect the production views in
`packages/hosted-store-service/app/` against `DESIGN.md` and the applicable
pinned design references materialized by `ab context`. Do not decide applicability
again or edit product code. Parity means shared vocabulary and facts, not pixels.

1. Run `ab context`, then resolve `context_dir="${AB_CONTEXT_DIR:-.ab}"`
   (unset or empty falls back to `.ab`). Read the printed manifest, normally
   `"$context_dir/context.json"`, and its materialized inputs from that context
   directory. Follow printed or manifest-allocated paths when they differ;
   use allocated paths verbatim, without adding another context prefix.
   Quote variable-derived paths and reuse or recompute `context_dir` in later
   shell invocations. Read the materialized spec from the same context
   (normally `"$context_dir/spec.md"`) for capture-parity authorization.
   If the manifest lists guidance (normally `"$context_dir/guidance.json"`),
   this is an answered escalation for the retried verification: read it first
   and apply the guidance while performing the same capture and inspection below. If the
   file is absent, continue unchanged.
2. Read `DESIGN.md`: ANSI's Two Grounds, Semantic Type, Color Is State,
   Title First, Sign-off, Glyph, Square Rules, and Flowing Document rules apply.
   Both grounds use the exact packaged Atkinson Hyperlegible Next and
   JetBrains Mono fonts; host font substitution is not acceptable.
3. Run `bun run capture:web-dashboard`. It renders offline production views
   over deterministic dispatch models, writes `frames.json`, PNGs, HTML and
   `verify-report.md` under `.ab/web-dashboard-frames/`. It needs local Chromium
   (`CHROMIUM_BIN` may select it). A capture crash, omitted required fact,
   missing browser or unreadable PNG is a failure, never a skip.
4. Run `bun tools/capture-parity.ts`; when the manifest supplies
   `commitRange.base`, also run with `--base <commitRange.base>`. Record both
   baselines. The default merge base may predate inherited changes. Frames
   identical to the recorded starting revision are inherited evidence; every
   difference against that revision must be authorized by the spec. A failed
   capture or unexplained difference fails, and this comparison never relaxes
   visual criteria. Terminal frame differences, like web differences, must each
   be authorized by the spec against this build's recorded starting revision.
   Never loosen comparison.
5. Open **every PNG listed in frames.json**, including both grounds and both
   widths, with the image tool. Compare applicable reference views at 1440px
   and 390px. Check all generated checklist criteria: title and slug, current
   teal steps, quiet timing, square ruled controls, opaque account menu with
   Theme choices, readable sign-in and connect, complete red escalation plus
   explanation, full-bleed phone answers and full-width primary controls,
   amber merge consent on ground, no clipping, no fake loading facts, and
   visible focus/pending/disabled/error states. Static captures prove
   presentation, not hydrated theme interaction. Confirm no surface tab words
   in the signed-in control line and retain the multi-repository selector.
   In wide/narrow and dimmed handoff frames, both runtimes, mode and deadline
   wrap in flow; `(draining)` remains amber even on the unfocused row.
   The verify-stages wide and narrow frames in both grounds must show both
   running members in the existing pipeline row and identify a cancelled
   member as not run with its cause.
6. Append criterion-by-criterion observations and an explicit pass/fail to
   `verify-report.md`. Guidance may explain evidence but cannot waive a failed
   criterion. Record how answered guidance affected the capture, interpretation
   or verdict. No shadows, gradients, pills, icon sets or interface emoji; fixture
   transcript content is not an interface glyph. No status fills, nested row
   scroller, pinned shell, optimistic state or unconfirmed destructive write.
   Page numbers and app title remain open decisions, not grounds to invent UI.
7. Only if every criterion passes, attach **each reviewed variant** using its
   unique manifest id. Generate the commands from `frames.json`, never from a
   hardcoded one-ground list. Each entry supplies `id` and `pngPath`; invoke
   `ab artifact put web-dashboard-frame:<id>:png <pngPath> --attach` with
   structured process arguments, awaiting and checking each command. Then run:

   ```
   ab verdict pass --notes .ab/web-dashboard-frames/verify-report.md
   ```

   On failure attach nothing and terminate exactly once with:

   ```
   ab verdict fail --report .ab/web-dashboard-frames/verify-report.md
   ```

If capture fails before a report exists, create that report under the same
scratch directory with the command, error and missing evidence. Never designate
frames from a failed run. A prior build's visual differences are not themselves
failures; the spec and recorded ANSI rules define the verdict.
