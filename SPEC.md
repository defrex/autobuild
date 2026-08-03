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

Principles — the first four carried from v1 — that are non-negotiable and that
every design decision below answers to:

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state. Agent surfaces own the fuzzy parts
   (primarily skills, plus narrow pre-build seams such as naming); plain tested
   code owns the state machine, validation, fallback, dedup, gating, and
   plumbing.
2. **Resumability is not a feature.** Re-running a build resumes it. There is
   no separate resume path; every phase is a function of durable state.
3. **Ingesters propose, humans dispatch.** Nothing auto-generated moves past
   Triage without a human grooming it to Ready. That single gate is where
   taste and prioritization live. A repository may waive the gate for its own
   harvest by naming a filing state (`[tickets].proposalState`, §12); the
   waiver is explicit, repository-wide, and configured, and no code path
   reaches Ready without one.
4. **Every step leaves a paper trail** — queryable, not carried in the repo.
5. **Processes communicate only through durable state.** There is no private
   channel between Autobuild processes — not kernel to operator UI, not parent
   to child, not kernel to sandbox. A process's liveness may be observed; what
   it has *done* is known only by reading the log. This is what keeps every
   component relocatable, and why a new process boundary never needs a new
   protocol.

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
| `TicketSource` | list/claim/comment/transition/create/update tickets; add, remove, and resolve declared dependencies | file-based (default directory); Linear; third-party in-process registrations; later GitHub Issues |
| `AgentRunner` | run agent sessions (see §9) | Claude Code CLI (headless); Codex CLI (`exec --json`); pi (SDK mode); third-party in-process registrations |
| `Workspace` | provision isolated working copies | git worktree; third-party in-process registrations; later remote sandbox |
| `Forge` | git + PR plumbing | GitHub; local Git; third-party in-process registrations |
| `TelemetrySource` | production signals | Sentry; later log streams |
| `BuildStore` | per-build streams plus repository journals: events, artifacts, transcripts, leases (see §7) | local; remote HTTP |

#### 3.2.1 In-process adapter plugins

A repository may list trusted Bun modules in `autobuild.toml`. Each module
default-exports a strict manifest with a diagnostic `name`, an `apiVersion`
semver range, and optional name-to-factory maps for `ticketSources`,
`agentRuntimes`, `workspaceProviders`, and `forges`. One manifest may register
adapters for several ports. A ticket-source entry is either its legacy bare
factory or `{ factory, requiredEnv?, contract? }`; `requiredEnv` lets the host
reject unset or empty credential variables before construction with a
diagnostic that names both source and variables. Plugin API 1.1 introduces the
descriptor metadata while remaining compatible with manifests accepting
`^1.0.0`. Factories receive
adapter-specific config, the process environment, and the absolute repository
root, and remain lazy during startup registration. Runtime registrations reuse
§9's capability-bearing `RuntimeRegistration`; the frozen `AgentRunner`
interface is not widened.

The host exposes one versioned authoring surface, `autobuild/plugin-sdk`: port
and manifest types, the reusable TicketSource/AgentRunner/WorkspaceProvider/
Forge/BuildStore/BlobStore contract suites, and fake/reference adapters. Plugin
production code can use erased type-only imports, with Autobuild present only
as a development or peer dependency; a consuming repository needs no bridge
module.

Plugin resolution has two repository-owned roots. Relative, absolute, and
`file:` specifiers resolve from the repository root whose config is being read;
in a scoped build CLI process, that is the immutable build worktree. Bare
package specifiers and package export maps resolve from the consuming
repository's main checkout, so they use that repository's installed
dependencies—not Autobuild's installation—and remain available when a local
store places linked worktrees outside the checkout's package ancestry. Dispatch
and sessionless commands naturally use the main checkout for both roots.
Autobuild does not install a missing package.

Configured specifier strings must be unique: an exact repeated value fails
config validation before module resolution or evaluation, identifies the
duplicate and its first declaration, and directs the operator to remove or
deduplicate it. Distinct specifier strings remain separate declarations.
Modules load in declaration order during `ab dispatch`, the sessionless
`ab ticket` commands, and scoped build CLI composition. Dispatch loads them after
strict config parsing and before stores, production adapters, ticket claims, or
build launch; ticket commands load them before ticket access; scoped processes
load worktree config and repository-path modules, but use the main checkout only
for package lookup, before opening their store or executing terminal plumbing.
Resolution/evaluation errors, malformed or missing default manifests, and
plugin-API incompatibility fail startup with both the configured module and
available compatibility details.
Builtin registration names and names registered by an earlier plugin are
reserved per port; collisions fail atomically, identify the conflicting adapter
and owners, and shadow nothing. The same name may exist on different ports.
`[workspace].provider` selects from the
workspace catalog; omission selects `git-worktree`. The selected factory is
invoked lazily with `[workspace.config]`, environment, and repository root.

Each adapter map value may remain a bare factory or may be an object containing
that factory plus an optional `contract: { factory, live? }` descriptor; ticket
sources may carry `requiredEnv` in the same object. The contract factory
receives the same repository context and returns the fixture
factory required by that port's unchanged shared suite. `ab plugin list`
projects builtin and configured registrations with provenance, resolution kind,
API compatibility, and contract availability. `ab plugin doctor` exhaustively
attempts every configured module and exits nonzero if any fail; this diagnostic
collection does not weaken `ab dispatch`, which remains fail-fast. `ab plugin
test <ticket-source|agent-runtime|workspace-provider|forge> <adapter>` delegates
one selected suite to Bun's test runner and preserves its per-test output and
exit status. A descriptor marked `live` is never launched unless
`AB_RUN_LIVE_PORT_CONTRACTS=1` is explicitly present.

Plugins execute in-process and are Bun-only. They have the same repository
trust boundary as declarative shell commands: no sandbox is promised.
`[tickets].source` may name a loaded plugin registration; unknown names fail
with all available builtin and plugin names. Dispatch routes one selected
instance through readiness, dependencies, claim, projection, harvest creation,
and janitor completion; the same registration backs every source-agnostic
`ab ticket` operation. Plugin sources receive the existing `[tickets]`
lifecycle fields unchanged and own any further validation; credentials remain
environment-only.

Forge selection is open through the root `forge` scalar (`github` by default).
Two adapters ship: `github` publishes through GitHub/`gh`; `local-git` uses only
the repository's shared local Git database and requires no remote, network, or
forge credentials. A selected plugin factory receives an empty adapter config, process
environment, and absolute repository root, and is invoked before store opening.
Unknown names list the complete available forge catalog. Dispatch and scoped
build CLI processes resolve the same configured name independently, and all
forge plumbing receives the selected adapter unchanged. `PrRef.url` is the
provider's nonblank locator: an HTTP(S) URL when a web UI exists, or a literal
provider-native identifier such as `refs/heads/ab/<slug>` for local Git. Workspace selection is
open through `[workspace].provider` as described above.

