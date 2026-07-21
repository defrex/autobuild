# Autobuild v2 — Specification

An agent-driven software development lifecycle system: it takes work from
*"something should be done"* to a merged PR, with a human in the loop only
where judgment matters. This is a ground-up rebuild of v1 (preserved in git
history at `6d4dce3`), keeping v1's validated ideas and replacing what it
hard-coded with real interfaces.

**What this document is.** SPEC.md holds the durable design: principles,
boundaries between components, invariants, and decisions with their rationale
(the **[D1]–[D11]** series). It is deliberately not three other things:

- **Not a behavior reference.** Exact schemas, flag grammars, validation
  rules, and edge-case handling are specified by the code and its tests —
  event payloads are frozen in `src/events/`, and the store contract in
  `src/store/contract.ts`. Where this document and the code disagree on
  behavior detail, the code is authoritative.
- **Not an operating manual.** How to install, configure, and drive the
  system lives in `README.md` and `docs/`.
- **Not a change log.** Each resolved design question lives in its ticket,
  build, and PR; the paper trail is queryable in the BuildStore. A merged
  change earns a paragraph here only if it altered a principle, boundary, or
  invariant.

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
| `TicketSource` | list/claim/comment/transition/create/update tickets; add, remove, and resolve declared dependencies | file-based (default directory); Linear; later GitHub Issues |
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
- **dispatcher** — watches the TicketSource for tickets passing the configured
  ready gate, claims, establishes the final conforming spec, chooses a short
  immutable build slug, provisions a workspace, and launches build-runners up
  to capacity. On process startup it attempts every current build for its
  repo, so re-running `ab dispatch` resumes durable work rather than only
  looking for new tickets. It also owns observation back-pressure: settling
  outstanding recoverable harvest runs takes priority over starting new scans
  (§12). Cron-friendly.
- **harvest-runner** — one staged repository workflow (`scan → synthesize ⇄
  review → file`) under a repository lease; not a build and not a phase.
- **ingesters** — other outer-loop processes turning signals into proposals (§12).
- **operator** — UI process(es); see §14.

### 3.4 The event log spine

Build processes append typed events to per-build logs; repository-scoped outer
workflows and operator settings append to a separate repository journal in the
same BuildStore. Consequences, by design:

- **State is a reduction of events.** Any state snapshot is a cache, never
  the source of truth. Resumability falls out.
- **The UI layer is a subscriber** plus a command channel back. TUI, web —
  same adapter pattern.
- **The audit trail is the log**, serialized.

The event vocabulary (§15) is deliberately designed early and carefully: it
is simultaneously the store schema, the kernel's I/O, the UI API, and the
resume format. A bad event schema calcifies.

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
| **Verdict** | Structured terminal outcome: reviews use `approve` \| `revise(findings)` \| `escalate(reason)`; agent verification uses `pass` \| `fail(report)` \| `skip(reason)` |
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
| `verify:e2e` | `/verify-e2e <build>` | `verify.completed {step, outcome}` | `verify-report:e2e` on pass/fail when present |
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
  per-repo config. Two subtypes: *check* (deterministic command; pass/fail is
  its exit code) and *agent-verify* (an agent run with a `pass|fail|skip`
  verdict schema). The durable outcomes are `pass`, `fail(report)`, and
  `skipped(reason)`. A failure routes back to `implement` with the report,
  re-entering the code loop. A skip requires a human-readable reason,
  satisfies only that step for the current cycle, and consumes no failure
  budget — it is neither passing evidence nor a failure, and it never hides
  another step's failure. A skip is produced either by an agent verifier's
  explicit verdict or by the kernel, when the approved plan did not select an
  optional step or a configured path-applicability rule excludes it (§16.1).
- **`finalize:*`** — optional ordered post-steps (release notes, changelog,
  publishing, ticket linking). Each configured step is either a deterministic
  command check with no agent session or an agent running an exact skill.
  Independent and failure-tolerant: a failed post-step files an observation;
  it never kills a green build.

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
  then sync the body back through the TicketSource so unrelated metadata
  remains untouched.

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

