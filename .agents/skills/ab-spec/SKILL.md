---
name: ab-spec
description: Design a feature spec-first through conversation, or flesh out an existing ticket to the spec standard. The human-interactive surface of the spec standard; creates or updates the ticket when done.
---

# /ab-spec [ticket]

The conversational surface over the complete
[spec standard](../ab-guide/references/spec-standard.md) installed with
`ab-guide` — read it first. It defines "buildable": what and why but never how,
verifiable acceptance criteria, explicit out-of-scope, and evidence. This skill
runs *before* a build exists, so it takes a ticket, not a build slug — and
unlike the phase skills, it is a conversation with a human, not an autonomous
session.

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
the ticket with the spec as its body using `ab ticket create`. Honor a
destination workflow state when the human already named one during grooming:

```
ab ticket create "…" --body spec.md --state "<state>"
```

Do not ask a placement question solely to obtain a state, and do not infer one
from the ticket. If grooming named no destination, omit `--state`; the create
then uses `[tickets].createState`, or the ticket source's own default when that
setting is absent.

When the explicitly named destination equals `[tickets].readyState`, tell the
human in the completion response that the ticket may be claimed by the next
dispatch once the repository's label, dependency, intake, capacity, and other
readiness gates are satisfied.

If grooming established prerequisites, follow the complete
[safe blocker-filing workflow](../ab-guide/references/ticket-dependencies.md).
A single `ab ticket create --blocked-by` invocation does not publish atomically:
Linear (including hosted Linear) exposes the issue before separate blocker writes.
For a ready destination, create in a known non-ready staging state, pass all
blockers at creation, read back and verify them, then move to ready last. The
human's requested final placement still wins; temporary staging needs no new
placement question. Never assume the source default is non-ready.

For a dependency chain, create in dependency order and obtain each new id from
the command's complete JSON result. This example assumes the repository's triage
state is `Triage`, its ready state is `Ready`, and the human requested ready:

```sh
ab ticket create "A" --body a.md --json --state Triage > a-ticket.json
a_id="$(jq -r '.ref.id' a-ticket.json)"
ab ticket create "B" --body b.md --blocked-by "$a_id" --json --state Triage > b-ticket.json
b_id="$(jq -r '.ref.id' b-ticket.json)"
ab ticket create "C" --body c.md --blocked-by "$b_id" --json --state Triage > c-ticket.json
c_id="$(jq -r '.ref.id' c-ticket.json)"
ab ticket show "$b_id" --json
ab ticket show "$c_id" --json
# Verify both tickets remain in Triage and their full blocker sets are present.
ab ticket move "$a_id" Ready --json
ab ticket move "$b_id" Ready --json
ab ticket move "$c_id" Ready --json
```

Never parse an id from the human-readable confirmation line: it can contain the
new ticket id and blocker ids in the same source-local form. Dependency order
alone does not close the ready-publication race. Blockers are evaluated when
the dispatcher claims a ticket; adding a blocker
after a ticket has already been claimed does not stop its active build.

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
- **Showing a draft ends the turn.** When presenting the spec (or any
  ticket body) for review, make it the final text of your message and ask
  for approval in prose — the user replies in chat. Never pair the draft
  with a structured question tool (AskUserQuestion or similar) in the same
  turn: text written before a tool call is not shown to the user, so they
  would be asked to approve a document they cannot see. Reserve structured
  questions for standalone decisions that don't depend on reading something
  you just wrote.
