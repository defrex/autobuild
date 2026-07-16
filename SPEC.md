# auto-build v2 — Specification

An agent-driven software development lifecycle system: it takes work from
*"something should be done"* to a merged PR, with a human in the loop only
where judgment matters. This is a ground-up rebuild of v1 (preserved in git
history at `6d4dce3`), keeping v1's validated ideas and replacing what it
hard-coded with real interfaces.

Status legend: sections describe **decided** design unless marked **[OPEN]**.

---

## 1. Why a rebuild

v1 proved the core loop works. Its structural limits, which motivate v2:

- **Repo as database.** Build state and artifacts lived in `build/<feature>/`
  dirs committed to the repo — accumulating noise, bloating the repo, with no
  clean archival story.
- **No observability seam.** State in local files meant no way to monitor
  builds, especially remote ones. The "UI" was tailing `build.log`.
- **Hard-coded everything.** The phase list, the verdict vocabulary, Linear,
  Sentry, and the review loop (implemented twice, differently) were all baked
  in.
- **Sentinel parsing.** Verdicts rode on stdout and were regex-parsed —
  fragile by construction.
- **Opaque agent sessions.** Near-zero insight into transcripts; no corpus
  for improving prompts or writing evals.

## 2. Constitution

Principles carried from v1 — these are non-negotiable and every design
decision below answers to them:

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state. Skills own the fuzzy parts
   (planning, reviewing, clustering); plain tested code owns the state
   machine, dedup, gating, and plumbing.
2. **Resumability is not a feature.** Re-running a build resumes it. There is
   no separate resume path; every phase is a function of durable state.
3. **Ingesters propose, humans dispatch.** Nothing auto-generated moves past
   Triage without a human grooming it to Ready. That single gate is where
   taste and prioritization live.
4. **Every step leaves a paper trail** — queryable, not carried in the repo.

## 3. System decomposition

Four kinds of things with sharp boundaries:

### 3.1 The kernel

A headless library: pipeline engine, the `converge` review-loop primitive,
event log handling, state reducer. No I/O opinions — no ticket tracker, no
telemetry vendor, no terminal.

### 3.2 Ports

Interfaces to the world, each with swappable adapters:

| Port | Duty | Initial adapters |
|---|---|---|
| `TicketSource` | list/claim/comment/transition/create tickets | Linear; later GitHub Issues, file-based |
| `AgentRunner` | run agent sessions (see §9) | Claude Agent SDK; pi (SDK mode) |
| `Workspace` | provision isolated working copies | git worktree; later remote sandbox |
| `Forge` | git + PR plumbing | GitHub |
| `TelemetrySource` | production signals | Sentry; later log streams |
| `BuildStore` | events, artifacts, transcripts (see §7) | local; remote HTTP |

### 3.3 Processes

Small, independently runnable, crash-safe:

- **build-runner** — one per build; owns one pipeline execution end to end.
  Per-build processes are deliberate: crash isolation, and the natural shape
  once builds run in remote sandboxes.
- **dispatcher** — watches the TicketSource for Ready tickets (label/state
  conditions), claims, provisions a workspace, launches build-runners up to a
  capacity limit. Cron-friendly.
- **ingesters** — outer-loop processes turning signals into proposals (§12).
- **operator** — UI process(es); see §14.

### 3.4 The event log spine

Every process appends typed events to a per-build append-only log in the
BuildStore. Consequences, by design:

- **State is a reduction of events.** Any state snapshot is a cache, never
  the source of truth. Resumability falls out.
- **The UI layer is a subscriber** plus a command channel back. TUI, web —
  same adapter pattern.
- **The audit trail is the log**, serialized.

The full event vocabulary is defined in §15. It is deliberately designed
early and carefully: it is simultaneously the store schema, the kernel's
I/O, the UI API, and the resume format. A bad event schema calcifies.

## 4. Ontology

One name, used everywhere. Every noun lives in exactly one layer.

| Term | Meaning |
|---|---|
| **Signal** | Raw input from the world — a Sentry issue, an observation |
| **Proposal** | A synthesized candidate ticket sitting in Triage, awaiting grooming |
| **Ticket** | A groomed, dispatchable unit of work in the TicketSource |
| **Build** | One pipeline execution for one ticket; has a slug; the unit the operator sees |
| **Phase** | A named stage of the pipeline grammar (§5) |
| **Round** | One iteration inside a review loop |
| **Artifact** | A durable, versioned output: spec, plan, review, report, transcript |
| **Verdict** | Structured outcome of a review/verification: `approve` \| `revise(findings)` \| `escalate(reason)` |
| **Finding** | One structured item inside a `revise` verdict (file refs, description, severity) |
| **Observation** | An out-of-scope discovery emitted mid-build: `followup` \| `refactor` \| `latent-bug` |
| **Escalation** | A parked request for human input, answerable from any UI |
| **Event** | An append-only log record; everything above leaves one |

Reserved-word discipline: **build** names the whole pipeline execution and
nothing else; the coding phase is **implement**.

### Naming propagation