**Build identity at dispatch:** once the final conforming spec is in hand,
the selected runtime proposes a short kebab-case slug from its substance —
judgment proposes; the dispatcher validates, deduplicates against the store,
and falls back to a deterministic title-derived name on any absence, invalid
output, error, or timeout. Naming failure never prevents build creation. The
slug and its `ab/<slug>` branch are recorded once and never renamed.

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
normalized, defined once, with a local embedded target and a remote
server-database target. Blobs are content-addressed (sha256) behind a narrow
`BlobStore` adapter (`put(hash, bytes)`, `get(hash)`): a plain directory
locally; remotely any object store — always an adapter, never an assumption.
The database stores refs, never bulk content. The design lives in the data
model and event vocabulary (§15); the schema should stay boring.

Transcripts are an artifact kind (`transcript`) with metadata: phase, round,
role, runner, model, token counts. This one decision produces the analysis
corpus — prompt improvement, evals against the build skills, replay — as a
query rather than a project.

### 7.2 Interface and adapters

Deliberately narrow: build runners need `append(event)`, `putArtifact`,
`getArtifact`, `getEvents(since)`; operator UIs add `listBuilds`, `subscribe`.
The same contract has repository-scoped `ensureRepo`, event/artifact deposit
and read methods, plus a repository lease. Two implementations of one
contract (`src/store/contract.ts` is the shared conformance suite):

1. **Local** — one self-contained state tree at `<main-repo>/.autobuild/` by
   default: database, content-addressed blobs, Git worktrees, and the file
   ticket source's default directory. The main checkout is derived from Git's
   repository/worktree topology, so a command run inside a linked worktree
   resolves the same state. There is no home-directory fallback or
   machine-global state. Store selection is uniform: explicit `--store` >
   nonempty `AB_STORE` > repository default.
2. **Remote** — the same store interface behind a small self-hosted HTTP API
   binary, selected by an `http(s)://` reference. What remote sandboxes talk
   to. Git worktrees and default file tickets necessarily remain local.

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

Three base-selection invariants make this safe with Git:

