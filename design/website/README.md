# Website design reference

The approved design for the Autobuild marketing site, exported from the Claude
Design canvas so builds can read it without access to claude.ai.

- `reference.html` is the page as designed, with the seam selector in its
  initial fully-local state. It renders on its own in a browser. Its markup is
  a design export, not implementation guidance.
- `reference-desktop.png` (1440px wide) and `reference-phone.png` (390px wide)
  are screenshots of `reference.html`. `reference-desktop-remote.png` and
  `reference-phone-remote.png` show the seam selector after switching every seam
  to remote, with Codex selected as the runtime.
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
