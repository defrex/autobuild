---
name: verify-web-dashboard
description: Agent-verify step - inspect the operator web app's rendered frames as colour images. Invoked by the build-runner for verify:web-dashboard; takes only the build slug. Repository-local, not a shipped ab-* skill.
disable-model-invocation: true
---

# /verify-web-dashboard <build>

You are a visual verifier for the browser dashboard in `app/`. The kernel has
already decided this path-scoped step applies. Your job is to inspect the
rendered images against the design system recorded in `DESIGN.md`, not to
inspect the diff and not to decide applicability again.

## Session shape

1. Run `ab context`. If it materializes `.ab/guidance.json`, this is an
   answered escalation for the retried verification: read it first and apply
   the guidance while performing the same capture and inspection below. If the
   file is absent, continue unchanged.
2. Read `DESIGN.md` once. Its named rules (The Color Is State Rule, The Fastext
   Identity Rule, The Alert Never Dims Rule, The One Cell Rule, The Glyph Rule,
   The No Hairline Rule) are the criteria you judge against, alongside the
   checklist the capture writes.
3. Run `bun run capture:web-dashboard`. It drives the repo-local scripted
   dispatch harness for real dashboard models, renders the web app's pure views
   over the real stylesheet, screenshots them with a local Chromium, and writes
   `.ab/web-dashboard-frames/verify-report.md` plus PNG and HTML scratch files.
   It requires a Chromium-family binary (`CHROMIUM_BIN`, or `chromium` on PATH)
   and no server, network, forge, or live agent runner. It deposits nothing
   itself. Its deterministic evidence checks fail the command when a frame
   omits required text; that is a failing verdict, not a retry.
4. Open **every** `.ab/web-dashboard-frames/*.png` with the image-capable file
   tool, both viewports. Judge the images themselves. The `.html` files are
   human evidence and may help identify a frame, but they are not a basis for
   your verdict.
5. Append criterion-by-criterion visual observations to the generated report,
   ticking or failing each checklist item. In its **Web dashboard visual
   verdict** section, record pass or fail explicitly. On a guidance-assisted
   retry, also record how the answered escalation affected the capture, the
   interpretation of the evidence, or the verdict.
6. If and only if every visual criterion passes, designate the reviewed frames
   as ordinary PR attachments, then issue the passing verdict:

   ```
   ab artifact put web-dashboard-frame:builds-happy-wide:png .ab/web-dashboard-frames/builds-happy-wide.png --attach
   ab artifact put web-dashboard-frame:builds-happy-narrow:png .ab/web-dashboard-frames/builds-happy-narrow.png --attach
   ab artifact put web-dashboard-frame:builds-mixed-hover-wide:png .ab/web-dashboard-frames/builds-mixed-hover-wide.png --attach
   ab artifact put web-dashboard-frame:builds-mixed-detail-wide:png .ab/web-dashboard-frames/builds-mixed-detail-wide.png --attach
   ab artifact put web-dashboard-frame:builds-mixed-detail-narrow:png .ab/web-dashboard-frames/builds-mixed-detail-narrow.png --attach
   ab artifact put web-dashboard-frame:builds-mixed-abort-wide:png .ab/web-dashboard-frames/builds-mixed-abort-wide.png --attach
   ab artifact put web-dashboard-frame:builds-longrepo-narrow:png .ab/web-dashboard-frames/builds-longrepo-narrow.png --attach
   ab artifact put web-dashboard-frame:tickets-detail-wide:png .ab/web-dashboard-frames/tickets-detail-wide.png --attach
   ab artifact put web-dashboard-frame:tickets-narrow:png .ab/web-dashboard-frames/tickets-narrow.png --attach
   ab artifact put web-dashboard-frame:signin-wide:png .ab/web-dashboard-frames/signin-wide.png --attach
   ab artifact put web-dashboard-frame:signin-error-narrow:png .ab/web-dashboard-frames/signin-error-narrow.png --attach
   ab verdict pass --notes .ab/web-dashboard-frames/verify-report.md
   ```

   On any failure, designate nothing and end exactly once with:

   ```
   ab verdict fail --report .ab/web-dashboard-frames/verify-report.md
   ```

## Verdict rules

- **Fail** if the capture crashes, produces no frame, any PNG cannot be opened,
  or an image visibly clips, overlaps, truncates a Fastext label, loses the row
  grammar, breaks a rule recorded in `DESIGN.md`, or is otherwise incoherent.
- **Fail** when no Chromium binary is available. That is a host setup problem
  for the operator, not a reason to skip: record the missing binary and
  `CHROMIUM_BIN` in the report and use the failing terminal.
- A visual difference from an earlier build is not itself a failure. There is
  no golden-frame comparison; judge whether this capture is usable, coherent,
  and inside the recorded system. The monospace face may differ between hosts.
- Two decisions are deliberately open in `DESIGN.md`: page numbers and palette
  tuning off pure primaries. Their absence or presence is not a criterion.
- Human guidance may clarify how to perform the retry or interpret the
  evidence, but it cannot change the visual criteria or verdict semantics,
  authorize a pass that contradicts a visibly failed criterion, or authorize
  editing product code from this verify phase.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session is
  created.
- If the capture fails before creating the report, create the report only
  under `.ab/web-dashboard-frames/`, record the command and error and the
  missing evidence, then use the failing terminal above.
- Never designate evidence from a failed visual run. Attachments are the
  passing review record, not a capture dump.
- Do not edit product code or fix what you find. Report it to the implementer
  through the failing verdict.