A phase's name derives its skill, its events, and its artifact kind —
mechanically:

| Phase | Skill | Events | Artifact |
|---|---|---|---|
| `plan` | `/plan <build>` | `plan.started`, `plan.completed` | `plan` (rev N) |
| `plan-review` | `/plan-review <build>` | `plan-review.verdict` | `plan-review` (rev N) |
| `implement` | `/implement <build>` | `implement.completed` | diff + `implement-notes` |
| `code-review` | `/code-review <build>` | `code-review.verdict` | `code-review` (rev N) |
| `verify:e2e` | `/verify-e2e <build>` | `verify.completed {step, pass}` | `verify-report:e2e` |
| `finalize` | `/finalize <build>` | `finalize.completed` | PR ref, summary |
| `reconcile` | `/reconcile <build>` | `reconcile.started`, `reconcile.completed` | `reconcile-notes` + merge commit |

Every phase skill takes **only the build slug**; everything else it needs
comes from the store via the `ab` CLI (§8).

Installed into a repo, skill names carry the `ab-` namespace prefix
(§16.3): `/ab-plan`, `/ab-code-review`, `/ab-verify-e2e`. This spec uses
the bare phase names throughout.

## 5. Pipeline grammar

```
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize (+ finalize:*)
```

The grammar is fixed — an opinionated skeleton, not a generic workflow
engine. Exactly two extension points:

- **`verify:*`** — an ordered, configurable list of verifiers, declared in
  per-repo config. One interface: `verify(ctx) → pass | fail(report)`. Two
  subtypes: *check* (deterministic command + parser: typecheck, lint, unit
  tests) and *agent-verify* (an agent run with a pass/fail schema: e2e
  browser-driving, evals). A failure routes back to `implement` with the
  report, re-entering the code loop.
- **`finalize:*`** — optional post-steps (release notes, changelog,
  screenshots, ticket linking). Independent and failure-tolerant: a failed
  post-step files an observation; it never kills a green build.

Everything else — phase order, the two review loops, escalation semantics —
is kernel-hard-coded. That is what keeps the system inspectable.

`spec` is *not* a phase; it is satisfied at or before dispatch (§6). After
`finalize`, the build enters a post-PR epilogue owned by the dispatcher's
janitor duty (§15.7): a conflicted PR triggers the `reconcile` phase —
agent-resolved merge of base into branch, full `verify:*` re-run — repeating
until merge or close.

## 6. The spec

Two things wear the name:

### 6.1 The spec standard

A reference document defining "buildable": what/why not how, acceptance
criteria, explicit out-of-scope, evidence links. It is a shared resource
cited by **every ticket-producing surface** — `/spec`, `harvest`, every
`ingest:*`, and `dispatch`. An ingester's proposal is a spec written to the
same standard with weaker evidence.

### 6.2 The /spec skill

The human-interactive, conversational surface over the standard. It takes
a ticket rather than a build slug, because it runs before a build exists:

- `/spec` (no args) — design a feature through conversation, spec-first; on
  completion it creates the ticket via the TicketSource.
- `/spec <ticket>` — flesh out a thin existing ticket into conforming shape,
  syncing back.

### 6.3 The spec artifact

The **contract artifact of a build**: kind `spec`, revision 0, sole input to
`plan`. Pre-build, the spec lives in the ticket body; **dispatch imports it**
(`spec.imported`) or, for thin-but-groomed tickets, authors one via a
non-interactive agent pass (`spec.authored`). Three production paths, one
artifact: human-led via `/spec`, dispatch-authored, ingester-shaped.

**Dispatch quality gate:** if a Ready ticket cannot be expanded into a
conforming spec, dispatch bounces it back to Triage with a comment citing
the standard — moving failure to the cheapest point instead of launching a
build that will thrash and escalate.

**Immutability:** the spec cannot change during a build. Every downstream
reviewer approves conformance *to it*; a drifting spec silently converts
approvals into approvals-of-something-else. A phase discovering the spec
itself is wrong raises an `escalation`; a human answers, the spec gets rev
N+1, and the build restarts from `plan` (cheap — downstream was invalidated
anyway).

## 7. The build store

The v1 repo-bloat and no-observability problems share one root cause: the
repo did double duty as workspace and database. v2 splits the roles:

- **Workspace** — the sandbox/worktree. Scratch by construction: the working
  tree plus the gitignored `.ab/` dir agents use as working memory during a
  phase (§8.3). Disposable.
- **Build store** — the durable home of everything else, one logical place
  whether builds run locally or in ten remote sandboxes.

### 7.1 Data model

```
builds       id/slug, ticket ref, repo, branch, status (derived), created/updated,
             lease + heartbeat (mutable liveness columns — §15.2.6, never events)
events       build_id, seq, timestamp, actor, type, payload (JSON)   — append-only
artifacts    build_id, kind, revision, blobRef, metadata
```