Agent runtime selection is open through every `[roles.*].runtime`: dispatch
materializes registered runtime factories before eager role validation, and the
lazy upgrade conflict resolver does the same only when its first conflict needs
judgment. Plugin registrations use the same exact-name routing, model-family and
default-model validation, event attribution, and optional one-shot capability
selection as builtins.

`TelemetrySource` remains deferred, and BuildStore's third-party extension
surface remains the remote HTTP protocol rather than in-process registration.

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
  looking for new tickets. Every ordinary tick also completes queued dispatch
  records whose pre-run sequence was interrupted: it reconstructs a missing
  `build.created` from the immutable record, executes only missing workspace,
  spec, and ticket-notification boundaries, and records each failed attempt as
  `dispatch.failed`. `build.created` retains any claim-time auto-merge
  attribution until its human-authored command fact is materialized, while
  `dispatch.comment-posted` prevents retries from duplicating the ticket notice.
  It also owns observation back-pressure: settling
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
  same adapter pattern. The shipped interactive terminal owns a supervised
  kernel child, and the BuildStore is their only changing-state boundary.
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
| `verify:e2e` | `/verify-app-e2e <build>` (repository-authored) | `verify.completed {step, outcome}` | `verify-report:e2e` on pass/fail when present |
| `finalize` | `/finalize <build>` | `finalize.completed` | PR ref, summary |
| `reconcile` | `/reconcile <build>` | `reconcile.started`, `reconcile.completed` | `reconcile-notes` + merge commit |

Every phase skill takes **only the build slug**; everything else it needs
comes from the store via the `ab` CLI (§8).

Canonical skills installed into a repo carry the `ab-` namespace prefix
(§16.3), for example `/ab-plan` and `/ab-code-review`. Repository-authored
extension skills use their own names, such as `/verify-app-e2e`. This spec uses
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
  it never kills a green build. A step that produces repository content
  selects and commits its files locally and must finish with a clean worktree.
  The runner verifies that the last durably published head remains an ancestor,
  then regular-pushes the new head and checkpoints it on
  `finalize.step-completed`. An unchanged head creates and pushes no commit;
  Git or publication failure is the ordinary failed-step observation, never a
  reason to rewrite history or fail the green build.

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

**Immutability:** the spec cannot change during a build except through the
explicit escalation revision protocol. Every downstream reviewer approves
conformance *to it*; a drifting spec silently converts approvals into
approvals-of-something-else. A phase discovering the spec itself is wrong
raises an `escalation`; a human uses `ab answer --revise-spec` (or
`--revise-spec-from-ticket`), the spec gets rev N+1, and the build restarts
from `plan` (cheap — downstream was invalidated anyway).

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
A build stream also exposes `appendIfCurrent(expectedSeq, event)`: one atomic
compare-and-append that returns no event when the stream has advanced. It is a
narrow coordination primitive for deterministic event-log deduplication under
concurrent processors; the event stream remains authoritative, with no
snapshot or side ledger. Sequence 0 names an empty stream, candidates receive
ordinary event validation, unknown builds reject, and a comparison miss leaves
the log and build timestamps untouched.
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
   to. The documented [remote store protocol](docs/remote-store-protocol.md)
   is the public BuildStore extension surface for independently implemented
   servers; `src/store/contract.ts`, driven through the shipped remote client,
   is the conformance bar. Autobuild does not load in-process BuildStore
   plugins. Git worktrees and default file tickets necessarily remain local.

`subscribe` is specced in the interface; the v2.0 implementation is polling
`getEvents(since)`. True push comes later.

### 7.3 Persistence granularity

Required phase outputs persist at **phase/round boundaries**; a killed phase
re-runs from its start. An agent may also explicitly deposit a review artifact
mid-session, including an atomic PR-attachment designation (§7.5, §8.2); these
immutable revisions are harmless if a killed phase later retries. Designated
streaming exception (future, out of scope for v2.0): **live transcript
streaming**, so a web UI controlling remote agents can watch output in real
time. The store's types should reserve a streaming revision concept even while
no adapter implements it.

### 7.4 Resumption across sandboxes

Because state is the event log and artifacts live in the store, a *new*
sandbox can resume a build a dead sandbox started: pull events, rehydrate
scratch from latest artifact revisions, continue. v1 structurally could not
do this.

Four base-selection invariants make this safe with Git:

