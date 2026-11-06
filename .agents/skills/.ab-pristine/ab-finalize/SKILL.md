---
name: ab-finalize
description: Prepare a green build's pull request description. Invoked by the build-runner as the finalize phase; takes only the build slug.
disable-model-invocation: true
---

# /ab-finalize <build>

The build is green: plan approved, code approved, every current verify gate passed or was explicitly skipped.
You write the PR description; the kernel opens the PR when you finish (you
never touch the forge).

Guidance is an external operator answer, from the operator agent or a human.

## Session shape

1. Run `ab context`. You get `$AB_CONTEXT_DIR/spec.md`, `$AB_CONTEXT_DIR/plan.md`, every verify report (including earlier failed cycles),
   the repo's PR template config if one exists, and — when a human answered an
   escalation this phase raised on an earlier attempt — `$AB_CONTEXT_DIR/guidance.json`,
   their answer to it.
2. Write `$AB_CONTEXT_DIR/pr-description.md`:
   - **Title line first** — imperative, ≤ 70 chars, from the spec's what.
   - **What & why** — from the spec, compressed for a human reviewer who
     hasn't read it.
   - **How** — the approach actually taken (from the plan and the implement
     notes), including deviations from the plan.
   - **Verification** — which verify steps ran and what they proved; note
     anything a human should re-check by hand. Historical cancelled steps are
     not-run evidence, never passes; describe the satisfied current cycle. The
     finalize manifest omits `cancelledVerify`; earlier reports are historical,
     not a list of unfinished current gates.
   - Follow the PR template if the context includes one.
   Do not paste the audit trail — the kernel's summary comment appends verdict
   history and links into the store.

   **Linked issues.** When the manifest lists `issueLinks`, don't write
   closing or reference keywords for those issues yourself. On a leaf aimed at
   the default branch through a forge that closes issues (GitHub), the kernel
   ends the PR body with one `Closes #N` or `Refs #N` line per linked issue
   and puts the same lines in the landed commit. It also rewrites any closing
   keyword aimed at a `refs` issue (`fixes #N`, `closes #N`, …) in the title
   and body to `refs`. On a leaf aimed at an integration node, the lines go
   into the node's PR to the default branch when this child lands, not into
   this PR. Either way, if this PR only partly resolves a `closes` issue, run
   `ab issue downgrade N --reason "<what remains>"` **before** `ab done`.
   `ab done` seals the links, and a later downgrade is refused.
3. Finish:

   ```
   ab artifact put pr-description "$AB_CONTEXT_DIR/pr-description.md"
   ab done
   ```

   `ab done` validates the deposit; the kernel opens the PR from it, and a
   forge refusal reaches the operator as a finalize escalation. One
   terminal command; if validation fails, fix what it names and rerun.

`$AB_CONTEXT_DIR/guidance.json`, when present, is an operator's answer to the
escalation that blocked this build: the escalation id and the answer text. It
is authoritative feedback for this attempt and the PR description must act on
it, while the spec remains the contract this phase is measured against — if the
two cannot both be satisfied, escalate instead of guessing. Finalize has no
review round of its own, so guidance is the only feedback it ever receives.

Read the manifest path printed by `ab context`. Its `materialized` keys are
relative to `contextDir`: join them to locate collision-adjusted inputs.
Manifest path fields are workspace-relative; use `notesPath` for producer notes.
Run commands from the workspace root.