- **The base is chosen once, at first branch creation**, from the freshly
  fetched origin tip of the configured base branch (fetched into a
  build-scoped internal ref so concurrent dispatches cannot clobber each
  other or the operator's refs). If the remote is unavailable, creation falls
  back to the local base and records the diagnostic.
- **Re-provisioning never re-cuts.** An existing build branch is resumed at
  its current tip — never rewound, rebased, or re-created from a newer base.
- **The first branch-cut SHA is the immutable review anchor.** Every
  `implement.completed` commit range uses it as `base`, across review rounds
  and sandbox resumption.

### 7.5 What the PR gets

A summary comment — verdict history, verification results, links into the
store. The full audit trail is queryable, not committed to the branch.

Evidence artifacts (such as dashboard-frame captures) are projected into the
PR as text with exact retrieval commands; the BuildStore copy is always
authoritative. Optionally, config may name a **public** GitHub release as an
image host so frames render inline during review. Two invariants govern that
option: enabling it is an explicit public-disclosure choice made in config,
and hosted copies are temporary — the dispatcher reclaims them after the
build reaches a terminal outcome, while store artifacts remain under the
store's retention policy. Hosting failures degrade to text; they never fail
verification or block finalize. No frame is ever written into a Git branch or
workspace.

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

A harvest session instead carries `AB_REPO`, `AB_HARVEST`, and an `AB_PHASE`
of `synthesize@N` or `review@N`. The AgentRunner invocation argument is
opaque: a build skill receives its slug; a harvest skill receives its run id.
The CLI resolves identity from ambient auth, and remote tokens distinguish
build from repository resources as well as session attribution. A leaked
harvest token cannot read a build stream and vice versa. Least privilege
comes from the runner, not prompt instructions.

Every phase and harvest turn also receives a runner-controlled `PATH` prefix
containing a private `ab` launcher from the same Autobuild distribution that
started the session, applied after ambient and scoped environment merging —
so a host executable named `ab` can never shadow the typed CLI, and agent
sessions need no separate global installation.

### 8.2 Command surface

| Command | Purpose | Terminal? |
|---|---|---|
| `ab context` | hydrate `.ab/` with the phase's inputs; print the manifest | no |
| `ab artifact put <kind> <file>` | deposit a versioned artifact → returns rev | no |
| `ab artifact get <kind>[@rev]` | fetch an artifact within own build | no |
| `ab artifact download …` | sessionless, read-only exact-byte retrieval; works after build termination | no |
| `ab observe --kind <followup\|refactor\|latent-bug> …` | structured observation, any phase, any time | no |
| `ab server <start\|stop\|restart\|status\|logs>` | dev-server lifecycle, config-driven (§16.2); `implement` and `verify` phases only | no |
| `ab done` | complete a producer phase (validates, then runs phase plumbing) | **yes** |
| `ab verdict <approve\|revise\|escalate\|pass\|fail\|skip> …` | complete a review/verify phase | **yes** |
| `ab escalate <question>` | park the build for human input | **yes** |

The verdict vocabulary is phase-dependent and the CLI enforces it: review
phases accept `approve|revise|escalate`; agent-verify steps accept
`pass|fail|skip` (`fail` requires a report; `skip` requires a reason).
Deterministic checks never touch the CLI — the kernel runs them directly.
Exact flags and validation live with the CLI implementation and its tests.

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
| `verify:<step>` (agent) | spec (acceptance criteria), step config, commit range | `verdict pass` \| `verdict fail --report` \| `verdict skip --reason` |
| `finalize` | spec, plan, verify reports, PR template config | `done` (requires `pr-description` artifact) |
| `reconcile` | spec, plan, implement-notes, conflict `{baseSha}` from this attempt's `reconcile.started` | `done` (requires merge commit present) |

Scoping is deliberate: the planner never sees code-review rounds; the
reviewer sees prior findings but not the producer's session. What a phase
*can't* see is part of its design.

### 8.4 Terminal discipline [D5]

**Every phase ends with exactly one terminal command** — `done`, `verdict`,
or `escalate`. The CLI rejects a second terminal call, and each terminal
validates its preconditions before emitting the phase event (no `done`
without the required artifacts; no `done` on a dirty worktree in
`implement`). A normally completed turn that ends **without** any terminal
call is an infra failure: the runner emits
`phase.failed {error: "no-terminal"}` and applies retry policy.

Provider/runtime-declared turn failures are a separate `AgentRunner` result
(§9), never conflated with agent silence: the runner deposits the transcript,
then emits `phase.failed` with the provider's message verbatim. Failures
positively classified as permanent (auth, permission, quota, billing) skip
the retry budget and raise a policy escalation instead. If the turn already
wrote a valid typed terminal, that terminal remains authoritative and no
contradictory failure is appended.

This completes the sentinel-parsing replacement: success is only expressible
through the typed channel, so "the agent rambled and exited" can never be
misread as completion, while a rejected turn cannot be misreported as agent
silence.

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

- *Completed turn, no terminal* → `phase.failed {no-terminal}`, retry per
  policy [D5].
- *Provider rejection* → transcript deposited, `phase.failed` with the
  verbatim error; permanent auth/quota/billing signals escalate instead of
  retrying [D5].
- *Malformed deposit* → rejected in-session with schema + error; agent
  corrects and retries [D6].
- *Crash after deposits, before terminal* → artifacts are revisioned; the
  re-run phase deposits fresh revs; orphaned revs are harmless history.
- *Wrong-build write* → token scope rejects it at the store [D8].
- *Store unreachable* → CLI retries with backoff; a phase that cannot
  deposit cannot complete → `phase.failed`, runner-level policy takes over.

### 8.8 Outer-loop namespace

Human/pre-build ticket grooming uses one configured-source namespace
(`ab ticket create|update|block|unblock|list|show|move`). These commands are
sessionless, source-agnostic, and never available as a mid-build spec
mutation path.

Observation harvest uses a separate typed, repository-scoped namespace
(`ab harvest context|submit|verdict|status`), mirroring the build session
commands: context hydration, a producer terminal, a reviewer terminal, and a
sessionless read-only status projection.

Agents never receive TicketSource credentials. Only the deterministic file
step creates/adopts approved proposals and commits ledger facts.

## 9. AgentRunner

Session-based, because review loops need memory:

```ts
type Result =
  | { kind: 'completed', text, usage }
  | { kind: 'failed', text, usage, failure: { message, permanent } }

interface AgentRunner {
  start(opts: { skill, invocation, workspace, model, … }): { session, result }
  continue(session, message): Result    // review-loop rounds
  end(session): Transcript              // → store, always
}
```

The discriminator is a port-level requirement: an SDK/provider-declared error
must never be returned as `completed`, so every adapter inherits the
distinction from `no-terminal`. `failure.message` preserves provider text;
`permanent` is set only on positive evidence (authentication, permission,
quota, billing) and means "escalate before retrying," while `false` means
"use existing retry policy." A failed `start` still returns an endable
session handle, guaranteeing transcript deposition.

Narrow non-phase judgments do not widen this contract. A runtime may
separately register an optional one-shot completion capability (tool-free,
non-resumable), used for slug naming (§6.3) and vendored-skill conflict
resolution (§16.3). A runtime without it is valid; each caller owns its
deterministic fail-safe.

- **Adapters:** Claude Agent SDK for Claude models; pi in SDK mode for other
  model families. Both are registered runtimes behind the interface. A future
  access path registers as a *distinct runtime name*, never a mode flag on an
  existing one.
- **Routing — explicit role inheritance (§16.1):** runtime, model, and
  extension allowlist live in one open `[roles]` map whose reserved `default`
  entry is the inheritance base. Every concrete role merges over it
  independently per field; the merged runtime/model pair must be compatible —
  the resolver never silently substitutes a runtime or model. All roles
  resolve **eagerly, before any session launches**, with problems aggregated
  into one error. Adding a runtime touches only the adapter registry, never
  the kernel. Mixing models across roles is intentional — a different
  reviewer catches more. The resolved runtime and model are recorded on every
  `session.started`, so an experiment's outcome is attributable to the
  configuration that produced it.
- **Transcripts come back through the interface**, not scraped from disk, so
  every adapter must produce one: the corpus is guaranteed complete,
  including turns rejected by a provider after a session handle exists.
- Adapters without native session resumption implement `continue` as
  start-with-rehydrate-from-store — which must exist anyway per §7.4.

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
like everything else. An answer carries either bare `retry` or free-text
`guidance` that feeds the parked phase's next run; answering is an attempt,
not a forced success — an unresolved condition may escalate again.

Policy escalations caused by an exhausted bounded retry/round budget are the
narrow exception to the human-answer rule: a fresh `ab dispatch` invocation
answers an all-policy open set with dispatcher-authored `resolution: retry`
and attempts the build from durable state. This unattended startup path is an
explicit process-restart retry boundary; agent and stall escalations remain
human judgment gates until an operator answers them.

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

Additional scheduled ingesters such as `ingest:sentry` remain an open design
thread and have no shipped config surface. Observation harvest is
threshold-driven: the dispatcher counts unclaimed structured observations
across the repository each tick, and at `[policy].harvestThreshold` it claims
the whole current accumulation as one immutable snapshot and starts one staged
run. Occurrence identity is
`{build slug, event seq}` — never payload id or a scalar high-water mark,
because event sequences are per build. Harvest state lives in the repository
journal, separate from build streams; the repository lease is the
cross-process exclusivity gate, and harvest runs fire-and-forget so dispatch
ticks stay responsive.

The fixed workflow is:

1. **scan (deterministic)** — subtract all claimed occurrences, reconcile
   prior proposal tickets through TicketSource lifecycle facts, and
   atomically store the scan packet with the run's claim.
2. **synthesize ⇄ review (judgment through `converge`)** — the continuing
   producer clusters same-problem records and authors typed
   create/join/suppress proposals; a fresh reviewer checks coverage, semantic
   dedup, spec quality, and evidence. Only approval advances.
3. **file (deterministic)** — render creates to the spec standard and file
   them into Triage. Filing is crash-safe by construction: an idempotency
   ID is durably reserved *before* each external create, so a restart adopts
   the already-created ticket instead of duplicating it, and a partially
   filed approved set creates only its missing tickets.

Beyond the workflow, harvest is governed by a small set of invariants (their
event-level mechanics live in the repository catalog and reducer tests):

- **Pause is a repository-wide durable gate**, not a run status — requested
  by a human, acknowledged by the kernel at a safe boundary, and never
  destructive to the open run or its claim.
- **A failed run parks; settling parked runs outranks new scans.** The
  dispatcher settles the oldest outstanding recoverable run before starting
  any new scan, so later runs cannot shadow an older stop.
- **Automatic recovery is bounded per run** (two reopens, no config surface),
  separate from within-step retry policy. Completed steps never re-run; an
  approved set goes straight to filing.
- **Give-up never silently destroys the snapshot.** Exhaustion atomically
  commits the provable partial dispositions to the ledger, releases only
  genuinely pending work, and raises a durable human-attention barrier so
  released work cannot be immediately reclaimed into another hot loop.
- **Human resume is repository-wide**: one acknowledgement reopens every
  ordinary parked run and clears every exhaustion barrier. It never
  resurrects a terminal run. Completed and escalated runs are irrevocable; a
  deliberate escalation consumes its snapshot and is never auto-recovered.
- **The harvester only proposes.** It never claims, readies, grooms, or
  dispatches a proposal. Humans still own Triage → Ready.

## 13. Ticket source policy

The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) at claim time as part of initiation; after import, the
build never reads the tracker again. Human-legibility projections (spec
posted as a comment, final summary, status transitions) flow outward only.
This keeps the abstraction honest: a file-based TicketSource with nowhere to
put blobs must be fully workable.

