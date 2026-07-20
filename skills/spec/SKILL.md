---
name: spec
description: Design a feature spec-first through conversation, or flesh out an existing ticket to the spec standard. The human-interactive surface of the spec standard; creates or updates the ticket when done.
---

# /ab-spec [ticket]

The conversational surface over the spec standard (`docs/spec-standard.md`
in the autobuild distribution — read it first; it defines "buildable": what
and why but never how, verifiable acceptance criteria, explicit out-of-scope,
evidence). This skill runs *before* a build exists, so it takes a ticket, not
a build slug — and unlike the phase skills, it is a conversation with a
human, not an autonomous session.

## Ticket operations

Reach for `ab` first and use it whenever its CLI supports the requested ticket
operation. That preference is about portability: `ab` is ticket-source
agnostic, so it works across whatever `[tickets]` source the repository
configures, while source-specific tooling is not portable across sources.
Depart from `ab` only when the user asks for an operation outside its CLI
surface. In that case, use the ticket tooling available in the current
environment and tell the user what you changed.

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
the ticket with the spec as its body using `ab ticket create`. The ticket lands
in `[tickets].createState`, or the ticket source's default creation state when
that setting is absent. If that state is also `[tickets].readyState`, creation
can make the ticket immediately dispatchable once every other configured
readiness and dependency gate is satisfied; otherwise it still needs the
repository's normal route to the ready state before dispatch.

If grooming established that this work is blocked by other tickets, pass them
at creation:

```
ab ticket create "…" --body spec.md --blocked-by AUT-8,AUT-9
```

The ids are source-local — whatever the repo's `[tickets]` source uses (e.g.
`AUT-8` for linear, `file-1` for file). The dispatcher will hold the ticket
unclaimed until every blocker completes.

## With a ticket argument: flesh out

Fetch the ticket. Diff it against the standard: which of the four parts are
missing or unverifiable? Interview the user only on the gaps — don't
re-litigate what the ticket already answers. Write the accepted conforming
spec to a file, then sync only the body:

```
ab ticket update <ticket> --body spec.md
```

Omitted metadata is preserved, including title, labels, assignee, state, and
provider-specific fields. If grooming changes dependencies, use the same
configured-source surface rather than a provider API or MCP call:

```
ab ticket block <ticket> <blocker-id>
ab ticket unblock <ticket> <blocker-id>
```

The first id is the ticket being amended. Both relationship operations are
idempotent; adding validates the blocker exists and rejects a self-block.

## Rules

- The spec says **what and why, never how** — if the user hands you a
  design, capture the underlying need and park the design in evidence as
  "proposed approach", clearly non-binding on the planner.
- Don't gold-plate: a spec is buildable when a planner could start, not when
  every question is answered. Thin-but-groomed is a valid state — dispatch
  can author the final spec if the ticket is honest about its gaps.
