# Autobuild v2 — Specification

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
- **dispatcher** — watches the TicketSource for tickets passing the required
  `[tickets].readyState` gate and optional `[tickets].readyLabels` narrowing,
  claims, establishes the final conforming spec, chooses a short immutable
  build slug, provisions a workspace, and launches build-runners up to
  `[dispatcher].capacity`. On process startup it also attempts every current
  build for its repo, so re-running `ab dispatch` resumes durable work rather
  than only looking for new tickets. Each tick also owns observation
  back-pressure: it gives an outstanding recoverable harvest run priority over
  every new scan, then starts a new run only when no recovery/control settlement
  is due and the configured count threshold is reached. An acknowledged pause
  and an unacknowledged recovery-exhausted attention barrier suppress launch;
  pending operator commands remain actionable. Cron-friendly.
- **harvest-runner** — one staged repository workflow (`scan → synthesize ⇄
  review → file`) under a repository lease; not a build and not a phase.
- **ingesters** — other outer-loop processes turning signals into proposals (§12).
- **operator** — UI process(es); see §14.

### 3.4 The event log spine

Build processes append typed events to per-build logs; repository-scoped outer
workflows and operator settings append to a separate repository journal in the
same BuildStore.
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
  per-repo config. The durable outcomes are `pass`, `fail(report)`, and
  `skipped(reason)`. Two subtypes: *check* (deterministic command + parser:
  typecheck, lint, unit tests) and *agent-verify* (an agent run with a
  `pass|fail|skip` schema: e2e browser-driving, evals). A failure routes back
  to `implement` with the report, re-entering the code loop. A skip requires a
  non-blank human-readable reason and satisfies only that step in the current
  cycle; it is neither passing evidence nor a failure and consumes no
  `maxVerifyAttempts` budget. Another step's failure still wins. Either an agent
  may explicitly declare `skip`, or the kernel may produce it when the approved
  plan selection or a configured path-applicability rule excludes the step.
  Config declares the universe and order. An approved plan may select a complete
  subset of optional steps in opening TOML front matter; `always = true` steps
  are mandatory and cannot be deselected. Missing plan metadata means all
  configured steps. Selection is tested before path applicability, and both
  must include a step for it to run.
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
  then sync the body back through `ab ticket update <id> --body <file>` so
  unrelated labels, assignee, state, and provider metadata remain untouched.

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

Naming is optional judgment, not a pipeline phase. The `slug` role inherits
the reserved `[roles.default]` base unless it supplies overrides; the literal
`default` entry is never dispatched as a role. The runtime capability is
one-turn and tool-free. Absence, invalid output,
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

1. **Local** — one self-contained state tree at
   `<main-repo>/.autobuild/` by default: `autobuild.sqlite`, content-addressed
   `blobs/`, Git `worktrees/`, and the file source's default `tickets/` tree.
   The main checkout is derived from Git's absolute repository/worktree
   topology, so a command run inside a linked worktree resolves the same state,
   while submodules and separate-Git-dir checkouts retain their own working-tree
   roots. There is no home-directory fallback or machine-global state
   location. Selection is uniform for sessionless commands: explicit `--store`
   > nonempty `AB_STORE`
   > repository default. A local override is normalized against the main repo
   and relocates the complete local tree, including worktrees and default file
   tickets. An explicitly configured `[tickets].dir` remains repo-relative.
2. **Remote** — the same store interface behind a small self-hosted HTTP API
   binary, selected by an unchanged `http(s)://` reference. What remote
   sandboxes talk to. Postgres (Neon) and any `BlobStore` adapter (§7.1) sit
   behind it without touching the interface. Git worktrees and default file
   tickets remain local under `<main-repo>/.autobuild/` because a URL cannot be
   a local-state root.

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

A Git workspace selects a base only when it creates the build branch. Before
that first creation it fetches `refs/heads/<baseBranch>` from `origin` into a
branch-scoped `refs/autobuild/provision/<branch>/base` ref, without updating
`FETCH_HEAD`, tags, the operator's local base, or a shared remote-tracking ref,
and creates the branch from the resolved immutable commit. Distinct destination
refs isolate concurrent dispatches. If fetch or remote-ref resolution fails, it
creates from the fully qualified local base commit and records the complete
remote diagnostic. A missing remote and local base remains fatal.

Re-provision is deliberately different: an existing worktree or build branch
is reused at that branch's current tip before any remote access. It is never
re-cut, rewound, or rebased from either base ref. This creation-time refresh is
separate from reconcile's execution-time refresh (§15.7).

### 7.5 What the PR gets

A summary comment — verdict history, verification results, links into the
store. The full audit trail is queryable, not committed to the branch.

A successful current-cycle `verify:dashboard` report may embed the versioned
manifest of its exact text/PNG frame artifact refs. Finalize resolves only that
cycle's successful report, validates every referenced artifact, and always
retains ANSI-stripped frames as escaped monospace text plus exact
`ab artifact download` commands. Missing, malformed, skipped, or stale-cycle
capture evidence omits this optional section.

Dashboard image hosting is optional and off by default. When a build's frozen
`dashboardFrames` target names an existing published, mutable release in a
public GitHub repository, finalize opens/adopts the PR first, copies those exact
BuildStore PNG bytes to release assets, records each external handle as
`dashboard-frame.hosted`, and embeds images only when the complete manifest was
hosted. A private source repository may target a separate public asset
repository; that temporary public disclosure is explicit configuration. No
frame is written beneath a Git workspace or enters any branch/tree. Unsupported
forges and upload/validation/timeout failures keep the complete text projection;
a configured upload failure records a follow-up observation but never changes a
verify result or blocks finalize. After `build.completed`, dispatcher janitor
work deletes each hosted copy and durably records reclamation, retrying failures
on later ticks. Inline URLs therefore intentionally expire after the review
window, while authoritative BuildStore artifacts remain under the store's
separate retention policy.

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

Every phase and harvest turn also receives a runner-controlled `PATH` prefix
containing a private `ab` launcher from the same Autobuild distribution that
started the session. The prefix is applied after ambient and turn-scoped
environment values are merged, so an inherited or scoped executable named
`ab` cannot shadow the typed CLI. Agent sessions therefore require no separate
global Autobuild installation; this guarantee changes command resolution, not
which commands the phase is authorized to execute.

### 8.2 Command surface