Schema requirements (the exact DDL is not design-critical): simple,
normalized, defined once in **Drizzle** with two targets — SQLite
(local) and Postgres (Neon, remote). Blobs are content-addressed
(sha256) behind a narrow `BlobStore` adapter (`put(hash, bytes)`,
`get(hash)`): a plain directory locally; remotely any object store —
Vercel Blob is the likely first remote adapter, S3-compatible stores just
another adapter, never an assumption. The database stores refs, never
bulk content. The design lives in the data model and event vocabulary
(§15); the schema should stay boring.

Transcripts are an artifact kind (`transcript`) with metadata: phase, round,
role, runner, model, token counts. This one decision produces the analysis
corpus — prompt improvement, evals against the build skills, replay — as a
query rather than a project.

### 7.2 Interface and adapters

Deliberately narrow: runners need `append(event)`, `putArtifact`,
`getArtifact`, `getEvents(since)`; operator UIs add `listBuilds`,
`subscribe`.

1. **Local** — SQLite + blob directory under `~/.autobuild/`. Zero setup,
   offline, v1-parity for solo use. The repo never sees build metadata.
2. **Remote** — the same layout behind a small self-hosted HTTP API binary.
   What remote sandboxes talk to. Postgres (Neon) and any `BlobStore`
   adapter (§7.1) sit behind it without touching the interface.

`subscribe` is specced in the interface; the v2.0 implementation is polling
`getEvents(since)`. True push comes later.

### 7.3 Persistence granularity

Artifacts persist at **phase/round boundaries only**; a killed phase re-runs
from its start. Designated first exception (future, out of scope for v2.0):
**live transcript streaming**, so a web UI controlling remote agents can
watch output in real time. The store's types should reserve a streaming
revision concept even while no adapter implements it.

### 7.4 Resumption across sandboxes

Because state is the event log and artifacts live in the store, a *new*
sandbox can resume a build a dead sandbox started: pull events, rehydrate
scratch from latest artifact revisions, continue. v1 structurally could not
do this.

### 7.5 What the PR gets

A summary comment — verdict history, verification results, links into the
store. The full audit trail is queryable, not committed to the branch.

## 8. The `ab` CLI

The **only** channel between agents and the store — and the enforcement
point of the entire ontology. Designed by walking every phase's session from
first command to terminal command, plus the failure paths (§8.7). Decisions
forced by the walkthrough are marked **[D5]–[D8]**, continuing §15's series.

It buys three properties at once:

1. **Storage-agnostic skills** — local or remote store, same commands.
2. **An enforced ontology** — the CLI validates schemas at deposit; verdicts
   travel a typed channel, never parsed from stdout (the root-cause fix for
   v1 sentinel parsing).
3. **Structured observations at the point of capture**, not prose mined from
   `observations.md` after the fact.

The kernel's job then reduces to: read the event log, decide the next phase
per the transition table, invoke the AgentRunner with `/{skill} {build}`,
wait for the terminal event, repeat.

### 8.1 Invocation model and ambient auth [D8]

The runner launches every session with environment set:

```
AB_STORE     # store URL or local path
AB_BUILD     # build slug
AB_PHASE     # current phase (+ round)
AB_SESSION   # session id
AB_TOKEN     # scoped token (remote store)
```

The skill still takes the build slug as its one argument (prompt clarity,
human invocability), but the CLI resolves everything from the environment —
and **the token is scoped to this build and session**: an agent physically
cannot append to another build's log or read another build's artifacts.
Least privilege comes from the runner, not from prompt instructions.

### 8.2 Command surface

| Command | Purpose | Terminal? |
|---|---|---|
| `ab context [--json]` | hydrate `.ab/` with the phase's inputs; print the manifest | no |
| `ab artifact put <kind> <file>` | deposit a versioned artifact → returns rev | no |
| `ab artifact get <kind>[@rev]` | fetch an artifact within own build | no |
| `ab observe --kind <followup\|refactor\|latent-bug> [--files …] <summary>` | structured observation, any phase, any time | no |
| `ab server <start\|stop\|restart\|status\|logs>` | dev-server lifecycle, config-driven (§16.2); `implement` and `verify` phases only | no |
| `ab done [--notes <file>]` | complete a producer phase (validates, then runs phase plumbing) | **yes** |
| `ab verdict <approve\|revise\|escalate\|pass\|fail> [--findings <json>] [--notes <file>] [--reason …]` | complete a review/verify phase | **yes** |
| `ab escalate <question> [--refs …]` | park the build for human input | **yes** |

The verdict vocabulary is phase-dependent and the CLI enforces it:
review phases accept `approve|revise|escalate`; agent-verify steps accept
`pass|fail`. Deterministic checks never touch the CLI — the kernel runs
them directly.

### 8.3 What `ab context` materializes

A phase-scoped hydration into the gitignored scratch dir:

```
.ab/
  context.json      # manifest: build, phase, round, artifact revs,
                    #   required deposits, allowed terminal commands
  spec.md
  plan.md           # per phase needs (see table)
  findings.json     # current feedback, when round > 1
  history/          # prior-round artifacts where the phase needs them
  verify/           # failure reports routed back to implement
```

