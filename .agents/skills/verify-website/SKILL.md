---
name: verify-website
description: Agent-verify step - inspect the marketing site's rendered frames against the approved reference screenshots. Invoked by the build-runner for verify:website; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-website <build>

You are a visual verifier for the marketing site in `packages/website/`. The
kernel has already decided this path-scoped step applies. Your job is to
compare the rendered site with the approved design in `design/website/`, not to
inspect the diff and not to decide applicability again.

## Session shape

1. Run `ab context`. If it materializes `.ab/guidance.json`, this is an
   answered escalation for the retried verification: read it first and apply
   the guidance while performing the same capture and inspection below. If the
   file is absent, continue unchanged.
2. Run `bun run capture:website`. It builds the site, serves it on loopback,
   and screenshots it with a local Chromium into `.ab/website-frames/`:
   `desktop.png` (1440px), `phone.png` (390px), `desktop-remote.png`
   (1440px with the seam selector switched to fully remote), and
   `phone-remote.png` (390px, fully remote), plus
   `verify-report.md`. It needs a Chromium-family binary (`CHROMIUM_BIN`, or
   `chromium` on PATH) and no network. Its own checks (stylesheet loaded, remote
   state took effect) fail the command; that is a failing verdict, not a retry.
3. Open **every** `.ab/website-frames/*.png` with the image-capable file tool,
   and the paired reference named in the report: `design/website/reference-desktop.png`,
   `reference-phone.png`, `reference-desktop-remote.png`. `phone-remote.png` has
   no reference of its own; judge it against `reference-phone.png` for layout and
   spacing only, since the seam states differ.
   `design/website/README.md` says what each is.
4. Compare each frame with its reference for copy, section order, colors, and
   layout. Check the report's measured section, footer, and button gaps for every
   frame, and read both "Horizontal overflow at 390px" lines (`phone` and
   `phone-remote`): a sideways scroll at 390px is a failure.
5. Append your per-frame observations and an explicit pass or fail to the
   report's **Website visual verdict** section. On a guidance-assisted retry,
   also record how the answered escalation affected your reading.
6. If and only if every frame matches, attach the reviewed frames to the PR and
   issue the passing verdict:

   ```
   ab artifact put website-frame:desktop:png .ab/website-frames/desktop.png --attach
   ab artifact put website-frame:phone:png .ab/website-frames/phone.png --attach
   ab artifact put website-frame:desktop-remote:png .ab/website-frames/desktop-remote.png --attach
   ab artifact put website-frame:phone-remote:png .ab/website-frames/phone-remote.png --attach
   ab verdict pass --notes .ab/website-frames/verify-report.md
   ```

   On any failure, attach nothing, list each finding in the report (frame,
   what differs, where), and end exactly once with:

   ```
   ab verdict fail --report .ab/website-frames/verify-report.md
   ```

## Verdict rules

- **Fail** when copy, section order, colors, or layout differ from the
  reference, when the page scrolls sideways at 390px, when the capture crashes,
  or when a PNG cannot be opened.
- **Fail** when no Chromium binary is available. That is a host setup problem
  for the operator, not a reason to skip: record the missing binary and
  `CHROMIUM_BIN` in the report and use the failing verdict.
- The page links web fonts and the capture runs offline, so a fallback typeface
  renders. A typeface-only difference, and the line wraps and page height it
  causes, is not a failure. Differing words, order, colors, or a clipped or
  overlapping layout is.
- Human guidance may clarify how to retry or interpret evidence, but it cannot
  change the criteria or authorize a pass over a visible difference.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session
  exists.
- If the capture fails before creating the report, create it only under
  `.ab/website-frames/`, record the command, the error, and the missing
  evidence, then use the failing verdict.
- Do not edit site code or fix what you find. Report it through the failing
  verdict.