| Command | Purpose | Terminal? |
|---|---|---|
| `ab context [--json]` | hydrate `.ab/` with the phase's inputs; print the manifest | no |
| `ab artifact put <kind> <file>` | deposit a versioned artifact → returns rev | no |
| `ab artifact get <kind>[@rev]` | fetch an artifact within own build | no |
| `ab artifact download <build> <kind>[@rev] --output <file> [--store <ref>]` | sessionless, read-only exact-byte retrieval for this repository; works after build termination | no |
| `ab observe --kind <followup\|refactor\|latent-bug> [--files …] <summary>` | structured observation, any phase, any time | no |
| `ab server <start\|stop\|restart\|status\|logs>` | dev-server lifecycle, config-driven (§16.2); `implement` and `verify` phases only | no |
| `ab done [--notes <file>]` | complete a producer phase (validates, then runs phase plumbing) | **yes** |
| `ab verdict <approve\|revise\|escalate\|pass\|fail\|skip> [--findings <json>] [--notes <file>] [--reason …] [--report <file>]` | complete a review/verify phase | **yes** |
| `ab escalate <question> [--refs …]` | park the build for human input | **yes** |

`artifact put` reads bytes without UTF-8 coercion. `artifact download` alone is
sessionless inside that namespace; `put|get` retain ambient own-build auth. The
download form applies the normal explicit `--store` > `AB_STORE` > local
selection, verifies repository ownership, creates output parents, and writes the
stored bytes exactly. A remote selection forwards `AB_TOKEN`.

The verdict vocabulary is phase-dependent and the CLI enforces it:
review phases accept `approve|revise|escalate`; agent-verify steps accept
`pass|fail|skip`. `fail` requires `--report`; `skip` requires a non-blank
`--reason` and needs no report artifact. Deterministic checks never touch the
CLI — the kernel runs them directly and emits only pass or fail.

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
`phase.failed {error: "no-terminal"}` and applies retry policy. This is the
only meaning of `no-terminal`; it cannot represent a provider rejection.

Provider/runtime-declared turn failures are a separate `AgentRunner` result
(§9). The runner ends the returned handle, deposits the transcript and
`session.ended`, then emits `phase.failed` with the provider's message
verbatim. Authentication, permission, quota, and billing failures positively
classified as permanent record attempt 1 with `willRetry: false`. The next
durable decision raises a policy escalation containing that message before
starting another session; deriving the guard from `phase.failed` closes the
crash gap between failure and escalation. Unknown errors and ordinary 429,
overload, timeout, transport, and 5xx failures retain the existing bounded
retry policy. If the turn already wrote a valid typed terminal, that terminal
remains authoritative and no contradictory failure is appended.

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
- *Provider rejection, retryable or unknown* → end/deposit the session, then
  `phase.failed` with the verbatim provider error and bounded retry.
- *Provider rejection, permanent auth/permission/quota/billing signal* →
  end/deposit the session, then `phase.failed {attempt: 1, willRetry: false}`;
  raise a policy escalation containing the same error before attempt 2.
- *Malformed deposit* → rejected in-session with schema + error; agent
  corrects and retries [D6].
- *Crash after deposits, before terminal* → artifacts are revisioned; the
  re-run phase deposits fresh revs; orphaned revs are harmless history.
- *Wrong-build write* → token scope rejects it at the store [D8].
- *Store unreachable* → CLI retries with backoff; a phase that cannot
  deposit cannot complete → `phase.failed`, runner-level policy takes over.

### 8.8 Outer-loop namespace

Human/pre-build ticket grooming uses one configured-source namespace. These
commands are sessionless, source-agnostic, and never available as a mid-build
spec mutation path:

| Command | Scope | Purpose |
|---|---|---|
| `ab ticket create <title> --body <file> [--labels …] [--blocked-by …]` | human/pre-build | create a ticket in the configured source |
| `ab ticket update <id> [--title …] [--body <file>] [--labels …]` | human/pre-build | partially replace editable fields; omitted fields survive and state is excluded |
| `ab ticket block <id> <blocker-id>` | human/pre-build | idempotently add one same-source blocker to an existing ticket |
| `ab ticket unblock <id> <blocker-id>` | human/pre-build | idempotently remove one same-source blocker from an existing ticket |

Observation harvest uses a separate typed, repository-scoped namespace:

| Command | Scope | Purpose |
|---|---|---|
| `ab harvest context` | harvest session | rebuild `.ab/` with claimed observations, reconciled ledger, proposals, prior findings |
| `ab harvest submit <json>` | synthesize terminal | validate exact occurrence coverage and deposit a proposal artifact/event |
| `ab harvest verdict <approve\|revise\|escalate> …` | review terminal | deposit notes, stamped findings, and structured verdict |
| `ab harvest status [--events N] [--json] [--store …]` | operator/read-only | reduce and display the repository gate, recovery attempts/limit, stopped boundary, attention state, exact pending work, and latest run |

Agents never receive TicketSource credentials. Only the deterministic file step
creates/adopts approved proposals and commits ledger facts.

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
must never be returned as `completed`, so every current and future adapter
inherits the distinction from `no-terminal`. `failure.message` preserves
provider text; `permanent: false` means "use existing retry policy," not a
claim that the error is transient. Adapters extract native terminal errors and
a shared narrow classifier marks only positive authentication, permission,
quota, and billing evidence permanent. A failed `start` still returns an
endable session handle, guaranteeing transcript deposition and
`session.ended`; only failures with no completed SDK result/handle are thrown.
Harvest uses the same result: a permanent failure records
`harvest.failed {willRetry: false}`, whose reducer parks that repository run at
its durable step boundary. The dispatcher's separate outer recovery policy may
reopen that same run twice; this does not reset or alter the within-step attempt
policy represented by `harvest.failed.attempt`. Failure-tolerant finalize
post-steps record `ok: false` and their normal follow-up observation.

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
- **Routing — explicit role inheritance (§16.1):** the *runtime* that executes
  a session and the *model* it runs on live in one open `[roles]` map, alongside
  the independent `extensions` allowlist axis. Its reserved optional `default`
  entry is the raw repo-wide base and is never itself dispatched. Every phase
  role merges over it independently per field; a set extensions list replaces
  rather than unions. With no default runtime, wiring supplies the fallback.
  With no model on either the phase role or `default`, the merged runtime uses
  its own built-in default — the sole implicit fill-in. Otherwise the exact
  merged runtime/model pair must be compatible: model-only entries never search
  for a supporting runtime, and incompatible inherited models are never
  replaced with runtime-local defaults. Each runtime declares the model
  families it serves for that compatibility check. The default and every role
  resolve **eagerly, before any session launches**, with all problems aggregated
  into one error naming each role, runtime, model, and served families. Adding a
  runtime touches only the adapter registry, never the kernel. Mixing models
  across roles is intentional — a different reviewer catches more. The resolved
  runtime and model are recorded on every `session.started` (the frozen
  `runner` field carries the resolved runtime name), so an experiment's outcome
  is attributable to the configuration that produced it.
