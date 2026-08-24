# Answering blocked builds

A build is **blocked** while one or more escalations are open. Inspect them with
`ab build status <slug>`, then choose the resolution that matches the problem.
Every action below is sessionless, records a human-authored fact, and accepts
`--store <ref>`.

| Need | Command | Effect |
|---|---|---|
| Give the phase a decision or missing information | `ab answer <slug> <text>` | Records `guidance`. In a review loop it feeds the next producer round. |
| Try again without guidance | `ab answer <slug>` | Records a bare `retry`; no prose is delivered to an agent. |
| Retire a review disagreement | `ab answer <slug> --dismiss` | Records `dismiss-finding` for each escalation that cites a real finding id. The next reviewer is told not to re-raise that chain. |
| Replace the build contract from a file | `ab answer <slug> --revise-spec <file>` | Records the replacement as the next spec revision and restarts at `plan`. |
| Re-import an amended ticket | `ab answer <slug> --revise-spec-from-ticket` | Reads the build's recorded ticket and performs the same revision. |
| Abandon the build | `ab abort <slug>` | Irrevocably requests abort; cleanup returns the ticket to Triage. |

The dashboard's blocked-build `r` field supports guidance and a blank retry.
Its build detail names the CLI-only dismissal and revision commands; it does not
provide a spec editor.

Restarting `ab dispatch` or running `ab dispatch --once` is not an answer or a
retry action. Every open escalation, including every policy and setup cause,
survives dispatcher startup until a human uses one of the paths above. Startup
still recovers unblocked work and acknowledges pending operator commands.

## Dismissing findings

Dismissal is evaluated per escalation. A blocker that cites no real
plan-review or code-review finding remains open, even when another blocker is
dismissed. Answer the remainder with guidance or a blank retry. Dismissal
settles only the cited chain: a reviewer can still report a genuinely different
problem in the same file under a new finding id.

## Revising the spec

Revision requires an open escalation because the spec is the contract against
which every downstream approval is measured. The replacement must satisfy the
same spec-standard quality gate used at dispatch; a non-conforming body is
rejected before an artifact or event is recorded, leaving the build blocked on
its current revision.

A successful answer records a human `escalation.answered` fact naming the exact
replacement artifact, followed by kernel `spec.revised`. The build re-plans and
pre-revision reviews, verification, and finalize completion do not satisfy the
new run. Historical phase runs remain pinned to the revision they saw. An
already-open pull request is retained and updated rather than duplicated.

The two events make interrupted work safely resumable. If the answer was
recorded but `spec.revised` was not, a repeated revision command publishes the
body named by that earlier answer; it does not read or authorize a newly
supplied file or ticket body.

A build that has already become terminal cannot restart. This includes the
short windows where its PR has merged or closed and completion is underway, or
where an abort request is pending. Abort is irrevocable; after cleanup, dispatch
the returned ticket as a fresh build if work should continue.