- **The base is chosen once, at first branch creation**, from the freshly
  fetched origin tip of the configured base branch (fetched into a
  build-scoped internal ref so concurrent dispatches cannot clobber each
  other or the operator's refs). If the remote is unavailable, creation falls
  back to the local base and records the diagnostic.
- **Re-provisioning never re-cuts.** An existing build branch is resumed at
  its current tip — never rewound, rebased, or re-created from a newer base.
  The first `workspace.provisioned` base remains immutable branch-cut
  provenance; later `existing` facts are resume evidence, not new cuts.
- **Each implementation completion records the branch's effective target
  divergence.** `ab done` asks the selected Forge to snapshot its authoritative
  base when that capability exists; otherwise it fetches the frozen target
  branch's current remote tip into a build-scoped private ref. It requires
  exactly one merge-base with
  the implementation `HEAD`. That merge-base and head become the durable
  `implement.completed {commits}` range, so target history already absorbed by
  the build is excluded while every branch-unique commit remains reviewable.
  Resolution is refreshed across review rounds and sandbox resumption. Fetch,
  ref, missing-ancestor, malformed-output, or ambiguous-base failure rejects
  the terminal before push, artifact deposit, or completion event; there is no
  stale fallback. This interrogation never moves the build branch, rewrites
  history, writes `FETCH_HEAD`, or updates operator/remote-tracking refs.
- **Conditional verify keeps its own durable diff base.** Path applicability
  still uses the initial branch-cut SHA until a completed reconcile promotes
  that attempt's refreshed target. It does not consume the focused review base.

### 7.5 What the PR gets

A summary comment — verdict history, verification results, links into the
store. The full audit trail is queryable, not committed to the branch.

Any agent session can explicitly designate an exact deposited artifact as a PR
attachment through `ab artifact put <kind> <file> --attach`. Designation is a
typed, atomic event on the ordinary artifact channel — never an artifact-name,
verify-step, or report-format convention. The current post-spec-restart
designation for each artifact kind is projected as text with an exact pinned
retrieval command; distinct kinds remain distinct. The BuildStore copy is
always authoritative, and non-image artifacts use this same path.

Optionally, `[pr.imageHost]` may name a **public** GitHub release so designated
`image/*` media render inline during review. The selected Forge must expose the
optional `PrAttachmentHosting` capability to serve upload and reclamation;
without it the supported path remains the complete text-only projection.
Non-images never cross that host boundary. Enabling it is an explicit
public-disclosure choice made in config, and hosted copies are temporary — the
dispatcher reclaims them after the build reaches a terminal outcome, while
store artifacts remain under the store's retention policy. Upload/validation/timeout failures record follow-up
observations and preserve the complete text projection; they never fail
verification or block finalize. Agents receive no forge credentials. A
designation after the PR exists publishes a new complete summary, so finalize
post-steps and post-reconcile verifiers need no custom phase.

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
per the transition table, ask the AgentRunner to invoke the named skill with
its runtime-native syntax (`/{skill} {build}` for Claude/Pi, `$<skill> {build}`
for Codex), wait for the terminal event, repeat.

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
| `ab artifact put <kind> <file> [--attach]` | deposit a versioned artifact → returns rev; optionally designate that exact revision for the PR | no |
| `ab artifact get <kind>[@rev]` | fetch an artifact within own build | no |
| `ab artifact download …` | sessionless, read-only exact-byte retrieval; works after build termination | no |
| `ab observe --kind <followup\|refactor\|latent-bug> …` | structured observation, any phase, any time | no |
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
(§9), never conflated with agent silence. When the selected role has declared
alternates, availability failures (overload, rate limit, 5xx, timeout,
transport, and unclassified provider failure) and provider exhaustion (quota,
usage limit, and billing) start the next target inside the same phase attempt.
Authentication, permission, and local runtime-configuration failures do not.
Each failed target's transcript is deposited. Only a stopped or exhausted chain
emits one `phase.failed` with the final provider message verbatim; that final
failure controls retry policy. Provider exhaustion skips the retry budget and
raises a policy escalation, while availability uses the existing bounded
budget. If the turn already wrote a valid typed terminal, that terminal remains
authoritative and no contradictory failure is appended.

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

All `git push`, PR creation, and forge API calls happen kernel-side. `ab done`
in `implement` first establishes the focused target merge-base, then pushes
and records `{base, head}`; `ab done` in `finalize` has the kernel open the PR
using the deposited `pr-description` artifact. After a successful
content-producing `finalize:*` step, the runner
requires a clean worktree and a descendant local `HEAD`, then regular-pushes
the configured build branch and records that head before completing the step.
A no-op step has no push. Agents only ever commit locally. Consequences: forge
credentials **never enter the sandbox** (load-bearing once builds run on
remote sandboxes), history is extended rather than force-pushed, and the
push-at-boundary rule from [D3] is enforced by construction rather than
convention.

### 8.7 Walkthroughs

**Happy path, one code-loop round-trip:**

```
implementer:  ab context → (work, commit) → ab observe --kind refactor "…"
              → ab done --notes .ab/implement-notes.md
                  ⇒ validates clean worktree and focused review boundary,
                    pushes branch, emits implement.completed {commits, artifact}
reviewer:     ab context   (gets spec, plan, {base,head}, prior findings)
              → ab verdict revise --findings f.json --notes review.md
                  ⇒ stamps finding ids, stores artifact,
                    emits code-review.verdict
implementer:  ab context   (findings.json now materialized) → …
```

**Failure paths:**

- *Completed turn, no terminal* → `phase.failed {no-terminal}`, retry per
  policy [D5].
- *Provider rejection* → transcript deposited; eligible failures walk the
  role's declared alternates within one attempt. A stopped/exhausted chain
  emits one `phase.failed` with the final verbatim error and every tried target;
  credentials/configuration stop immediately, final exhaustion escalates
  instead of retrying, and final availability uses bounded retry [D5].
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

`ab repository status [--json] [--store <ref>]` is the sessionless read-only
projection of the repository journal's dispatcher controls: ticket intake, the
repository-wide pause, and the claim-time auto-merge default. It uses the same
dispatch-settings reducer as dispatcher decisions and the dashboard. An absent
repository stream reduces as an empty journal and reports intake on, repository
pause off, and auto-merge default off; the query does not create that stream,
append an event, claim a ticket, attach a runner, or start dispatcher work.

Agents never receive TicketSource credentials. Only the deterministic file
step creates/adopts approved proposals and commits ledger facts.

## 9. AgentRunner

Session-based, because review loops need memory:

```ts
type Result =
  | { kind: 'completed', text, usage }
  | { kind: 'failed', text, usage,
      failure: { message, permanent, cause?: 'availability' | 'exhaustion' |
                 'credentials' | 'configuration' } }

interface AgentRunner {
  start(opts: { skill, invocation, workspace, model, … }): { session, result }
  continue(session, message): Result    // review-loop rounds
  end(session): Transcript              // → store, always
}
```

The discriminator is a port-level requirement: an SDK/provider-declared error
must never be returned as `completed`, so every adapter inherits the
distinction from `no-terminal`. `failure.message` preserves provider text and
`cause` separates availability, provider exhaustion, credential/permission,
and local runtime configuration. `permanent` remains the retry-policy and
legacy-plugin compatibility bit: exhaustion and credential/configuration
failures are permanent, while availability uses existing bounded retry. A
legacy plugin may omit `cause`; `permanent: false` remains alternate-eligible
and `permanent: true` remains a stopping failure. A failed `start` still returns
an endable session handle, guaranteeing transcript deposition.

Narrow non-phase judgments do not widen this contract. A runtime may
separately register an optional one-shot completion capability (tool-free,
non-resumable), used for slug naming (§6.3) and vendored-skill conflict
resolution (§16.3). A runtime without it is valid; each caller owns its
deterministic fail-safe.

- **Adapters:** three builtins sit behind the interface: the locally installed
  Claude Code CLI in headless mode for Claude models; the locally installed
  Codex CLI for unqualified `gpt-*` models; and pi in SDK mode for
  provider-qualified model families, including its independent
  `openai-codex/*` route. The Claude and Codex adapters use their CLI's local
  authenticated login and native session resume. All three provide tool-free
  one-shot completion. Plugins may register additional adapters, each under a
  *distinct runtime name*, never
  as a mode flag on an existing one. Plugin adapters must pass the exported
  AgentRunner contract suite.
- **Routing — explicit role inheritance (§16.1):** runtime, model, and
  extension allowlist live in one open `[roles]` map whose reserved `default`
  entry is the inheritance base and must explicitly name a runtime.

  **Which key a session selects.** One rule for both kinds of agent step: an
  agent verify step and an agent finalize step each select `[roles.<step>]` by
  their *logical step name*; core phases select `[roles.<phase>]`.

  ```toml
  [verify.e2e]
  kind = "agent"
  skill = "verify-app-e2e" # repository-authored skill

  [roles.e2e]        # the STEP name — not "verify-app-e2e"
  runtime = "pi"
  ```

  The step's configured skill name remains a deprecated alias for existing
  configurations and will be removed in a future release. It is consulted only
  when `[roles.<step>]` is undeclared, so the step name always wins.

  **What is and is not a fallback**, stated separately so the mechanisms are
  not conflated:

  1. Primary field resolution never hunts for a compatible substitute. Every
     concrete role merges runtime, model, and extensions over `default`
     independently; an incompatible merged pair is an eager error.
  2. A **requested** role key that no `[roles.<key>]` declares resolves to
     `[roles.default]` wholesale. That is undeclared-key fallback, not outage
     routing.
  3. A role may declare `alternates = [{ runtime?, model?, extensions? }, …]`.
     The list is a fourth independently inherited field: a role's own list,
     including `[]`, replaces the default list wholesale. Each entry overlays
     that concrete role's effective primary axes and is resolved and validated
     eagerly with indexed problems in the aggregate startup error.
  4. A **declared** key that nothing ever requests is resolved, validated, and
     then never used. `ab dispatch` reports it at startup as a warning.

  All roles
  resolve **eagerly, before any session launches**, with problems aggregated
  into one error. A missing default diagnostic includes a copyable table and
  every materialized runtime name. Builtin and plugin registrations use the same model-family,
  default-model, session, and optional one-shot capability path; adding a
  runtime touches only the adapter registry, never the kernel. Mixing models
  across roles is intentional — a different reviewer catches more. The
  Within one agent-session attempt, eligible failures try the primary then each
  alternate in order without spending another phase attempt. Each target has a
  fresh session bracket. A failed producer continuation may therefore continue
  on a different runtime only by rehydrating durable context, not by inheriting
  the failed conversation. Selection is non-sticky: every later phase, loop
  continuation, and retry starts from the primary. The final failure controls
  retry/permanent behavior. This applies to core phases, agent verify/finalize,
  and Harvest, but not tool-free one-shots. Every selected runtime/model is
  recorded on `session.started`; fallback starts cite the preceding target and
  verbatim error, while exhausted `phase.failed`/`harvest.failed` facts carry
  the complete ordered attempt list.
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
not a forced success — an unresolved condition may escalate again. For an
agent verifier's own `ab escalate`, that next run is the same `verify:<step>`:
`verify.started.feedback` cites the answer and `ab context` materializes it as
`.ab/guidance.json`. The citation remains the durable carrier across any crash
before launch; only a later `session.started` with the same phase and attempt
consumes it. Producer guidance uses the same phase-and-round launch boundary. A
bare retry reruns the step without guidance. The intentionally different policy
escalation after an exhausted failed verify report feeds `implement`, where its
guidance outranks
the pending report.

Policy escalations caused by an exhausted bounded retry/round budget are the
narrow exception to the human-answer rule: a fresh `ab dispatch` invocation
answers an all-policy open set with dispatcher-authored `resolution: retry`
and attempts the build from durable state. This unattended startup path is an
explicit process-restart retry boundary; agent and stall escalations remain
human judgment gates until an operator answers them.

Crash-gap and exhaustion deduplication is exact to the escalation's source/class
and target. A triggering event is considered acknowledged only by a later
`escalation.raised` with that same `source` and `phase`; a raise for another
class or target cannot suppress it. The triggering event's sequence is the
boundary, so newer qualifying failure, verdict, or conflict evidence re-arms
that exact condition after an answer.

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
pressure-driven: on the existing one-pass scan of repository build streams, the
dispatcher measures both unclaimed observation count and repository drift. A run
starts when count reaches `[policy].harvestThreshold` **or** when the number of
same-repository `pr.merged` facts strictly after the oldest unclaimed
observation reaches `[policy].harvestMaxDrift`, whichever happens first. Drift
counts distinct other builds only: the build that recorded the oldest
observation is excluded even if it later merges, and aborted or closed-unmerged
builds contribute no `pr.merged` fact. The drift limit defaults to `3`; zero
disables that condition and restores count-only gating. Empty accumulations
never trigger. Either condition claims the whole current accumulation as one
immutable snapshot, including newer observations, and `harvest.started` records
`count`, `drift`, or `both` as durable trigger provenance. Occurrence identity
is `{build slug, event seq}` — never payload id or a scalar high-water mark,
because event sequences are per build. Harvest state lives in the repository
journal, separate from build streams; the repository lease is the cross-process
exclusivity gate, and harvest runs fire-and-forget so dispatch ticks stay
responsive.

The fixed workflow is:

1. **scan (deterministic)** — subtract all claimed occurrences, reconcile
   prior proposal tickets through TicketSource lifecycle facts, expose each
   distinct observation-origin ticket's source match, existence, and resolution
   state, and atomically store the scan packet with the run's claim.
2. **synthesize ⇄ review (judgment through `converge`)** — the continuing
   producer clusters same-problem records and authors typed
   create/join/suppress proposals. A create may carry source-local `blockedBy`
   ids when its evidence establishes a hard prerequisite other than the
   automatic observation-origin relationship; contextual references and
   nonbinding ordering do not become blockers. A fresh reviewer checks
   coverage, semantic dedup, spec quality, evidence, and both directions of
   that prerequisite rule. Only approval advances.
3. **file (deterministic)** — refresh the selected TicketSource lifecycle for
   every declared blocker and same-source ticket that originated a create's
   clustered observations. Unknown agent-declared ids fail filing; missing,
   resolved, foreign-source, and absent origins contribute nothing. The created
   ticket receives the first-seen deduplicated union of declared blockers and
   still-existing unresolved origins. The filing fact and report preserve those
   two provenance sets separately. Creates are rendered to the spec standard
   and filed into `[tickets].proposalState`, Triage by default, with the reserved
   `autobuild:proposal` provenance label.
   Filing is crash-safe by construction: an idempotency ID is durably reserved
   *before* each external create, so a restart adopts the already-created
   ticket instead of duplicating it, and a partially filed approved set creates
   only its missing tickets. Ready projections expose that stable external
   creation key separately from the human-facing ticket id. Dispatch brackets
   each ready listing with repository-journal reads and withholds a ticket when
   its key matches an unfinished reservation, including a reservation first
   observed during the listing interval. The ticket remains counted as queued,
   consumes no capacity, and receives a distinct durable standing diagnostic.
   A later tick releases it after filing settles or the owning run completes,
   escalates, fails non-retryingly, or exhausts recovery; tickets without a
   matching reservation are unchanged. The label is informational: Autobuild never reads
   it as readiness policy and does not remove it during grooming.

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
- **The harvester only proposes.** It never claims, grooms, or dispatches a
  proposal, and it files every one into the same configured state rather than
  ranking them. Humans own Triage → Ready by default. A repository that points
  `[tickets].proposalState` at its ready state has waived that gate for itself:
  every harvested proposal enters the ordinary dispatch eligibility checks
  unread, on the strength of the synthesize ⇄ review loop and the spec gate.
  An unresolved harvested `blockedBy` relationship still prevents claim until
  the source reports completion or the relationship is deliberately removed.
  The waiver is a field of
  its own rather than a reuse of `triageState`, because bounces, aborts, and
  closed-unmerged PRs must still land where the next tick will not reclaim
  them — a bounce filed into Ready is claimed and bounced again forever.

## 13. Ticket source policy

The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) as part of initiation — at claim time, or on a later tick
while an interrupted dispatch still lacks its imported spec. After import, the
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
separate operation with their own validation. Labels are values at the port
boundary: a label name need not already exist for either create or update.
Adapters own reconciliation with provider-side label registries, including
concurrent attempts to create the same name; callers never pre-register labels.

