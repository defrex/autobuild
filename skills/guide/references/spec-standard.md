# The spec standard

This document is the complete reference definition of **buildable**. Every
ticket-producing surface uses the same standard: interactive specification,
harvest, ingesters, and dispatch. An ingester's proposal is a spec written to
this standard with weaker evidence. Dispatch's quality gate returns any Ready
ticket that cannot be expanded into a conforming spec to Triage, citing this
standard.

A conforming spec has four parts:

## 1. What and why — never how

State the change in terms of observable behavior and the reason it matters.
Implementation strategy belongs to the `plan` phase; a spec that prescribes
file names, function signatures, or libraries is over-specified and will
mislead the planner. One or two paragraphs.

- Bad: "Add a `RateLimiter` class in `src/middleware/` using a token bucket."
- Good: "Login attempts are currently unlimited; an attacker can brute-force
  credentials. After this change, repeated failed logins from one source are
  throttled, and legitimate users see a clear retry-after message."

## 2. Acceptance criteria

A checklist of verifiable statements that define done. Each criterion must be
something a reviewer or a verify step can actually check — behavior, not
intention. These become the contract that `plan-review`, `code-review`, and
`verify:*` all measure against.

- Each criterion is a single observable fact ("a sixth failed login within
  five minutes returns 429 with a Retry-After header").
- Avoid criteria that cannot fail ("code is clean").
- Do not predict which repository paths implementation will touch. Tickets
  describe observable behavior; any repository-configured path applicability
  is evaluated later by the kernel from the build's actual diff in each verify
  cycle.

## 3. Out of scope — explicit

Name the adjacent work this spec deliberately excludes. This is what keeps
builds from thrashing: the implementer files an `ab observe` observation for
out-of-scope discoveries instead of expanding the diff, and the reviewer
cannot demand out-of-scope work in findings.

## 4. Evidence

Links and data supporting the why: the Sentry issue and its frequency, the
observation events that were clustered into this proposal, the conversation
where the human decided this matters. Evidence strength varies by origin —
a human-authored `/spec` may cite a decision; an `ingest:sentry` proposal
cites error counts and affected users. Weak evidence is acceptable; absent
evidence is not.

---

## Sizing and splitting

Every build pays a fixed cost no matter how small its diff: spec, plan and
plan review, code review, the repository's full verify suite, finalize,
merge, and a restack for everything queued behind it. Ten small tickets pay
that cost ten times, and a blocker chain pays it in series. Prefer fewer,
larger tickets: one ticket per coherent change, as large as one plan and one
review pass can hold without the quality bar slipping, and no larger than one
implement session can finish.

A ticket is the right size when its acceptance criteria describe one feature
or fix a reviewer can judge in a single pass, one plan can cover it without
deferring a design decision to a later build, and its out-of-scope list is
short and obvious. It is too big when its criteria fall into groups that share
no behavior, when part of it waits on a decision nobody has made, when its
parts need different merge — one can ship now while another needs consent
or must wait — or when implementing it would outgrow one session.

Do not split:

- by layer (schema, then API, then UI) when the layers make one behavior
  change;
- into "refactor, then feature" unless the refactor is valuable and safe on
  its own;
- to make progress visible, or because the spec got long. A long spec with
  clear criteria is fine.

### Fit one implement session

Larger stops paying off where the work outgrows one agent session. The first
implement round is a single session, and everything it does stays in that
session's context: the spec and plan, every file it reads, every edit, every
test and check run and its output, and every debugging detour. A ticket that
fills the implementer's context window — commonly a million tokens or less —
degrades mid-build: the harness compacts away the reasoning that held the
change together, or an operator has to clear context and restart by hand.
Size each ticket to finish well inside one window, with headroom for
debugging.

Nothing measures this at grooming time, so estimate from what the
implementer must do, not from how long the spec is:

- **Reading.** Count the code it must understand before it can edit safely.
  Several unfamiliar subsystems, each read end to end, cost more than the
  diff itself.
- **Edit sites.** Count files touched, not lines changed. A rename or
  signature change threaded through dozens of callers spends context on
  every one, however mechanical.
- **Iteration.** Count the separate behaviors that each need their own
  tests, failures, and fixes, and the slow or verbose loops — full suites,
  UI captures, migrations — the session will repeat.
- **Your own reading.** If writing the spec meant reading most of several
  subsystems, the implementer reads them again, then writes the code and
  tests on top.

Most tickets sit far below this ceiling; it is a limit, not a target. A
ticket that touches one subsystem and a handful of files needs no estimate.
When the signals put a ticket near the ceiling, split it at a seam (below)
rather than gamble on the build fitting.

### Cut along seams

A seam decides where to cut once a split is justified; it is not a reason to
split. A full-stack change that crosses an API boundary stays one ticket
unless its size says otherwise.

When a feature does need several tickets, find the seams before deciding the
cut: places where the code already has a narrow, stable contract between
parts — a port or adapter interface, a schema or event type, a wire protocol,
a CLI command's output, a module's public API. Read the code to find them;
don't guess. Put each ticket on one side of a seam.

A cut at a seam pays twice:

- **Fewer conflicts.** Tickets on opposite sides of a contract touch
  different code, so they build in parallel and restack cleanly. Two tickets
  that would edit the same functions are one ticket, or a blocker chain.
- **Testability.** The contract is the test boundary. Each side is verified
  against it — the provider by contract tests, the consumer against a fake or
  fixture — so neither build needs the other to prove it works.

If no seam exists where the work divides, keep it as one ticket, or make the
first ticket establish the contract with tests at the boundary and block the
tickets on either side of it until it merges. After that, they can build
concurrently.

State the seam in each ticket as behavior, not structure: what the contract
promises observably (the event, the command output, the protocol response) is
a fair acceptance criterion on both sides; file names and signatures still
belong to the planner. Record in Evidence why the cut falls where it does, so
a planner reading one ticket knows what its siblings own.

### Keep the blocker graph wide

A split feature takes as long as its longest blocker chain, not as long as
its ticket count. A wave of independent tickets finishes in about one build's
time; the same tickets in a chain take one build per link. Prefer cuts that
let tickets start together. When one ticket must merge first — usually the one
that establishes a shared contract — keep it to that contract and its tests,
so the wave behind it starts sooner, and fold nothing unrelated into it.
Add a blocker only for a real prerequisite, never to express a preferred
order.

---

## Immutability during a build

The spec is the build's contract artifact (kind `spec`, revision 0).
Every downstream reviewer approves conformance to its pinned revision.
For leaves, a phase that discovers the spec itself is wrong raises an
escalation (`ab escalate`); a human answers, the spec gets revision N+1,
and the leaf restarts from `plan` after any unfinished reconcile resumes under
the revised spec and its publication is confirmed.

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