The manifest tells the agent its contract — `required` deposits and
`allowedTerminals` — so skills are self-checking against the same data the
CLI validates with. Per-phase inputs and terminals:

| Phase | Materialized inputs | Terminal |
|---|---|---|
| `plan` | ticket, spec; prior plan rev + findings (round > 1) | `done` (requires `plan` artifact) |
| `plan-review` | spec, plan@latest, all prior rounds' findings (for `persists` marking) | `verdict` (requires notes artifact) |
| `implement` | spec, approved plan, feedback (findings **or** verify report), own prior notes | `done` (requires clean worktree + notes) |
| `code-review` | spec, plan, commit range `{base, head}`, prior findings, implement-notes | `verdict` |
| `verify:<step>` (agent) | spec (acceptance criteria), step config, commit range | `verdict pass\|fail --report` |
| `finalize` | spec, plan, verify reports, PR template config | `done` (requires `pr-description` artifact) |
| `reconcile` | spec, plan, implement-notes, conflict `{baseSha}` | `done` (requires merge commit present) |

Scoping is deliberate: the planner never sees code-review rounds; the
reviewer sees prior findings but not the producer's session. What a phase
*can't* see is part of its design.

### 8.4 Terminal discipline [D5]

**Every phase ends with exactly one terminal command** — `done`, `verdict`,
or `escalate`. The CLI rejects a second terminal call, and each terminal
validates its preconditions before emitting the phase event (no `done`
without the required artifacts; no `done` on a dirty worktree in
`implement`). A session that ends **without** any terminal call is an infra
failure: the runner emits `phase.failed {error: "no-terminal"}` and applies
retry policy. This completes the sentinel-parsing replacement: success is
only expressible through the typed channel, so "the agent rambled and
exited" can never be misread as completion.

### 8.5 Atomic deposits, validation as feedback [D6]

Terminal commands are **atomic bundles**: `ab verdict revise --findings
f.json --notes review.md` stores the notes artifact, validates and
id-stamps the findings, and appends the `*.verdict` event in one operation —
there is no state where an artifact exists without its event or vice versa.
Validation failures (malformed findings JSON, missing required artifact)
return the schema and a precise error to the agent *in-session*, so the
correction loop is immediate and cheap — schema errors are agent feedback,
not build failures.

### 8.6 Agents never touch the remote [D7]

All `git push`, PR creation, and forge API calls happen kernel-side, as
plumbing triggered by terminal commands: `ab done` in `implement` pushes the
branch and records `{base, head}`; `ab done` in `finalize` has the kernel
open the PR using the deposited `pr-description` artifact. Agents only ever
commit locally. Consequences: forge credentials **never enter the sandbox**
(load-bearing once builds run on remote sandboxes), and the push-at-boundary
rule from [D3] is enforced by construction rather than convention.

### 8.7 Walkthroughs

**Happy path, one code-loop round-trip:**

```
implementer:  ab context → (work, commit) → ab observe --kind refactor "…"
              → ab done --notes .ab/implement-notes.md
                  ⇒ validates clean worktree, pushes branch,
                    emits implement.completed {commits, artifact}
reviewer:     ab context   (gets spec, plan, {base,head}, prior findings)
              → ab verdict revise --findings f.json --notes review.md
                  ⇒ stamps finding ids, stores artifact,
                    emits code-review.verdict
implementer:  ab context   (findings.json now materialized) → …
```

**Failure paths:**

- *Silent session end* (no terminal) → `phase.failed {no-terminal}`, retry
  per policy [D5].
- *Malformed deposit* → rejected in-session with schema + error; agent
  corrects and retries [D6].
- *Crash after deposits, before terminal* → artifacts are revisioned; the
  re-run phase deposits fresh revs; orphaned revs are harmless history.
- *Wrong-build write* → token scope rejects it at the store [D8].
- *Store unreachable* → CLI retries with backoff; a phase that cannot
  deposit cannot complete → `phase.failed`, runner-level policy takes over.

### 8.8 Outer-loop namespace (deferred)

Pre-build surfaces need a small separate namespace: `ab ticket create`
(the `/spec` skill filing a groomed ticket) and `ab ticket propose`
(ingesters filing to Triage), plus ledger operations for ingesters. Same
binary, same ambient-auth model, different scope — detailed design belongs
to the outer-loop/ingester thread, not here.

## 9. AgentRunner

Session-based, because review loops need memory:

```ts
interface AgentRunner {
  start(opts: { skill, buildSlug, workspace, model, … }): Session
  continue(session, message): Result    // review-loop rounds
  end(session): Transcript              // → store, always
}
```

- **Adapters:** Claude Agent SDK (subscription billing) for Claude models;
  **pi in SDK mode** for all other models. Both behind the interface —
  preferences may change per project and over time.
- **Routing:** a role → runner/model map in per-project config, generalizing
  v1's `harnessMap`. Mixing models across roles is intentional — a different
  reviewer catches more.
- **Transcripts come back through the interface**, not scraped from disk, so
  every adapter must produce one: the corpus is guaranteed complete.