**Partial listings and source invariants.** A listing returns both valid
tickets and diagnostics for individually malformed records, which are
excluded but left byte-untouched — one broken ticket never blocks unrelated
dispatch. Tracker-wide safety violations (duplicate ids across states,
stateless records) remain fatal: continuing could permit double dispatch.

**Pre-build edits.** Update is partial and strict: it replaces only the named
editable fields, and state is never an update field — transitions are a
separate operation with their own validation.

**Ticket dependencies.** A ticket may declare blockers within its source, at
creation or later. The source owns representation (how a blocker is stored)
and completion semantics (what "done" means); the dispatcher owns the
decision — an unresolved blocker means the ticket is not claimed and creates
no build. Dependencies are written during grooming and read at dispatch time,
both initiation, so the never-consulted-mid-build rule is untouched. A
dependency-blocked ticket stays queued source work rather than becoming a
blocked build: the runtime `blocked` status is for builds awaiting a human.

**Crash-safe filing.** Creation supports a state override (harvest targets
Triage explicitly) and an idempotency key that must adopt the same ticket on
retry across process restarts. The reservation fact precedes the external
side effect — that ordering, not provider behavior, is what makes filing
crash-safe.

## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events appended to the
applicable build or repository log (§15.2.7). The event vocabulary *is* the
UI API; forge mutation remains kernel/dispatcher plumbing. Anything a UI
displays is a reduction of the logs, and anything it does is an event — so
every frontend (terminal today, web later) is the same adapter pattern
against the same store, and a dead runner still receives commands on resume.

