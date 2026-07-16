---
name: ab-spec
description: Design a feature spec-first through conversation, or flesh out an existing ticket to the spec standard. The human-interactive surface of the spec standard; creates or updates the ticket when done.
---

# /spec [ticket]

The conversational surface over the spec standard (`docs/spec-standard.md`
in the autobuild distribution — read it first; it defines "buildable": what
and why but never how, verifiable acceptance criteria, explicit out-of-scope,
evidence). This skill runs *before* a build exists, so it takes a ticket, not
a build slug — and unlike the phase skills, it is a conversation with a
human, not an autonomous session.

## No argument: design spec-first

Interview the user toward a conforming spec. Work the standard's four parts
in order, but as a conversation, not a form:

1. **What and why.** Get the observable behavior change and the reason it
   matters. Push back on solutions masquerading as problems ("add Redis" is
   not a why). Read the relevant code as claims come up — ground the
   conversation in what actually exists.
2. **Acceptance criteria.** Propose them yourself from the discussion; let
   the user correct. Each must be checkable by a reviewer or a verify step.
3. **Out of scope.** Ask what adjacent work is explicitly excluded. Propose
   candidates — the tempting expansions you noticed while reading the code.
4. **Evidence.** Link what exists: the error rates, the user reports, the
   prior discussion.

Draft the spec in full, show it, iterate until the user accepts. Then create
the ticket with the spec as its body (`ab ticket create` when available in
this install; otherwise create it via the repo's ticket tracker and say
where). The ticket lands in Triage — a human grooms it to Ready; creation is
not dispatch.

## With a ticket argument: flesh out

Fetch the ticket. Diff it against the standard: which of the four parts are
missing or unverifiable? Interview the user only on the gaps — don't
re-litigate what the ticket already answers. Sync the conforming spec back
to the ticket body, preserving anything the ticket carried that the standard
doesn't structure (assignee, labels, discussion links).

## Rules

- The spec says **what and why, never how** — if the user hands you a
  design, capture the underlying need and park the design in evidence as
  "proposed approach", clearly non-binding on the planner.
- Don't gold-plate: a spec is buildable when a planner could start, not when
  every question is answered. Thin-but-groomed is a valid state — dispatch
  can author the final spec if the ticket is honest about its gaps.
