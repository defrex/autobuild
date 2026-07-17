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
   transitions, signal identity, or state. Agent surfaces own the fuzzy parts
   (primarily skills, plus narrow pre-build seams such as naming); plain tested
   code owns the state machine, validation, fallback, dedup, gating, and
   plumbing.
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
| `TicketSource` | list/claim/comment/transition/create tickets; resolve declared dependencies | file-based (the zero-config default); Linear; later GitHub Issues |
| `AgentRunner` | run agent sessions (see §9) | Claude Agent SDK; pi (SDK mode) |
| `Workspace` | provision isolated working copies | git worktree; later remote sandbox |
| `Forge` | git + PR plumbing | GitHub |
| `TelemetrySource` | production signals | Sentry; later log streams |
| `BuildStore` | per-build streams plus repository journals: events, artifacts, transcripts, leases (see §7) | local; remote HTTP |

### 3.3 Processes

Small, independently runnable, crash-safe:

- **build-runner** — one per build; owns one pipeline execution end to end.
  Per-build processes are deliberate: crash isolation, and the natural shape
  once builds run in remote sandboxes.
- **dispatcher** — watches the TicketSource for Ready tickets (label/state
  conditions), claims, establishes the final conforming spec, chooses a short
  immutable build slug, provisions a workspace, and launches build-runners up
  to a capacity limit. On process startup it also attempts every current build
  for its repo, so re-running `ab dispatch` resumes durable work rather than
  only looking for new tickets. Each tick also owns observation back-pressure:
  it resumes an unfinished repository harvest, or starts one when the configured
  count threshold is reached. Cron-friendly.
- **harvest-runner** — one staged repository workflow (`scan → synthesize ⇄
  review → file`) under a repository lease; not a build and not a phase.
- **ingesters** — other outer-loop processes turning signals into proposals (§12).
- **operator** — UI process(es); see §14.

### 3.4 The event log spine

Build processes append typed events to per-build logs; repository-scoped outer
workflows append to a separate repository journal in the same BuildStore.
Consequences, by design:

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
| **Harvest run** | One repository-scoped claimed observation snapshot and staged proposal workflow; never a build |
| **Phase** | A named stage of the build pipeline grammar (§5) |
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

**Build identity at dispatch:** once the final conforming spec is in hand
(including a successfully authored replacement), dispatch asks the selected
runtime for a one-shot name derived from the substance of that full spec. The
base is one to three lowercase ASCII kebab tokens. The dispatcher validates the
proposal without repairing it, then checks the whole BuildStore for collisions;
`-2`, `-3`, and so on are appended after validation and do not count against the
three-token base. The slug and `ab/<slug>` branch are recorded once and never
renamed, so existing and in-flight builds are untouched.

Naming is optional judgment, not a pipeline phase. It uses the `[agent]`
default pair unless the open `[roles]` map supplies a `slug` override. The
runtime capability is one-turn and tool-free. Absence, invalid output,
rejection, or a fixed dispatcher-owned deadline all take the deterministic
first-three-tokens-of-kebab(title) fallback (`build` for an empty normalized
title); naming failure never prevents build creation. Validation, timeout,
fallback, and uniqueness remain deterministic dispatcher policy.

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
repo_streams repo, created/updated, lease + heartbeat
repo_events  repo, seq, timestamp, actor, type, payload (JSON) — append-only
repo_artifacts repo, kind, revision, blobRef, metadata
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

Deliberately narrow: build runners need `append(event)`, `putArtifact`,
`getArtifact`, `getEvents(since)`; operator UIs add `listBuilds`, `subscribe`.
The same contract has repository-scoped `ensureRepo`, event/artifact deposit and
read methods, plus a repository lease. Build methods and reducers remain
unchanged for build callers.

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

A harvest session instead carries `AB_REPO`, `AB_HARVEST`, and an `AB_PHASE` of
`synthesize@N` or `review@N`. The AgentRunner invocation argument is opaque: a
build skill receives its slug; a harvest skill receives its run id. The CLI
resolves identity from ambient auth, and remote tokens distinguish build from
repository resources as well as session attribution. A leaked harvest token
cannot read a build stream and vice versa. Least privilege comes from the
runner, not prompt instructions.

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

