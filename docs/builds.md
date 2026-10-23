---
title: "One build, end to end"
group: "concepts"
description: "Follow a work ticket through planning, review, verification, pull request creation, and landing."
label: "Builds"
order: 2
---

# One build, end to end

A build is one execution for one ticket, identified by a slug. A work ticket follows the fixed pipeline: `spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize`. Integration nodes have a [different lifecycle](integration-overview.md) for collecting related changes.


## The spec is the contract

Your operator agent grooms the ticket with you to establish what to build before execution. At dispatch, Autobuild pins a conforming spec as a stored artifact. `spec` names that contract, not another agent phase. Planning, review, and verification judge the change against it.

Ordinary execution uses the pinned spec rather than rereading mutable tracker text. If the contract needs to change, an escalation lets your operator agent record a deliberately revised spec under your instructions and restart from planning.


## Produce, then review

The planner proposes an implementation plan. A plan reviewer checks it against the spec. Once approved, the implementer makes local commits, and a code reviewer checks the change against the spec and plan. Either reviewer can approve, request revisions with structured findings, or escalate a question.

Each agent phase starts in its own session. Within a review loop, the producer continues across rounds while each reviewer gets a fresh session. The spec, approved plan, implementation notes, findings, and verification reports carry context between phases as durable artifacts. A build does not depend on one agent remembering the whole conversation.

Review loops have a configured review-round ceiling. They also have a stall limit: when a reviewer marks the same finding as persisting across enough rounds, deterministic code escalates the disagreement. Reaching either limit parks the build for an answer instead of spending rounds indefinitely. Your operator agent can replace the ceiling under your instructions for the parked loop and current spec revision.


## Verify, then publish

After code review approves, Autobuild prepares the build's single net change on the sampled destination and runs the configured `verify:*` steps in order. A check verifier runs a command and uses its exit code. An agent verifier inspects evidence and records a pass, failure report, or explicit skip reason. Applicability rules can also skip a step with a recorded reason.

A failed verifier returns the work build to implementation with its report, followed by code review and verification again. Once verification succeeds, the finalize agent writes the pull request description; Autobuild handles publication and opens the PR.

`verify:*` and `finalize:*` are the only configurable extension points. Optional `finalize:*` post-steps run after PR creation, for tasks such as a changelog or ticket link. They are failure-tolerant: a failed post-step records an observation rather than killing a green build. The core phase order stays fixed.


## When a human is needed

After grooming, escalations are the pipeline's judgment gates. An unclear requirement, a persistent review disagreement, or an exhausted policy bound can park the build with a recorded question. Your operator agent answers bounded questions from your instructions and records retry guidance or an answer through the CLI or operator tools. It brings unresolved product decisions to you. Restarting dispatch does not answer that question, and an answer does not force success.

Your operator agent manages landing consent under your instructions. It is a separate policy decision: repositories can require it even for a green build. Verification, forge checks, and merge gates still apply. See [integration and landing policy](integration-overview.md).


## The reconcile epilogue

After finalize, Autobuild continues watching the destination. A clean restack onto a newer base is automatic and starts no agent. A conflicted replay enters `reconcile`: an agent resolves the kernel-prepared change on a frozen refreshed base, then the configured post-reconcile verification runs. This epilogue repeats as needed until the PR is merged or closed.

Read [integrating related work](integration-overview.md#one-identity-per-leaf-change) for replay and verification details. The [dispatcher guide](dispatcher.md) explains how builds run and resume.