**Ticket dependencies.** A ticket may declare blockers within its source, at
creation or later. The source owns representation (how a blocker is stored)
and completion semantics (what "done" means); the dispatcher owns the
decision — an unresolved blocker means the ticket is not claimed and creates
no build. Dependencies are written during grooming or by an approved harvest
create, then read at dispatch time. Harvest validates agent-declared source-local ids
and automatically derives unresolved same-source observation origins through
fresh configured-source lifecycle reads before creating the proposal ticket.
The scan packet exposes the earlier informational lifecycle view to producer
and reviewer, while the filing read is authoritative. Both paths remain
initiation, so the never-consulted-mid-build rule is untouched. A
dependency-blocked ticket stays
queued source work rather than becoming a blocked build: the runtime `blocked`
status is for builds awaiting a human.

**Crash-safe filing.** Creation supports a state override (harvest targets
Triage explicitly) and an idempotency key that must adopt the same ticket on
retry across process restarts. Ticket projections may carry this stable
external creation key separately from their source-facing identifier; adapters
that support idempotent creation preserve it through create, adoption, get, and
ready listing. The reservation fact precedes the external side effect — that
ordering, not provider behavior, is what makes filing crash-safe. Dispatch
uses the key only to withhold unfinished Autobuild creates; its absence fails
open for legacy/plugin tickets and introduces no new readiness gate.

## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events appended to the
applicable build or repository log (§15.2.7). The event vocabulary *is* the
UI API; forge mutation remains kernel/dispatcher plumbing. Anything a UI
displays is a reduction of the logs, and anything it does is an event — so
every frontend (terminal today, web later) is the same adapter pattern
against the same store, and a dead runner still receives commands on resume.

Interactive `ab dispatch` owns the terminal in a frontend process and supervises
one private child containing the dispatcher, build runners, Harvest, config and
plugin loading, and every ticket/forge/workspace/runtime adapter. The frontend
has no handle on those adapters: it reads build and repository streams plus
referenced artifacts, writes operator commands, and keeps only presentation
state (selection, scroll, composer text, confirmation) in memory. The child
publishes a run-correlated effective-config artifact before its first tick and
records tick/queue diagnostics, reload outcomes, runner coordination, and
normal/abnormal lifecycle as repository facts. Thus a rejected on-disk reload
cannot change the displayed effective capacity, and a frontend restart can
reconstruct every operational notice from the Store. Repository polling advances
from the last observed sequence rather than replaying the growing journal on
every frame. Ctrl-C restores terminal modes immediately and asks the child to
stop; repeated signals remain graceful while a dispatcher tick is crossing the
ticket-claim boundary, and a child also stops when its terminal-owning parent
dies. A timed-out child is terminated unless such a tick is open, in which case
that tick first reaches a recoverable durable boundary. `--plain`, non-TTY,
and `--once` kernel semantics remain the line-oriented/direct compatibility
path; `--once` still performs one tick and drains its in-flight work.

Durable operator settings (intake, the repository-wide pause, the claim-time
auto-merge default, the harvest gate) are repository-journal facts: they
survive restarts, propagate between dispatchers by ordinary polling, and are
never optimistically rendered — the UI shows acknowledged state. The
repository-wide pause holds every queued build: while it is set, no dispatcher
tick may attach a runner to a build that does not have one yet.

The operator's job across many concurrent builds: see status at a glance,
act on a selected build, find blocked builds, answer escalations, and inspect
any build's trail. Every nonterminal build, including `queued`, has a dashboard
row; a pre-run row names its pending dispatch boundary or latest durable
failure. A human may discard only such a queued build. Discard is dispatcher
cleanup, returns the ticket to its configured Ready state, and completes with
`discarded`; it is deliberately distinct from abort, which returns work to
Triage for human judgment. Any selected nonterminal build can be aborted from
the list or detail view with `a`; Enter confirms and Escape cancels, so the first
keypress never writes destructive intent. CLI and dashboard both append the same
`build.abort-requested` fact through the shared control service. The concrete
presentation — layout, key bindings, colors — is owned by the dashboard
implementation and its tests.

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
   `*-requested`/`*-cancelled` events (including queued-only discard), `escalation.answered`, and dispatcher
   setting facts; kernel or dispatcher plumbing acknowledges effects that
   require a boundary. The store is the *only* coordination surface — no side
   channel — and polling covers commands exactly the way it covers
   `subscribe`. A runner that is dead still receives pause/resume/abort
   commands and escalation answers on resume. While a turn is live, the runner
   subscribes from its session boundary and forwards an abort as caller-owned
   cancellation to the AgentRunner; it closes the session transcript without
   recording `phase.failed`, acknowledges abort, and releases its lease.

### 15.3 Catalog

Authoritative in code (`src/events/payloads.ts`, `src/events/repository.ts`).
The families, with illustrative members:

| Family | Examples |
|---|---|
| Build lifecycle | `build.created`, `workspace.provisioned`, `dispatch.comment-posted`, `dispatch.failed`, `runner.attached`, `runner.setup-failed`, `abort.remote-branch-deleted`, `abort.local-branch-deleted`, `abort.ticket-returned`, `build.completed` |
| Operator commands [D2] | `build.pause-requested` → `build.paused`; `build.discard-requested`; `build.auto-merge-requested`; `escalation.answered` |
| Spec | `spec.imported`, `spec.authored`, `spec.revised` |
| Sessions | `session.started`, `session.ended` (with transcript ref and usage — the analysis corpus) |
| Plan/code loops | `plan.started` … `plan-review.verdict`; `implement.started` … `code-review.verdict` |
| Verify/finalize | `verify.started {step, attempt, feedback?}`, `verify.completed {step, outcome}`, `finalize.completed {pr}`, `finalize.step-completed {step, ok, headSha?}` |
| PR attachments | `pr-attachment.designated`, `pr-attachment.hosted`, `pr-attachment.reclaimed`, `pr-attachment.reclaim-failed` |
| Post-PR [D1] | `pr.merged`, `pr.conflicted`, `reconcile.started`, `reconcile.completed` |
| Cross-cutting | `observation.recorded`, `escalation.raised`, `phase.failed` |
| Repository journal | dispatcher setting facts; run lifecycle, effective config, tick/queue diagnostics, reload and runner outcomes; the `harvest.*` workflow, recovery, and ledger facts |

