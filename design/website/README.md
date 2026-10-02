# Website design reference

The approved design for the Autobuild marketing site, exported from the Claude
Design canvas so builds can read it without access to claude.ai.

- `reference.html` is the page as designed, with the seam selector in its
  initial fully-local state. It renders on its own in a browser. Its markup is
  a design export, not implementation guidance.
- `reference-desktop.png` (1440px wide) and `reference-phone.png` (390px wide)
  are screenshots of `reference.html`. `reference-desktop-remote.png` shows the
  seam selector after switching every seam to remote, with Codex selected as the runtime.
- Sections are 288px apart at desktop width and 192px apart below 720px, with
  the same space after the last section. No horizontal rules appear anywhere.
  The pipeline section has no "inside one build-runner" caption, and the page
  closes on a single outlined "View on GitHub" button.
- `design-system.md` and `tokens.json` are the Autobuild design system the page
  is drawn in: palette, type scale, spacing, components, and diagram
  vocabulary.

Source canvas: https://claude.ai/artifact/44JujTnC3hfGby38ukT71J (version 31)
Design system: https://claude.ai/artifact/32vkyg5RhPFRmiMwEpinrT