- **Transcripts come back through the interface**, not scraped from disk, so
  every adapter must produce one: the corpus is guaranteed complete, including
  turns rejected by a provider after a session handle exists.
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

On the interactive dispatch dashboard, `p` on a blocked build opens optional
feedback without hiding the blocker. Enter answers every escalation captured
when the field opened, regardless of `agent`, `stall`, or `policy` source:
whitespace-only input records human `resolution: retry` and carries no phase
feedback; nonempty input records human `resolution: guidance` with the trimmed
text. Escape cancels without an event. If the build was also authoritatively
paused, submission requests resume after answering the blockers. The normal
lease sweep re-attaches the parked phase from durable state. This is an attempt,
not a forced success: an unresolved condition or question may escalate again
and return the build to blocked.

Policy escalations caused by an exhausted bounded retry/round budget are the
narrow exception to the human-answer rule: a fresh `ab dispatch` invocation
answers an all-policy open set with dispatcher-authored `resolution: retry` and
attempts the build from durable state. This unattended startup path is an
explicit process-restart retry boundary, not a watch-tick loop; agent and stall
escalations remain human judgment gates until an operator answers them.

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
is separate from build streams. Its harvest reducer derives run/step state,
claims, review history, external-create ID reservations, filing facts, and the
authoritative committed disposition ledger; its dispatcher-settings reducer
independently derives intake and the claim-time auto-merge default.
Dispatch starts harvest fire-and-forget and tracks it as in-flight: watch ticks
remain responsive for janitor, lease sweep, ticket dispatch, dashboard input,
and SIGINT, while `--once` drains the visible workflow before exit. A
process-local in-flight guard prevents overlapping launches from one dispatcher;
the repository lease is the cross-process exclusivity gate. Heartbeats that
positively report a lapsed lease force the former owner to re-claim or stop at
the next durable boundary, so a replacement never advances concurrently.

Harvest pause is a repository-wide durable gate, not a run status. A human
`harvest.pause-requested` is acknowledged by the kernel as `harvest.paused` at
the next safe unit boundary; no later step, review round, filing unit, or new
scan starts while that fact stands. The open run, immutable observation claim,
artifacts, and completed rounds remain unchanged.

A non-retrying `harvest.failed` is a second durable stop: the latest run remains
`failed` and initially keeps its whole claimed snapshot. Before any new scan,
the dispatcher launches settlement of that outstanding run. Under the
repository lease the runner records a kernel-only
`harvest.recovery-requested {run, attempt, limit}` fact, then acknowledges that
request through the same `harvest.resumed` transition used for a human
`harvest.resume-requested`. The common acknowledgement returns the same run to
`running` and clears only its current error projection; run id, immutable claim,
scan/proposal/review artifacts, historical attempts, UUID reservations, and
filed proposal facts survive. A crash between request and acknowledgement is
reduced as one pending request, so a replacement acknowledges it without
spending another attempt.

Automatic recovery has a fixed outer limit of **two reopen attempts**, separate
from within-step retry policy and with no config surface or backoff. The runner
continues from the reduced boundary: completed steps do not re-run, an approved
set goes directly to filing, and already filed proposal keys are skipped. If a
reopened run stops again, the next durable request is monotonic. When the second
automatic reopen also fails, the runner atomically records
`harvest.recovery-exhausted`: stopped step/round/error, attempts/limit, committed
partial dispositions, released occurrence keys, and stable pending proposal
descriptors.

Give-up never silently destroys the snapshot. Before approval, every claimed
occurrence is pending and released. After approval, the deterministic partition
uses only the frozen scan/proposal artifacts and durable filing facts: filed
creates, still-valid frozen joins, and suppressions enter the committed
repository ledger and stay claimed; missing creates, tombstone/unknown joins,
and any otherwise unclassifiable members are pending and released. If a
successful artifact read proves content missing, malformed, or mismatched, the
classifier fails safe toward release; a rejected store read remains a transient
infrastructure failure and is retried instead of being mistaken for content.
No TicketSource call occurs while calculating this boundary. A durable attention
barrier then prevents the released work from being immediately reclaimed as a
succession of new bounded runs. `ab harvest status` reports recoverability,
automatic attempts/limit, the stopped boundary, exact pending
occurrences/proposal keys, and attention state.

A human resume before exhaustion and automatic recovery converge on
`harvest.resumed` and therefore the same reopened run shape. After exhaustion,
the same human command acknowledges only the attention barrier: it never
resurrects the terminal old run, and normal threshold scanning may then claim
the released work in a future run. Completed runs remain terminal. Deliberate
agent/stall/policy escalations are unchanged: they consume their claimed
snapshot, are never automatically recovered, and do not prevent later
observations from being scanned.

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
   configured Triage state explicitly, and keep a deterministic proposal key
   as the semantic/ledger identity. Before each new external create, generate a
   platform UUID v4 and durably reserve it for that proposal key; only then pass
   the reserved ID through the TicketSource adoption seam. A restart before
   create reuses the reservation, while a restart after create but before the
   per-proposal filing fact resends the same ID and adopts the ticket. Error
   resume also reads those filing facts before each create, so a partially filed
   approved set creates only its missing tickets. One terminal event commits
   every occurrence disposition.

The harvester only proposes: it never claims, readies, grooms, or dispatches a
proposal. A terminal escalation consumes its claimed snapshot so watch ticks do
not hot-loop, and harvest resume never reopens that deliberate human-in-the-loop
outcome. Completed/cancelled/missing proposal refs remain dedup tombstones.
Every step brackets start/result events and agent sessions/transcripts. The
dispatch header always projects the acknowledged repository gate as `harvest
ON`/`harvest OFF`; the selectable `Harvest` row exists only for an open run or
unresolved failed/escalated attention. Completed runs, idle paused repositories,
and acknowledged terminal attention have no row. The internal run id remains in
the repository journal, not in the row. Humans still own Triage → Ready.

## 13. Ticket source policy

The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) at claim time as part of initiation; after import, the
build never reads the tracker again. Human-legibility projections (spec
posted as a comment, final summary, status transitions) flow outward only.
This keeps the abstraction honest: a file-based TicketSource with nowhere to
put blobs must be fully workable.

**Pre-build edits.** `update(id, patch)` partially replaces the modeled
editable fields `title`, `body`, and `labels`. A patch is strict and must name
at least one field; supplied title/body values cannot be blank, while an
explicit empty label list clears labels. Omitted fields — including state,
assignee, and provider metadata — remain untouched. `transition()` exclusively
owns state changes; state is not an update field. Unknown tickets and invalid
patches fail before mutation and name the problem.

