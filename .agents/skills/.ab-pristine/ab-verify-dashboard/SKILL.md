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

1. Run `ab context`.
2. Run `bun run capture:dashboard`. This drives the local scripted dispatch
   harness and writes `.ab/dashboard-frames/verify-report.md` plus PNG/text
   scratch files. It requires no server, network, forge, or live agent runner.
3. Open **every** `.ab/dashboard-frames/*.png` with the image-capable file tool.
   Judge the images themselves. The `.txt` files are human evidence and may
   help identify a frame, but they are not a basis for your verdict.
4. Append criterion-by-criterion visual observations to the generated report:
   each image opened and non-empty; rows/status/progress/separators do not
   overlap; the Harvest row is legible; the narrow frame truncates/wraps
   deliberately without clipping; colour emphasis is present while literal
   status remains readable.
5. End exactly once:

   ```
   ab verdict pass --notes .ab/dashboard-frames/verify-report.md
   ab verdict fail --report .ab/dashboard-frames/verify-report.md
   ```

## Verdict rules

- **Fail** if capture crashes, produces no frame, any PNG cannot be opened, or
  an image visibly clips, overlaps, leaks control text, loses row structure, or
  is otherwise broken.
- A visual difference from an earlier build is not itself a failure. There is
  no golden-frame comparison; judge whether this capture is usable and coherent.
- Never run Git diff/log/status to decide whether the step applies. Never emit
  `skip`: a nonmatching change is skipped by the kernel before this session is
  created.
- If capture fails before creating the report, create the report only under
  `.ab/dashboard-frames/`, record the command/error and the missing evidence,
  then use the failing terminal above.
- Do not edit product code or fix what you find. Report it to the implementer
  through the failing verdict.