Abort cleanup is a dispatcher-owned ordered saga. It releases any lease, closes
an open unmerged PR without overriding a racing merge, releases the workspace,
deletes the exact published remote branch and exact local branch, unions the
`autobuild:aborted` label into the current ticket labels, returns the ticket to
configured Triage, and only then completes as `abandoned`. External effects are
idempotent and the three `abort.*` facts checkpoint projections across crashes;
missing Forge capabilities or outages leave the remainder due on the next tick.

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

Queued state additionally retains ordered `dispatch.failed` diagnostics and an
outstanding `build.discard-requested` fact. `build.completed {outcome:
"discarded"}` settles that intent without changing the status vocabulary.
Runner state retains ordered `runner.setup-failed {command,attempt,exitStatus,
output}` facts and projects the latest one until a later `runner.attached`
proves successful setup recovery.

Every projection — operator UI, CLI status, dispatcher decisions — is a
reduction of the logs. Caches may key a reduction by last event sequence,
but no decision ever consults a snapshot in place of the append-only log.
Separate reducers derive dispatcher settings and harvest state from the
repository journal; each ignores the other's facts.

### 15.6 Walkthroughs

**Happy path** (elided: `session.started/ended` brackets around every agent
run):

```
build.created → workspace.provisioned{base:{source:remote,sha}} → spec.imported → dispatch.comment-posted → runner.attached
plan.started{r1} → plan.completed{plan@1, verifySteps}
plan-review.started{r1} → plan-review.verdict{approve}
implement.started{r1} → implement.completed{commits, notes@1}
code-review.started{r1} → code-review.verdict{approve}
verify.started{types} → verify.completed{outcome:pass} → …unit
verify.started{e2e} → pr-attachment.designated{artifact,filename,mediaType} → verify.completed{outcome:pass}
finalize.started → pr-attachment.hosted{designationSeq,asset} → finalize.completed{pr} → finalize.step-completed{release-notes}
(later, janitor:) pr.merged → workspace.released → build.completed{merged} → pr-attachment.reclaimed{hostedSeq}
```

**Interrupted dispatch:** if the log stops after `build.created`, a later
ordinary dispatcher tick provisions the workspace, atomically imports the spec,
posts the ticket notice once, and launches the runner. Claim-time auto-merge
attribution retained by `build.created` is materialized as the ordinary
human-authored request before launch. A failed boundary appends `dispatch.failed
{stage,attempt,error}` and stays queued for another tick. A discard request is
honored only while the build remains queued; one that races with runner
attachment is inert and cannot tear down live work. A human discard instead
releases any partial workspace and lease, returns the ticket to Ready, then
appends `build.completed {outcome: discarded}` last. No runner is required.

**A — verify failure:** `verify.completed {step: e2e, outcome: fail,
report}` → kernel routes back into the code loop: `implement.started
{round: 2, feedback: {verify: {step, report}}}` → fix → `code-review` round
2 → approve → verify re-runs **from the first step** (implement changed the
code; cheap checks first), `attempt: 2`. `policy.maxVerifyAttempts`
exhausted → `escalation.raised {source: "policy"}`. Guidance answering that
policy escalation routes to `implement` and outranks the pending report. By
contrast, when the agent verifier itself uses `ab escalate`, guidance answering
it reruns that same step with `verify.started {feedback: {guidance}}`; `ab context`
writes `.ab/guidance.json`. The start citation remains pending through repeated
pre-launch recovery. A later `session.started` for that same verifier and
attempt consumes the answer once, so a later failure routes its report to
`implement` without stale guidance. Producer starts use the same exact-phase,
round-matched rule. A bare retry reruns the verifier with no feedback.

**B — review stall:** round 1 `code-review.verdict {revise, [f1]}` → round 2
verdict's finding marks `persists: [f1]` → round 3 again → kernel:
`escalation.raised {source: "stall", refs: [chain]}`; status → `blocked`.
`escalation.answered` uses the resolution vocabulary `guidance`,
`dismiss-finding`, `revise-spec`, `abort`, or `retry`. Operators produce
`dismiss-finding` and `revise-spec` through `ab answer`; a `revise-spec` answer
names the exact replacement artifact it authorizes. `guidance` feeds the answer
into the next producer round as authoritative feedback; `dismiss-finding`
marks the chain human-resolved and the next reviewer round is told so. Engine-routed
guidance is latest-only per destination (`plan`, `code`, or one exact agent
verifier): a newer answer durably supersedes every older answer for that
destination before delivery. A guidance-bearing producer or verifier start is
the durable carrier, and only its later matching `session.started` launch
consumes the winner; until then the winner remains eligible across recovery.
After that delivery, no shadowed answer can surface on a later round, while an
answer appended after delivery is a new eligible winner. Destinations remain
independent, and the kernel derives both the winner and its delivery from the
event history so replay and restart preserve the result.

**C — setup failure:** the first attach retains the normal `runner.attached`
fact, then a failed setup appends `runner.setup-failed
{command,attempt,exitStatus,output}` and starts no phase or session. A retry runs
setup under the claimed lease before announcing another attachment. Another
failure appends only a new failure fact; success appends `runner.attached
{resumedFromSeq}` and clears the current error projection. After
`policy.maxSetupAttempts`, the kernel raises one policy escalation targeted at
`setup`; lease sweeps and fresh dispatcher startup leave it parked until a human
answer re-arms the setup budget. Its exhaustion guard considers only setup-targeted
policy raises, independently of phase-policy exhaustion. After claiming the lease,
however, a runner honors an engine-selected pause or abort acknowledgement before
setup-failure gating, even while that escalation is open. This control-only path
executes no setup, appends no `runner.attached`, and starts no phase or session.
Resume and all decisions that use the workspace still require successful setup.
The setup target belongs only to escalation metadata and is not a pipeline `Phase`.

**D — sandbox death:** log ends at `implement.started {round: 2}`; heartbeat
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
and completes builds. After any terminal outcome it also reclaims every
pending hosted PR-attachment copy. Reclamation success and failure are durable
correlated facts; a failed delete remains pending and retries on later ticks,
including after the build is already done. A merged-PR fixup request is a *new
ticket*, never a reopened build.

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
all verification and finalize work is complete. GitHub's exact documented
account-plan refusal for the branch-rulesets endpoint proves that no ruleset
can exist only when the independent classic-protection probe also
successfully reports no protection. Every near miss, generic authorization
failure, malformed or unknown response, and tooling failure remains unknown
and fails closed.

