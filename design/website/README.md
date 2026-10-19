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
  closes on outlined "Getting started" and "View on GitHub" buttons.
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

## Documentation foundation reference revision

On 2026-10-19, the `website-docs-foundation` spec explicitly authorized a
Documentation link in the landing action area and a Getting started link in
the closing get-started section. The four landing reference PNGs now include
those two additions. GitHub access and all existing copy remain present;
`reference.html` stays the historical export. The added hero action wraps to
another row; subsequent sections shift with that added height. The closing
links also wrap at phone width. No unrelated landing styles or assets changed.

Evidence: `bun run capture:website` produced eight reviewed full-page PNGs:
local and remote landing states at 1440px and 390px, plus both docs pages at
both widths. The docs retain the broadcast palette, face and type scale in a
72ch reading column with above-content navigation. All four phone probes
reported scrollWidth 390 and innerWidth 390; every stylesheet loaded and
prose pages reported zero figures. Landing section gaps remain 288px desktop
and 192px phone, footer gaps match, and terminal-to-action spacing is 48px.
The keyboard skip link was also checked in Chromium: focused, visible at the
top of the viewport, with the existing 2px focus outline. The maintainer
reviews this integrated reference set before the website node lands.
## Pipeline motion (2026-10-19)

The pipeline plays once on first viewport entry: twelve 400ms beats visit spec,
plan, plan-review, plan (revision), plan-review (approval), implement,
code-review, implement (revision), code-review (approval), verify:*, finalize,
and merged. Each review return emphasizes its existing cyan connector. All
labels remain selectable, in place and fully visible. After 4,800ms the drawing
returns to its original colors; the native “Replay animation” word control stays
below it. Replay uses the same controller intended for the other figures.

The four `reference-*.png` baselines listed above continue to represent actual
reduced motion, including the documentation links from the foundation revision above. Reduced motion and disabled JavaScript
show the original complete drawing with no replay control. The additional
`reference-desktop-motion-final.png`, `reference-phone-motion-final.png`,
`reference-desktop-remote-motion-final.png`, and
`reference-phone-remote-motion-final.png` record normal-motion completion with
the replay control visible. They include those same documentation links and come from the same capture adapter at 4,800ms;
they do not replace the reduced-motion baselines. `reference.html` remains the
historical design export.

Review evidence follows [the capture protocol](../../tools/website-capture.md):
one logical `pipeline` marker covers both responsive drawings. Capture seeks
the production timeline at 0, 2,400 and 4,800ms, and checks reduced-motion
stillness and 390px overflow. Separate Chromium playback checks exercise actual
viewport entry, both review returns, keyboard replay, rapid replay, breakpoint
changes, preference changes and the JavaScript-disabled fallback.

## Dispatcher and intake motion (2026-10-19)

The dispatcher and intake now share the pipeline's one-shot viewport controller,
400ms beat, native Replay animation control, and static fallback. The dispatcher
uses four beats per ready ticket: claim, route, runner start, and state writes
through the CLI and phase-event paths. Earlier runners remain active as later
ones start. The phone drawing emphasizes its existing three stack layers and
common write paths for those same three starts. The intake uses three beats
per source: source filing, routing through the PM agent, and ticket delivery
along the existing route into the dispatcher. The human and escalation branch
remain unchanged. Both sequences finish at 4,800ms by removing every transient
attribute; labels stay selectable throughout.

Only the four `reference-*-motion-final.png` files were refreshed, with all
three production capture adapters sought to completion and all Replay controls
visible. The four reduced-motion landing references remain unchanged and match
the new capture pixel for pixel. Disabled JavaScript keeps the same complete
figures with hidden controls. `reference.html` remains the historical export.

`bun run capture:website` produced 44 reviewed PNGs: four reduced-motion landing
states, four docs frames, and 36 motion samples (three figures, three sample
times, two widths, local and remote seams). All stylesheets loaded, reduced-motion
frames were still, section spacing remained unchanged, and all 390px probes
reported scrollWidth and innerWidth of 390. Separate Chromium checks exercised
actual viewport entry, completion, no repeat on return, keyboard and rapid replay,
breakpoint changes, preference changes, and disabled JavaScript. Controller tests
also cover hidden-tab settling. No external runtime dependency was added.