Durable operator settings (intake, the claim-time auto-merge default, the
harvest gate) are repository-journal facts: they survive restarts, propagate
between dispatchers by ordinary polling, and are never optimistically
rendered — the UI shows acknowledged state.

The operator's job across many concurrent builds: see status at a glance,
act on a selected build, find blocked builds, answer escalations, and inspect
any build's trail. The concrete presentation — layout, key bindings, colors —
is owned by the dashboard implementation and its tests.

## 15. Event vocabulary

Drafted by walking one build's happy path end to end, then three unhappy
paths (verify failure, review stall, sandbox death). Four decisions this
exercise forced are marked **[D1]–[D4]**; all four are **confirmed**, with
[D1] extended to cover merge standardization and conflict resolution (§15.7).

The complete vocabulary is frozen in code: build payloads in
`src/events/payloads.ts`, repository workflow and control payloads in
`src/events/repository.ts`. Every adapter validates before append. The
sections below define the envelope, the conventions that govern every event,
and the walkthroughs that motivated the design — not a field-by-field
catalog.

### 15.1 Envelope

Every event shares:

```jsonc
{
  "build": "auth-rate-limit",     // build slug
  "seq": 42,                      // per-build, monotonic, assigned by the store on append
  "ts": "2026-07-15T14:03:22Z",   // assigned by the store
  "actor": { "kind": "agent", "role": "code-review", "session": "s_9f2" },
  "type": "code-review.verdict",
  "payload": { /* per-type, frozen in src/events/ */ }
}
```

`actor.kind ∈ kernel | agent | human | dispatcher | ingester`. Agents carry
`role` and `session`; humans carry `user`. The store assigns `seq` and `ts`
so producers can't fake ordering. Repository-journal events use the same
shape with `repo` in place of `build` and their own per-repository sequence,
validated by the separate repository catalog so build reducers cannot
accidentally interpret repository state.

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
   `*-requested`/`*-cancelled` events, `escalation.answered`, and dispatcher
   setting facts; kernel or dispatcher plumbing acknowledges effects that
   require a boundary. The store is the *only* coordination surface — no side
   channel — and polling covers commands exactly the way it covers
   `subscribe`. A runner that is dead still receives pause/resume/abort
   commands and escalation answers on resume.