Inability to prove or apply auto-merge is nonfatal pipeline plumbing, not a PR
creation failure: finalize still records the open PR and completes, consent
stays pending for later janitor polls, and the first non-transient refusal for
that PR and consent command records one kernel-authored follow-up. A repository
with native auto-merge disabled is left open for a human; Autobuild never
changes the setting. The local-git forge has no external gate or native
setting: consent produces the same inspected-head guarded squash candidate,
mergeability is recomputed against the current local base, and the exact
`pr-description` becomes the single-parent squash commit message. When the base
branch is checked out, Git's two-tree `read-tree -m -u` transition preflights and
lands the old-to-squash tree: tracked/index changes on untouched paths and
untracked non-colliding files survive, while a tracked or untracked overwrite
leaves consent pending and records one path-bearing follow-up instead of failing
the dispatcher. Its durable pending-landing record is written before moving the
base ref. A poll after a crash retries that same old-to-landed transition without
rolling back the ref or overwriting operator work; the PR remains open and
retryable until checkout repair succeeds. No merge is ever assumed: a build
reaches `merged` only when a later poll observes the landing and any required
checkout synchronization. Without consent, the local branch and PR record
remain open for inspection with ordinary Git.

**Conflicts re-enter the pipeline via `reconcile`.** When the janitor's
mergeability check fails it emits `pr.conflicted` and re-attaches a
build-runner (the dispatcher itself never runs agents). Immediately before
each attempt, the runner asks the Forge for its current authoritative base
snapshot when supported, otherwise fetching the build's frozen base branch
fresh from `origin`, and records the resolved SHA on `reconcile.started` — known-stale input is never
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

Decisions here continue the series: **[D9]** declarative repo config and
**[D11]** vendored editable skills.

### 16.1 `autobuild.toml` [D9]

One declarative file at the repo root. A running dispatcher owns an accepted
snapshot read from the **main checkout** and refreshes it before each dispatch
tick. Dispatcher and build-runner orchestration capture that snapshot at each
action boundary — dispatch, setup, and pipeline step — so a valid change may
affect the next action of an in-flight build but never interrupts an agent turn
or deterministic command already running. Scoped phase CLI processes separately
read the build worktree's branch-owned file. Because the file is repo-versioned,
changes still flow through the pipeline itself: once merged, the system can
adopt a retuned configuration without restarting the dispatcher.

A missing or unreadable file and a malformed or routing-invalid candidate are
rejected atomically: the last valid snapshot, resolver, and revision remain in
force, and no action starts under missing, partial, or defaulted configuration.
The dispatcher emits an actionable operator notice without repeating it for the
same failure. Restoring a valid `autobuild.toml` clears the rejection and
ordinary boundary reload resumes.

```toml
baseBranch = "main"
capacity = 3                    # concurrent builds for this repo
forge = "github"                # builtin: github | local-git; or a plugin name
plugins = ["./plugins/local.ts", "@acme/autobuild-plugin"]

#[workspace]                     # optional; default provider = "git-worktree"
#provider = "company-container" # builtin or plugin-registered name
#[workspace.config]              # selected plugin's declarative config
#image = "ghcr.io/acme/build:bun"

#[pr.imageHost]                 # optional public inline rendering for attached images
#provider = "github-release"
#repository = "owner/public-review-assets"
#releaseId = 123456

[commands]                      # deterministic verbs the kernel may run
setup = "bun install"           # after provision / sandbox rehydrate (§15.6-C)
typecheck = "bun run type-check"
test = "bun run test"
publish = "bun run publish"

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
skill = "verify-app-e2e"       # repository-authored agent verifier
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
maxSetupAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 6
harvestThreshold = 5            # observation-count pressure in dispatch
harvestMaxDrift = 3             # merged builds since oldest observation; 0 disables

[tickets]
source = "file"
readyState = "ready"            # required: the one state a ticket must sit in to dispatch
```

The root scalars must appear before the first table header (TOML otherwise
nests them in that table). `forge` defaults to `"github"` and `plugins` defaults
to `[]`, preserving repositories with no plugin configuration. Every nonblank
`plugins` specifier must be unique by exact string; a repeated entry fails
config validation with the duplicate position, first position, and
remove/deduplicate guidance. `[workspace]` defaults to
`provider = "git-worktree"` and empty config; the strict selector
envelope permits open plugin-owned values only under `[workspace.config]`.
Unknown providers fail with the complete available-name list. Providers still
yield a locally reachable working-copy path; remote execution remains a later
sandbox project. Declarative (TOML), not executable config: the
kernel, dispatcher, CLI, and any future tooling parse it without evaluating
anything; commands are plain shell strings. Parsing is strict — an unknown table or key is an error, so a
typo cannot silently disable a verifier. The full config surface, field
semantics, and validation rules live with the config code and
`docs/configuration.md`. The removed `[dashboardFrames]`, `[project]`,
`[dispatcher]`, `[harvest]`, and `[outer]` tables have no aliases or migration
shims. `[tickets].source` is a nonblank builtin or plugin registration name.
The builtin `linear` and `file` branches retain their exact field restrictions
and defaults; any other name is resolved after plugin loading, receives the
existing ticket table as factory config, and fails with the complete available
name set when unregistered. Plugin-declared `requiredEnv` values are never TOML
fields: secrets stay in the process environment or local `.env`.

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

### 16.3 Skill installation: vendored, namespaced, editable [D11]

This project ships 11 canonical default skills for the fixed phases, the
non-phase surfaces (`spec`, `tickets`, and `guide`), and the outer-loop skills.
Repository setup guidance ships as `guide/references/setup.md`, not as a skill;
agent verifier skills are authored by each repository when needed. `ab init`
installs into a repo:

- **A stack-neutral `autobuild.toml` skeleton**, rendered only when absent. It
  declares no setup command or verify step and inspects no language or package
  manifest. Its explicit `[roles.default].runtime` is only a schema placeholder.
  Existing config is never overwritten, even with `--force`.
- **An agent-driven setup handoff.** Init probes every registered runtime and
  reports each usable/unusable result, then chooses an interactive setup agent
  using the product-fixed `claude`, `codex`, `pi` preference order. The launcher
  choice does not constrain the pipeline's final roles or models. On an
  interactive terminal, init starts that coding-agent CLI directly in the
  target repository with inherited terminal I/O, no `AB_*` session identity,
  and a short prompt pointing to the installed editable
  `.agents/skills/ab-guide/references/setup.md`. The prompt carries the
  new-config or existing-config preface but does not embed the reference body.
  Its exit status is init's. This direct process creates no build, session,
  transcript, event, or BuildStore record. Without a usable shipped runtime or
  an interactive terminal, installation still succeeds and init prints the
  exact same pointer prompt for the user to run in a coding agent. A missing
  setup reference in an older or partial distribution does not fail init. On
  rerun, the prompt asks the agent to review and improve the preserved existing
  config.
- **Copies** of the 11 default skills into the project skills directory,
  namespaced `ab-*`. Copies, not references — per-repo customization is the
  point: this repo's code-review standards and setup reference live in the
  vendored trees. Harness-specific discovery paths are symlinks to the one
  canonical editable copy. Setup directs the repository to author and configure
  its own agent verifier when judgment-driven end-to-end coverage is warranted.