- Adapters without native session resumption (and post-sandbox-death
  resumes) implement `continue` as start-with-rehydrate-from-store — which
  must exist anyway per §7.4.

## 10. The review loop (`converge`)

One generic primitive, used for both the plan loop and the code loop:

```ts
converge<A>(
  produce:  (feedback: Feedback | null) => Promise<A>,    // planner | implementer
  review:   (artifact: A) => Promise<Verdict>,            // plan-reviewer | code-reviewer
  policy:   { maxRounds, escalateOn, reviewerRunner, … }
// Feedback = findings from a verdict, or a verify failure report (§5)
): Approved<A> | Escalated
```

- **Structured verdicts** (`approve | revise(findings) | escalate(reason)`),
  deposited via `ab verdict`. Findings are structured (file refs,
  description, severity) so round N+1's producer prompt is assembled
  deterministically, not "here's what the reviewer said."
- **Memory model:** producer *continues* its session across rounds; reviewer
  gets a *fresh* session each round (a fresh skeptic catches more). Both are
  policy knobs.
- **Anti-stall rule:** new findings round-over-round is normal; the *same*
  finding surviving N rounds is a disagreement between two agents and
  auto-escalates rather than burning rounds (mechanics in §15.4: the
  reviewer marks persistence — judgment; the kernel applies the threshold —
  determinism).

## 11. Escalation

An escalation is an **event**, answerable from any UI — not a file to go
find. When a build parks, the operator surface shows it among the blocked
builds with the question and an answer channel (an `escalation.answered`
event — commands are events, §15.2.7). The durable record is in the store
like everything else.

## 12. The outer loop

```
signals (telemetry, observations)
   → ingest:* / harvest        (signal source → dedup ledger → cluster/synthesize → propose)
   → Triage (proposals)
   → groom                     (the human gate — named in the ontology, no skill)
   → Ready
   → dispatch                  (claim → workspace → spec import/author → launch build-runner)
   → build → PR → merge
```

- **One ingester pattern**, per-source differences live in the source
  adapter: `ingest:sentry` filters by frequency/users/recency/deploy
  staleness; `harvest` clusters and dedups observations. Both cite the spec
  standard so proposals are born as spec-like as their evidence allows.
- **Observations are structured events** emitted mid-build via `ab observe`
  (`followup | refactor | latent-bug`, with file/ticket refs). `harvest`
  clusters records, not prose; dedup is cheap.
- v1's load-bearing mechanics carry forward: the dedup ledger (a processed
  signal never re-files), claim-before-launch (no double-dispatch),
  single-writer ingester discipline.

## 13. Ticket source policy

The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) at claim time as part of initiation; after import, the
build never reads the tracker again. Human-legibility projections (spec
posted as a comment, final summary, status transitions) flow outward only.
This keeps the abstraction honest: a file-based TicketSource with nowhere to
put blobs must be fully workable.

## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events in the same log
(§15.2.7): `escalation.answered`, `build.pause-requested`,
`build.resume-requested`, `build.abort-requested`. The event vocabulary
*is* the UI API.

- v2.0 front end: terminal, with herdr as the multiplexer.
- Later: web UI and others — same adapter pattern against the same store.
- The operator's job across many concurrent builds: see status at a glance,
  find blocked builds, answer escalations, inspect any build's trail.

## 15. Event vocabulary

Drafted by walking one build's happy path end to end, then three unhappy
paths (verify failure, review stall, sandbox death). Four decisions this
exercise forced are marked **[D1]–[D4]**; all four are **confirmed**
(2026-07-15), with [D1] extended to cover merge standardization and
conflict resolution (§15.7).

### 15.1 Envelope

Every event shares:

```jsonc
{
  "build": "auth-rate-limit",     // build slug
  "seq": 42,                      // per-build, monotonic, assigned by the store on append
  "ts": "2026-07-15T14:03:22Z",   // assigned by the store
  "actor": { "kind": "agent", "role": "code-review", "session": "s_9f2" },
  "type": "code-review.verdict",
  "payload": { /* per-type, below */ }
}
```

`actor.kind ∈ kernel | agent | human | dispatcher | ingester`. Agents carry
`role` and `session`; humans carry `user`. The store assigns `seq` and `ts`
so producers can't fake ordering.

### 15.2 Conventions

1. **Closed vocabularies live in type names; open ones live in payloads.**
   Phases are a closed set → `plan.completed`. Verify and finalize steps are
   config-defined (open) → `verify.completed {step: "e2e"}`.
2. **Events carry facts, never derived state.** Build status is a reduction
   (§15.5); no event ever says "status is now X".
3. **Blobs live in artifacts; events carry refs** `{kind, rev}`.
4. **[D3] Code travels through the Forge, never the store.**
   `implement.completed` pushes the branch; events carry commit SHAs only.
   This is what makes cross-sandbox resume work (§15.6-C) and keeps the
   store lean.
5. **Append-only; corrections are new events.**
6. **Liveness is not history.** Heartbeats and runner leases are mutable
   columns on the `builds` table, never events — they would drown the log.