### 15.3 Catalog

Authoritative in code (`src/events/payloads.ts`, `src/events/repository.ts`).
The families, with illustrative members:

| Family | Examples |
|---|---|
| Build lifecycle | `build.created`, `workspace.provisioned`, `runner.attached`, `build.completed` |
| Operator commands [D2] | `build.pause-requested` → `build.paused`; `build.auto-merge-requested`; `escalation.answered` |
| Spec | `spec.imported`, `spec.authored`, `spec.revised` |
| Sessions | `session.started`, `session.ended` (with transcript ref and usage — the analysis corpus) |
| Plan/code loops | `plan.started` … `plan-review.verdict`; `implement.started` … `code-review.verdict` |
| Verify/finalize | `verify.started`, `verify.completed {step, outcome}`, `finalize.completed {pr}` |
| Post-PR [D1] | `pr.merged`, `pr.conflicted`, `reconcile.started`, `reconcile.completed` |
| Cross-cutting | `observation.recorded`, `escalation.raised`, `phase.failed` |
| Repository journal | dispatcher setting facts; the `harvest.*` workflow, recovery, and ledger facts |

One deliberate subtlety worth recording: `pr.conflicted.baseSha` is
detection-time evidence, while `reconcile.started.baseSha` is the freshly
fetched merge target for that attempt. Agent context uses only the started
fact, so a reconcile never runs against a known-stale base.

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
`{phase, round, openEscalations[], pr?, autoMerge, lastEvent}`. `blocked` ≡
an `escalation.raised` without a matching `escalation.answered`, matched by
id. `paused` ≡ a `build.paused` without a later `build.resumed`, and takes
reducer precedence over blocked. Auto-merge state tracks the latest human
*desired* value separately from the latest *applied* fact, settled only when
both match — a stale acknowledgement can never erase newer intent.

Every projection — operator UI, CLI status, dispatcher decisions — is a
reduction of the logs. Caches may key a reduction by last event sequence,
but no decision ever consults a snapshot in place of the append-only log.
Separate reducers derive dispatcher settings and harvest state from the
repository journal; each ignores the other's facts.

### 15.6 Walkthroughs

**Happy path** (elided: `session.started/ended` brackets around every agent
run):

```
build.created → workspace.provisioned{base:{source:remote,sha}} → spec.imported → runner.attached
plan.started{r1} → plan.completed{plan@1, verifySteps}
plan-review.started{r1} → plan-review.verdict{approve}
implement.started{r1} → implement.completed{commits, notes@1}
code-review.started{r1} → code-review.verdict{approve}
verify.started{types} → verify.completed{outcome:pass} → …unit → …e2e
finalize.started → finalize.completed{pr} → finalize.step-completed{release-notes}
(later, janitor:) pr.merged → workspace.released → build.completed{merged}
```

**A — verify failure:** `verify.completed {step: e2e, outcome: fail,
report}` → kernel routes back into the code loop: `implement.started
{round: 2, feedback: {verify: {step, report}}}` → fix → `code-review` round
2 → approve → verify re-runs **from the first step** (implement changed the
code; cheap checks first), `attempt: 2`. `policy.maxVerifyAttempts`
exhausted → `escalation.raised {source: "policy"}`.

**B — review stall:** round 1 `code-review.verdict {revise, [f1]}` → round 2
verdict's finding marks `persists: [f1]` → round 3 again → kernel:
`escalation.raised {source: "stall", refs: [chain]}`; status → `blocked`.
`escalation.answered {resolution: "guidance"}` feeds the answer into the next
producer round as authoritative feedback; `dismiss-finding` marks the chain
human-resolved and the next reviewer round is told so.

**C — sandbox death:** log ends at `implement.started {round: 2}`; heartbeat
goes stale → dispatcher expires the lease, provisions a fresh sandbox →
`workspace.provisioned {base: {source: existing, sha}}` → `runner.attached
{resumedFromSeq}` → reducer says implement r2 started-not-completed → re-run
the phase from its start. The provider restores the already-created branch at
round 1's pushed head [D3]; the Git adapter never re-cuts it from a newer
base (§7.4). `ab context` rehydrates scratch from the store into a fresh
session. Uncommitted round-2 work is lost by design (§7.3 — phase boundaries
are the resume points).

