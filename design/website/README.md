# Website design reference

The approved design for the Autobuild marketing site, exported from the Claude
Design canvas so builds can read it without access to claude.ai.

- `reference.html` is the page as designed, with the seam selector in its
  initial fully-local state. It renders on its own in a browser. Its markup is
  a design export, not implementation guidance.
- `reference-desktop.png` (1440px wide) and `reference-phone.png` (390px wide)
  and the corresponding `reference-desktop-remote.png` and
  `reference-phone-remote.png` were refreshed on 2026-10-19 using
  `bun run capture:website` from the implemented page for the approved
  project-pinned-install command-copy revision: `bun add -d --exact
  @defrex/autobuild`, `bun ab init`, and `bun ab dispatch`. The remote frames
  switch every seam to remote, with Codex selected as the runtime.
  All four frames were reviewed at their original widths; both phone probes
  reported scrollWidth 390 with innerWidth 390. The longer command wraps in
  the existing layout; no CSS, type, spacing, diagram, or hero assets changed.
  These frames include the existing real dashboard and responsive diagrams
  described below; `reference.html` remains the historical design export.
- The hero dashboard in the reference is drawn by hand and its steps and
  states do not match the product. The built page supersedes it with the
  real `ab dispatch` frame (`packages/website/src/hero-frame.txt`, captured
  from the scripted dashboard scenario), rendered as preformatted text in the
  reference's well; on narrow viewports that frame scrolls sideways inside
  its own container, as the design system allows for diagrams. The rest of
  the page still follows the reference.
- Below 720px each of the three remaining wide figures (pipeline, dispatcher,
  intake) is replaced by a portrait layout of the same content, so nothing
  scrolls sideways; at desktop width nothing changes. The pipeline runs top
  to bottom, the dispatcher shows one build-runner with stacked cards behind
  it above a full-width build store, and the intake lays its four sources in
  a 2×2 grid with the PM agent below.
- Sections are 288px apart at desktop width and 192px apart below 720px, with
  the same space after the last section. No horizontal rules appear anywhere.
  The pipeline section has no "inside one build-runner" caption, and the page
  closes on a single outlined "View on GitHub" button.
- `design-system.md` and `tokens.json` are the Autobuild design system the page
  is drawn in: palette, type scale, spacing, components, and diagram
  vocabulary.

Source canvas: https://claude.ai/artifact/44JujTnC3hfGby38ukT71J (version 33)
Design system: https://claude.ai/artifact/32vkyg5RhPFRmiMwEpinrT

## Reviewing reference updates

Landing deviations require specific authorization in the build spec, an update
to the matching reference PNG and this README in the build-owned diff, and a
capture matching the new reference. Review the previous approved reference when
needed; a blanket refresh does not authorize unrelated changes. The maintainer
reviews the integrated reference set before the website node lands.

Docs pages and motion samples are judged against `design-system.md` and the
build spec. The generated inventory includes every built docs HTML page at
1440px and 390px, reduced-motion still evidence, and start/midpoint/final samples
for marked animated figures. Every phone variant must pass overflow checks.
See [the capture protocol](../../tools/website-capture.md) for adapter and
inventory details. This tooling revision preserves all approved PNG bytes and
the approval history above.

## Pipeline motion (2026-10-19)

The pipeline plays once on first viewport entry: twelve 400ms beats visit spec,
plan, plan-review, plan (revision), plan-review (approval), implement,
code-review, implement (revision), code-review (approval), verify:*, finalize,
and merged. Each review return emphasizes its existing cyan connector. All
labels remain selectable, in place and fully visible. After 4,800ms the drawing
returns to its original colors; the native “Replay animation” word control stays
below it. Replay uses the same controller intended for the other figures.

The four `reference-*.png` baselines listed above continue to represent actual
reduced motion and remain byte-identical. Reduced motion and disabled JavaScript
show the original complete drawing with no replay control. The additional
`reference-desktop-motion-final.png`, `reference-phone-motion-final.png`,
`reference-desktop-remote-motion-final.png`, and
`reference-phone-remote-motion-final.png` record normal-motion completion with
the replay control visible. They come from the same capture adapter at 4,800ms;
they do not replace the reduced-motion baselines. `reference.html` remains the
historical design export.

Review evidence follows [the capture protocol](../../tools/website-capture.md):
one logical `pipeline` marker covers both responsive drawings. Capture seeks
the production timeline at 0, 2,400 and 4,800ms, and checks reduced-motion
stillness and 390px overflow. Separate Chromium playback checks exercise actual
viewport entry, both review returns, keyboard replay, rapid replay, breakpoint
changes, preference changes and the JavaScript-disabled fallback.