7. **[D2] Operator commands are events in the same log.** Humans append
   `*-requested` events; the kernel acknowledges with fact events. The store
   is the *only* coordination surface — no side channel — and polling covers
   commands exactly the way it covers `subscribe`. A runner that is dead
   still receives its commands on resume.

### 15.3 Catalog

**Build lifecycle**

| Type | Actor | Payload |
|---|---|---|
| `build.created` | dispatcher, human | `{ticket: {source, id, url, title}, repo, baseBranch}` |
| `build.completed` | dispatcher | `{outcome: merged \| closed-unmerged \| abandoned}` |
| `runner.attached` | kernel | `{instance, host, resumedFromSeq?}` |
| `workspace.provisioned` | dispatcher, kernel | `{provider, ref, branch}` |
| `workspace.released` | dispatcher, kernel | `{}` |

**Operator commands [D2]**

| Type | Actor | Payload |
|---|---|---|
| `build.pause-requested` / `build.resume-requested` / `build.abort-requested` | human | `{reason?}` |
| `build.paused` / `build.resumed` / `build.aborted` | kernel | `{}` (acknowledgements) |

**Spec**

| Type | Actor | Payload |
|---|---|---|
| `spec.imported` | dispatcher | `{artifact: {kind: "spec", rev: 0}, ticket}` |
| `spec.authored` | agent | `{artifact, session}` |
| `spec.revised` | kernel | `{artifact: {rev: N}, escalation: seq}` |

**Sessions** (every agent run is bracketed by these; the transcript link is
what guarantees the analysis corpus)

| Type | Actor | Payload |
|---|---|---|
| `session.started` | kernel | `{session, role, runner, model, phase, round?}` |
| `session.ended` | kernel | `{session, transcript: {kind: "transcript", rev}, usage: {inputTokens, outputTokens, turns}}` |

**Plan loop / code loop** (symmetric by design)

| Type | Actor | Payload |
|---|---|---|
| `plan.started` | kernel | `{round, feedback?: {findings: [id]} \| {guidance: {escalation, answer}}}` (symmetric with `implement.started` — §15.6-B guidance must reach a fresh producer session) |
| `plan.completed` | agent | `{round, artifact: {kind: "plan", rev}}` |
| `plan-review.started` | kernel | `{round}` |
| `plan-review.verdict` | agent | `{round, verdict, findings: [Finding], artifact: {kind: "plan-review", rev}}` |
| `implement.started` | kernel | `{round, feedback?: {findings: [id]} \| {verify: {step, report}}}` |
| `implement.completed` | agent | `{round, commits: {base, head}, artifact: {kind: "implement-notes", rev}}` |
| `code-review.started` | kernel | `{round}` |
| `code-review.verdict` | agent | `{round, verdict, findings, artifact}` |

**Verify / finalize**