Two liveness rules complete the picture. Within one dispatcher process,
build-runner launches are single-flighted by slug — in-memory liveness beats
a transiently stale lease, while the durable lease remains the cross-process
recovery gate (the guard is deliberately not durable: a dead process's
memory disappears with it). And a new `ab dispatch` process attempts every
actionable build on its first tick rather than waiting for the sweep; lease
claiming stays the exclusivity gate, so a genuinely live old runner wins
harmlessly.

### 15.7 Post-PR lifecycle [D1 — confirmed]

Walking the happy path exposed a gap in the grammar: `finalize` creates the
PR, but *something* must watch it to merge/close, release the workspace, and
emit `build.completed`. v2 makes it a deterministic **janitor duty of the
dispatcher** (which already polls on cron): it checks open PRs for its
builds, emits `pr.merged`/`pr.closed`/`pr.conflicted`, releases workspaces,
and completes builds. A merged-PR fixup request is a *new ticket*, never a
reopened build.

**Merge standard: one rule per direction, never rebase.**

- **PR → main: squash merge.** Main stays linear, one commit per build —
  which keeps reverts (one commit → one new ticket), release notes, and
  history archaeology clean.
- **main → feature branch: merge commit.** A stale branch is refreshed by
  merging base *into* it, resolving conflicts once against current main.
- **Rebase is banned**, for two reasons. Operationally: at this system's
  merge velocity, a rebase re-resolves conflicts commit-by-commit against a
  target that keeps moving — agents can be stuck in
  rebase-conflict-after-rebase-conflict nearly indefinitely (observed in
  practice). Structurally: rebase rewrites the branch and severs the SHAs
  recorded in `implement.completed` events [D3]. Squash-at-merge is safe on
  both counts.

**Merge gates are never bypassed.** The operator's auto-merge command is
durable consent to merge, not a bypass. Whenever the base branch has any real
merge-blocking gate, consent is applied as GitHub-native auto-merge, so the
forge's own checks decide when the PR lands. Only when the forge
authoritatively reports no gate may the janitor perform a normal,
head-guarded squash itself — never admin, force, or rebase — and only after
all verification and finalize work is complete. Unknown gate data, opaque
blockers, and auth failures all fail closed. No merge is ever assumed: a
build reaches `merged` only when a later poll observes that the PR actually
landed.

**Conflicts re-enter the pipeline via `reconcile`.** When the janitor's
mergeability check fails it emits `pr.conflicted` and re-attaches a
build-runner (the dispatcher itself never runs agents). Immediately before
each attempt, the runner fetches the build's frozen base branch fresh and
records the resolved SHA on `reconcile.started` — known-stale input is never
used (§15.3). The agent merges that base into the branch guided by the spec,
plan, and implement-notes, with the explicit charge to regress against
neither; the resolution lands as a merge commit, and because reconciliation
changed code, **`verify:*` re-runs in full**. A resolution the agent judges
risky — semantic conflicts, spec-relevant choices — escalates rather than
guesses. Reconcile skips `code-review` by default (escalation covers the
judgment cases; policy can force it), and `policy.maxReconcileAttempts`
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
baseBranch = "main"
capacity = 3                    # concurrent builds for this repo

[commands]                      # deterministic verbs the kernel may run
setup = "bun install"           # after provision / sandbox rehydrate (§15.6-C)
typecheck = "bun run type-check"
test = "bun run test"
publish = "bun run publish"

[server]                        # dev-server lifecycle — see §16.2
start = "bun dev"
url = "http://localhost:3000"   # readiness probe target

[verify]
steps = ["types", "unit", "e2e"]
[verify.types]
kind = "check"                  # deterministic: command + pass/fail
command = "typecheck"           # ref into [commands]
[verify.unit]
kind = "check"
command = "test"
[verify.e2e]
kind = "agent"                  # agent-verify: skill + pass|fail|skip verdict
skill = "ab-verify-e2e"
needsServer = true
paths = ["web/**"]              # optional changed-path applicability

