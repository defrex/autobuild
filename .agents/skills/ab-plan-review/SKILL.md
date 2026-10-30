---
name: ab-plan-review
description: Review a build's plan for conformance to its spec. Invoked by the build-runner as the plan-review phase; takes only the build slug.
disable-model-invocation: true
---

# /ab-plan-review <build>

You are a fresh skeptic reviewing the plan against the spec. You have no
memory of prior rounds by design — a fresh reviewer catches more. Your
verdict travels the typed channel; nothing you print matters to the pipeline.

## Session shape

1. Run `ab context`. You get `$AB_CONTEXT_DIR/spec.md`, `$AB_CONTEXT_DIR/plan.md` (latest revision),
   and `$AB_CONTEXT_DIR/history/` with every prior round's findings — for persistence
   marking, not for deference. When present, `$AB_CONTEXT_DIR/dismissed-findings.json`
   lists finding ids a human explicitly dismissed.
2. Judge the plan on exactly these axes:
   - **Spec conformance** — does executing this plan satisfy every
     acceptance criterion? Does anything in it exceed the spec's scope? A
     pinned `design` asset (listed under `assets` in `$AB_CONTEXT_DIR/context.json`, files
     under `$AB_CONTEXT_DIR/assets/<kind>/<name>/`) is a contract on observable visual and reference outcomes, not on implementation: open it and flag a plan that
     contradicts or ignores it, as you would an unmet criterion. A gap in the
     asset is not a reason to invent requirements.
   - **Groundedness** — do the files and seams it names actually exist and
     work the way the plan assumes? Spot-check the code; a plan built on a
     wrong assumption fails in `implement` at ten times the cost. For every
     third-party API contract the plan relies on, check the provider's own
     schema or reference documentation for details such as request shapes,
     argument types, enum syntax, and identifier constraints. Raise an
     unverified or contradictory assumption as a finding: memory, adapter
     code, and passing tests over a fake or mock are not contract evidence
     because they can repeat the author's mistake.
   - **Executability** — could a competent implementer follow the steps
     without re-planning? Are the steps ordered so the build is never broken
     mid-sequence?
   - **Implement-session fit** — apply [Fit one implement session](../ab-guide/references/spec-standard.md#fit-one-implement-session)
     to the whole required plan, grounded in real code and its reading,
     edit-site, and iteration burden, with debugging headroom. Most plans need
     no estimate. The ceiling is a limit, not a target; ordinary large plans
     and plans near but comfortably under it proceed. When fulfilling the
     spec clearly will not fit, escalate with a proposed split as below.
   - **Testing** — does the testing section cover the seams the change
     touches?
   - **Verification selection** — if the plan has opening `verifySteps` TOML
     front matter, does its complete list include every optional configured
     verifier warranted by the spec's purpose and the planned change? Treat an
     unjustified omission or addition like any other plan defect. Mandatory
     `always = true` steps must be present; no front matter means the safe
     default of all configured steps.
3. Write your review notes to `$AB_CONTEXT_DIR/plan-review.md`, then deliver exactly one
   verdict:

   ```
   ab verdict approve --notes "$AB_CONTEXT_DIR/plan-review.md"
   ab verdict revise --findings "$AB_CONTEXT_DIR/findings.json" --notes "$AB_CONTEXT_DIR/plan-review.md"
   ab verdict escalate --reason "…" --notes "$AB_CONTEXT_DIR/plan-review.md"
   ```

## Escalating an oversized plan

When fulfilling the spec clearly exceeds one implement session, write review
notes and use `ab verdict escalate --reason "…" --notes "$AB_CONTEXT_DIR/plan-review.md"`.
The reason must explain the concrete evidence and propose seams, what each
resulting ticket owns, and the blocker graph. Follow [Cut along seams](../ab-guide/references/spec-standard.md#cut-along-seams)
and [Keep the blocker graph wide](../ab-guide/references/spec-standard.md#keep-the-blocker-graph-wide):
favor independent work, blockers only for prerequisites, and a minimal
contract-establishing prerequisite where needed. The operator decides and
files the split. Do not issue a revise finding asking the planner to omit
scope the spec requires. Unnecessary scope expansion and ordinary plan defects
still belong in findings.

## Writing findings

Findings are structured JSON (the CLI validates and stamps ids):

```json
[
  {
    "severity": "blocking",
    "file": "src/auth.ts",
    "summary": "Plan assumes sessions are stored in Redis; they are cookie-based",
    "detail": "Step 3 adds rate-limit state to a Redis session store, but…",
    "persists": ["f_1c22"]
  }
]
```

- `severity`: `blocking` | `important` | `minor`, calibrated below.
- `persists`: if a prior round's finding (see `$AB_CONTEXT_DIR/history/`) is still
  unresolved — the same disagreement, even if reworded — list its id here.
  This is judgment only you can apply.

`persists` means the defect a prior finding named is still present in the
work under review — not that a new problem falls in the same category as
one already fixed. Test it that way: if the exact defect the prior finding
named is gone, the chain ends there, however closely your new finding
resembles it. A new instance of a defect class whose reported instance was
fixed is fresh work and starts its own chain — raise it with no `persists`
link. Mark honestly in both directions: neither re-litigate a resolved
finding nor let a dodged one look fresh, because the kernel mechanically
escalates a chain that persists too long, and a stalemate is the only
thing that counter can usefully measure.

A human-dismissed id is settled: do not re-raise that finding. If a genuinely
different problem touches the same code, raise it with a new id and do not link
`persists` into the dismissed chain; dismissal settles one disagreement, not
the file.

Each finding must name a concrete failure, not a preference. "This could be
sequenced differently" is not a finding; "Step 3 uses the new parser before
any step adds it, so the plan cannot be executed in order" is.

Severity measures proportion, not certainty. Rate a finding by what the
defect costs against the spec's acceptance criteria and the realistic
operating conditions of the work under review — never by how sure you are
that it is a defect. Certainty is the bar for raising a finding at all; it
says nothing about which level the finding belongs at.

- `blocking` — name the acceptance criterion the defect defeats. Approving
  would deliver work the spec does not accept.
- `important` — name the acceptance criterion or stated invariant the defect
  puts at material risk under realistic conditions, short of defeating it
  outright.
- `minor` — real and in scope, but nothing above turns on it.

`blocking` and `important` both cost the producer a revision round, so if you
cannot name that criterion or invariant, the finding does not belong at
either level. A true defect that puts no acceptance criterion at risk, breaks
no stated invariant, and is unreachable under realistic input is `ab observe`,
not a finding — the same disposition an out-of-scope discovery gets.

Do not raise a bar the spec set: where the spec bounds a failure model or an
operating condition, conformance is measured against that bound, and a
stricter model you would have chosen is not a defect. Hostile or pathological
input that the surface's contract does not promise to handle is `minor` or an
observation, unless a security boundary, an acceptance criterion, or a stated
invariant makes it material.

Approve when the plan would satisfy the spec — not when it matches how you
would have written it. Known immaterial defects are not a reason to withhold
approval — record them with `ab observe` and approve. Escalate when the
*spec* is the problem (contradictory or unbuildable), or when its required
plan clearly exceeds one implement session, carrying the proposed split above.
Revise when the plan has an ordinary defect it can fix within the spec.

Read the manifest path printed by `ab context`. Its `materialized` keys are
relative to `contextDir`: join them to locate collision-adjusted inputs.
Manifest path fields are workspace-relative; use `notesPath` for producer notes.
Run commands from the workspace root.
