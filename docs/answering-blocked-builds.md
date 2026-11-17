# Answering blocked builds

A build is **blocked** while one or more escalations are open. Inspect them with
`ab build status <slug>`, then choose the resolution that matches the problem.
Every action below is sessionless, records a human-authored fact, and accepts
`--store <ref>`.

| Need | Command | Effect |
|---|---|---|
| Give the phase a decision or missing information | `ab answer <slug> <text>` | Records `guidance`. In a review loop it feeds the next producer round; a ticket wait's answer instead resumes the phase that declared it, including the same review round. |
| Try again without guidance | `ab answer <slug>` | Records a bare `retry`; no prose is delivered to an agent, except that a ticket wait's resumed phase still gets a one-line summary and its `wait` block. |
| Widen an exhausted review loop | `ab answer <slug> [<text>] --review-round-ceiling <n>` | Answers the open `review-round-limit` escalation and replaces the configured cap with absolute ceiling `n` for that loop and spec revision only. |
| Retire a review disagreement | `ab answer <slug> --dismiss` | Records `dismiss-finding` for each escalation that cites a real finding id. The next reviewer is told not to re-raise that chain. |
| Replace the build contract from a file | `ab answer <slug> --revise-spec <file>` | Records the replacement as the next spec revision and restarts leaves at `plan`; nodes recollect and verify. |
| Re-import an amended ticket | `ab answer <slug> --revise-spec-from-ticket` | Reads the build's recorded ticket and performs the same revision. |
| Abandon the build | `ab abort <slug> [--to ready] [--reason <text>]` | Irrevocably requests abort; cleanup returns the ticket to Triage, or with `--to ready` to Ready with its blockers kept, and then reports `ticket.handed-back`. Ready requires the current ticket to meet the spec standard; otherwise cleanup returns it to Triage, and the comment and event name the requested destination and the missing parts. |

The dashboard's blocked-build `r` shortcut requests an inline answer step that
supports guidance and a blank retry. While that step is open, it is exclusive
to the selected row: the row exposes only **SUBMIT** and **CANCEL**. Its ordinary
**RESUME**, **ABORT**, auto-merge, and detail controls are unavailable, and the
`r` and `a` row shortcuts do not trigger them (those letters remain ordinary
text while typing in the guidance field).

A successful submit records the trimmed guidance, or a bare retry for blank
input, resumes through the normal answer lifecycle, and closes the local step.
**CANCEL** or Esc closes it without writing and preserves both the selected
build and whether its detail was open. A later **RESUME** can request a fresh,
empty answer step. A later **ABORT** first replaces the row controls with local
**CONFIRM ABORT** and **CANCEL** confirmation; no durable abort occurs until it
is confirmed.

Controls on unrelated rows retain their established target-aware behavior.
Activating one leaves the old answer mode, selects that row, and performs its
normal action. The selected build's full detail names the CLI-only dismissal
and revision commands; it does not provide a spec editor.

Restarting `ab dispatch` or running `ab dispatch --once` is not an answer or a
retry action. Every open phase and policy escalation, including every setup
cause, survives dispatcher startup until your operator agent, within your
instructions and authority, or you answer through one of the paths above. A
janitor escalation is the exception: its ordinary retries continue across
startup, a successful attempt closes it unanswered, and a bare retry only brings
the next attempt forward. Startup still recovers unblocked work and acknowledges
pending operator commands.

## Ending a ticket wait

A build whose agent ran `ab wait-on` asks to wait on other tickets. Until the
dispatcher validates the request on its next tick, the build keeps its
capacity slot and `ab build status <slug>` reports the wait as requested. A
refused request writes nothing to the source ticket; the request and its
refusal stay in the build log, and the declaring phase re-runs with the
refusal as guidance.

Once accepted, the build's escalation question begins `Waiting on`,
`ab build status <slug>` shows a `waiting on:` line naming the tickets, its
ticket lists those tickets in `blockedBy`, and the build holds no capacity
slot. `ab builds` and both dashboards show it as `waiting` on those tickets
rather than as a blocked question; in `ab builds --json` its `status` stays
`blocked` and a `wait` field names the tickets. On either dashboard, `r` or
RESUME on a waiting build answers it. Completing the named tickets does not end the wait: an answer does,
whether the blockers have completed or the work landed another way.
`ab answer <slug> <text>` or a bare `ab answer <slug>` ends the wait, and the
build takes the next free slot ahead of new ticket claims. If its target
branch moved while it waited, the build first restacks onto the target's
current head so the resumed phase sees the merged blockers; a conflicting
restack shows as `reconcile` and resolves first. The phase that declared the
wait then re-runs at the same round or attempt. Its `guidance.json` carries a
`wait` block naming the tickets, the reason, and how the wait ended.

