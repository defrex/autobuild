# Product

<!-- impeccable:product-schema 1 -->

Provenance: audiences, the usage scene, and the parity commitment below were
confirmed with the maintainer on 2026-09-07. Everything else is drawn from the
repository (`SPEC.md`, `README.md`, `docs/`, `app/`). Correct it here if it is
wrong; do not reopen the confirmed fields without a reason.

## Platform

web

## Users

The primary user is the **operator**: the engineer who runs Autobuild against
one or more repositories. They groom tickets in and review pull requests out;
everything between is headless. The browser has one surface, Builds. There the
operator keeps many concurrent builds moving with as little attention as
possible: see status at a glance, find blocked builds, answer escalations,
pause or resume work, and inspect any build's trail.

Confirmed audiences, in the order they exist today:

1. The maintainer, running Autobuild on the Autobuild repository through its
   own hosted deployment.
2. Teams that adopt Autobuild and self-host the hosted service, admitting
   operators through an email allowlist.
3. A future multi-tenant hosted product where anyone signs in and sees their
   own repositories. Committed direction, not yet built.

Ticket authoring and grooming are not browser jobs. Operators write tickets
through the `/ab-spec` skill inside their coding agent (README) and manage them
through the agent or `ab ticket` CLI workflow.

## Product Purpose

Autobuild is an agent-driven software development lifecycle. A groomed ticket
goes through spec, plan, plan review, implementation, code review,
verification, PR creation, conflict reconciliation, and merge, with humans
involved only for grooming and escalations. The README puts it as "Tickets in,
PRs out. No babysitting required."

The web dashboard, titled "Autobuild operator" today, is the browser front on
that system. Success for the operator is that ten builds in flight cost the
same attention as one: the dashboard says in a glance whether anything needs
them, lets them act on the build that does, and otherwise lets them leave.

## Positioning

Headless is safe because the pipeline is deterministic code, not model
judgment. Agents plan, implement, and review; tested code owns state,
transitions, gating, and plumbing. Build state is a typed, append-only event
log, every phase reports through a typed CLI, and no outcome is ever inferred
from what a model printed. Kill the process anywhere and the build resumes from
durable state.

That is the claim a neighbouring "run coding agents in parallel" tool cannot
truthfully copy: every build leaves a queryable paper trail, merge gates are
never bypassed, and the operator UI is a pure reduction of the log. Anything
the dashboard shows is derived from events; anything it does is an event
appended to the same log.

## Operating Context

- **Peripheral, not focal.** Operators glance at the dashboard on a second
  monitor or in a background tab while doing other work. It must answer "does
  anything need me?" without being read.
- **Phone check-ins.** Builds run headless, so operators check in and answer
  escalations from a phone while away from the desk. Escalation answering and
  build controls must work on a narrow screen.
- **Shared between teammates.** Two operators may watch the same repository's
  builds and coordinate. Settings show acknowledged durable state, never one
  person's optimistic view.
- **Parity with the terminal dashboard.** `ab dispatch` renders a live TTY
  dashboard (see `docs/assets/headline-wide.png`). The web dashboard is a
  first-class sibling front on the same event log and keeps the same mental
  model and vocabulary: the same row shape (identity and lifecycle status,
  then the pipeline with per-step elapsed time), the same step states, the
  same control names. Confirmed by the maintainer.
- **Served by the hosted service.** The dashboard is the Next.js app at the
  repository root, deployed on Vercel with Neon Postgres. Sign-in is GitHub
  OAuth through Better Auth with a server-side email allowlist. The browser
  holds only a session cookie, never a store token or provider secret.
- **Polling, not streaming.** Both dashboards poll every two seconds; there is
  no push channel. Elapsed timers tick locally between polls.
- **Multi-repository.** One deployment serves several repositories; the
  operator views one at a time.

## Capabilities and Constraints

Confirmed capabilities of the web dashboard today:

- **Builds, the only surface.** A dispatcher status bar (active/limit, queued,
  repository paused or running, unclaimed observations/threshold) with toggles
  for intake, default auto merge, and the harvest gate, plus Pause all and
  Resume all. A pipeline table with one row per nonterminal build: ticket id
  and slug, status, pipeline steps with elapsed time, pull request state, and
  controls (pause or resume, enable or disable auto merge, discard, abort). A
  harvest row for the observation-harvest workflow. A build detail panel with
  escalations, an answer composer (guidance, retry, dismiss, review-round
  ceiling, revised spec from a supplied body or the amended ticket), session
  rows with token usage, and transcript viewing.