**Ticket dependencies.** A ticket may declare that it is blocked by other
tickets of the same source at creation (`ab ticket create --blocked-by`) or
amend one relationship later (`ab ticket block` / `ab ticket unblock`). Adds
require both tickets to exist, reject a direct self-block, and succeed as a
no-op when already present. Removes require the target ticket but succeed when
the relation or blocker is absent. The source owns both halves of what a
provider-neutral caller cannot know: how a blocker relationship is
*represented* (Linear issue relations; the file source's TOML `blockedBy`) and
what *complete* means for one (Linear's `state.type`; the file source's
`Done`). The dispatcher owns the decision built on those facts — an unresolved
blocker means the ticket is not claimed and not dispatched, and it creates no
build. Dependencies are written during grooming and read at dispatch time,
both of which are **initiation**, so the rule above — never consulted
mid-build — is untouched. A dependency-blocked ticket stays queued source work
rather than becoming a blocked build: the runtime `blocked` status is for
builds awaiting a human, not for work that has not started.

`create(draft, {state?, idempotencyKey?})` supports crash-safe outer-loop
filing. A state override lets harvest target Triage even when ordinary user
creation has another default. An idempotency key must adopt the same ticket on
retry across process restarts. File persists the opaque key in frontmatter,
and fake sources also treat it as opaque. Linear requires the key to be a
durably reserved UUID v4, sends it verbatim as the caller-supplied issue ID,
and queries that same ID to adopt after an ambiguous or duplicate create. The
deterministic proposal key remains the semantic ledger identity; the random
Linear ID is stable across restarts because its reservation fact precedes the
side effect. Ordinary Linear creation without an idempotency key generates and
sends no caller-supplied issue ID.

## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events in the applicable build
or repository log (§15.2.7): `escalation.answered`,
`build.pause-requested`, `build.resume-requested`, `build.abort-requested`,
`build.auto-merge-requested`, `build.auto-merge-cancelled`,
`dispatcher.intake-set`, `dispatcher.auto-merge-default-set`,
`harvest.pause-requested`, and `harvest.resume-requested`. The event vocabulary
*is* the UI API; forge mutation remains kernel/dispatcher plumbing.

- v2.0 front end: terminal, with herdr as the multiplexer.
- `ab dispatch` on a TTY is an interactive fixed frame. Its first two rows form
  an always-present process-global top section: one selectable `Auto Build`
  title row with the repository basename, capacity, active-build count,
  `intake ON`/`intake OFF`, `auto merge default ON`/`auto merge default OFF`,
  and `harvest ON`/`harvest OFF`, followed by one process-local status slot.
  All three control values come from the repository journal and survive process
  restarts and other dispatchers' writes. The harvest token reflects only its
  reducer's acknowledged gate state, never an optimistic pending command. Tick
  counts, dependency diagnostics, parked-build notices, harvest outcomes,
  action confirmations, and warnings replace that slot instead of entering
  scrollback. A blank row separates the top section from the first body row,
  and another separates the body from the legend or modal controls. The
  redundant startup banner is omitted. `--plain` (and non-TTY output) remains
  line-oriented, prints every line as before, and reads no keyboard input.
- Up/Down move through one ordered list: the global top section first, optional
  `Harvest` second, then slug-sorted builds. Selection survives repaint,
  re-sort, and body-row appearance/disappearance by tracking a discriminated
  stable identity (`global`, `harvest`, or build slug), never a row index. The
  selection marker appears at the start of the title when global is selected;
  Up there is a no-op.
- The bottom legend is the authoritative, contextual key map. Navigation and
  Ctrl-C appear for every selection. On global it offers `p` for intake, `m`
  for the claim-time auto-merge default, and `h` for the durable harvest gate.
  On `Harvest`, it offers `p resume` for an ordinary failure or `p acknowledge`
  for unresolved exhaustion/escalation, and no run action while running or
  awaiting acknowledgement. On a build it offers `p` for pause/resume (or
  blocked feedback) and `m` for durable auto-merge intent. `m` on `Harvest` is
  an explanatory build-only no-op. While the blocked-resume field is active,
  printable keys edit it, Backspace edits,
  Enter submits, and Escape cancels; navigation and actions are suppressed.
  The field stays bound to its captured build and escalation ids, polling
  remains live, and that build's blocker rows remain visible.
- Intake is durable repository state. `--intake` and `--no-intake` are mutually
  exclusive explicit setters; omission reuses the latest stored value, with ON
  as the fallback only when no intake fact exists. `p` on global re-reads the
  journal and appends the opposite current value. Every serialized dispatch
  tick re-reads the setting before its claim stage, and the dashboard's existing
  poll reflects changes from any dispatcher. When off, new ticket claims are
  skipped in every dispatcher for that repository while janitor, stale-runner,
  harvest, and in-flight work continue.
- The claim-time auto-merge default is independent durable repository state,
  not `autobuild.toml` configuration. `--auto-merge` and `--no-auto-merge` are
  mutually exclusive explicit setters; omission reuses the latest stored value,
  with OFF as the fallback only when no fact exists. Global `m` re-reads and
  appends the opposite current value. Each tick samples the current repository
  value. When on, each ticket claim that creates a fresh build appends the
  existing human-authored `build.auto-merge-requested` fact immediately after
  `build.created` and before runner launch, so the build's first visible frame
  already shows `auto merge` and normal durable cancellation/native-application
  behavior applies. The default is sampled only at creation: changing it never
  writes to existing builds, resumed/adopted logs are unaffected, direct
  creation paths are unaffected, and build-row `m` remains independent
  (including cancellation while the default stays on). Repository sequence
  order gives each setting independent last-write-wins semantics; polling, not
  a push channel, propagates changes between dispatchers.
- Repository harvest is projected with the same `PipelineStep` representation
  and row grammar as builds, but the gate and run are separate display facts.
  The header's green/yellow `harvest ON`/`harvest OFF` token is always present
  and comes from acknowledged `paused` state in the repository event log, so it
  survives processes and reflects other actors. Header `h` re-reads that log
  and appends `harvest.pause-requested` or `harvest.resume-requested`; the newest
  pending command is the requested target, so rapid presses countermand each
  other, while the token itself changes only on `harvest.paused` or
  `harvest.resumed`.
- The optional run row's identity is `Harvest` (never its internal run id). It
  exists for a running/open run, including one frozen by a paused gate, and for
  unresolved `FAILED` or `ESCALATED` attention. `completed` removes it
  immediately. An idle paused repository has no row. Recovery-exhausted failure
  disappears after its attention acknowledgement. Because escalation has no
  dedicated acknowledgement payload, its row disappears only when the raw
  journal contains a human `harvest.resume-requested` after that run's terminal
  seq and a later kernel `harvest.resumed` that consumes the request; the request
  alone is not enough. Row removal structurally reconciles selection to the
  successor at that index or the final predecessor (the global row when no body
  row remains).
- A visible row keeps the existing right-aligned status colors, completed-step
  projection, frozen timing, claim count, and stopped-boundary detail. A paused
  open run reads yellow `PAUSED`; ordinary infrastructure failure reads red
  `FAILED` with automatic progress and offers `p resume`. Exhaustion remains
  red and says `recovery exhausted — human attention required`, names the stop,
  reports pending count, and offers `p acknowledge`; escalation also offers
  `p acknowledge`. A pending resume advertises no duplicate action. Row `p`
  never emits a pause. If the gate is off it writes nothing and directs the
  operator to select the header and press `h`; that header resume deliberately
  serves both as gate intent and, after kernel acknowledgement, run resume or
  attention acknowledgement under the shared event vocabulary. The exhausted
  run remains terminal, an ordinary failure reopens, and an escalation remains
  terminal but its display attention is dismissed. `m` remains the build-only
  explanatory no-op.
- Verify progress is never color-only. A passed step uses the ordinary done
  rendering; a skipped step is also satisfied but carries the literal
  `skipped` qualifier (for example `[x] verify:e2e(skipped)`), while a failed
  cycle retains `failed` and provisional semantics. `ab build status` likewise
  exposes the canonical outcome in JSON and renders `SKIP` plus the reason in
  text.
- A build with auto-merge intent off has no auto-merge token. Requested,
  natively enabled, and cancelling intent all render the literal `auto merge`;
  teal/cyan means requested locally but not yet applied, green means native
  auto-merge is enabled, and yellow means cancellation is in flight. The token
  disappears when the correlated cancelling fact lands. Auto-merge intent uses
  GitHub-native auto-merge whenever a real merge gate exists; on a
  proved-ungated branch it consents to the guarded non-admin squash fallback
  defined in §15.7.
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
validated by the separate repository catalog in `src/events/repository.ts` so
build reducers cannot accidentally interpret repository workflow or control
state.

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
   `*-requested`/`*-cancelled` events, `escalation.answered`, and strict
   dispatcher setting facts; kernel or dispatcher plumbing acknowledges effects
   that require a boundary. Build
   commands use the build stream; harvest commands and dispatcher settings use
   the repository journal. The store is the *only* coordination surface — no
   side channel —
   and polling covers commands exactly the way it covers `subscribe`. A runner
   that is dead still receives pause/resume/abort commands and escalation
   answers on resume. Auto-merge commands carry desired state until PR plumbing
   applies them, including when the command predates PR creation.

### 15.3 Catalog

**Build lifecycle**

| Type | Actor | Payload |
|---|---|---|
| `build.created` | dispatcher, human | `{ticket: {source, id, url, title}, repo, baseBranch, dashboardFrames?: {provider: "github-release", repository, releaseId}}` (optional target frozen at claim time) |
| `build.completed` | dispatcher | `{outcome: merged \| closed-unmerged \| abandoned}` |
| `runner.attached` | kernel | `{instance, host, resumedFromSeq?}` |
| `workspace.provisioned` | dispatcher, kernel | `{provider, ref, branch, base: {source: remote, sha} \| {source: local, sha, remoteError} \| {source: existing, sha}}` |
| `workspace.released` | dispatcher, kernel | `{}` |

`workspace.provisioned.base.sha` is the branch commit actually selected or
reused. `remote` means first creation from the freshly fetched origin tip;
`local` is the non-fatal stale-local fallback and must retain why remote was
unusable; `existing` means resume at an already-created branch tip with no base
refresh. Historical provisioning facts without `base` remain readable, while
all new writes require it.

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
| `plan.completed` | agent | `{round, artifact: {kind: "plan", rev}, verifySteps?: [step]}`; current writers include the validated effective set in config order, omission is historical default-all |
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
| `verify.completed` | kernel, agent | pass/fail: `{step, attempt, outcome: "pass" \| "fail", report?: {kind, rev}}`; skip: `{step, attempt, outcome: "skipped", reason}` |
| `finalize.started` | kernel | `{}` |
| `finalize.completed` | kernel | `{pr: {number, url, headSha}}` (kernel opens the PR after the agent's `ab done` — [D7], §8.6) |
| `finalize.step-completed` | agent | `{step, ok, note?}` |
| `dashboard-frame.hosted` | kernel | `{frameId, artifact: {kind, rev}, asset: {provider: "github-release", repository, releaseId, assetId, url}}` |
| `dashboard-frame.reclaimed` | dispatcher | `{hostedSeq}` |
| `dashboard-frame.reclaim-failed` | dispatcher | `{hostedSeq, attempt, error}` |

The dashboard-frame facts are audit/cleanup plumbing only and never change
phase, status, or verification routing. `hostedSeq` correlates cleanup with the
exact successful upload fact, so deletion survives config changes and workspace
removal.

The skipped reason is trimmed and must remain non-empty. For stored-log
compatibility, readers also accept the historical strict payload
`{step, attempt, pass: boolean, report?}` and normalize `true → pass`,
`false → fail` without rewriting or reclassifying any event. Current writers
always emit `outcome`; mixed boolean/outcome shapes are rejected.

**Post-PR [D1]** (see §15.7; `pr.*` emitted by the dispatcher acting as
janitor, `reconcile.*` by a re-attached build-runner)

| Type | Actor | Payload |
|---|---|---|
| `pr.auto-merge-enabled` / `pr.auto-merge-disabled` | kernel, dispatcher | `{commandSeq}` (correlated native-state application fact; never emitted for a direct candidate) |
| `pr.merged` | dispatcher | `{sha}` |
| `pr.closed` | dispatcher | `{}` |
| `pr.conflicted` | dispatcher | `{baseSha}` (detection-time snapshot/evidence) |
| `reconcile.started` | kernel | `{attempt, baseSha}` (fresh execution-time merge target) |
| `reconcile.completed` | agent | `{mergeCommit, artifact: {kind: "reconcile-notes", rev}}` |

The two `baseSha` facts deliberately have different boundaries:
`pr.conflicted.baseSha` preserves what the janitor observed when it detected
conflict; `reconcile.started.baseSha` records the base freshly fetched and
resolved immediately before that actual attempt runs. Agent context uses only
the matching started fact, never the older conflict snapshot.

**Cross-cutting**

| Type | Actor | Payload |
|---|---|---|
| `observation.recorded` | agent | `{id, kind: followup \| refactor \| latent-bug, summary, files?, refs?}` |
| `escalation.raised` | agent, kernel | `{id, phase, round?, source: agent \| stall \| policy, question, refs?}` |
| `escalation.answered` | human; dispatcher only for all-policy startup retry | `{id, answer, resolution: guidance \| dismiss-finding \| revise-spec \| abort \| retry}` |
| `phase.failed` | kernel | `{phase, round?, attempt, error, willRetry}` (infra failure — distinct from verdicts) |

**Repository dispatcher controls** (separate journal)

| Type | Actor | Payload |
|---|---|---|
| `dispatcher.intake-set` | human | `{enabled: boolean}` — repository-wide ticket-claim gate |
| `dispatcher.auto-merge-default-set` | human | `{enabled: boolean}` — repository-wide claim-time default |

Both are strict setting facts, not request/acknowledgement pairs. Each setting
reduces independently by greatest repository sequence. A missing fact yields
the historical fresh-repository default: intake ON and auto-merge default OFF.

**Repository observation harvest** (same separate journal)

| Type | Actor | Payload |
|---|---|---|
| `harvest.pause-requested` / `harvest.resume-requested` | human | `{}` — durable repository commands |
| `harvest.paused` / `harvest.resumed` | kernel | `{}` — safe-boundary acknowledgements; resume settles either a human or automatic request, while post-exhaustion human resume acknowledges attention only |
| `harvest.recovery-requested` | kernel | `{run, attempt, limit}` — monotonic durable selection of one automatic reopen |
| `harvest.recovery-exhausted` | kernel | `{run, step, round?, error, attempts, limit, releasedObservations, committedDispositions, pendingProposals}` — atomic partial-ledger/selective-release/attention boundary |
| `harvest.started` | kernel/dispatcher | `{run, observations: [{build, seq}], scan: artifact}` — atomically claims the snapshot |
| `harvest.step.started` / `harvest.step.completed` | kernel | `{run, step: scan \| synthesize \| review \| file, round?, outcome?, artifact?}` |
| `harvest.session.started` / `harvest.session.ended` | kernel | run/session/role/round and transcript/usage facts |
| `harvest.proposals.submitted` | agent | `{run, round, artifact}` |
| `harvest.review.verdict` | agent | `{run, round, verdict, findings, artifact, reason?}` |
| `harvest.proposal.id-reserved` | kernel | `{run, proposalKey, id}` — UUID v4 reserved before external create |
| `harvest.proposal.filed` | kernel | `{run, proposalKey, ticket}` — post-create adoption/filing boundary |
| `harvest.completed` | kernel | `{run, dispositions, report}` — authoritative committed ledger facts |
| `harvest.escalated` | kernel/agent | `{run, source, reason, round?, observations}` |
| `harvest.failed` | kernel | `{run, step, round?, attempt, error, willRetry}` — `willRetry:false` parks the run for bounded automatic or explicit recovery |

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
`escalation.raised` without a matching `escalation.answered`; matching is by id,
so answering every open id clears the block regardless of source. `paused` ≡ a
`build.paused` without a later `build.resumed`; paused has authoritative reducer
precedence, while the dashboard visually labels a paused build with open
escalations as blocked and retains a separate `(paused)` marker. `autoMerge`
retains the latest human desired value and command seq separately from the
latest applied `{enabled, commandSeq}` fact. The desired command is settled only when both
fields match, so a stale acknowledgement cannot erase newer intent. The
operator UI's build list is exactly this reduction over every build in the
store.

The separate dispatcher-settings reducer derives intake and the claim-time
auto-merge default from their latest independent setting facts; it ignores
harvest facts. Every dispatcher tick and dashboard projection uses that current
reduction. The separate repository harvest reducer ignores dispatcher settings
and derives `paused`, its acknowledgement sequence/time, pending pause/resume
commands, runs, claims, automatic recovery
request/ack history, exhaustion/attention state, and the disposition ledger from
repository events. `harvest.pause-requested` alone does not close or change a
run; only `harvest.paused` closes the gate. While paused, `openHarvestRun` still
returns the same running snapshot. Opposing human requests expire older pending
intent and acknowledgements clear requests of their kind. A non-retrying
failure changes only the latest run to the parked `failed` state and initially
retains its claim. A correlated `harvest.resumed` reopens that ordinary failed
run identically for a human or automatic request, preserving every workflow
collection and historical attempt. `harvest.recovery-exhausted` verifies that
committed dispositions plus released keys partition the immutable snapshot,
adds the committed subset to the ledger, removes only released keys from the
claim set, and raises attention atomically. A later human-requested `harvest.resumed` acknowledges that barrier without
reopening the exhausted run. Completed and escalated outcomes are irrevocable.
The dashboard additionally treats a post-terminal human resume request plus its
later kernel resume acknowledgement as display-only resolution of escalated
attention; neither event changes that run's terminal reducer state.

### 15.6 Walkthroughs

**Happy path** (elided: `session.started/ended` brackets around every agent
run):

```
build.created → workspace.provisioned{base:{source:remote,sha}} → spec.imported → runner.attached
plan.started{r1} → plan.completed{plan@1, verifySteps}
plan-review.started{r1} → plan-review.verdict{approve}
implement.started{r1} → implement.completed{commits, notes@1}
code-review.started{r1} → code-review.verdict{approve}
verify.started{types} → verify.completed{outcome:pass} → …unit → …e2e → …evals
finalize.started → finalize.completed{pr} → finalize.step-completed{release-notes}
(later, janitor:) pr.merged → workspace.released → build.completed{merged}
```

**A — verify failure:** `verify.completed {step: e2e, outcome: fail, report}` →
kernel routes back into the code loop: `implement.started {round: 2,
feedback: {verify: {step, report}}}` → fix → `code-review` round 2 →
approve → verify re-runs **from the first step** (implement changed the
code; cheap checks first), `attempt: 2`. `policy.maxVerifyAttempts`
exhausted → `escalation.raised {source: "policy"}`.

**A2 — verify skip:** `verify.completed {step: e2e, outcome: skipped,
reason}` leaves the reason queryable and advances to the next configured step
(or finalize) in that cycle. It retains the cycle's `attempt` identity but does
not increment the failure budget, count as a pass, or hide a failure from any
other step.

**A3 — path applicability:** for a step with `paths`, the kernel diffs current
`HEAD` against the durable branch-cut base immediately before that step. No
match produces `verify.started` then a kernel-authored skipped completion whose
reason names `[verify.<step>].paths`; neither command nor agent/server/session
starts. A reconcile promotes its successfully refreshed base SHA and begins a
new verify cycle, so rules are evaluated again: upstream-only merged paths are
subtracted while build-owned conflict resolutions can bring a previously
skipped step into scope. Diff/base infrastructure failure produces no skip and
fails closed for retry.

**B — review stall:** round 1 `code-review.verdict {revise, [f1]}` → round 2
verdict's finding marks `persists: [f1]` → round 3 again → kernel:
`escalation.raised {source: "stall", refs: [chain]}`; status → `blocked`.
`escalation.answered {resolution: "guidance"}` feeds the answer into the next
producer round as authoritative feedback; `dismiss-finding` marks the chain
human-resolved and the next reviewer round is told so.

**C — sandbox death:** log ends at `implement.started {round: 2}`; heartbeat
column goes stale → dispatcher expires the lease, provisions a fresh
sandbox → `workspace.provisioned {base: {source: existing, sha: <round-1
head>}}` → `runner.attached {resumedFromSeq}` → reducer says implement r2
started-not-completed → re-run the phase from its start. The provider restores
the already-created branch at round 1's pushed `head` [D3]; the Git adapter
checks that branch before remote access and never re-cuts it from a newer base.
`ab context` rehydrates scratch from the store into a fresh session.
Uncommitted round-2 work is lost by design (§7.3 — phase boundaries are the
resume points).

One live `ab dispatch` process single-flights build-runners by build slug. Its
in-memory runner slot is stronger local liveness evidence than a transiently
stale lease, so repeated ticks cannot replace a runner that the same process
still knows is active or open competing agent sessions for its current phase
attempt. The slot clears when that runner settles or fails; a no-terminal turn
can therefore take its existing bounded sequential retry, and later actionable
work can be launched again. This guard is deliberately not durable: when the
process genuinely dies its memory disappears, and the BuildStore lease remains
the cross-process stale-runner exclusion and recovery gate. An open historical
`session.started` bracket is never used as a lock because a dead session may
never append `session.ended`.

A new `ab dispatch` process does not wait for the ordinary stale-lease sweep
to discover work: on its first tick it attempts every actionable,
non-terminal build in its repo. Lease claiming remains the exclusivity gate,
so an old runner that is genuinely alive wins harmlessly. Pauses, PR/spec
waits, and agent/stall escalations remain parked. An all-policy escalation
set is recorded as dispatcher-authored `escalation.answered {resolution:
retry}` before launch, re-arming the bounded phase-failure budget once for this
invocation. This remains distinct from a human dashboard submission: the human
may retry any source with empty input or supply guidance, and the later ordinary
lease sweep performs the reattachment.

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
  the build's landing point. The operator's `m` command is durable consent to
  merge. Whenever the exact base branch has a real merge-blocking gate
  (classic protection or an active repository/inherited organization
  ruleset), enabling uses GitHub-native `gh pr merge --auto --squash`; this is
  true even when every requirement is currently satisfied and GitHub reports
  `CLEAN`. When both gate probes authoritatively report no gate, the janitor
  may instead run a normal guarded squash (`--squash --match-head-commit`) —
  never `--admin`, force, or rebase. The fallback additionally requires the PR
  to be positively mergeable and the engine to be parked at `awaiting-pr`, so
  finalize post-steps and every post-reconcile verify step have completed.
  Unknown gate data, unknown/future merge states, opaque blockers, auth errors,
  and permission failures fail closed; none authorizes the fallback.
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
log after opening/adopting the PR and reconciles any unmatched command before
committing `finalize.completed`; later commands are reconciled by the janitor
on open PRs. `pr.auto-merge-enabled`/`disabled` acknowledges only a confirmed
native desired state and cites the human command seq. An ungated or
transient result leaves intent pending and finalize completes normally; the
janitor is the sole owner of a direct fallback. Immediately before that call it
re-reads the log, requires the same latest command seq still requests merge,
and checks the deterministic engine is at `awaiting-pr`. Cancellation therefore
prevents a fallback and disables native auto-merge when one exists.

Both native and direct forge calls precede their durable observation. Native
application is idempotent across the forge-call/event-append crash window. A
direct squash emits no speculative event: whether the call succeeds and the
process lives or dies, the next ordinary forge poll observes the landed PR and
emits `pr.merged`, then workspace release and `build.completed`. The expected
head SHA rejects a changed-head race, and a normal (non-admin) merge remains
subject to protection added after the probe.

`build.completed` is also the reclamation boundary for hosted dashboard copies.
After completing merged, closed-unmerged, or abandoned work, the janitor deletes
every `dashboard-frame.hosted` handle not correlated by a later
`dashboard-frame.reclaimed`. It revisits already-done builds to close the
completion/delete crash window. A timeout, API error, or unavailable capability
appends `dashboard-frame.reclaim-failed` and leaves the handle pending; a later
tick retries, and provider 404 means success. Cleanup runs from the main
repository after workspace removal and can neither delay nor undo build
completion, ticket transition, or capacity release.

**Conflicts re-enter the pipeline via `reconcile`.** When the janitor's
mergeability check fails it emits `pr.conflicted {baseSha}` and re-attaches
a build-runner (the dispatcher itself never runs agents). That SHA is durable
detection-time evidence, not the later merge target. Immediately before each
actual reconcile run, after its bounded infrastructure-retry guard, the runner
fetches the build's frozen `build.created.baseBranch` from `origin` into a
build-scoped internal ref, resolves it as a commit, and emits
`reconcile.started {attempt, baseSha}`. `ab context` supplies the newest started
SHA matching that attempt; it never falls back to `pr.conflicted`. A fetch or
resolution failure emits `phase.failed` and starts no agent, so known-stale
input is never used.

A crashed attempt re-runs with the same attempt number but refreshes and records
the base again before its replacement session. If the base moves after a
session starts, a still-conflicted PR is observed by the existing epilogue loop
and receives the next reconcile attempt.

The agent merges that supplied base into the branch guided by the spec, plan,
and implement-notes, with the explicit charge to regress against neither; the
resolution lands as a merge commit (`reconcile.completed {mergeCommit}`; the
push is `ab done` plumbing per [D7]). Because reconciliation changed code,
**`verify:*` re-runs in full**; a failure routes back into the code loop as
usual (§5). A resolution the agent judges risky — semantic conflicts,
spec-relevant choices — escalates rather than guesses. Reconcile output skips
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

# Optional; omission is the default text-only behavior.
[dashboardFrames]
provider = "github-release"
repository = "owner/public-review-assets"
releaseId = 123456

[commands]                      # deterministic verbs the kernel may run
setup = "bun install"           # after provision / sandbox rehydrate (§15.6-C)
# This example assumes the root package defines these exact scripts.
lint = "bun run lint"
typecheck = "bun run type-check"
test = "bun run test"

[server]                        # dev-server lifecycle — see §16.2
start = "bun dev"
url = "http://localhost:3000"   # readiness probe target
readyTimeout = 60               # seconds

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
paths = ["web/**", "src/routes/**"] # optional positive any-match selectors
# always = true                 # mandatory/non-deselectable; overrides paths

[finalize]
steps = ["release-notes"]       # optional post-steps, failure-tolerant (§5)

[roles.default]                 # reserved inheritance base, never a phase (§9)
runtime = "claude"              # no configured model ⇒ this runtime's own default
                                 # no extensions ⇒ hermetic

[roles.slug]                    # optional pre-build naming override
runtime = "pi"
model = "openai-codex/gpt-5.6-sol"

[roles.plan]                    # fields override default independently
runtime = "pi"
model = "openai-codex/gpt-5.6-sol"
extensions = ["subagents", "web-access"]

[roles.code-review]
runtime = "pi"
model = "moonshotai/kimi-k3"
extensions = ["web-access"]

[roles.harvest]                 # optional producer override
runtime = "pi"
model = "openai-codex/gpt-5.6-sol"

[roles.harvest-review]          # optional fresh-reviewer override
runtime = "pi"
model = "moonshotai/kimi-k3"

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3

[dispatcher]
capacity = 3                    # concurrent builds for this repo

[tickets]
source = "file"
readyLabels = ["autobuild"]
readyState = "ready"            # required: the one state a ticket must sit in to dispatch

[harvest]                       # observation-count back-pressure in dispatch
threshold = 10

[outer]                         # cron schedules for OTHER ingesters
"ingest:sentry" = { cron = "0 */4 * * *" }
```

Declarative (TOML), not executable config: the kernel, dispatcher, CLI, and
any future tooling parse it without evaluating anything; commands are plain
shell strings. The removed legacy `[agent]` table is rejected with an error
that directs its fields to `[roles.default]`; it is not a parsing alias or an
automatic migration.

`[dashboardFrames]` is optional and has no enabled default. Its provider is the
literal `github-release`; `repository` is one nonblank `owner/repo` pair and
`releaseId` is positive. The release must pre-exist, be published and mutable,
and its repository must be public because GitHub's image proxy cannot fetch
authenticated release assets. Autobuild creates no release or tag. The `gh`
identity needs Contents write permission on the host repository. The dispatcher
copies this target into `build.created`, so an in-flight build never changes
destination when branch config changes or a dispatcher restarts.

A plan may begin with the narrow TOML front-matter contract below; no other
plan metadata is interpreted:

```toml
+++
verifySteps = ["types", "e2e"]
+++
```

This is the complete selected set, not an ordering or configuration channel.
Names must exist in `[verify].steps` with matching tables; the planner's
`ab done` rejects malformed metadata, blanks, duplicates, unknown names, and
omission of an `always = true` step before appending `plan.completed`. New
writes record the effective list in config order. Missing metadata and
historical events without the field mean all configured steps. `plan-review`
reviews the block in the same artifact with the existing verdict vocabulary;
the completion present when its approving verdict lands is authoritative, not
the latest or a superseded revision. A `spec.revised` restart replaces the
selection through a fresh approved plan. Reconcile reuses it for every new
verify cycle.

Both verify kinds accept optional `paths` and `always`. `paths` is a non-empty
list of positive repository-relative globs with OR semantics across both rules
and changed paths. Matching is case-sensitive over Git `/` paths. The grammar
supports literals, segment-local `*`/`?`, and `**` only as a whole segment;
absolute/traversing/empty segments, negation, escapes, character classes, brace
expansion, extglobs, and malformed `**` fail strict config validation at the
named step. No `paths` is unconditional. `always = true` overrides a present
list (which is still validated), is mandatory for plan selection, and false is
equivalent to omission.

For each unsatisfied configured step, the engine checks the approved plan
selection first. Exclusion writes the ordinary skipped outcome with
`excluded by approved plan selection (plan@<rev>): verify step "<step>" was not selected`
and performs no diff, command, server, or session work. A selected step then
continues to applicability. The runner evaluates a conditional step from
current `HEAD` using
`git diff --no-renames --name-only -z`. The base is the initial
`workspace.provisioned.base.sha`, promoted only by a `reconcile.started.baseSha`
whose reconcile successfully completed. Thus both rename sides are visible,
filenames are NUL-safe, and newly merged upstream-only work is not attributed
to the build. Evaluation repeats in each cycle. No match records the canonical
skipped outcome with
`excluded by [verify.<step>].paths: no changed path matched <JSON paths>` and
launches nothing; Git/base failure is infrastructure, never a synthetic skip.

This repository installs `dashboard` after its deterministic checks as the first
consumer of that applicability boundary. `src/integration/dashboard-capture.ts`
uses the existing scripted-agent integration harness, injected dispatch
terminal/input, and per-paint renderer hook to prepare several real pipeline
positions plus an open paused Harvest row, then captures fixed-clock wide and
narrow frames. The dashboard's limited ANSI/OSC vocabulary is rendered with a
pinned local DejaVu Mono font and system fonts disabled into deterministic PNG
and plain-text artifact pairs. The verifier opens every PNG and reaches its
verdict from those images; it neither inspects the diff nor self-skips. Captures
are evidence, not byte-exact golden gates, and require no network, live runner,
forge, browser, or hosted asset.

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
`implement`, `code-review`, the dashboard-image and sample e2e agent-verify
steps, `finalize`, `reconcile`,
`spec`, `tickets`, `guide`, and the outer-loop skills). `ab init` installs into
a repo:

- When `autobuild.toml` is absent, renders it from a valid setup-only baseline
  template after inspecting only the target repository's root `package.json`.
  Exact own script keys produce fixed fragments: `lint` →
  `lint = "bun run lint"` (command only), `type-check` →
  `typecheck = "bun run type-check"` plus the `types` check, and `test` →
  `test = "bun run test"` plus the `unit` check. Missing `package.json` or a
  missing `scripts` map produces no package-backed commands or checks;
  malformed JSON or an invalid recognized declaration fails with the manifest
  path. The `types` and `unit` tables exist only with their backing commands.
  Existing config is never reconciled or overwritten, even with `--force`.
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
   `src/events/payloads.ts`; repository workflow and control payloads are frozen
   separately in `src/events/repository.ts`. Every adapter validates before
   append.
2. **[OPEN] Other-ingester detail** — observation harvest and its typed CLI,
   repository journal, ledger, trigger, and review loop are decided in §8.8 and
   §12. Per-source filter design for scheduled `ingest:*` sources remains open.
3. **[OPEN] Retention/archival policy** — the v1 archival gap, now a store
   config concern rather than a repo problem. Needs a default (e.g. prune
   blobs for merged builds after N months, keep events).
4. **[OPEN] Global capacity** — per-repo capacity lives in `[dispatcher]`
   (§16.1); whether a cross-repo global cap is needed, and where it lives,
   is unresolved.