- **Model-invocation discipline.** Phase skills are installed
  non-agent-invocable: they are invoked explicitly by the runner or a human,
  never auto-triggered by a model pattern-matching a description — a model
  must not start a pipeline phase by accident. The model-invocable exceptions
  (`ab-spec`, `ab-tickets`, `ab-guide`) are exactly the three skills that
  **drive no phase**; membership is decided by that criterion, not taste.

When `.agents/skills` and `.claude/skills` resolve to the same filesystem
entry, that repository-level alias already satisfies harness discovery. Init
and upgrade create no per-skill links through it and do not reinterpret its
live or pristine files as legacy `.claude` copies. A real
`.claude/skills/ab-*` directory that is a distinct filesystem entry remains a
conflict: all other skills are still processed, every such conflict is reported
with move/remove guidance, setup is not launched by init, and the command exits
nonzero.

**Installation identity** is local to the running distribution. `ab --version`
reads its package version, Bun-recorded forge commit when present, and the
independent plugin API version; it needs no repository, config, store, or
network. A source checkout is identified by its `.git` marker. A movable Bun
forge install is identified only when the distribution's `.bun-tag`, its owning
direct `github:owner/repository` dependency, and `bun.lock` record agree. The
owner/repository is derived from those package-manager records, never hardcoded,
so a fork install follows its fork. Unknown or contradictory provenance is a
named refusal, never a guessed install command.

**Upgrades** run only on explicit `ab upgrade`. By default the command resolves
the latest full GitHub Release from that installation repository. If newer, it
uses the matching Bun local or global operation to install the release, then
hands off to a fresh process from the replaced distribution before touching
skills. Thus both defaults and merge logic come from the new version. A local
install updates the owning project's `package.json` dependency and `bun.lock`;
a global install updates Bun's global package-manager state. An already-current
(or locally newer) install proceeds directly to skill merge. A source checkout
is never mutated and still merges installed skills, including when an exact
release was named. For the default latest operation, an indeterminate mechanism
or lookup/install failure warns and also merges installed skills. For an
operator-selected `--version <semver>`, indeterminate mechanism, resolution, or
install failure is fatal and does not merge against the wrong defaults.
`--no-self-update` always selects merge-only
behavior. An exact version may be older than the installed version.

Upgrade records its successful work in one local commit on the target's current
HEAD by default. The exact ownership boundary is the reported skills' canonical
`.agents` trees, pristine records, and `.claude` discovery paths, plus
`package.json` and `bun.lock` only when this run's successful local Bun update
wrote those files inside the target repository. A global update contributes no
repository path. Additions, modifications, symlinks, and deletions all
participate; a run with no owned Git change creates no commit. The message
identifies `ab upgrade` and lists every skill with an owned byte change together
with its reported outcome. It supplies no authorship or attribution trailers.
Unrelated staged, unstaged, and untracked work is neither committed nor
unstaged.

The baseline is captured before self-update and carried to the replacement
binary. `--no-commit` also survives that handoff and leaves the merge exactly as
written. A replacement child marked as a handoff but missing that pre-update
baseline — as when an older parent launches a newer child without the newer
context — suppresses the entire automatic commit, names the cross-version
compatibility reason, and leaves all upgrade-owned changes uncommitted for the
operator. The skill-upgrade results and merge-derived exit status are unchanged.
Any content conflict, Claude discovery conflict, pre-existing dirt in an owned
path, non-Git target, changed HEAD/worktree identity, or in-progress merge,
rebase, or cherry-pick likewise suppresses the whole commit and prints the
reason. If upgrade cannot snapshot the worktree's Git index, it warns and
declines to stage. A staging or commit failure restores that exact pre-attempt
index without touching the merged worktree files, and warns with the original
Git failure.
Commit suppression or failure never changes the merge-derived exit status:
content conflicts remain zero and discovery conflicts remain nonzero. Upgrade
never pushes or rewrites existing history.

Skill handling remains the classic vendoring problem: `ab init` records the
pristine version of each installed skill; upgrade three-way merges (pristine
base × local edits × new default). Two fixed former defaults, `ab-setup` and
`ab-verify-e2e`, additionally have one-time retirement handling when absent
from the incoming distribution. A pristine record is required to prove
Autobuild provenance; without it, a same-named repository-authored skill is
untouched and unreported. Upgrade reports `removed` when the complete live and
pristine trees match byte-for-byte, no configured agent verify or finalize step
names the skill, and no user-owned Claude discovery entry remains; it also
reports `removed` when the canonical live tree is already missing. In the latter
state it clears obsolete provenance and removes only an Autobuild-owned dangling
discovery link. Any customization, config reference, or inability to inspect
config safely preserves the live tree and reports `kept`. When an otherwise
removable canonical tree is shadowed by a user-owned
`.claude/skills/<name>` discovery entry — either a distinct real directory or a
foreign symlink — upgrade reports `kept`, removes only the canonical/pristine
Autobuild-owned trees, preserves the entry byte-for-byte (including a symlink's
link text and target), and includes it in the existing structured
discovery-conflict report and nonzero exit behavior. Every terminal
classification clears obsolete pristine ownership, so a second upgrade neither
recreates a dangling link nor resurrects or re-reports the retirement. All
other installed skills absent from the distribution retain the `unknown`
local-addition classification.

A conflict may be resolved by the optional
tool-free `upgrade` one-shot with a standing bias: **prefer the local
customization**. The agent output is only an untrusted proposal — deterministic
validation verifies skill identity and exact preservation of every already-clean
merge region before anything is written. Each per-file judgment has a fixed
generous deadline of at least ten minutes. While it runs on an interactive
stdout, upgrade redraws a live indicator naming the skill and path, elapsed
time, and Ctrl-C cancellation. Ctrl-C there aborts only that invocation: the
file becomes an ordinary byte-untouched content conflict and upgrade continues.
Outside an active resolution Ctrl-C retains ordinary process termination.
Non-TTY output stays byte-identical and line-oriented. Failed, timed-out,
cancelled, or unavailable judgment leaves both live and pristine byte-untouched
and names the manual merge path. These content conflicts remain exit zero;
discovery conflicts retain their nonzero contract. Local customization survives
upgrades; divergence is visible instead of silent. No other command checks for
or installs releases in the foreground or background.

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
4. **[OPEN] Hosted, multi-host deployment** — the remote store (§7.2) and
   cross-sandbox resumption (§7.4) already permit kernel, operator UI, and
   builds to run on separate hosts against one store. Undecided: whether those
   processes reach a hosted store directly or through a service tier that owns
   write-rule enforcement and version skew between independently deployed
   clients, and whether artifacts stay content-by-value (§7.1) or become
   references a front end fetches for itself.
