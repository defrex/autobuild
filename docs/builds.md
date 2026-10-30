---
title: "One build, end to end"
group: "concepts"
description: "Follow a work ticket through planning, review, verification, pull request creation, and merge."
label: "Builds"
order: 2
---

# One build, end to end

A build is one execution of one work ticket, identified by a slug, through a fixed pipeline:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
```

Integration nodes have a [different lifecycle](integration-overview.md).


## The spec is the contract

At dispatch, Autobuild pins the groomed, conforming spec as a stored artifact; `spec` names that contract, not an agent phase. Planning, review, and verification judge against the pinned spec, not mutable tracker text.

To change the contract, your operator agent answers an escalation with a revised spec, and the build restarts from planning:

```sh
bun ab answer <slug> --revise-spec revised-spec.md
```


## Produce, then review

| Loop | Producer | Reviewer checks against |
|---|---|---|
| `plan ⇄ plan-review` | planner proposes a plan | the spec |
| `implement ⇄ code-review` | implementer makes local commits | the spec and plan |

If a leaf spec revision arrives during an unfinished reconcile, the same reconcile attempt resumes under the revised spec on its retained frozen target. Its replay and committed contribution remain owned by reconcile. Confirmed publication must settle before the fresh plan loop opens; prior approvals and verification remain invalidated.

Either reviewer approves, requests revisions with structured findings, or escalates a question.

The planner and plan reviewer also check whether the required work fits one implement session. Most plans need no estimate; ordinary large plans and plans comfortably under the ceiling proceed. When the concrete work clearly exceeds that ceiling, the planner escalates before depositing a plan, or the plan reviewer escalates instead of requesting removal of required scope. The escalation carries evidence and a proposed split: seams, what each resulting ticket owns, and the blocker graph. See [sizing and splitting](spec-standard.md#fit-one-implement-session) for the sizing signals and seam guidance.

- **Sessions.** Each phase gets its own session; the producer keeps it across a loop's rounds, and each reviewer round starts fresh.
- **Context** passes between phases as durable artifacts: spec, approved plan, implementation notes, findings, and verification reports.

Two limits park the build for an answer:

- **Round ceiling.** `[policy].maxReviewRounds` (default 6) per loop. Your operator agent can override it for the parked loop and current spec revision with `ab answer <slug> --review-round-ceiling <n>`.
- **Stall limit.** A finding the reviewer marks as persisting for `[policy].stallRounds` rounds (default 3) escalates.


## Verify, then publish

After code review approves, Autobuild prepares the build's single net change on the sampled destination and runs ordered verification stages. Each stage's `verify:*` members may run concurrently; the next stage waits until every member passes or skips:

- **Check verifiers** run a command; the exit code decides.
- **Agent verifiers** record a pass, a failure report, or a skip reason.
- **Applicability rules** can skip a step with a recorded reason.

A failed stage settles before sending the build, with every failed member's report, back through implementation, code review, and verification. By default siblings finish; a failing `failFast` member cancels unfinished siblings. See [Verification](verification.md).

Once verification passes, the finalize agent writes the PR description; Autobuild publishes the branch and opens the PR. Optional `finalize:*` post-steps, such as a changelog or ticket link, run after PR creation; a failed post-step records an observation instead of failing the build. `verify:*` and `finalize:*` are the only configurable extension points.


## When a human is needed

After grooming, escalations are the judgment gates. A build parks with a recorded question on an unclear requirement, required work that clearly exceeds one implement session, a persistent review disagreement, or an exhausted policy bound.

Your operator agent answers bounded questions from your instructions and brings unresolved product decisions to you. Restarting dispatch doesn't answer a question, and an answer doesn't force success.

For an oversized-work escalation, your operator agent decides the split and files the resulting tickets, bringing unresolved product decisions to you. Autobuild does not split or file them automatically.

Merge consent is a separate policy decision your operator agent manages. Repositories can require it even for a green build; verification, forge checks, and merge gates still apply. See [integration and merge policy](integration-overview.md).


## The reconcile epilogue

After finalize, Autobuild watches the destination until the PR merges or closes:

```text
(pr.conflicted → reconcile → verify:*)* → merged or closed
```

- **Clean restack** onto a newer base is automatic; no agent runs.
- **Conflicted replay** enters `reconcile`: an agent resolves the kernel-prepared change on a frozen refreshed base, then post-reconcile verification runs.

See [integrating related work](integration-overview.md#one-identity-per-leaf-change) for replay details and the [dispatcher guide](dispatcher.md) for how builds run and resume.
