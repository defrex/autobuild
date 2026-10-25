---
name: spec
description: Design a feature spec-first through conversation, or flesh out an existing ticket to the spec standard. The human-interactive surface of the spec standard; creates or updates the ticket when done.
---

# /ab-spec [ticket]

The conversational surface over the complete
[spec standard](../ab-guide/references/spec-standard.md) installed with
`ab-guide` — read it first. It defines "buildable": what and why but never how,
verifiable acceptance criteria, explicit out-of-scope, and evidence, plus how
to size work and where to split it. This skill
runs *before* a build exists, so it takes a ticket, not a build slug — and
unlike the phase skills, it is a conversation with a human, not an autonomous
session.

## Node tickets and targets

Write a node ticket as a **charter**: the integration goal, checkable completion
conditions for the whole, and its destination and merge expectations under the
repository's effective policy. Put evolving feature specifics in child tickets.
The charter still follows all four parts of the spec standard: what and why,
verifiable acceptance criteria, out of scope, and evidence.

For example: “Integrate a coherent account-management flow so users can manage
their account in one place. Done means the child-delivered account settings and
account closure flows work together and pass integration verification. Merge the
complete flow into its parent under the configured merge policy.” Record the
scope exclusions and supporting evidence alongside these criteria; describe each
flow's detailed requirements in its child spec.