A wait declared in `implement` first publishes the build's commits, so the
agent must commit or discard its changes before running `ab wait-on`; the
command refuses a dirty worktree. When a local push fails, the command
records no wait and the same session can fix the failure and run it again.
When a remote publication is lost before the wait is entered, the dispatcher refuses the
wait with cause `publication-lost` and implement re-runs with the refusal as
guidance.

## Widening an exhausted review loop

`--review-round-ceiling` is available only while the selected build has one open
`review-round-limit` policy escalation. The positive integer is an absolute
ceiling, not an increment: setting 12 again leaves the cap at 12. The answer and
override are one durable human-authored event, so no dispatcher restart is
needed and replay preserves the value.

The escalation's phase selects the plan or code loop. The other loop and every
other build keep the configured `maxReviewRounds`; `spec.revised` clears both
loop overrides. The stall threshold still applies before the widened round cap.
A ceiling cannot be supplied pre-emptively, as a standalone control, or together
with `--revise-spec`/`--revise-spec-from-ticket` because revision resets the
round budget itself. Current overrides appear in `ab build status` and on the
dashboard.

## Dismissing findings

Dismissal is evaluated per escalation. A blocker that cites no real
plan-review or code-review finding remains open, even when another blocker is
dismissed. Answer the remainder with guidance or a blank retry. Dismissal
settles only the cited chain: a reviewer can still report a genuinely different
problem in the same file under a new finding id.

## Revising the spec

Leaf revision requires an open escalation because the spec is the contract against
which every downstream approval is measured. The replacement must satisfy the
same spec-standard quality gate used at dispatch; a non-conforming body is
rejected before an artifact or event is recorded, leaving the build blocked on
its current revision.

A successful answer records a human `escalation.answered` fact naming the exact
replacement artifact, followed by kernel `spec.revised`. The leaf re-plans and
pre-revision reviews, verification, and finalize completion do not satisfy the
new run. Historical phase runs remain pinned to the revision they saw. An
already-open pull request is retained and updated rather than duplicated.

If a leaf spec revision arrives during an unfinished reconcile, the same reconcile attempt resumes under the revised spec on its retained frozen target. Its replay and committed contribution remain owned by reconcile. Confirmed publication must settle before the fresh plan loop opens; prior approvals and verification remain invalidated.

The two events make interrupted work safely resumable. If the answer was
recorded but `spec.revised` was not, a repeated revision command publishes the
body named by that earlier answer; it does not read or authorize a newly
supplied file or ticket body.

A build that has already become terminal cannot restart. This includes the
short windows where its PR has merged or closed and completion is underway, or
where an abort request is pending. Abort is irrevocable; after cleanup, dispatch
the returned ticket as a fresh build if work should continue.

Operators may explicitly revise an opened idle collecting node or a node blocked on failed
integration verification without an escalation. Use
`ab answer <node> --revise-spec replacement.md` or, after amending its ticket,
`ab answer <node> --revise-spec-from-ticket`. Ticket edits alone do not revise
the build. Both forms enforce the same spec standard as leaf revisions.
Each kernel `spec.revised` records the exact artifact and operator identity
(with optional transport provenance); earlier revisions remain readable.
Ticket-origin revisions re-pin assets; supplied bodies preserve asset pins.
The node recollects and verifies the new revision, including on the same head
and parent after a failed cycle. Earlier cycles remain historical evidence
and cannot block or authorize merge under the replacement. Children keep
their specs, claims and targets; contributions are not restarted.
Active verification/reconcile or writer work, restack/reparent work, pause,
pending controls, merge intent and ended PRs refuse the no-escalation path.
A concurrent state change refuses publication with a retry explanation;
uncited artifacts are inert. Leaves still require an open escalation and
restart from `plan` after any unfinished reconcile resumes under the revised
spec and its publication is confirmed.
