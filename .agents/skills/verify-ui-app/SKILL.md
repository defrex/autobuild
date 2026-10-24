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

1. Run `ab context`. Read the manifest and any guidance before proceeding.
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
   baselines. Differences must be authorized by the spec. ANSI changes web
   pixels and adds light/dark variants; terminal frames must remain identical
   against this build's recorded starting revision. Never loosen comparison.
5. Open **every PNG listed in frames.json**, including both grounds and both
   widths, with the image tool. Compare applicable reference views at 1440px
   and 390px. Check all generated checklist criteria: title and slug, current
   teal steps, quiet timing, square ruled controls, opaque account menu with
   Theme choices, readable sign-in and connect, complete red escalation plus
   explanation, full-bleed phone answers and full-width primary controls,
   amber landing consent on ground, no clipping, no fake loading facts, and
   visible focus/pending/disabled/error states. Static captures prove
   presentation, not hydrated theme interaction.
6. Append criterion-by-criterion observations and an explicit pass/fail to
   `verify-report.md`. Guidance may explain evidence but cannot waive a failed
   criterion. No shadows, gradients, pills, icon sets or interface emoji; fixture
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
