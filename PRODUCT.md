# Product

<!-- impeccable:product-schema 1 -->

Provenance: audiences, the usage scene, and the parity commitment were first
confirmed with the maintainer on 2026-09-07. The product tiers, the broadened
audience, the operator-agent model, organizations, the revised parity
commitment, and the revised visual constraint were confirmed on 2026-10-24.
Everything else is drawn from the repository (`SPEC.md`, `README.md`, `docs/`,
the hosted store service app tree). Correct it here if it is wrong; do not
reopen the confirmed fields without a reason.

## Platform

web

## Users

Everybody builds; they build different things. The users are engineers,
product managers, and designers, and they all work the same way: they talk to
an **operator agent** to decide what should be built, shape it into specs, and
drive the resulting builds to merge. The pipeline between a groomed ticket and
a merged pull request is headless.

The web app is where those people see what is happening and act on it without
opening a terminal. They see status at a glance, find blocked builds, answer
escalations, pause or resume work, inspect any build's trail, and manage who
belongs to their organization. Many of them are not engineers. They must be
able to read a build's state and act on it without knowing the pipeline's
internals.

Roles on a deployment of the web service:

- **Super user:** an Autobuild maintainer named in the deployment's
  environment. Creates organizations, manages any organization's members, and
  reaches every project.
- **Organization owner:** at most one per organization. Manages that
  organization's members.
- **Member:** reaches every project the organization owns.

Ticket authoring and grooming are not browser jobs. They happen in conversation
with the operator agent.

## Product Purpose

Autobuild is an agent-driven software development lifecycle. A groomed ticket
goes through spec, plan, plan review, implementation, code review,
verification, PR creation, conflict reconciliation, and merge, with humans
involved only for grooming and escalations. The README puts it as "Tickets in,
Product out."

The product comes in tiers:

1. **Open source, free.** The full local configuration, or a self-hosted web
   service.
2. **Hosted, multi-tenant.** One managed web service that many organizations
   sign in to. This is the V1 target: polished enough to test with real
   customers.
3. **Managed single-tenant.** A dedicated web service installation for
   enterprise customers, still managed. Further out; not designed yet.

The web app, titled "Autobuild operator" today, is the browser front on that
system. Success is that ten builds in flight cost the same attention as one:
the app says in a glance whether anything needs you, lets you act on the build
that does, and otherwise lets you leave.

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

- **The operator agent is where work starts.** The ticket system and the
  dispatcher run somewhere — locally, or in the web service. People open an
  operator agent and chat with it to work on specs and decide what to build.
  That agent may be a local coding agent at the repository root driving the
  `ab` CLI, or a remote agent connected through the MCP server. Both are
  first-class setups. Known gap, deliberately unsolved for now: a remote MCP
  agent cannot reach a sandbox environment when build runners are local.
- **Peripheral, not focal.** People glance at the web app on a second monitor
  or in a background tab while doing other work. It must answer "does
  anything need me?" without being read.
- **Phone check-ins.** Builds run headless, so people check in and answer
  escalations from a phone while away from the desk. Escalation answering and
  build controls must work on a narrow screen.
- **Shared within an organization.** Every member of an organization sees all
  of its projects, and several may watch the same builds and coordinate.
  Settings show acknowledged durable state, never one person's optimistic
  view.
- **Vocabulary parity with the terminal dashboard.** `ab dispatch` renders a
  live TTY dashboard (see `docs/assets/headline-wide.png`). The web app is a
  first-class sibling front on the same event log and keeps the same mental
  model and vocabulary: the same row shape (identity and lifecycle status,
  then the pipeline with per-step elapsed time), the same step states, the
  same control names. The web app may carry capabilities the terminal lacks
  where they belong to the web service itself — sign-in, organizations,
  membership, and later account and billing — but never a second vocabulary
  for builds.
- **Served by the web service.** The app lives in
  `packages/hosted-store-service/app`, deployed on Vercel with Neon Postgres.
  Sign-in is GitHub OAuth through Better Auth. Super users come from the
  deployment's environment; everyone else is admitted through organization
  membership. The browser holds only a session cookie, never a store token or
  provider secret.
- **Polling, not streaming.** Both dashboards poll every two seconds; there is
  no push channel. Elapsed timers tick locally between polls.
- **Multi-project.** One deployment serves many projects; a person views one
  at a time, chosen from the projects their organizations own.

## Capabilities and Constraints

Confirmed capabilities of the web app today:

- **Builds.** A dispatcher status bar (active/limit, queued, repository paused
  or running, unclaimed observations/threshold) with toggles for intake,
  default auto merge, and the harvest gate, plus Pause all and Resume all. A
  pipeline table with one row per nonterminal build: ticket id and slug,
  status, pipeline steps with elapsed time, pull request state, and controls
  (pause or resume, enable or disable auto merge, discard, abort). A harvest
  row for the observation-harvest workflow. Each build has its own page with
  escalations, an answer composer (guidance, retry, dismiss, review-round
  ceiling, revised spec from a supplied body or the amended ticket), session
  rows with token usage, and transcript viewing.
- **Sign-in page.** Provider buttons and an access-refused message.

In progress (integration node file-103): organizations, super users, and an
organization management surface for super users and owners.

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
- **operator agent**: the agent a person chats with to specify and drive work.
- **operator**: the human using either dashboard.
- **organization**, **owner**, **member**, **super user**: as defined under
  Users.

Undecided:

- Pricing, billing, quotas, and what separates the free and paid tiers.
- The shape of the managed single-tenant enterprise tier.
- Whether the web app keeps the title "Autobuild operator" as its audience
  widens.

## Brand Commitments

- **Name:** Autobuild, one word. The web surface titles itself "Autobuild
  operator" today.
- **Voice:** direct, confident, plain, for anyone who builds — engineers,
  product managers, designers. Short declarative sentences in the README's
  register. No superlatives, no exclamation points. Pipeline terms stay, but a
  newcomer meeting one is told what it means. The tagline in use is "Tickets
  in, Product out."
- **Terminology is binding.** The vocabulary above matches `SPEC.md`, the CLI,
  and the terminal dashboard; the web uses it verbatim.
- **Visual starting point, revised by the maintainer on 2026-10-24:** the
  terminal register — monospace type, text-based icons, the `ab dispatch`
  dashboard (`docs/assets/headline-wide.png`) as reference — is where the
  visual system starts, no longer a binding constraint. The system may move
  away from it, for example a proportional face for prose, where that makes
  the product feel accessible to people who are not engineers. Emoji glyphs
  remain excluded.

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

1. **Attention is the scarce resource.** The app's job is to let people
   leave. Surface what needs a human; let everything else recede.
2. **Show the log, never a guess.** Every displayed fact is a reduction of
   durable events; every action is an event. No optimistic state, no inferred
   outcomes.
3. **One vocabulary across every front.** Terminal, web, CLI, and spec share
   terms and mental model. Learning one teaches the others.
4. **Every builder can act.** A product manager or designer can read a build's
   state and act on it without knowing the pipeline's internals. Precision for
   engineers never costs legibility for everyone else.
5. **Destructive intent is deliberate.** Abort and other irreversible actions
   take a second step; the first touch never writes them.
6. **Product, not this repository.** Nothing in the shipped app encodes the
   maintainer's own repository, tracker, or evidence.

## Accessibility & Inclusion

No formal standard has been adopted. The incumbent dashboard already carries
semantic landmarks, labelled regions, visible focus rings, alert roles on
errors, a polite live region while loading, and screen-reader text for step
states; future work keeps that floor. Anyone must be able to answer an
escalation on a phone-width viewport.