### 8.8 Outer-loop namespace

Human/pre-build ticket creation remains `ab ticket create`. Observation harvest
uses a typed, repository-scoped namespace:

| Command | Scope | Purpose |
|---|---|---|
| `ab harvest context` | harvest session | rebuild `.ab/` with claimed observations, reconciled ledger, proposals, prior findings |
| `ab harvest submit <json>` | synthesize terminal | validate exact occurrence coverage and deposit a proposal artifact/event |
| `ab harvest verdict <approve\|revise\|escalate> …` | review terminal | deposit notes, stamped findings, and structured verdict |
| `ab harvest status [--events N] [--json] [--store …]` | operator/read-only | reduce and display the latest repository run |

Agents never receive TicketSource credentials. Only the deterministic file step
creates/adopts approved proposals and commits ledger facts.

## 9. AgentRunner

Session-based, because review loops need memory:

```ts
interface AgentRunner {
  start(opts: { skill, invocation, workspace, model, … }): Session
  continue(session, message): Result    // review-loop rounds
  end(session): Transcript              // → store, always
}
```

Pre-build naming does not widen this session/skill contract. A runtime may
separately register an optional one-shot completion capability
(`{prompt, cwd, env, model?, signal?} → {text}`), used without tools and without
entering the resumable session map. A runtime without it is valid and causes the
deterministic naming fallback (§6.3).

- **Adapters:** Claude Agent SDK (subscription billing) for Claude models;
  **pi in SDK mode** for all other models (Kimi/Moonshot, GPT/OpenAI). Both
  registered runtimes behind the interface — preferences may change per project
  and over time. A future Claude Code print-mode access path registers as a
  *distinct runtime name*, never a mode flag on an existing one.
- **Routing — two independent axes (§16.1):** the *runtime* that executes a
  session and the *model* it runs on. Both are set once as a repo-wide default
  (`[agent]`) and overridden per step (`[roles]`), generalizing v1's
  `harnessMap`. Overrides resolve **most-specific-first**: `runtime + model`
  pins exactly that pair (a runtime that cannot serve the model is a config
  error); `runtime` alone uses that runtime's own default model; `model` alone
  routes to a runtime that serves it — the default runtime when it qualifies,
  else the single supporter (zero, or several non-default supporters, is a loud
  config error); `neither` is the default pair. Each runtime declares the model
  families it serves, so the whole config resolves **eagerly, before any
  session launches** — an unregistered runtime never silently falls back.
  Adding a runtime touches only the adapter registry, never the kernel. Mixing
  models across roles is intentional — a different reviewer catches more. The
  resolved runtime and model are recorded on every `session.started` (the
  frozen `runner` field carries the resolved runtime name), so an experiment's
  outcome is attributable to the configuration that produced it.
- **Transcripts come back through the interface**, not scraped from disk, so
  every adapter must produce one: the corpus is guaranteed complete.
- Adapters without native session resumption (and post-sandbox-death
  resumes) implement `continue` as start-with-rehydrate-from-store — which
  must exist anyway per §7.4.

## 10. The review loop (`converge`)

One generic primitive, used for the plan loop, code loop, and harvest's
synthesize/review loop:

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

Policy escalations caused by an exhausted bounded retry/round budget are the
narrow exception to the human-answer rule: a fresh `ab dispatch` invocation
answers them with `resolution: retry` and attempts the build from durable
state. This is an explicit process-restart retry boundary, not a watch-tick
loop; agent and stall escalations remain human judgment gates.

## 12. The outer loop

```
signals (telemetry, observations)
   → ingest:* / harvest        (signal source → dedup ledger → cluster/synthesize → propose)
   → Triage (proposals)
   → groom                     (the human gate — named in the ontology, no skill)
   → Ready
   → dispatch                  (claim → spec import/author → name → workspace → launch build-runner)
   → build → PR → merge
```

