# The spec standard

The reference definition of **buildable** (SPEC §6.1). Every ticket-producing
surface cites this document: `/spec`, `harvest`, every `ingest:*`, and
`dispatch`. An ingester's proposal is a spec written to this same standard
with weaker evidence. Dispatch's quality gate bounces any Ready ticket that
cannot be expanded into a conforming spec back to Triage, citing this
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

## Immutability during a build

The spec is the build's contract artifact (kind `spec`, revision 0). It
cannot change during a build (SPEC §6.3): every downstream reviewer approves
conformance *to it*. A phase that discovers the spec itself is wrong raises
an escalation (`ab escalate`); a human answers, the spec gets revision N+1,
and the build restarts from `plan`.
