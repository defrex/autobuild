---
name: ab-verify-dashboard
description: Agent-verify step - inspect deterministic simulated dispatch-dashboard frames as colour images. Invoked by the build-runner for verify:dashboard; takes only the build slug.
disable-model-invocation: true
---

# /ab-verify-dashboard <build>

You are a visual verifier. The kernel has already decided this path-scoped step
applies. Your job is to inspect the simulated terminal images, not to inspect
the diff and not to decide applicability again.

## Session shape

1. Run `ab context`. If it materializes `.ab/guidance.json`, this is an
   answered escalation for the retried verification: read it first and apply
   the guidance while performing the same dashboard capture and visual
   inspection below. If the file is absent, continue with the existing flow
   unchanged.
2. Run `bun run capture:dashboard`. This drives the repo-local scripted
   dispatch harness and writes `.ab/dashboard-frames/verify-report.md` plus
   PNG/text scratch files. It requires no server, network, forge, or live agent
   runner and does not deposit artifacts itself.
3. Open **every** `.ab/dashboard-frames/*.png` with the image-capable file tool.
   Judge the images themselves. The `.txt` files are human evidence and may
   help identify a frame, but they are not a basis for your verdict.
4. Append criterion-by-criterion visual observations to the generated report:
   each image opened and non-empty; rows/status/progress/separators do not
   overlap; the Harvest row is legible; both mixed frames persistently show
   `repository PAUSED` and the `CAP-QUEUED` row as yellow `(held)` while keeping
   its literal `QUEUED` status; the narrow frame truncates/wraps those additions
   deliberately without clipping; colour emphasis is present while literal
   status remains readable; Unicode samples (accented text, curly punctuation,
   em dash, CJK, variation-selector emoji, flag, and ZWJ family) are readable,
   unsplit, non-overlapping, and not rendered as code-point escapes; and the
   resume-prompt frame shows the blocked-build composer panel in place of the key legend — build name, optional-guidance
   note, blocker question, a two-line field with a visible caret, and its key
   bindings. On a guidance-assisted retry, also record how the answered
   escalation affected the capture, interpretation of the evidence, or verdict.
5. If and only if every visual criterion passes, designate the reviewed files
   as ordinary PR attachments, then issue the passing verdict:

   ```
   ab artifact put dashboard-frame:mixed-wide:text .ab/dashboard-frames/mixed-wide.txt --attach
   ab artifact put dashboard-frame:mixed-wide:png .ab/dashboard-frames/mixed-wide.png --attach
   ab artifact put dashboard-frame:mixed-narrow:text .ab/dashboard-frames/mixed-narrow.txt --attach
   ab artifact put dashboard-frame:mixed-narrow:png .ab/dashboard-frames/mixed-narrow.png --attach
   ab artifact put dashboard-frame:unicode-transcript:text .ab/dashboard-frames/unicode-transcript.txt --attach
   ab artifact put dashboard-frame:unicode-transcript:png .ab/dashboard-frames/unicode-transcript.png --attach
   ab artifact put dashboard-frame:resume-prompt:text .ab/dashboard-frames/resume-prompt.txt --attach
   ab artifact put dashboard-frame:resume-prompt:png .ab/dashboard-frames/resume-prompt.png --attach
   ab verdict pass --notes .ab/dashboard-frames/verify-report.md
   ```

   On any failure, designate nothing and end exactly once with:

   ```
   ab verdict fail --report .ab/dashboard-frames/verify-report.md
   ```

## Verdict rules

- **Fail** if capture crashes, produces no frame, any PNG cannot be opened, or
  an image visibly clips, overlaps, leaks control text, loses row structure, or
  is otherwise broken.
- A visual difference from an earlier build is not itself a failure. There is
  no golden-frame comparison; judge whether this capture is usable and coherent.
- Human guidance may clarify how to perform the retry or interpret the evidence,
  but it cannot change the visual criteria or verdict semantics, authorize a
  pass that contradicts a visibly failed criterion, or authorize editing product
  code from this verify phase.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session is
  created.
- If capture fails before creating the report, create the report only under
  `.ab/dashboard-frames/`, record the command/error and the missing evidence,
  then use the failing terminal above.
- Never designate evidence from a failed visual run. Attachments are the
  passing review record, not a capture dump.
- Do not edit product code or fix what you find. Report it to the implementer
  through the failing verdict.