| Type | Actor | Payload |
|---|---|---|
| `verify.started` | kernel | `{step, attempt}` |
| `verify.completed` | kernel, agent | `{step, attempt, pass, report?: {kind, rev}}` |
| `finalize.started` | kernel | `{}` |
| `finalize.completed` | kernel | `{pr: {number, url, headSha}}` (kernel opens the PR after the agent's `ab done` — [D7], §8.6) |
| `finalize.step-completed` | agent | `{step, ok, note?}` |

**Post-PR [D1]** (see §15.7; `pr.*` emitted by the dispatcher acting as
janitor, `reconcile.*` by a re-attached build-runner)

| Type | Actor | Payload |
|---|---|---|
| `pr.merged` | dispatcher | `{sha}` |
| `pr.closed` | dispatcher | `{}` |
| `pr.conflicted` | dispatcher | `{baseSha}` |
| `reconcile.started` | kernel | `{attempt, baseSha}` |
| `reconcile.completed` | agent | `{mergeCommit, artifact: {kind: "reconcile-notes", rev}}` |

**Cross-cutting**

| Type | Actor | Payload |
|---|---|---|
| `observation.recorded` | agent | `{id, kind: followup \| refactor \| latent-bug, summary, files?, refs?}` |
| `escalation.raised` | agent, kernel | `{id, phase, round?, source: agent \| stall \| policy, question, refs?}` |
| `escalation.answered` | human | `{id, answer, resolution: guidance \| dismiss-finding \| revise-spec \| abort}` |
| `phase.failed` | kernel | `{phase, round?, attempt, error, willRetry}` (infra failure — distinct from verdicts) |

### 15.4 Finding schema and stall mechanics [D4]

```jsonc
Finding {
  "id": "f_3a91",                 // kernel-assigned at deposit, stable for the build
  "severity": "blocking" | "important" | "minor",
  "file": "src/auth.ts",          // optional
  "lines": [40, 62],              // optional
  "summary": "…",
  "detail": "…",                  // optional
  "persists": ["f_1c22"]          // reviewer-marked: earlier findings this one continues
}
```

Stall detection splits along the constitution's line: deciding whether a new
finding is *the same disagreement* as an earlier one is fuzzy → **judgment**
→ the reviewer (fresh each round) receives the prior rounds' findings and
marks `persists`. Applying the threshold is mechanical → **determinism** →
the kernel raises `escalation.raised {source: "stall"}` when any persistence
chain survives `policy.stallRounds` rounds.

### 15.5 Derived state (the reducer)

`status ∈ queued | running | paused | blocked | done | aborted`, plus
`{phase, round, openEscalations[], pr?, lastEvent}`. `blocked` ≡ an
`escalation.raised` without a matching `escalation.answered`; `paused` ≡ a
`build.paused` without a later `build.resumed`. The operator UI's build
list is exactly this reduction over every build in the store.

### 15.6 Walkthroughs

**Happy path** (elided: `session.started/ended` brackets around every agent
run):

```
build.created → workspace.provisioned → spec.imported → runner.attached
plan.started{r1} → plan.completed{plan@1}
plan-review.started{r1} → plan-review.verdict{approve}
implement.started{r1} → implement.completed{commits, notes@1}
code-review.started{r1} → code-review.verdict{approve}
verify.started{types} → verify.completed{pass} → …unit → …e2e → …evals
finalize.started → finalize.completed{pr} → finalize.step-completed{release-notes}
(later, janitor:) pr.merged → workspace.released → build.completed{merged}
```

**A — verify failure:** `verify.completed {step: e2e, pass: false, report}` →
kernel routes back into the code loop: `implement.started {round: 2,
feedback: {verify: {step, report}}}` → fix → `code-review` round 2 →
approve → verify re-runs **from the first step** (implement changed the
code; cheap checks first), `attempt: 2`. `policy.maxVerifyAttempts`
exhausted → `escalation.raised {source: "policy"}`.

**B — review stall:** round 1 `code-review.verdict {revise, [f1]}` → round 2
verdict's finding marks `persists: [f1]` → round 3 again → kernel:
`escalation.raised {source: "stall", refs: [chain]}`; status → `blocked`.
`escalation.answered {resolution: "guidance"}` feeds the answer into the next
producer round as authoritative feedback; `dismiss-finding` marks the chain
human-resolved and the next reviewer round is told so.

**C — sandbox death:** log ends at `implement.started {round: 2}`; heartbeat
column goes stale → dispatcher expires the lease, provisions a fresh
sandbox → `workspace.provisioned` → `runner.attached {resumedFromSeq}` →
reducer says implement r2 started-not-completed → re-run the phase from its
start: fetch the branch at round 1's pushed `head` [D3], `ab context`
rehydrates scratch from the store, fresh session. Uncommitted round-2 work
is lost by design (§7.3 — phase boundaries are the resume points).

### 15.7 Post-PR lifecycle [D1 — confirmed]

Walking the happy path exposed a gap in the grammar: `finalize` creates the
PR, but *something* must watch it to merge/close, release the workspace, and
emit `build.completed`. v1 solved this with `monitor` + `cleanup` phases;
v2 makes it a deterministic **janitor duty of the dispatcher** (which
already polls on cron): it checks open PRs for its builds, emits
`pr.merged`/`pr.closed`/`pr.conflicted`, releases workspaces, and completes
builds. A merged-PR fixup request is a *new ticket*, never a reopened build.

**Merge standard: one rule per direction, never rebase.**

- **PR → main: squash merge.** Main stays linear, one commit per build —
  which keeps reverts (one commit → one new ticket), release notes, and
  history archaeology clean. `pr.merged {sha}` records the squash commit as
  the build's landing point.
- **main → feature branch: merge commit.** A stale branch is refreshed by
  merging base *into* it, resolving conflicts once against current main.
- **Rebase is banned**, for two reasons. Operationally: at this system's
  merge velocity, a rebase re-resolves conflicts commit-by-commit against a
  target that keeps moving — by the time the agent finishes, two more PRs
  have landed and it starts over; agents can be stuck in
  rebase-conflict-after-rebase-conflict nearly indefinitely (observed in
  practice). Structurally: rebase rewrites the branch and severs the SHAs
  recorded in `implement.completed` events [D3]. Squash-at-merge is safe on
  both counts — it creates a new commit on main without rewriting the
  branch, so mid-build provenance is untouched.

**Conflicts re-enter the pipeline via `reconcile`.** When the janitor's
mergeability check fails it emits `pr.conflicted {baseSha}` and re-attaches
a build-runner (the dispatcher itself never runs agents). The runner
executes the `reconcile` epilogue phase: an agent merges base into the
branch guided by the spec, plan, and implement-notes, with the explicit
charge to regress against neither; the resolution lands as a merge commit
(`reconcile.completed {mergeCommit}`; the push is `ab done` plumbing per
[D7]). Because reconciliation changed code, **`verify:*` re-runs in full**;
a failure routes back into the code loop as usual (§5). A resolution the
agent judges risky — semantic conflicts, spec-relevant choices — escalates
rather than guesses. Reconcile output skips
`code-review` by default (escalation covers the judgment cases;
`policy.reconcileReview` can force it), and `policy.maxReconcileAttempts`
bounds thrash against a busy base.

The grammar's tail is thus an epilogue loop, outside the mainline:

```
finalize → ( pr.conflicted → reconcile → verify:* )* → merged | closed
```

## 16. Per-repo configuration and installation

Decisions here continue the series: **[D9]** declarative repo config,
**[D10]** kernel-owned server lifecycle, **[D11]** vendored editable skills.

### 16.1 `autobuild.toml` [D9]

One declarative file at the repo root. It is read **from the build's
branch** at workspace provision, so every build sees one consistent config —
and because it is repo-versioned, changes to it flow through the pipeline
itself: the system can retune its own configuration via a ticket and a PR.

```toml
[project]
baseBranch = "main"

[commands]                      # deterministic verbs the kernel may run
setup = "bun install"           # after provision / sandbox rehydrate (§15.6-C)
lint = "bun lint"
typecheck = "bun tsc --noEmit"
test = "bun test"

[server]                        # dev-server lifecycle — see §16.2
start = "bun dev"
url = "http://localhost:3000"   # readiness probe target
readyTimeout = 60               # seconds

[verify]
steps = ["types", "unit", "e2e"]
[verify.types]
kind = "check"                  # deterministic: command + pass/fail
command = "typecheck"           # ref into [commands]
[verify.e2e]
kind = "agent"                  # agent-verify: skill + verdict schema
skill = "ab-verify-e2e"
needsServer = true

[finalize]
steps = ["release-notes"]       # optional post-steps, failure-tolerant (§5)

[roles]                         # role → runner/model routing (v1 harnessMap, generalized)
plan = { runner = "claude" }
code-review = { runner = "pi", model = "…" }

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3

[dispatcher]
capacity = 3                    # concurrent builds for this repo
readyLabels = ["autobuild"]

[outer]                         # cron schedules for outer-loop processes
"ingest:sentry" = { cron = "0 */4 * * *" }
harvest = { cron = "0 9 * * *" }
```

Declarative (TOML), not executable config: the kernel, dispatcher, CLI, and
any future tooling parse it without evaluating anything; commands are plain
shell strings.

### 16.2 Server lifecycle [D10]

**Config declares; the kernel owns.** The dev server matters most for e2e
verification and must work identically local and sandboxed:

- Readiness is a probe: hit `server.url` until success or `readyTimeout`.
- Verify steps with `needsServer = true` get a running server before their
  session starts.
- Agents in `implement` and `verify` phases control it only through
  `ab server start|stop|restart|status|logs` (§8.2) — deterministic,
  config-driven plumbing; no ad-hoc process hunting, and `ab server logs`
  gives agents the feedback loop they actually need when e2e fails.
- The kernel guarantees teardown at phase end via process-group ownership: a
  dead session can never orphan a server.

### 16.3 Skill installation: vendored, namespaced, editable [D11]

This project ships the **canonical default skills** (`plan`, `plan-review`,
`implement`, `code-review`, agent-verify steps, `finalize`, `reconcile`,
`spec`, and the outer-loop skills). `ab init` installs into a repo:

- Writes an `autobuild.toml` template.
- **Copies** the default skills into the repo's skill directory, namespaced
  `ab-*` (e.g. `.claude/skills/ab-code-review/`). Copies, not references —
  per-repo customization is the point: this repo's code-review standards,
  this repo's e2e driving instructions, live in the vendored skill.
- Marks skills **non-agent-invocable** (`disable-model-invocation`) except
  `ab-spec` — phase skills are invoked explicitly by the runner or a human,
  never auto-triggered by a model pattern-matching a description.

**Upgrades** are the classic vendoring problem: `ab init` records the
pristine version of each installed skill; `ab upgrade` three-way merges
(pristine base × local edits × new default). Merge conflicts go to an
**agent**, with a standing bias: **prefer the local customization** —
upstream changes are adopted where they don't collide with what the repo
deliberately changed. Only when the correct resolution is genuinely
ambiguous does the agent escalate to a human. Local customization survives
upgrades; divergence is visible instead of silent.

## 17. Out of scope for v2.0 (explicitly)

- True push `subscribe` (interface reserved; polling implementation).
- Live transcript streaming (types reserved; boundary persistence only).
- Web UI (seam designed; terminal first).
- Generic workflow DAGs (the grammar is fixed; extension via `verify:*` and
  `finalize:*` only).

## 18. Open threads

1. **[OPEN] Event payload schemas** — §15 decisions confirmed; remaining:
   freeze payloads as versioned JSON Schema at implementation time.
2. **[OPEN] Outer-loop detail** — the ingester thread: the `ab ticket`
   namespace (§8.8), ledger operations, per-source filter design.
3. **[OPEN] Retention/archival policy** — the v1 archival gap, now a store
   config concern rather than a repo problem. Needs a default (e.g. prune
   blobs for merged builds after N months, keep events).
4. **[OPEN] Global capacity** — per-repo capacity lives in `[dispatcher]`
   (§16.1); whether a cross-repo global cap is needed, and where it lives,
   is unresolved.