Other ingesters such as `ingest:sentry` remain schedule-driven through
`[outer]`. Observation harvest is different: the already-running dispatcher
counts structured `observation.recorded` envelopes across this repository on
each tick. Below `[harvest].threshold` it does nothing. At or above the
threshold it selects the whole current accumulation and starts one staged run;
a started run atomically claims its immutable occurrence snapshot, and
observations arriving later wait for the next threshold.

Occurrence identity is `{build slug, event seq}` — never payload id or a scalar
high-water mark, because event sequences are per build. The repository journal
is separate from build streams and reduces to run/step state, claims, review
history, filing facts, and the authoritative committed disposition ledger.
A repository lease plus dispatch's serialized operation queue enforces one
harvest at a time.

The fixed workflow is:

1. **scan (deterministic)** — subtract all claimed occurrences, reconcile prior
   proposal tickets through TicketSource lifecycle facts (including
   resolved/missing tombstones), and atomically store the scan packet with
   `harvest.started`.
2. **synthesize ⇄ review (judgment through `converge`)** — the continuing
   producer clusters same-problem records and authors typed create/join/suppress
   proposals; a fresh reviewer checks exact coverage, semantic dedup, spec
   quality, and evidence. `revise` findings feed the next producer round;
   `maxReviewRounds` and `stallRounds` bound the loop. Only approval advances.
3. **file (deterministic)** — render creates to the spec standard, target the
   configured Triage state explicitly, and create/adopt through a stable
   cluster idempotency key. Per-proposal filing facts close the external-create
   crash window; one terminal event commits every occurrence disposition.

The harvester only proposes: it never claims, readies, grooms, or dispatches a
proposal. A terminal escalation consumes its claimed snapshot so watch ticks do
not hot-loop. Completed/cancelled/missing proposal refs remain dedup tombstones.
Every step brackets start/result events and agent sessions/transcripts, and the
latest run appears as a visibly literal, nonselectable `HARVEST` row in the
dispatch dashboard. Humans still own Triage → Ready.

## 13. Ticket source policy

The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) at claim time as part of initiation; after import, the
build never reads the tracker again. Human-legibility projections (spec
posted as a comment, final summary, status transitions) flow outward only.
This keeps the abstraction honest: a file-based TicketSource with nowhere to
put blobs must be fully workable.