- **Sign-in page.** Provider buttons and an access-refused message.

Constraints future work must preserve:

- The dashboard shows acknowledged durable state. Settings and controls are
  never optimistically rendered.
- Destructive intent is a second step. Abort confirms before writing; a first
  interaction never writes destructive intent. Discard applies only to queued
  builds and returns the ticket to Ready; abort returns work to Triage. The
  two are deliberately distinct.
- Every control and answer is an event in the log. The UI cannot add actions
  the event vocabulary lacks and cannot infer outcomes from agent output.
- The browser talks only to same-origin web routes backed by the strict, typed
  operator API. No credentials reach the client.
- The dashboard is product code that ships to every user. It must not encode
  this repository's specifics: its tracker, its verify steps, its capture
  evidence.
- The product's name is one word, Autobuild, capitalized as a proper noun. A
  repository check fails on the two-word or hyphenated spelling.

Vocabulary, to be used verbatim:

- **build**: one pipeline execution for one ticket, identified by a **slug**.
- **phase** or **step**: spec, plan, plan-review, implement, code-review,
  verify:*, finalize, reconcile, merge. Review phases **converge** over
  **rounds** under a **review-round ceiling**.
- **escalation** and **blocker**: a build parked for a human answer.
- **intake**: whether the dispatcher claims new ready tickets. **Repository
  pause**: holds every queued build.
- **auto merge**: a per-build setting and a repository default; merge gates
  are never bypassed.
- **observation** and **harvest**: things agents notice but rightly leave
  alone, distilled into **proposals** that land in Triage.
- **discard** and **abort**: distinct, as above.
- **operator**: the human using either dashboard.

Undecided:

- The shape of multi-tenancy (organizations, per-user repository access,
  billing) for the future hosted product. Not designed yet.
- Whether the web dashboard may gain capabilities the terminal lacks. Parity
  is the current commitment.

## Brand Commitments

- **Name:** Autobuild, one word. The web surface titles itself "Autobuild
  operator" today.
- **Voice:** engineer to engineer, direct, confident, plain. Short declarative
  sentences in the README's register. No superlatives, no exclamation points.
  The tagline in use is "Tickets in, PRs out. No babysitting required."
- **Terminology is binding.** The vocabulary above matches `SPEC.md`, the CLI,
  and the terminal dashboard; the web uses it verbatim.
- **Visual constraint, binding, set by the maintainer on 2026-09-07:** the
  interface should read like a terminal UI. Monospace type throughout, in a
  face engineers already know from their terminals. Text-based icons: ASCII
  where possible, Unicode where it helps, never emoji glyphs. The `ab dispatch` terminal dashboard
  (`docs/assets/headline-wide.png`) is the existing reference for this
  register.

## Evidence on Hand

- `docs/assets/headline-wide.png`: a rendered frame of the terminal dashboard
  with five builds and a harvest run in flight. It is generated from a
  scripted end-to-end scenario, not from real customer builds; its ticket ids
  and slugs are fixtures.
- `README.md`: the product's marketing copy and pipeline explanation.
- `SPEC.md` section 14, "Operator UI", and `docs/operator-api.md`: the
  operator's job and the API the dashboard consumes.
- The maintainer's live hosted deployment runs this repository's own builds.
  Its data is real but private.

Absent, and not to be fabricated: customer names, testimonials, case studies,
benchmarks, throughput figures, pricing, press.

## Product Principles

1. **Attention is the scarce resource.** The dashboard's job is to let the
   operator leave. Surface what needs a human; let everything else recede.
2. **Show the log, never a guess.** Every displayed fact is a reduction of
   durable events; every action is an event. No optimistic state, no inferred
   outcomes.
3. **One vocabulary across every front.** Terminal, web, CLI, and spec share
   terms and mental model. Learning one teaches the others.
4. **Destructive intent is deliberate.** Abort and other irreversible actions
   take a second step; the first touch never writes them.
5. **Product, not this repository.** Nothing in the shipped dashboard encodes
   the maintainer's own repository, tracker, or evidence.

## Accessibility & Inclusion

No formal standard has been adopted. The incumbent dashboard already carries
semantic landmarks, labelled regions, visible focus rings, alert roles on
errors, a polite live region while loading, and screen-reader text for step
states; future work keeps that floor. Operators must be able to answer an
escalation on a phone-width viewport.
