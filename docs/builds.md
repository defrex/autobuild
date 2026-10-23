---
title: "One build, end to end"
group: "concepts"
description: "Follow a work ticket through planning, review, verification, pull request creation, and landing."
label: "Builds"
order: 2
---

# One build, end to end

A build is one execution for one ticket, identified by a slug. A work ticket follows a fixed pipeline:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
```

Integration nodes have a [different lifecycle](integration-overview.md) for collecting related changes.


## The spec is the contract

At dispatch, Autobuild pins the groomed, conforming spec as a stored artifact. `spec` names that contract, not another agent phase.

- Planning, review, and verification judge the change against the pinned spec, not mutable tracker text.
- To change the contract, your operator agent answers an escalation with a deliberately revised spec under your instructions, and the build restarts from planning.

```sh
bun ab answer <slug> --revise-spec revised-spec.md
```


## Produce, then review

Each review loop pairs a producer with an independent reviewer:

| Loop | Producer | Reviewer checks against |
|---|---|---|
| `plan ⇄ plan-review` | planner proposes a plan | the spec |
| `implement ⇄ code-review` | implementer makes local commits | the spec and plan |

Either reviewer can approve, request revisions with structured findings, or escalate a question.

- **Sessions.** Each agent phase starts in its own session. The producer continues across a loop's rounds; each reviewer round gets a fresh session.
- **Context.** The spec, approved plan, implementation notes, findings, and verification reports carry context between phases as durable artifacts. No agent has to remember the whole conversation.

Two limits park the build for an answer instead of spending rounds indefinitely:

- **Round ceiling.** `[policy].maxReviewRounds` (default 6) bounds each loop. Your operator agent can replace it for the parked loop and current spec revision with `ab answer <slug> --review-round-ceiling <n>`.
- **Stall limit.** When a reviewer marks the same finding as persisting for `[policy].stallRounds` rounds (default 3), Autobuild escalates the disagreement.


## Verify, then publish

After code review approves, Autobuild prepares the build's single net change on the sampled destination and runs the configured `verify:*` steps in order:

- **Check verifiers** run a command; the exit code decides.
- **Agent verifiers** inspect evidence and record a pass, a failure report, or an explicit skip reason.
- **Applicability rules** can skip a step with a recorded reason.

A failed verifier returns the build to implementation with its report, then code review and verification again. See [Verification](verification.md). Once verification passes, the finalize agent writes the pull request description; Autobuild publishes the branch and opens the PR.

`verify:*` and `finalize:*` are the only configurable extension points; the core phase order is fixed. Optional `finalize:*` post-steps run after PR creation, for tasks such as a changelog or ticket link. They're failure-tolerant: a failed post-step records an observation rather than killing a green build.


## When a human is needed

After grooming, escalations are the pipeline's judgment gates. A build parks with a recorded question on:

- an unclear requirement
- a persistent review disagreement
- an exhausted policy bound

Your operator agent answers bounded questions from your instructions, recording retry guidance or an answer through the CLI or operator tools. It brings unresolved product decisions to you. Restarting dispatch doesn't answer a question, and an answer doesn't force success.

Landing consent is a separate policy decision, managed by your operator agent. Repositories can require it even for a green build; verification, forge checks, and merge gates still apply. See [integration and landing policy](integration-overview.md).


## The reconcile epilogue

After finalize, Autobuild keeps watching the destination until the PR is merged or closed:

```text
(pr.conflicted → reconcile → verify:*)* → merged or closed
```

- **Clean restack** onto a newer base is automatic and starts no agent.
- **Conflicted replay** enters `reconcile`: an agent resolves the kernel-prepared change on a frozen refreshed base, then the configured post-reconcile verification runs.

Read [integrating related work](integration-overview.md#one-identity-per-leaf-change) for replay and verification details. The [dispatcher guide](dispatcher.md) explains how builds run and resume.