**Ticket dependencies.** A ticket may declare that it is blocked by other
tickets of the same source, at creation (`ab ticket create --blocked-by`).
The source owns both halves of what a provider-neutral caller cannot know:
how a blocker relationship is *represented* (Linear issue relations; the file
source's TOML `blockedBy`) and what *complete* means for one (Linear's
`state.type`; the file source's `Done`). The dispatcher owns the decision
built on those facts — an unresolved blocker means the ticket is not claimed
and not dispatched, and it creates no build. Dependencies are written at
creation and read at dispatch time, both of which are **initiation**, so the
rule above — never consulted mid-build — is untouched. A dependency-blocked
ticket stays queued source work rather than becoming a blocked build: the
runtime `blocked` status is for builds awaiting a human, not for work that
has not started.

`create(draft, {state?, idempotencyKey?})` supports deterministic outer-loop
filing. A state override lets harvest target Triage even when ordinary user
creation has another default. An idempotency key must adopt the same ticket on
retry across process restarts: the file adapter persists it in frontmatter;
Linear uses a deterministic caller-supplied issue UUID and adopt-on-conflict.

## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events in the same log
(§15.2.7): `escalation.answered`, `build.pause-requested`,
`build.resume-requested`, `build.abort-requested`,
`build.auto-merge-requested`, and `build.auto-merge-cancelled`. The event
vocabulary *is* the UI API; forge mutation remains kernel/dispatcher plumbing.

- v2.0 front end: terminal, with herdr as the multiplexer.
- `ab dispatch` on a TTY is an interactive fleet dashboard. Its bottom legend
  is the authoritative key map: Up/Down select a build by slug identity, `p`
  requests pause/resume, `m` toggles GitHub-native auto-merge, `d` toggles
  in-memory dispatcher drain, and Ctrl-C exits. `--plain` (and non-TTY output)
  remains line-oriented and reads no keyboard input.
- Selection survives repaint/re-sort by tracking the build slug. Drain belongs
  only to one running dispatcher: while on it skips new ticket claims but keeps
  janitor, stale-runner, harvest, and in-flight work running; restart defaults
  it off.
- The latest repository harvest is projected with the same `PipelineStep`
  representation as builds, but carries a literal `HARVEST` marker and is not
  selectable. Every keyboard action continues to enumerate build slugs only.
- Later: web UI and others — same adapter pattern against the same store.
- The operator's job across many concurrent builds: see status at a glance,
  act on a selected build, find blocked builds, answer escalations, and inspect
  any build's trail.

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
so producers can't fake ordering. Repository-journal events use the same shape
with `repo` in place of `build`, and their own per-repository sequence. They are
validated by a separate harvest catalog so build reducers cannot accidentally
interpret outer-loop state.

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
   `*-requested`/`*-cancelled` events; kernel or dispatcher plumbing
   acknowledges their effects with fact events. The store is the *only*
   coordination surface — no side channel — and polling covers commands
   exactly the way it covers `subscribe`. A runner that is dead still receives
   pause/resume/abort commands on resume. Auto-merge commands carry desired
   state until PR plumbing applies them, including when the command predates
   PR creation.

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
| `build.auto-merge-requested` / `build.auto-merge-cancelled` | human | `{}` |
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
| `pr.auto-merge-enabled` / `pr.auto-merge-disabled` | kernel, dispatcher | `{commandSeq}` (correlated application fact) |
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
| `escalation.answered` | human; dispatcher for policy retry | `{id, answer, resolution: guidance \| dismiss-finding \| revise-spec \| abort \| retry}` |
| `phase.failed` | kernel | `{phase, round?, attempt, error, willRetry}` (infra failure — distinct from verdicts) |

**Repository observation harvest** (separate journal)

| Type | Actor | Payload |
|---|---|---|
| `harvest.started` | kernel/dispatcher | `{run, observations: [{build, seq}], scan: artifact}` — atomically claims the snapshot |
| `harvest.step.started` / `harvest.step.completed` | kernel | `{run, step: scan \| synthesize \| review \| file, round?, outcome?, artifact?}` |
| `harvest.session.started` / `harvest.session.ended` | kernel | run/session/role/round and transcript/usage facts |
| `harvest.proposals.submitted` | agent | `{run, round, artifact}` |
| `harvest.review.verdict` | agent | `{run, round, verdict, findings, artifact, reason?}` |
| `harvest.proposal.filed` | kernel | `{run, proposalKey, ticket}` — external-create retry boundary |
| `harvest.completed` | kernel | `{run, dispositions, report}` — authoritative committed ledger facts |
| `harvest.escalated` | kernel/agent | `{run, source, reason, round?, observations}` |
| `harvest.failed` | kernel | `{run, step, round?, attempt, error, willRetry}` |

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
`{phase, round, openEscalations[], pr?, autoMerge, lastEvent}`. `blocked` ≡ an
`escalation.raised` without a matching `escalation.answered`; `paused` ≡ a
`build.paused` without a later `build.resumed`. `autoMerge` retains the latest
human desired value and command seq separately from the latest applied
`{enabled, commandSeq}` fact. The desired command is settled only when both
fields match, so a stale acknowledgement cannot erase newer intent. The
operator UI's build list is exactly this reduction over every build in the
store.

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

A new `ab dispatch` process does not wait for the ordinary stale-lease sweep
to discover work: on its first tick it attempts every actionable,
non-terminal build in its repo. Lease claiming remains the exclusivity gate,
so an old runner that is genuinely alive wins harmlessly. Pauses, PR/spec
waits, and agent/stall escalations remain parked. An all-policy escalation
set is recorded as `escalation.answered {resolution: retry}` before launch,
re-arming the bounded phase-failure budget once for this invocation.

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
  the build's landing point. An operator may toggle GitHub-native auto-merge:
  enabling uses `gh pr merge --auto --squash`, never `--admin` or a direct
  merge, so GitHub's required checks remain the gate. If checks are already
  green GitHub may merge immediately; the janitor still observes that result
  on its next ordinary poll before completing the build.
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

Auto-merge desired state is durable across PR creation. Finalize re-reads the
log after opening/adopting the PR and applies any unmatched command before
committing `finalize.completed`; later commands are applied by the janitor on
open PRs. The setter is idempotent and every application fact cites the human
command seq. Thus a crash after the forge call but before the fact append
retries safely, while a newer cancellation remains distinguishable from a
stale enable acknowledgement. Cancellation disables native auto-merge on an
existing PR or clears the pre-PR desired flag.

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

[agent]                         # repo-wide DEFAULT on the axes (§9)
runtime = "claude"              # no model ⇒ the runtime's own default; no extensions ⇒ hermetic

[roles]                         # per-step OVERRIDES, most-specific-first (§9)
slug = { model = "openai/gpt-5.6-sol" }  # optional pre-build naming override
plan = { model = "openai/gpt-5.6-sol", extensions = ["subagents", "web-access"] }  # model + pi extensions
code-review = { runtime = "pi", model = "moonshotai/kimi-k3", extensions = ["web-access"] }  # pinned pair + web grounding
harvest = { model = "openai/gpt-5.6-sol" }          # optional producer override
harvest-review = { model = "moonshotai/kimi-k3" }   # optional fresh-reviewer override

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3

[dispatcher]
capacity = 3                    # concurrent builds for this repo
readyLabels = ["autobuild"]
readyState = "ready"            # required: the one state a ticket must sit in to dispatch

[harvest]                       # observation-count back-pressure in dispatch
threshold = 10

[outer]                         # cron schedules for OTHER ingesters
"ingest:sentry" = { cron = "0 */4 * * *" }
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
`spec`, `tickets`, `guide`, and the outer-loop skills). `ab init` installs into
a repo:

