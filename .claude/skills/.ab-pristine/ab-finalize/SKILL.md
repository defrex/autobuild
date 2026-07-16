---
name: ab-finalize
description: Prepare a green build's pull request description. Invoked by the build-runner as the finalize phase; takes only the build slug.
disable-model-invocation: true
---

# /finalize <build>

The build is green: plan approved, code approved, every verify step passed.
You write the PR description; the kernel opens the PR when you finish (you
never touch the forge).

## Session shape

1. Run `ab context`. You get `.ab/spec.md`, `.ab/plan.md`, every verify
   report, and the repo's PR template config if one exists.
2. Write `.ab/pr-description.md`:
   - **Title line first** — imperative, ≤ 70 chars, from the spec's what.
   - **What & why** — from the spec, compressed for a human reviewer who
     hasn't read it.
   - **How** — the approach actually taken (from the plan and the implement
     notes), including deviations from the plan.
   - **Verification** — which verify steps ran and what they proved; note
     anything a human should re-check by hand.
   - Follow the PR template if the context includes one.
   Do not paste the audit trail — verdict history and links into the store
   are appended by the kernel's summary comment (SPEC §7.5).
3. Finish:

   ```
   ab artifact put pr-description .ab/pr-description.md
   ab done
   ```

   `ab done` validates the deposit; the kernel opens the PR from it. One
   terminal command; if validation fails, fix what it names and rerun.