[finalize]
steps = ["publish", "release-notes"] # ordered, failure-tolerant (§5)
[finalize.publish]
kind = "check"
command = "publish"
[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.default]                 # reserved inheritance base, never a phase (§9)
runtime = "claude"

[roles.code-review]             # fields override default independently
runtime = "pi"
model = "moonshotai/kimi-k3"

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 4
harvestThreshold = 10           # observation-count back-pressure in dispatch

[tickets]
source = "file"
readyState = "ready"            # required: the one state a ticket must sit in to dispatch
```

The two root scalars must appear before the first table header (TOML otherwise
nests them in that table). Declarative (TOML), not executable config: the
kernel, dispatcher, CLI, and any future tooling parse it without evaluating
anything; commands are plain shell strings. Parsing is strict — an unknown table or key is an error, so a
typo cannot silently disable a verifier. The full config surface, field
semantics, and validation rules live with the config code and
`docs/configuration.md`. The removed `[project]`, `[dispatcher]`, `[harvest]`,
and `[outer]` tables have no aliases or migration shims.

Two configurable narrowing mechanisms govern which verify steps run, both
resolving to the ordinary `skipped` outcome so exclusions stay queryable:

- **Plan selection.** An approved plan may declare the complete subset of
  optional verify steps warranted by the spec, in strict front matter
  validated at deposit. The selection paired with the approving review
  verdict is authoritative; `always = true` steps can never be deselected.
  Missing metadata means all configured steps, so historical builds keep
  their behavior.
- **Path applicability.** A step may declare positive changed-path selectors,
  evaluated by the kernel immediately before the step on every verify cycle,
  diffing `HEAD` against the build's durable base (promoted by a completed
  reconcile, so upstream-merged work is not attributed to the build). No
  match skips without launching anything; a Git failure is infrastructure and
  fails closed, never a synthetic skip.

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

This project ships the canonical default skills for every phase plus the
non-phase surfaces (`spec`, `tickets`, `guide`, and the outer-loop skills).
`ab init` installs into a repo:

- **A baseline `autobuild.toml`**, rendered only when absent, seeded from the
  target's own package scripts so generated commands match reality. Existing
  config is never reconciled or overwritten, even with `--force`.
- **Copies** of the default skills into the project skills directory,
  namespaced `ab-*`. Copies, not references — per-repo customization is the
  point: this repo's code-review standards and e2e driving instructions live
  in the vendored skill. Harness-specific discovery paths are symlinks to the
  one canonical editable copy.
- **Model-invocation discipline.** Phase skills are installed
  non-agent-invocable: they are invoked explicitly by the runner or a human,
  never auto-triggered by a model pattern-matching a description — a model
  must not start a pipeline phase by accident. The model-invocable exceptions
  (`ab-spec`, `ab-tickets`, `ab-guide`) are exactly the skills that **drive
  no phase**; membership is decided by that criterion, not taste.

**Upgrades** are the classic vendoring problem: `ab init` records the
pristine version of each installed skill; `ab upgrade` three-way merges
(pristine base × local edits × new default). A conflict may be resolved by
the optional tool-free `upgrade` one-shot with a standing bias: **prefer the
local customization**. The agent output is only an untrusted proposal —
deterministic validation verifies skill identity and the exact preservation
of every already-clean merge region before anything is written. Failed or
unavailable judgment leaves both live and pristine byte-untouched and names
the manual merge path. Local customization survives upgrades; divergence is
visible instead of silent.

## 17. Out of scope for v2.0 (explicitly)

- True push `subscribe` (interface reserved; polling implementation).
- Live transcript streaming (types reserved; boundary persistence only).
- Web UI (seam designed; terminal first).
- Generic workflow DAGs (the grammar is fixed; extension via `verify:*` and
  `finalize:*` only).

## 18. Open threads

1. **[OPEN] Other-ingester detail** — observation harvest is decided (§8.8,
   §12); per-source filter design for scheduled `ingest:*` sources remains
   open.
2. **[OPEN] Retention/archival policy** — the v1 archival gap, now a store
   config concern rather than a repo problem. Needs a default (e.g. prune
   blobs for merged builds after N months, keep events).
3. **[OPEN] Global capacity** — per-repo capacity is the top-level `capacity`
   scalar (§16.1); whether a cross-repo global cap is needed, and where it
   lives, is unresolved.