A charter can evolve while the node is open. See
[iterating inside a node](../ab-guide/references/integration-tree.md#iterating-inside-a-node)
for adding children, hand-pushed tweaks, explicit charter revisions, and what
verification judges each against.

For node lifecycle, target validation and source-specific storage, read
[nodes and targets](../ab-guide/references/integration-tree.md). When filing
related work, follow the shared
[destination choice](../ab-guide/references/integration-tree.md#choosing-a-destination)
guidance before choosing root or a node.

```sh
ab ticket create "Integration" --body spec.md --kind node
ab ticket create "Child" --body child.md --target <node-id>
ab ticket update <id> --target <node-id>
ab ticket update <id> --no-target
ab ticket update <id> --kind work
ab ticket show <id> --json
ab ticket tree --json
```

Whenever grooming produces more than one ticket for a feature, first confirm
the split is warranted under the standard's
[sizing and splitting](../ab-guide/references/spec-standard.md#sizing-and-splitting)
guidance, then explicitly choose root or a node before filing,
including when fleshing out an existing ticket splits it into several tickets.
Consult the shared destination criteria and read
the repository's effective merge policy in `autobuild.toml`; explain the actual
merge and consent flow to the human in plain terms. Ask the human when the
choice is unclear from grooming. Root is valid when each ticket can ship alone.
Choosing root or a node never changes the requested workflow state or silently
promotes tickets; the placement instructions below still apply.

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
   If the criteria fall into separate groups, apply
   [sizing and splitting](../ab-guide/references/spec-standard.md#sizing-and-splitting)
   before treating the work as several tickets: default to one larger ticket,
   and when a split is warranted, propose the seams and the blocker graph to
   the user with the reason for each cut.
3. **Out of scope.** Ask what adjacent work is explicitly excluded. Propose
   candidates — the tempting expansions you noticed while reading the code.
4. **Evidence.** Link what exists: the error rates, the user reports, the
   prior discussion. Designs and other reference material are attached as
   ticket assets and cited by kind and name — see
   [Designs and reference material](#designs-and-reference-material).

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
readiness gates are satisfied. Before ready filing, follow
[After filing: check operator presence](#after-filing-check-operator-presence):
with a live operator, say the existing operator will pick it up; without one,
say you will operate it. The human's explicit instructions override either default.

If grooming established prerequisites, follow the complete
[safe blocker-filing workflow](../ab-guide/references/ticket-dependencies.md).
A single `ab ticket create --blocked-by` invocation does not publish atomically:
Linear (including hosted Linear) exposes the issue before separate blocker writes.
For a ready destination, create in a known non-ready staging state, pass all
blockers at creation, read back and verify them, then move to ready last. The
human's requested final placement still wins; temporary staging needs no new
placement question. Never assume the source default is non-ready.

For a dependency chain explicitly chosen to ship together under a node, create
in dependency order and obtain each new id from the command's complete JSON
result. Write a spec-standard node charter in `integration.md` as well as the child
specs. This example assumes the repository's triage state is `Triage`, its ready
state is `Ready`, and the human requested ready placement for the whole set.
Use the repository's actual states; if final placement is non-ready, leave the
set there after verification instead of promoting it. Root remains a valid
explicit choice when each ticket is independently useful and safe to ship:

```sh
ab ticket create "Integration" --body integration.md --kind node --json --state Triage > node-ticket.json
node_id="$(jq -r '.ref.id' node-ticket.json)"
ab ticket create "A" --body a.md --target "$node_id" --json --state Triage > a-ticket.json
a_id="$(jq -r '.ref.id' a-ticket.json)"
ab ticket create "B" --body b.md --blocked-by "$a_id" --target "$node_id" --json --state Triage > b-ticket.json
b_id="$(jq -r '.ref.id' b-ticket.json)"
ab ticket create "C" --body c.md --blocked-by "$b_id" --target "$node_id" --json --state Triage > c-ticket.json
c_id="$(jq -r '.ref.id' c-ticket.json)"
ab ticket show "$node_id" --json
ab ticket show "$a_id" --json
ab ticket show "$b_id" --json
ab ticket show "$c_id" --json
# Verify the node and all children remain in Triage, all child targets equal
# node_id, and every complete blocker set is correct (A: none; B: A; C: B).
# Repair and read back any mismatch before publishing any ticket.
ab ticket move "$node_id" Ready --json
ab ticket move "$a_id" Ready --json
ab ticket move "$b_id" Ready --json
ab ticket move "$c_id" Ready --json
```

Register and verify all planned children before making the node ready, so it
cannot collect a partial feature. The node must satisfy the repository's ready
gates and open before children can be claimed; a CLI move alone does not prove
admission. After publication, read back the final states, targets and blockers;
repair partial writes without blindly creating duplicates.

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

If the human points at a design or other reference material while fleshing out,
follow [Designs and reference material](#designs-and-reference-material).

Omitted metadata is preserved, including title, labels, assignee, state, and
provider-specific fields. If grooming changes dependencies, use the same
configured-source surface rather than a provider API or MCP call:

```
ab ticket block <ticket> <blocker-id>
ab ticket unblock <ticket> <blocker-id>
```

The first id is the ticket being amended. Both relationship operations are
idempotent; adding validates the blocker exists and rejects a self-block.

## Designs and reference material

When the user points at a design, mock, prototype, screenshot set, sample
payload, or other reference material, export it during this conversation, so
no build worker ever has to convert a link. Use whatever tools this session
has (a browser, a connector, a screenshot tool, fetch, a CLI) and do not tie
the result to any one design tool. Produce portable static files in one
folder: a static reference page (`index.html`, with its assets inline or
alongside) plus screenshots of the key states and widths.

Attach the folder (or a single file) to the ticket as a `design` asset:

```
ab ticket attach <id> design <path> [--name <name>]
```

The ticket must exist first. For a new ticket, create it in a non-ready
staging state, attach, and check with `ab ticket show <id>`. Then place it
where the human asked: if the intended destination is ready, move it there
last, so a build cannot claim it before its assets exist; otherwise leave it
in its destination (or the configured create state) and do not promote it. Attaching the same
kind and name again makes a new revision. Assets are frozen into a build when
it claims the ticket; attaching afterward does not reach a build already
running.

Cite the asset in the spec's Evidence by kind and name (``design `home-page` ``),
never by external link. The spec still states the underlying need; the asset is
the visual contract.

If this session cannot export the design (no tool for it, an auth wall, or
files over the store's size limit), keep the external link in Evidence and say
plainly, in the spec and to the human, that builds cannot read it, so the
planner does not treat it as a contract.

## After filing: check operator presence

Before leaving work in the ready state, run `ab repository status --json` and
inspect `operator.registrations`. If a live operator is present, record the
operating context in the ticket body: intent, rejected alternatives, and why
things were ruled out of scope. File the work, tell the human the existing
operator will pick it up, and stop without arming a watch.

If no operator is present, say you will operate, load `ab-operate`, and follow
its startup check and standing watch. The role covers the builds the repository's dispatcher dispatches,
including newly dispatched builds, rather than only this conversation's tickets.
The human's explicit instructions override either default.

This is the default, not a requirement:

- If the human says they will operate the work themselves, or hands it to
  another agent, file the tickets and stop. A standing preference to the same
  effect in the repository's agent instructions wins too.
- If the work is not in the ready state, for example left in triage for later
  grooming, there is nothing to shepherd yet. Offer to operate once it is
  ready; do not start a watch.
- If this session cannot keep a long-running watch (no background or monitor
  facility, or no operator surface), say so and leave operation to the human.

Operating follows the `ab-operate` skill's rules, including its boundaries:
never start, stop, or restart a dispatcher. If no dispatcher holds the
repository, report that rather than waiting on builds that cannot start.

## Rules

- **Fewer, larger tickets.** Split only when sizing calls for it, cut at
  seams, and keep the blocker graph wide so independent tickets build
  together.
- The spec says **what and why, never how.** An exported, attached `design`
  asset is a contract on observable visual and reference outcomes — layout,
  content, states, copy, look — that plan, review, and verify judge against;
  it is not a contract on implementation, and component structure, libraries,
  and file layout stay the planner's. A technical design or proposed approach
  the user hands you, and any link you could not export, goes in Evidence as
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