- Writes an `autobuild.toml` template.
- **Copies** the default skills into the Agent Skills standard project
  directory, namespaced `ab-*` (e.g. `.agents/skills/ab-code-review/`). Copies,
  not references — per-repo customization is the point: this repo's code-review
  standards and e2e driving instructions live in the vendored skill. Pi
  discovers the canonical copy directly; harness-specific discovery paths are
  symlinks to it, with `.claude/skills/ab-*` pointing to
  `.agents/skills/ab-*`.
- Marks skills **non-agent-invocable** (`disable-model-invocation`) except the
  **model-invocable set**: `ab-spec`, `ab-tickets`, and `ab-guide`. Phase skills
  are invoked explicitly by the runner or a human, never auto-triggered by a
  model pattern-matching a description — a model must not start a pipeline phase
  by accident. Membership in the exception is decided by that criterion, not by
  taste: a skill may be model-invocable only if it **drives no phase**.
  `ab-spec` is the human-interactive entry point that runs before a build
  exists; `ab-tickets` is the agent-facing surface on the local tracker, where a
  conversational trigger ("move ticket X to ready") is the point; `ab-guide` is
  read-only reference material about the system itself. None of them advances a
  build, so none carries the risk the rule exists to prevent. The set is
  deliberately small; a further candidate must be judged against the same
  criterion.

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

1. **Event payload schemas (decided)** — build payloads are frozen in
   `src/events/payloads.ts`; repository harvest payloads are frozen separately
   in `src/events/harvest.ts`. Every adapter validates before append.
2. **[OPEN] Other-ingester detail** — observation harvest and its typed CLI,
   repository journal, ledger, trigger, and review loop are decided in §8.8 and
   §12. Per-source filter design for scheduled `ingest:*` sources remains open.
3. **[OPEN] Retention/archival policy** — the v1 archival gap, now a store
   config concern rather than a repo problem. Needs a default (e.g. prune
   blobs for merged builds after N months, keep events).
4. **[OPEN] Global capacity** — per-repo capacity lives in `[dispatcher]`
   (§16.1); whether a cross-repo global cap is needed, and where it lives,
   is unresolved.
