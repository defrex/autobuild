# Autobuild — Specification

An agent-driven software development lifecycle system: it takes work from
*"something should be done"* to a merged PR, with a human in the loop only
where judgment matters. This is a ground-up rebuild of the pilot (preserved in
git history at `6d4dce3`), keeping the pilot's validated ideas and replacing
what it hard-coded with real interfaces. Versions are the npm release versions
of `@defrex/autobuild`; the pilot was never versioned.

**What this document is.** SPEC.md holds the durable design: principles,
boundaries between components, invariants, and decisions with their rationale
(the **[D1]–[D11]** series). It is deliberately not three other things:

- **Not a behavior reference.** Exact schemas, flag grammars, validation
  rules, and edge-case handling are specified by the code and its tests —
  event payloads are frozen in `packages/core/src/events/`, and the store contract in
  `packages/core/src/store/contract.ts`. Where this document and the code disagree on
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

The pilot proved the core loop works. Its structural limits, which motivate
this design:

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

Principles — the first four carried from the pilot — that are non-negotiable and that
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
Ticket sources may optionally provide native `listPage(criteria, page)` windows with a matching total. Paged operator reads use it when present, otherwise slice the exhaustive listing; unpaged and dispatcher reads remain exhaustive.


Interfaces to the world, each with swappable adapters:

| Port | Duty | Initial adapters |
|---|---|---|
| `TicketSource` | list/claim/comment/transition/create/update tickets; add, remove, and resolve declared dependencies | file-based (default directory); Linear; third-party in-process registrations; later GitHub Issues |
| `AgentRunner` | run agent sessions (see §9) | Claude Code CLI (headless); Codex CLI (`exec --json`); local pi CLI (`--mode rpc`, minimum 0.84.3); third-party in-process registrations |
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

The host exposes one versioned authoring surface, `@defrex/autobuild/plugin-sdk`: port
and manifest types, the reusable TicketSource/AgentRunner/WorkspaceProvider/
Forge/BuildStore/BlobStore contract suites, and fake/reference adapters. Plugin
production code can use erased type-only imports, with Autobuild present only
as a development or peer dependency; a consuming repository needs no bridge
module.

Plugin resolution has two repository-owned roots and one installation root.
Relative, absolute, and `file:` specifiers resolve from the repository root
whose config is being read; in a scoped build CLI process, that is the
immutable build worktree. Bare package specifiers and package export maps
resolve first from the consuming repository's main checkout, so they use that
repository's installed dependencies and remain available when a local store
places linked worktrees outside the checkout's package ancestry; a package the
repository lacks then resolves from the Autobuild installation the CLI runs
from as a fallback. Install extensions as repository development dependencies
with `bun add -d --exact @defrex/autobuild-<extension>`. A
repository copy always wins over an installed one. Dispatch and sessionless
commands naturally use the main checkout for both repository roots. Autobuild
does not install a missing package.

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
`[workspace].provider` selects from the workspace catalog; omission selects
`git-worktree`, while `vercel-sandbox` is the shipped opt-in remote execution
provider. Plugin factories are invoked lazily with `[workspace.config]`,
environment, and repository root. The Vercel builtin instead consumes its
strict typed config and requires an HTTPS Store/scoped token and HTTPS GitHub
origin before any ticket claim.

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

Forge readiness is an optional read-only port capability, inspected on the host
by init validation and once at dispatch startup after repository lease acquisition.
It reports squash/rebase merge methods and kernel build/node/archive publication
permissions as hard requirements, and protected-target linear history and root
freshness as recommendations. Results are pass, fail, or unknown; incomplete
inspection never proves permission. Local Git passes trivially; legacy plugins
report unknown. Known hard failures fail init validation and produce one durable
`dispatcher.forge-readiness-failed` repository fact per run/check. They do not
add a dispatch admission gate. Repository attention watches (`ab watch`), dashboard
warnings, and operator queries expose all failures and remediation for the run;
`ab wait` remains build-only. No setting is changed and no probe ref is pushed.

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

Resident checkout-backed `ab dispatch` starts a launcher and one dispatcher
**generation**. The launcher eagerly loads its own filesystem/process code,
opens no Store, holds no repository/execution lease and makes no kernel
decisions. Before starting the generation it freezes the invoking distribution
and its already installed production dependency graph into the canonical
checkout's `.autobuild/runtime/` cache, offline. Source edits (including
uncommitted edits) and dependency bytes participate in content identity; version
alone never selects a snapshot. Completed distribution roots are immutable.
The generation, kernel, later local runners and agent PATH `ab` all execute
from that same root. Run/attach runtime identities name the cached directory.
Source generations capture their guest archive from that exact snapshot.
Registry generations preserve the normalized host archive and resolve their
manifest version's published GitHub release asset on first guest use. Host launch
is offline; version and SHA256 validation precede atomic guest-asset completion.
Missing, corrupt or wrong-version assets fail guest delivery and remain retryable.
Metadata retains explicit provenance and the host digest, adding the guest digest
after resolution; older entries without provenance are not silently reused.

The versioned v1 launch contract consists of argv, a consumed one-shot
`AB_DISPATCH_GENERATION` marker, graceful signals and exit reasons `stopped`,
`handoff`, `failed`. Public invocations discard inherited markers. No private
operational channel exists; work outcomes still come only from durable state.
The runtime-owned `--read-upgrade` reader supports an optional independently
versioned conditional environment exchange, preserving full v1 answers for old
peers. The launcher retains only its current successful answer and pre-read
repository change position per exact reader/runtime, journal, run, lineage and
recovery query. Each unchanged check makes one change-position request and reads
zero metadata, reducer values or event rows, regardless of journal length or a
fresh helper process. Full refresh samples the position before the projection;
a concurrent append therefore invalidates the next check. Unchanged checks
revalidate cached target identity and rollback retention locally, without
manufacturing durable facts. Errors discard conditional state; an unloadable
target still uses the healthy predecessor reader with the active query. The
launcher retains its filesystem/process-only boundary and polling cadence of
1 second idle or 250 ms pending, processing child exits and pending actions on
cached answers too. Legacy peers remain functional with full reads.

The launcher observes presentation stop/continue liveness so Ctrl-Z returns the
shell prompt and `fg` resumes only the presentation; the kernel keeps running.
Terminal restoration by the launcher is a fallback for abnormal termination,
never a second alternate-screen exit after a clean generation stop.
Automatic upgrades default on (`[upgrade] automatic = true`). The resident
kernel checks immediately and every 60 seconds independently of dispatch ticks.
It resolves the root manifest and Bun lock from a single authoritative base
branch commit through the forge, never from a feature branch, checkout pin or
stale tracking ref. A declared dependency selects pinned mode; unsupported or
inconsistent metadata is an attention failure. With no declaration (including
no root manifest), installed mode rereads the original public installation
pathname retained across handoffs. A launch from a source root in the dispatched
repository's Git common-directory topology selects source mode instead. That
eligibility and its initial packaged snapshot are frozen across successors. The
target is the forge-authoritative base commit, exported into private cache staging
without changing any operator or build worktree. A frozen-lockfile, script-free
Bun install supplies dependencies; the completed immutable runtime records the
exact commit and follows ordinary cache retention and pruning. Source adoption
compares packaged contents and production-reachable dependency resolution rather
than version or commit: excluded-file advances do not hand off. Included shipped
documentation counts as packaged content.

A changed exact version (including a downgrade) is installed in isolation and
validated in the immutable cache before cutover. The operator's installation
and consuming dependency graph are untouched. Registry/lock/install/contract
failures retain the running generation and record repository attention. Failed
inputs are suppressed until their target metadata changes or an operator starts
a fresh launcher; unrelated base commits do not reset suppression.

The kernel records `dispatcher.upgrade-target-resolved` once per changed successful
target observation per run, including equal-content source advances. Repository
status exposes its mode, base and target SHA independently of the running commit
and earlier failure or handoff evidence. Identical polls append nothing.
A successor first validates configuration and the actual selected store without
starting repository work or terminal input/output. Provider compatibility evidence
chooses drain when sharing is safe and cutover otherwise. SQLite compares its
untouched catalog semantically (columns, indexes, keys and constraints) with target
requirements, accepting equivalent schemas built by guarded ALTER migrations; HTTP uses the live service's client
and protocol admission. Missing evidence chooses cutover. A target outside the hosted client overlap
window also requires cutover; target admission and successful protocol writes
are still mandatory. Cutover never makes a rejected target runnable. Successful durable
protocol writes are also required: a service that admits the client but rejects
a new yield fact fails preflight, leaving the predecessor active with target and
reason in repository attention. Failed targets are not retried every tick; a change in selected-store compatibility
evidence allows the normal target-check cadence to retry.

Local harvest suspends durably before repository lease release on handoff or
clean stop. The next generation resumes eligible native sessions with fresh
logical credentials, or records a reasoned `harvest.session.resume-fallback`
and starts fresh. Orderly suspension spends no recovery attempt; real crashes
retain recovery accounting.

The predecessor serializes acceptance with ticks and launch admission, joins
repository-owned harvest and provisioning work, and records the exact local
executions, start time and deadline. Its terminal frontend removes and joins
input/render work before acknowledging terminal release. Only after that durable
acknowledgement and a successful repository lease claim may the successor draw
or consume input. Only the successor ticks, claims, runs janitor/harvest and
launches runners. Execution leases remain with existing local runners; remote
executions detach immediately. Their exact instances and recorded guest runtimes
are captured separately on `dispatcher.handoff-started.remoteBuilds`. This
authorization work survives local retirement completion and late attachment;
it never adds to local drain counts or delays predecessor exit. Recovery reads
only builds whose repository digest records an open execution, at most once per
build per tick; historical captures of ended executions add no build reads. Guests retain
their leases and heartbeats and request neutral relaunch after their current
phase completes. The successor re-attaches with refreshed guest bytes.

A draining predecessor supervises its captured local executions until they settle
or `policy.upgradeDrainSeconds` (900 seconds by default) elapses. The deadline
tracks accepted live policy changes relative to the original start. Remaining
local sessions suspend through the normal durable native-resume path before
process-group cleanup. Cutover uses this suspension path immediately and waits
for predecessor stop before takeover. Retirement completion records drained and
suspended counts separately from takeover. A successor reconstructs unfinished
retirement from execution leases and durable build facts after predecessor death.
An unrelated dispatcher taking the lease still causes ordinary supersession and
teardown.

At each completed phase boundary, a local or remote build runner compares its immutable
attach runtime with the accepted handoff target mirrored in its instance-scoped
build-log drain authorization. The comparison uses existing boundary facts and
adds no Store read. A mismatch records `execution.relaunch-requested` and exits
after normal phase completion, publication settlement and session cleanup.
Confirmed teardown records the neutral `relaunch` execution outcome; it consumes
no failure or no-progress allowance. The current repository lease holder
relaunches from durable state on its own immutable runtime, including after an
ownership gap. Equal or absent targets preserve normal execution. Remote guests
re-attach through the provider, which reinstalls the accepted generation’s archive
before launching the next execution. Deadline suspension applies only to local phases.

With rollback-capable launcher and generation peers, three failed successor exits
within ten minutes of the original durable takeover restore the immediately previous
cached runtime. The first two failures restart the same runtime without repeating
preflight. Preflight failures never count; outside that window ordinary failure
exit behavior applies. Rollback goes back one runtime only. The launcher opens no
store: it passes a validated, versioned recovery context to the restored generation,
which records `dispatcher.runtime-rolled-back` under repository authority and holds
the failed target for that launcher lineage. Store compatibility changes, resolution
errors and disabling/re-enabling upgrades do not clear this hold. A successfully
resolved different target records `dispatcher.rollback-hold-cleared`; a fresh operator
launch starts a new lineage. Both previous and held runtimes remain protected from
cache pruning. Existing phase executions keep their leases and continue on the
restored runtime at the next boundary; unreadable decisive facts defer a build with
attention before any action. Peers without negotiated rollback capability retain
existing failure behavior and report that capable runtimes are required.

The journal records `dispatcher.target-prepared`, `dispatcher.yield-requested`,
`dispatcher.handoff-started`, `dispatcher.terminal-released`, `dispatcher.takeover`,
per-execution `dispatcher.drain-settled`, deadline changes and
`dispatcher.handoff-completed`, plus rollback and hold-clear facts, correlated by predecessor run, successor run,
launcher lineage, both runtimes and cached target. Legacy handoffs without a
mode mean cutover. Repository-following watch suppresses predecessor lease-loss
observations only for a matching recorded stop or reducer-validated successor
takeover, including while the predecessor drains. Handoff intent or release
without takeover retains loss attention on expiry; successor loss and upgrade
failure/rollback attention remain independent. The launcher first binds the runtime-owned journal transport to its persisted
repository record, so rejected configuration edits cannot redirect readers away
from the held run. It reads runtime-owned durable projections while generations overlap; it owns no store or operational authority and keeps each
live runtime reserved. Overlap requires explicit launcher and target capabilities; unsupported
targets fail safely with manual-restart attention. Operator stop wins and joins
all live children. Only the presentation owner installs terminal cleanup.
Its active input subscription maintains raw termios across retired generation
exits, including repeated handoffs, restart and rollback. Repair occurs on the
next maintenance turn (normally within 100 ms; event-loop stalls can delay it).
Maintenance stops before input release, job-control suspension or operator stop;
clean exit restores the shell's prior cooked tty state.
`[upgrade] automatic = false` disables target preparation; `--once`, origin
`--repository`, hosted cron and development hot rendering remain direct.

Cache publication is atomic after validation. Current, distinct previous,
explicitly held and live process-use entries survive pruning independently of
Store leases. Process-start identities distinguish PID reuse; uncertain
liveness retains code. Each cached Bun entry disables automatic installation
and pins a cache-owned neutral compiler config before evaluating JavaScript.
Autobuild compiler chains must remain inside the runtime. Third-party package
files, including development configs, remain exactly as installed.

- **build-runner** — one operating-system process per build; owns one pipeline
  execution end to end. The local implementation starts the process beside its
  Git worktree in its own POSIX session/process group and owns teardown of that
  complete group, including agent-tool grandchildren. Workspace execution is a
  substitutable capability, so a future sandbox provider can place both checkout
  and process elsewhere without the dispatcher spawning a local proxy; that
  provider owns equivalent complete-environment teardown. Per-build processes are deliberate: crash
  isolation, and the natural shape once builds run in remote sandboxes.
- **dispatcher** — watches the TicketSource for tickets passing the configured
  ready gate, claims, establishes the final conforming spec, chooses a short
  immutable build slug, provisions a workspace, and launches build-runners up
  to capacity. On process startup it attempts every current build for its
  repo, so re-running `ab dispatch` resumes durable work rather than only
  looking for new tickets. Every ordinary tick also completes queued dispatch
  records whose pre-run sequence was interrupted: it reconstructs a missing
  `build.created` from the immutable record (only records an older dispatcher
  left with an empty stream: new claims write it atomically with the record), executes only missing workspace,
  spec, and ticket-notification boundaries, and records each failed attempt as
  `dispatch.failed`. New claims do not seed merge consent or materialize
  historical auto-merge defaults; policy is sampled at readiness. Meanwhile,
  `dispatch.comment-posted` prevents retries from duplicating the ticket notice.
  It also owns observation back-pressure: settling
  outstanding recoverable harvest runs takes priority over starting new scans
  (§12). Cron-friendly.
  Before claiming, the dispatcher journals a repository-scoped preparation intent;
  a won claim and the exact selected creation slug are durable boundaries. Caught
  asset-copy, spec-authoring, naming, and build-creation failures return the ticket
  to configured Ready; a nonconforming spec goes to configured Triage. Recovery
  checks the exact selected build first: a matching record and atomic
  `build.created` retain ownership even if creation threw after committing.
  Unavailable or conflicting readback never authorizes release or a replacement
  build. Pending attempts retain the original failure, latest recovery error and
  retry deadline in the canonical repository reduced value; resolved attempts
  leave that value. Under repository ownership, each tick admits at most eight
  due recovery attempts, before intake and independently of capacity or intake
  settings, with a 30-second durable retry delay after recovery failure. Unresolved
  ticket identities remain withheld. An uncertain claim outcome or unrelated
  external ticket state, missing ticket/state, or conflicting slug ownership terminates
  automatic recovery with an `abandoned` resolution and diagnostic reason. The
  ticket is left unchanged; an operator can leave it finished or cancelled, or
  inspect ownership and explicitly return it to Ready for another attempt. These
  cases stop provider polling and diagnostic appends. Recovery failures are
  reported without preventing janitor, lease sweep, or other dispatch recovery.
  This is not general process
  crash recovery. Confirmed Ready/Triage transitions settle idempotently, so a
  failed bounce comment does not return an invalid ticket to Ready.
- **harvest-runner** — one staged repository workflow (`scan → synthesize ⇄
  review → file`) under a repository lease; not a build and not a phase.
- **ingesters** — other outer-loop processes turning signals into proposals (§12).
- **operator UI** — UI process(es); see §14.

Ticket-source ready scans run immediately when no completed measurement exists,
then every
`ticketScanIntervalSeconds` (default 60 seconds, a positive integer). Actual
tick spacing is the floor when the configured interval is shorter. A
same-repository `pr.merged`, `build.completed`, or `build.aborted` fact forces
another scan on the next tick; changed ready criteria also force a scan.
Housekeeping keeps its ordinary tick cadence. Between scans, queue depth and
standing diagnostics repeat the last completed measurement, including across
process restarts. Tickets groomed directly in the tracker are picked up within
one scan interval plus one tick when capacity permits. Observation while intake
is off shares the cadence; an observation measurement cannot suppress a fresh
admission scan when intake is enabled.

### 3.4 The event log spine

Build processes append typed events to per-build logs; repository-scoped outer
workflows and operator settings append to a separate repository journal in the
same BuildStore. Consequences, by design:

- **State is a reduction of events.** Any state snapshot is a cache, never
  the source of truth. Resumability falls out.
- **Reducer snapshots are a cache the log regenerates, never an authority.**
  The store may keep, per scope (one build log or the repository journal) and
  reducer, that reducer's serialized state as of a cursor, keyed by scope,
  reducer, reducer version, and cursor, so a process with no hot memory loads
  it, reads only the newer events, and advances. A missing snapshot, one
  written by a different reducer version, or one ahead of the log is ignored
  and the state is rebuilt by full replay with identical results; stored
  cursors never decrease; deleting every snapshot changes no observable
  output. A store without snapshot storage behaves as if every snapshot were
  missing.
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
| **Operator** | The role driving Autobuild through `ab` or MCP, normally an agent; a human may also drive the interface directly |
| **Operator agent** | An external agent operating the builds the repository's dispatcher dispatches, guided by `ab-operate`; it adopts new builds while serving the role |
| **Human (maintainer)** | The person authorizing work and making human decisions; addressed as “you” in reader-facing prose |
| **Signal** | Raw input from the world — a Sentry issue, an observation |
| **Proposal** | A synthesized candidate ticket sitting in Triage, awaiting grooming |
| **Ticket** | A source record of kind `work` (default) or `node`, optionally targeting a same-source node; ordinary groomed work is dispatchable |
| **Node ticket** | A named integration point represented by a ticket of kind `node`; its integration build owns a branch collecting child work |
| **Build** | One ticket execution with a slug; either a work pipeline or an integration branch lifecycle; the unit the operator sees |
| **Integration build** | A node build that opens its branch without a runner or capacity charge, collects child work, verifies its complete head and merges under ordered policy (node consent by default) |
| **Harvest run** | One repository-scoped claimed observation snapshot and staged proposal workflow; never a build |
| **Phase** | A named stage of the build pipeline grammar (§5) |
| **Round** | One iteration inside a review loop |
| **Artifact** | A durable, versioned output: spec, plan, review, report, transcript |
| **Verdict** | Structured terminal outcome: reviews use `approve` \| `revise(findings)` \| `escalate(reason)`; agent verification uses `pass` \| `fail(report)` \| `skip(reason)` |
| **Finding** | One structured item inside a `revise` verdict (file refs, description, severity) |
| **Observation** | An out-of-scope discovery emitted mid-build: `followup` \| `refactor` \| `latent-bug` |
| **Escalation** | A parked request for external judgment from the operator agent or human, answerable from any UI |
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
| `verify:acceptance` | `/verify-acceptance <build>` (repository-authored) | `verify.completed {step, outcome}` | `verify-report:acceptance` on pass/fail when present |
| `finalize` | `/finalize <build>` | `finalize.completed` | PR ref, summary |
| `reconcile` | `/reconcile <build>` | `reconcile.started`, `reconcile.prepared`, `reconcile.replayed`, `reconcile.publish-intended`, `reconcile.rewritten`, `reconcile.contended`, `reconcile.completed` | `reconcile-notes` + one replayed change |

Every phase skill takes **only the build slug**; everything else it needs
comes from the store via the `ab` CLI (§8).

Canonical skills installed into a repo carry the `ab-` namespace prefix
(§16.3), for example `/ab-plan` and `/ab-code-review`.

An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind.

Repository-authored extension skills use their own names, such as `/verify-acceptance`. This spec uses
the bare phase names throughout.

## 5. Pipeline grammar

Work builds retain the fixed grammar below. Integration builds instead follow
`spec → branch opening → collecting → complete → verify:* → authorization → merge → close`.
Authorization follows ordered merge policy: nodes default to explicit consent,
while an auto rule authorizes a complete, verified candidate without a command.
They never enter plan, implement, code-review or finalize. A node conflict uses
source-aware reconcile. Idle collecting nodes own no execution resources;
reconcile and verification use descendant-sensitive execution capacity (§12).
Empty nodes have no PR.

```
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize (+ finalize:*)
```

Verification uses ordered stages. A string in `[verify].steps` is a singleton
stage; a nonempty array groups members that start together. Empty stages and
repeated names are errors. Plain string lists retain serial event sequences.
Every member resolves post-reconcile policy, approved selection/`always`, then
path applicability at stage entry. Only pass or skip satisfies a member. The
next stage, or finalize after the last, waits for every member to pass or skip.

By default a failure lets all siblings finish; the settled stage routes once
with every failed report, and no later stage runs. `failFast = true` on either
step kind instead cancels members without outcomes, preserving existing
outcomes. The kernel records `verify.cancelled {step, attempt, cause: {step}}`.
Cancellation is neither a pass nor a failure. It ends the entire build execution
through its existing process-group or environment supervisor; a replacement
execution resumes before implement can start. This opt-in teardown/relaunch cost
avoids per-member process groups and ensures cancelled descendants cannot keep
writing to the shared workspace, including after a crash.

An agent escalation holds its own member while siblings continue. The barrier
waits for the answer and that member's rerun, unless fail-fast cancels it.
Cancellation supersedes only that exact verifier occurrence's agent escalations,
including late raises and answers. They stay in history but no longer block,
route guidance, reset budgets, revise the spec or request abort. Answer commands
reject a superseded escalation as stale. Unrelated escalations retain authority.

All members of a cycle share one monotonic attempt. A failed cycle spends one
`maxVerifyAttempts` unit regardless of its failure count. Restart preserves
outcomes and reruns members without outcomes at that same attempt, with
independent agent contexts under `$AB_CONTEXT_DIR` in the shared workspace.
Integration nodes use the same barriers with exact head, parent and restack
identity; their failed-cycle attention is published only after settlement.

The grammar is fixed — an opinionated skeleton, not a generic workflow
engine. Exactly two extension points:

- **`verify:*`** — ordered stages of configurable verifiers, declared in
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
kernel-prepared single-change replay onto a frozen refreshed base, with agent
conflict resolution and the captured post-reconcile `verify:*` policy — repeating
until merge or close.

Leaf branches are collapsed into one build change and restacked onto the frozen
target branch's current head at verify entry, before any verifier or exclusion.
This is kernel work within the fixed grammar, not another phase. A verify failure
returns to implementation; its new commits append to the canonical change, and
the next approved cycle collapses and restacks again. While waiting to merge after
finalize and its post-steps, an observed target move also schedules a restack.
For a node-targeted leaf, published finalize-step commits also schedule one
waiting restack, even when the target SHA is unchanged, so guarded merge
preserves one canonical build identity.
Clean waiting restacks retain existing verification when build-owned config is
unchanged (§16.1), including when replay replaces the pin commit's ancestry.
Conflicts use reconcile and its captured post-reconcile policy. A conflict before initial verification cannot
skip initial checks through that policy.


## 6. The spec

Two things wear the name:

### 6.1 The spec standard

A reference document defining "buildable": what/why not how, acceptance
criteria, explicit out-of-scope, evidence links — plus sizing guidance:
fewer, larger tickets, split only at clean seams into a wide blocker graph so
independent tickets build in parallel. It is a shared resource
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
explicit operator revision protocol (leaf escalation or the node exception below). Every downstream reviewer approves
conformance *to it*; a drifting spec silently converts approvals into
approvals-of-something-else. A phase discovering the spec itself is wrong
raises an `escalation`; a human uses `ab answer --revise-spec` (or
`--revise-spec-from-ticket`), the spec gets rev N+1, and the leaf restarts
from `plan` (cheap — downstream was invalidated anyway).

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
restart from `plan`.

Caught preparation failures before an established build follow the durable
claim recovery contract in §5; incomplete hosted snapshots never launch a build.

**Ticket assets are frozen with the spec.** Claiming a ticket pins the
ticket's current assets (§7.1.3) into the build the same way the spec becomes
revision 0: `build.created.assets` lists exactly which `(kind, name, revision)`
the build sees, omitted when the ticket has none. The set is sampled
immediately after the claim succeeds and before spec authoring, and it is
written atomically with the build record (`createBuild` takes the initial
`build.created` event), so an edit made while a spec is being authored, or a
crash between the two writes, can never change or lose the pin; interrupted
dispatch recovery re-reads it from the log. Attaching, replacing, or removing
an asset afterwards leaves the running build alone, because a build reads its
assets by pinned revision, never "latest". `ab ticket attach` and `asset rm`
warn when the ticket has an active build. Revising the spec **from the ticket**
(`ab answer --revise-spec-from-ticket`) re-pins the ticket's then-current
assets together with its body, as `spec.revised.assets` (present, possibly
empty, means "re-pin to this set"); the set is sampled once, when the body is
read, and recorded on the `escalation.answered` authorization too, so a retry
after a crash publishes the originally authorized set. Revising from a supplied
body file leaves the pinned assets unchanged. The one case this cannot cover is
a record an older dispatcher created with an empty stream: recovery can only
sample the ticket's current assets for it.

For hosted tickets, exact sampled revisions are copied into immutable repository
artifacts in the destination build store before pins are published. Pins carry
explicit manifest references; bounded binary chunks preserve files and empty
directories without contacting the ticket service during build reads. Original
ticket revision numbers are preserved. Old pins without snapshot references
continue reading their existing ticket rows.

## 7. The build store

The pilot's repo-bloat and no-observability problems share one root cause:
the repo did double duty as workspace and database. This design splits the
roles:

- **Workspace** — the sandbox/worktree. Scratch by construction: the working
  tree plus the gitignored `.ab/` dir agents use as working memory during a
  phase (§8.3). Disposable.
- **Build store** — the durable home of everything else, one logical place
  whether builds run locally or in ten remote sandboxes.

### 7.1 Data model

```
builds       id/slug, ticket ref, repo, branch, status (derived), created/updated,
             runner lease + heartbeat; independent node writer lease
             (mutable liveness columns — §15.2.6, never events)
events       build_id, seq, timestamp, actor, type, payload (JSON)   — append-only
artifacts    build_id, kind, revision, blobRef, metadata
repo_streams repo, created/updated, lease + heartbeat, bounded tick observation
repo_events  repo, seq, timestamp, actor, type, payload (JSON) — append-only
repo_artifacts repo, kind, revision, blobRef, metadata
ticket_assets repo, ticket_id, kind, name, revision, layout, manifest (JSON), size,
             removed, created — one row per revision
```

#### 7.1.1 Operator sessions (the third resource kind)

An operator session is durable orchestrator-conversation state — a record keyed
by repository and session owner (the human account stored in `operator`), hosted-only. It is neither a build nor a
repository fact: folding it into the build streams would leak conversation
facts into the build reducer, and folding it into the repository journal would
mix one session owner's chat with dispatcher and harvest history that every process
reads. The store's data model therefore gains a third resource family with the
same shape as the other two:

```
sessions          id (os_…), repo, operator, title?, created/updated
session_events    session_id, seq, timestamp, actor, type, payload (JSON) — append-only
session_artifacts session_id, kind, revision, blobRef, metadata
```

The record carries only identity and timestamps; everything else — status
(`idle | running | suspended | awaiting-approval | archived`), the open turn,
the pending approval, wake settings, wake cursors, the turn list — is a
reduction of the session's own event log (a pure reducer, never a column).
The session event catalog is closed and validated separately from the build
and repository catalogs, so no build reducer can interpret session facts, and
per-session sequencing is independent. The stream primitive's scope vocabulary
gains `{kind: "session"}` with the session id as its reference, so every
turn's content is one session-scoped stream. Local installs never create
sessions: local adapters implement the contract uniformly, and the operator
API (§14) is the only creation surface.

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

Reading session events uses the same contract shape as stream reads (§7.6):
cursor-based, returning events with `seq` strictly greater than `sinceSeq`
(default 0) in increasing sequence order, and an optional bounded wait —
`waitSeconds` in whole seconds — that returns as soon as an event lands and
no later than the §7.6 bound, with a `waitSeconds` above 30 clamping to 30
exactly as stream reads do. One asymmetry is deliberate: an event log has no
closed state, so a session-event read wakes only on an appended event or the
clamped deadline, never on a close. Every store adapter enforces the same
rules, so a poll loop cannot drift between stream and session-event reads;
over the remote protocol the read is
`GET /sessions/{id}/events?since={n}&wait={n}`, parsed exactly like the
stream read's ([docs/remote-store-protocol.md](docs/remote-store-protocol.md),
§5).

#### 7.1.2 The embedded orchestrator (turns)

The operator is always an external agent: a coding-agent harness at the
repository root using the `ab` CLI, or an agent connected through MCP and the
operator tools. The canonical `ab-operate` skill describes that role. Autobuild
never hosts or starts it. The embedded turn runner was abandoned and removed.

The hosted service records sessions, messages, explicit wake settings, approval
answers and archives as durable facts only. Message, wake and approval writes
return `{ok:true}` without turn or stream ids. New sessions receive only
`session.created`; wake settings are written explicitly, never inherited from
repository config. Neither HTTP writes nor origin-mode dispatcher ticks start,
resume or reap turns, execute approved calls, or close historical streams.
External harnesses own their conversation, scheduling, concurrency and approvals.

Historical turn events, approvals, wake cursors and session-scoped streams remain
valid and readable under §7.1.1 and §7.6. Answering a matching pending approval
clears that approval but does not resume its suspended turn or change its stream.
The operator API does not expose raw turn-event append. No migration deletes
historical events or changes their reduction.

`[orchestrator].enabled` and `[orchestrator.sandbox]` retain the externally driven
sandbox tools, credential isolation, archive cleanup and dispatcher idle
settlement. New config rejects the removed `model`, `invocationBudgetSeconds`,
`approvals` and repository-default `wake` keys. Immutable historical effective
config artifacts discard only those obsolete keys during validation; stored
bytes are unchanged and other unknown or malformed settings still fail.

#### 7.1.3 Ticket assets

A **ticket asset** is a named, versioned bundle of files attached to a ticket —
a design export, a reference screenshot, a sample payload — that shapes a change
but belongs outside the repository, where it would go stale once the change ships. It is keyed by
`(repo, ticketId, kind, name)` and works identically whichever ticket source is
configured. It is a fourth resource family beside builds, repository journals,
and sessions, but a deliberately thin one: no event log, because nothing here
needs reduction, and no retention pruning, because assets live as long as the
ticket's other durable data and never expire on their own.

Hosted ticket assets live in the ticket service's repository-keyed storage,
regardless of where builds run or which BuildStore is selected. File tickets use
native portable storage composed with legacy BuildStore attachments; Linear
tickets retain BuildStore storage. Existing service assets need no migration;
old local hosted-ticket attachments are not moved or used as a fallback.

Each put creates a new increasing **revision**; earlier revisions stay retrievable.
Adapters normally start at 0. Native file assets reserve revisions from
1,000,000,000 upward so explicit reads of old BuildStore revisions remain
unambiguous when native and legacy assets are composed.
An asset is a `file` (exactly one file) or a `tree` (a folder: its root is
implicit, so a tree with zero entries is a valid empty folder). The manifest is
a list of entries — `file` entries with size and content address, and `dir`
entries so empty directories survive. File bytes live in the `BlobStore`; the
database holds only the manifest, the same rule as artifacts. **Removal is a
tombstone**: a row taking the next revision number with an empty manifest. The
latest row decides liveness, so the default read and list skip a removed asset,
while an explicit earlier revision stays readable — a build that pinned revision
N keeps retrieving it. Re-attaching after a removal takes the next revision, so
revision numbers may skip the tombstone.

Every adapter runs one shared validator before any write. `kind` and `name` are
`[A-Za-z0-9._-]+` and at most 64 characters, so they are safe to print in a
command line. Entry paths are relative, `/`-separated, with no empty, `.`, or
`..` segment, at most 256 bytes each and 128 per segment, with no duplicates and
no file as an ancestor of another entry. A revision holds at most 1000 entries
(files plus directories) and **25 MiB** of file bytes; a larger put is refused
with an error that names the limit, and nothing is stored. A remote deployment
may advertise a lower effective limit (§7.2): a platform that rejects oversized
request bodies before application code runs cannot rely on server-side
validation alone, so the client enforces the advertised limit before uploading.

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
Node branch writers use separate `claimNodeWriter`, `renewNodeWriter`, and
`releaseNodeWriter` operations. Claim permits an absent, expired, or same-holder
lease; renewal requires the same unexpired holder, and release is holder-checked.
The memory, SQLite, Postgres, and HTTP stores enforce the same contract. These
leases neither grant nor renew runner authority. Delegated execution credentials
cannot acquire node writer authority. The active operation remains a durable
build-stream reservation across expiry, not mutable lease data.

The same contract has repository-scoped `ensureRepo`, event/artifact deposit
and read methods, plus a repository lease. Ticket assets (§7.1) add
`putTicketAsset`, `getTicketAsset` (latest live revision, or an explicit
revision), `listTicketAssets` (summaries without manifests: the latest live
revision per kind and name, or every real revision), `removeTicketAsset`, and
`ticketAssetLimits(repo)`, the effective ceilings the store accepts. Scoped
build and session handles reject all of them. Before execution, a runner obtains
an interface-enforced handle scoped to exactly its build. Own-build records,
stream, artifacts, lease, and subscription remain available; another build,
collection/admin operations, nested foreign scope, and every repository-journal
operation reject. The one ticket-asset read a build handle keeps is
`getPinnedTicketAsset(slug, kind, name, rev?)`: the asset as that build froze it
(the latest pinned revision, or any revision the build ever pinned), found by
reducing the build's own events and then reading that exact revision. It needs
no lease, so it answers for a finished build, and remote build tokens reach it
through `GET /builds/:slug/ticket-assets`. `createBuild` optionally takes the
build's initial `build.created` event and appends it as seq 1 in the same atomic
step as the record on every adapter. This guard applies identically to every adapter; remote tokens
carry the same authority over the wire as defense in depth rather than creating
it. Two implementations of one contract (`packages/core/src/store/contract.ts` is the shared
conformance suite):

1. **Local** — one self-contained state tree at `<main-repo>/.autobuild/` by
   default: database, content-addressed blobs, Git worktrees, and the file
   ticket source's default directory. The main checkout is derived from Git's
   repository/worktree topology, so a command run inside a linked worktree
   resolves the same state. There is no home-directory fallback or
   machine-global state. Store selection is uniform: explicit `--store` >
   nonempty `AB_STORE` > repository default. When a phase or Harvest CLI
   process reopens this store, a handle wrapper derives exact build-or-repository
   authority and agent-event session attribution from its validated ambient
   identity. The same wrapper applies when `ab builds`, `ab build status`, or
   `ab artifact download` is invoked with a complete ambient phase identity;
   without identity those read forms retain unscoped operator access. This
   preserves the remote adapter's observable resource boundary without making
   the SQLite adapter itself ambient-aware.
2. **Remote** — the same store interface behind the independently deployed
   hosted HTTP service, selected by an `http(s)://` reference. Kernels,
   sandboxes, terminal dashboards, and later human-facing pages share this
   service tier; it owns token authorization, protocol write validation,
   artifact policy, release-line compatibility, and independent protocol
   enforcement. The
   later human routes share its deployment so a browser or second service never
   receives the machine signing secret. Artifacts remain content-by-value. The
   documented [remote store protocol](docs/remote-store-protocol.md) is the
   public BuildStore extension surface for independently implemented servers;
   `packages/core/src/store/contract.ts`, driven through the shipped remote
   client, is the conformance bar. Autobuild does not load in-process BuildStore
   plugins. Git worktrees and default file tickets necessarily remain local.

A service accepts stable and prerelease clients from its own `major.minor`
release line and the two preceding minor lines in the same major. A major starts a new family:
X.0 accepts only X.0, X.1 accepts X.0/X.1, and X.2 onward accepts three lines.
Patch versions are interchangeable in both directions and must never change
the protocol. Upgrade the service first, then projects independently within
its window. Supported release lines retain their wire handlers and known
protocol identities; an unknown protocol is refused independently of version.
Stable and prerelease service and client identities share their numeric major/minor
line. Malformed or missing identities, build metadata (`+…`), prefixes and
whitespace are refused with HTTP 409.
A newer client is told to upgrade the service; a client below the window is
told to upgrade the project's Autobuild. Diagnostics name the service version
and supported range.

Unauthenticated `GET /health` publishes `ok`, `autobuildVersion`,
`protocolVersion`, and `supportedClientRange: { minVersion, maxVersionExclusive }`.
Range endpoints remain stable versions. The range is inclusive at the minimum
and exclusive at the maximum; a 0.11.x
service publishes `>=0.9.0 <0.12.0`. Health needs no credentials, version
headers, or available backend.

`subscribe` is specced in the interface; the current implementation is polling
`getEvents(since)`. True push comes later.

Operator UIs additionally have a repository-scoped batch read,
`getRepoBuildDigests(repo)`: the projection of every build's log onto its
terminal fact, its `observation.recorded` occurrences with their event
timestamps, and the ts of its latest `pr.merged`, derived from the event log on
each call. It lets a dashboard snapshot count unclaimed observations and gate
rows without reading the full history of finished builds (§16.1), and it backs
the harvest-launch pressure gate (dispatcher and harvest runner alike): launch
decisions evaluate from digests and the repository journal alone, so
gate-evaluation cost is flat in accumulated build history, with the full
per-build scan paid only when a gate actually trips and a scan packet is built.

Stateless repository-level readers also have a bounded journal read,
`getRepoStateEvents(repo)` (AUT-489): every durable, slow-growing event type
(all harvest facts, operator-sandbox facts, cross-generation handoff correlation
facts including preparation, request, failure, start, release, takeover, deadline,
settlement and completion, and the three dispatcher setting
types) plus, when the journal has one, the tail from the latest
`dispatcher.run-started`. The run-scoped `dispatcher.runtime-recorded` companion
is retained in this same bounded tail. Reducing this subset with the state readers yields
exactly what a full replay yields, so the cost of reading repository state no
longer grows with the number of past dispatcher invocations. The journal
itself stays append-only: full replay remains the normative truth, and
`ab watch` still sees every recorded fact.

#### Hosted connected projects

The product's hosted service keeps a durable PostgreSQL project registry,
independent of BuildStore repository journals and ticket data. Entries record
normalized repository origin, addition timestamp and adding identity. An
append-only journal records additions/removals; latest sequence determines
membership. Removal never deletes build, event, artifact or ticket history;
re-registration restores access and records fresh addition metadata.

Database-authorized owners administer it without redeploying through
`ab-hosted-store projects list`, `projects add REPOSITORY --user IDENTITY`, and
`projects remove REPOSITORY --user IDENTITY`. Attribution is declared by the
administrator; ordinary store/project tokens cannot administer registration.
Human access is scoped to Better Auth organizations. Super users named by
`AB_WEB_SUPER_USER_EMAILS` can operate every registered project. Other users
can operate only projects assigned to an organization containing their normalized
email. Membership grants work before first sign-in; each organization has zero
or one owner. Only super users create organizations, change ownership, or move
projects. Members can inspect their own organization’s active projects and roster,
including emails and persisted identity names/joined status. Owners can manage
their own members but cannot remove themselves.
Creation does not make the super user a member. Legacy projects remain unassigned
and visible only to super users until management assignment or an authorized
reconnect approval assigns them. Admission and repository authority
are checked from current state on every browser request and MCP tool callback.
Removed members lose access immediately without re-login. Machine project,
delegated, internal and admin credentials retain their existing boundaries.

Dashboard discovery, MCP `repositories.list` and every repository tool call,
and all operator API routes for every operator credential consult current
membership. Unregistered operator paths return not-found before execution.
Registry failures fail closed and transient initialization can retry.
The dashboard selection lives at `/?repo=<URL-encoded normalized origin>`;
missing/invalid selections canonicalize to the first active entry, and an
empty registry issues no project data/control requests.

The hosted dispatcher queries the registry each authorized invocation when
`AB_DISPATCHER_REPOSITORIES` is unset. An explicit list is intersected with
current registration in its configured order. Empty registration is a
successful zero-project tick. Removal stops later invocations, without
cancelling already-started work or changing machine-route token authority.

`AB_WEB_REPOSITORIES` is deprecated: the first initialization with a nonempty
CSV imports absent projects once per database as `system:AB_WEB_REPOSITORIES`.
The import and durable marker share one transaction and mutation lock across
processes. Absence does not consume the marker. Restarts or later variable
edits cannot resurrect removals. Deployments migrate the pinned schema before
starting services; runtime initialization never runs DDL.

### 7.3 Persistence granularity

Required phase outputs persist at **phase/round boundaries**; a killed phase
re-runs from its start. An agent may also explicitly deposit a review artifact
mid-session, including an atomic PR-attachment designation (§7.5, §8.2); these
immutable revisions are harmless if a killed phase later retries. The
streaming exception reserved here is now the stream primitive (§7.6): live
output persists continuously while an agent runs, so a session that dies
mid-turn leaves its transcript behind instead of nothing.

### 7.4 Resumption across sandboxes

Because state is the event log and artifacts live in the store, a *new*
sandbox can resume a build a dead sandbox started: pull events, rehydrate
scratch from latest artifact revisions, continue. The pilot structurally could not
do this.

The base-selection invariants make this safe with Git:

- **The base is chosen once, at first branch creation**, from the freshly
  fetched origin tip of the configured base branch (fetched into a
  build-scoped internal ref so concurrent dispatches cannot clobber each
  other or the user's refs). If the remote is unavailable, creation falls
  back to the local base and records the diagnostic.
- **Re-provisioning resumes; eligible restacks rewrite.** Provisioning alone
  resumes the published branch. The kernel collapses and restacks at verify
  entry and after target moves while awaiting merge. The first
  `workspace.provisioned` base stays immutable branch-cut provenance; later
  `existing` facts are resume evidence, not new cuts. A remote workspace lost
  before publication may be freshly cut again; the latest `remote` or `local`
  provisioning fact then supplies the starting base until an implementation
  or replay range has been established.
- **Review loops keep their starting effective base.** The initial loop uses
  the latest fresh cut; after a successful verify-entry restack, later failure
  loops use that restacked contribution base. Plan, implementation and
  code-review never rewrite the branch. Previously recorded review ranges
  remain immutable, including between rounds.
- **Each implementation completion records its proven contribution boundary.**
  `ab done` uses the current projected contribution base, falling back to the
  latest fresh-cut provisioning base (`remote` or `local`, never an `existing`
  resume). It validates that immutable base against HEAD and records it verbatim.
  A moving or rewritten destination never changes the review range, and review
  requires no target fetch or merge-base calculation. Missing provenance fails
  before publication. Successful restacks establish the baseline for later loops
  and collapses. Historical event ranges stay immutable; the current
  `implement.commits` projection advances to `targetBase..headSha`
  on successful leaf `restack.rewritten`, `restack.completed`, and
  `reconcile.rewritten` facts. `ab context` supplies that current range unchanged
  to code review and every agent verify step. Node integration cycles retain
  their separate range semantics.
- **Verification names its actual base.** Successful restack or reconcile
  publication promotes the contribution/path base. Every new verify start and
  result, including skips, cites the cycle's base and head. Those citations stay
  frozen throughout the cycle and survive clean waiting restacks; historical
  facts without citations remain readable. Upstream-only paths are excluded.
- **Work distance is advisory durable telemetry.** Each admitted work target poll
  samples destination-only commits (`BUILD..TARGET`), even when only the build
  head changed. `target.distance` pins branch, target SHA, nullable build head
  and nullable nonnegative count. Missing history/capability is unknown. Equal
  samples are deduplicated; destination changes and rewrites invalidate samples.
  Sampling never provisions a workspace, renders Git reads, or gates restacking.
- **Observation never mutates a running workspace.** `target.moved` records an
  exact observed head, even during a session. Transactions freeze their target;
  later observations coalesce into one follow-on transaction for the newest
  snapshot at the next eligible point. Session and execution settlement fence
  rewrites, and trusted publication waits for remote guest teardown.

### 7.5 What the PR gets

One marked summary comment contains verdict history, verification results,
and links into the store. Built-in forges discover its per-build marker on
every refresh and edit it, recreating it only after confirmed absence. The
full audit trail is queryable, not committed to the branch.

Summary publication is best effort, once per completed phase occurrence,
after sessions end; attaching artifacts performs no summary write. Durable
claim-before-write facts consume the occurrence budget even across crashes.
Rate limits stop that occurrence and persist a cooldown (provider headers or
at least one minute) before a later phase may catch up. Failures never fail
artifact designation or phase completion. Bodies are capped at 65,536 UTF-16
code units. Oversized projections are deposited as a non-attached `pr-summary`
artifact; a compact comment provides the exact pinned download command.
Current-API plugins retain `commentOnPr` and receive the same bounded calls;
legacy plugins may append instead of editing.

Local runners publish under their build lease. Remote guests record durable
summary boundary requests and yield; only the credentialed dispatcher settles
those requests, after guest execution ends and under exclusive ownership,
before replacement execution or workspace cleanup. Attempts and request
dispositions survive restart and do not alter pipeline routing.

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
designation after the PR exists is included at the completed phase boundary,
so finalize post-steps and post-reconcile verifiers need no custom phase.

### 7.6 Streams (the third primitive)

The store's content model is three primitives, each doing one job:

- **Events** carry facts — small, typed, append-only, the routing spine.
- **Artifacts** carry bulk — content-addressed bytes deposited at boundaries.
- **Streams** carry the agent's running output — token deltas, tool calls and
  results, reasoning — which is too bulky for the event log and arrives too
  continuously to be an artifact until a session ends.

A stream is an append-only, per-stream sequenced log of **chunks** (a chunk is
a nonempty batch of protocol parts) with an open-then-closed lifecycle. The
chunk vocabulary is the Vercel AI SDK UI Message Stream protocol, version 1 of
the current major (AI SDK 7): the store holds the protocol's parts rather than
a private shape, so a read route can re-emit them as Server-Sent Events that
the AI SDK's own client hooks and any customer's tooling consume unchanged.
The store performs no protocol validation on append; each part only needs a
nonempty-string `type`, and the store assigns each batch its per-stream
sequence (from 1) and timestamp, so producers cannot fake ordering.

Closing a stream assembles its chunks into the protocol's `UIMessage[]`
document — dropping parts of undefined types while counting them — and
deposits that document as an artifact (`stream:<streamId>`, revision 0) on the
owning scope in the same atomic operation that marks the stream closed. A
stream that dies mid-turn stays open and readable, so its output survives.

Close serializes against append, per stream: an append issued while a stream
is being closed — or after it has closed — either merges in the finalized
artifact or is rejected with `StreamClosedError`; an accepted append is never
silently omitted from the artifact the close deposits. Appends to other
streams are unaffected.

Closing an already-closed stream is a no-op that returns the closed record.
The repeated close's outcome argument is ignored; the artifact the first
close deposited is left untouched.

**Rejections write nothing.** Append validation and every rejection below
happen before any mutation: a rejected operation leaves no chunk, no sequence
number, and no artifact. An append batch must be a nonempty array of JSON
objects, each carrying a nonempty-string `type`; a batch that fails this
shape is rejected with a plain error, and a batch whose serialized JSON
exceeds 1,048,576 bytes is rejected with `StreamBatchTooLargeError`.
Operations that address an unknown stream id — append, read, and close — are
rejected with a plain error; `getStream` alone answers `null` for an unknown
id, never an error. The contract is common to every shipped store — the
in-memory reference, the local SQLite adapter, and the remote Postgres-backed
service. Over the remote protocol the typed rejections cross the wire as
status codes — the ceiling as 413, the closed-append rejection above as 409,
the unknown stream as 404 — and the shipped client rehydrates the same error
types; `docs/remote-store-protocol.md` specifies the wire surface.

**Rejection precedence is transport-dependent, deliberately.** The store-side
adapters reject an append in the order part validation, batch-size ceiling,
unknown stream, closed stream: a malformed or oversized batch addressed to an
unknown stream id reports the validation error or `StreamBatchTooLargeError`,
never unknown-stream — the batch is validated and size-checked before the
per-stream critical section, and the unknown-stream lookup inside it precedes
the closed check. Over the remote protocol the server resolves and authorizes
the stream before parsing the request body, so the same request is rejected
`404 not-found` (`unknown stream "…"`) before the body schema or the ceiling
is evaluated. Both orders are deliberate: the 404-first order is the server's
no-existence-leak shape (an unknown stream and a foreign-scoped stream are the
same 404), while the local order keeps malformed input failing before any
per-stream synchronization. Writer-facing clients must therefore not assume a
single precedence across transports — a malformed batch on an unknown stream
legitimately rejects with different errors by transport — and both orders
reject before any mutation: no chunk, no sequence number, no artifact.

Chunk retention is deposit-path and count-based, like artifact retention: at
the next stream create in a scope, every previously closed stream's chunks
except the most recently closed are deleted; finalized artifacts are never
touched.

Streams are scoped to a build, to a repository, or to an operator session
(§7.1.1) — the scope vocabulary is closed. Reads are cursor-based
(`since` sequence) with an optional bounded wait (`waitSeconds`, whole
seconds) that returns as soon as a chunk lands or the stream closes — the
resumable live channel every frontend would otherwise invent for itself.
The wait is bounded at `MAX_STREAM_WAIT_SECONDS` = 30: a `waitSeconds` above
30 clamps to 30, so a request to wait 61 seconds returns no later than 30.
Every store — the in-memory reference, the SQLite adapter, and the remote
client/server path — enforces the same clamp, and session-event reads
(§7.1.1) honor the identical rule so a poll loop cannot drift between the
two.

**Presentation, never routing.** No kernel, engine, reducer, or dispatcher
decision reads stream content; outcomes travel only the typed CLI. Writers
(agent runners emitting parts) and readers (operator UIs) are separate
tickets; this section defines only the primitive.

## 8. The `ab` CLI

The **only** channel between agents and the store — and the enforcement
point of the entire ontology. Designed by walking every phase's session from
first command to terminal command, plus the failure paths (§8.7). Decisions
forced by the walkthrough are marked **[D5]–[D8]**, continuing §15's series.

It buys three properties at once:

1. **Storage-agnostic skills** — local or remote store, same commands.
2. **An enforced ontology** — the CLI validates schemas at deposit; verdicts
   travel a typed channel, never parsed from stdout (the root-cause fix for
   the pilot's sentinel parsing).
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
AB_CONTEXT_DIR # workspace-relative session scratch directory
AB_SESSION   # session id
AB_TOKEN     # signed credential for this exact phase session (remote store)
```

A harvest session instead carries `AB_REPO`, `AB_HARVEST`, and an `AB_PHASE`
of `synthesize@N` or `review@N`. The AgentRunner invocation argument is
opaque: a build skill receives its slug; a harvest skill receives its run id.
The CLI resolves identity from ambient auth. Every build process holds an
interface-enforced build-scoped Store handle. At the phase CLI opening boundary,
both local and remote handles are wrapped with authority over exactly
`AB_BUILD` or `AB_REPO`. Before launch, the dispatcher exchanges its project credential with the service
for a build or prepared harvest-execution grant. After recording a session start,
the runner exchanges that grant for an exact phase-session grant. The remote
handle forwards only this delegated credential; the service enforces its project,
resource and session boundaries on the wire. Build and
repository resources cannot cross, and naming another resource to a Store
operation cannot widen either handle. Event-bearing writes attributed to an
agent must name the ambient `AB_SESSION`; non-agent writes remain allowed so the
CLI can perform its existing trusted kernel plumbing, including finalize.
Operator and kernel processes with no agent identity markers retain interface-unscoped
Store handles; remote authorization still limits access to the credential project. Three read-only forms are also valid inside a phase: `ab build
status` and `ab artifact download` may read only `AB_BUILD`, while `ab builds`
is denied because collection access cannot represent one build. A complete
Harvest identity has repository scope and cannot use those build/admin reads.
If any build or Harvest identity marker is present, the corresponding
`AB_STORE`/resource/phase/session tuple must be complete, valid, and unambiguous;
partial, empty, malformed, shared-only, or mixed identity fails before Store
access rather than falling back to operator authority. `AB_STORE` and
`AB_TOKEN` alone remain operator selection and credentials, not identity.
Dispatcher machine authority is an opaque, revocable credential for exactly one
registered project. The service keeps only a digest of its random secret and
credential metadata (creator, creation, last use, expiry and revocation), and
checks both credential status and project registration in one fresh database
read on each request. Last-use metadata is written at most once per 60 seconds,
with a database cutoff fencing concurrent writers; it trails actual use by at
most 60 seconds. Requests starting after revocation, expiry, or deregistration
are refused; an authentication already in flight may complete. Authentication
is shared only within a handled request. Repository record/existence reads may
also be reused within that request, including compound operator reads, but
events, reducer tails, and mutation locks remain fresh. It
checks actual build/session/stream ownership and filters collections server-side.
Explicit project mismatch is 403; missing and foreign indirect IDs share 404.
Remote project build creation allocates a fresh slug and branch; the returned
record is authoritative. Local adapters retain exact-slug behavior.

Owners issue/list/revoke credentials with deployment-local `ab-hosted-store
credentials` commands. Retired deployment-wide and repository-less operator
tokens are rejected with migration guidance. An explicit versioned owner-only
break-glass admin is the sole machine cross-project exception. Internal signed
owner delegation is short-lived, repository-bound and operator-only. The hosted
dispatcher issues stored credentials with immutable dispatcher purpose (raw
store and tickets only) per repository invocation. It deletes each credential on
completion, including failures. Crash-safety expiry is the earlier of the configured
TTL upper bound and the invocation deadline plus 60 seconds. Each served tick
prunes at most 100 expired or revoked dispatcher rows using indexed probes;
unexpired legacy rows retain their recorded expiry before eventual pruning.
Already issued delegated grants do not depend on the parent row or its expiry.
Owner-issued project credentials attribute operator writes to their recorded
creator. Agents never receive the dispatcher's project credential. Delegated
reads retain access to same-project repository state; build mutations target only
that build, and harvest mutations target only the prepared run and execution,
its artifacts and streams, with heartbeat authority for its adopted lease holder.
Phase grants also enforce agent session attribution. They cannot create builds or
operator sessions, administer repositories, invoke operator routes, or delegate.
A runner can delegate only to a recorded session within its own authority.

Delegated grants have no fixed wall-clock expiry. The service checks signed
bindings against authoritative durable lifecycle facts on every request and
fails closed if those reads fail. Active, paused and escalated builds may outlive
a dispatcher restart or a week-long parent credential. Build termination,
harvest execution/run termination, or the phase's own session end or suspension retires the
corresponding grant after a 60-second evidence grace window. A durable ending
permanently closes that grant; recovered harvest executions use fresh durable
authorizations and fresh grants. Project removal denies all its grants immediately.
Local-store projects require no exchange.

Hosted ticket operations are gated by grant kind: build-runner and build-phase
grants have no access; harvest-phase grants can only list-ready, get and read
dependency-states; harvest-runner grants can also create proposals. All other
ticket mutations require project or admin authority. Refusals name the grant
kind and operation.

Ticket admission uses the credential project. Hosted tickets, comments, blockers, creation-key
deduplication and assets are partitioned by registered repository, never team.
Lifecycle comes from independent project ticket policy (triage, ready, doing, done
by default; configurable doneState). Legacy projects without independent policy
use their uploaded configuration with Backlog / Doing / Done defaults. Owner admin ticket requests explicitly select a registered
repository. The service has no Linear ticket backend: external tracker and
file sources remain dispatcher-side, and service ticket surfaces refuse those
projects with actionable source feedback. Legacy team queues migrate atomically
to their sole configured claimant; conflicts stop unchanged for an owner
assignment and rerun. See the hosted service migration procedure.
See the remote store, remote ticket and operator protocol references for wire
and revocation details. Least privilege comes from code, not prompt instructions.

Every phase and harvest turn also receives a runner-controlled `PATH` prefix
containing a private `ab` launcher from the same Autobuild distribution that
started the session, applied after ambient and scoped environment merging —
so a host executable named `ab` can never shadow the typed CLI, and agent
sessions need no separate global installation.

### 8.2 Command surface

| Command | Purpose | Terminal? |
|---|---|---|
| `ab context` | hydrate `$AB_CONTEXT_DIR/` with the phase's inputs; print the manifest | no |
| `ab artifact put <kind> <file> [--attach]` | deposit a versioned artifact → returns rev; optionally designate that exact revision for the PR | no |
| `ab artifact get <kind>[@rev]` | fetch an artifact within own build | no |
| `ab artifact download …` | read-only exact-byte retrieval; operator-wide without identity, own-build only with ambient phase identity; works after build termination | no |
| `ab observe --kind <followup\|refactor\|latent-bug> …` | structured observation, any phase, any time | no |
| `ab done` | complete a producer phase (validates, then runs phase plumbing) | **yes** |
| `ab verdict <approve\|revise\|escalate\|pass\|fail\|skip> …` | complete a review/verify phase | **yes** |
| `ab escalate <question>` | park the build for human input | **yes** |
| `ab mcp [--store <ref>] [--repo <id>]` | serve the agent tool registry as an MCP server over stdio; fails closed inside a phase | no |

The read-only `ab builds`, `ab build status`, and `ab artifact download` forms
require no session identity for operator use and preserve their repository-wide
results and store-selection precedence in that case. When a complete ambient
phase tuple is present, they retain its local or remote Store authority:
own-build status/download succeed, foreign and repository-scoped targets fail,
and `ab builds` fails at repository-wide `listBuilds` access rather than
filtering. Malformed ambient identity fails closed as defined in §8.1.

The verdict vocabulary is phase-dependent and the CLI enforces it: review
phases accept `approve|revise|escalate`; agent-verify steps accept
`pass|fail|skip` (`fail` requires a report; `skip` requires a reason).
Deterministic checks never touch the CLI — the kernel runs them directly.
Exact flags and validation live with the CLI implementation and its tests.

### 8.3 What `ab context` materializes

A phase-scoped hydration into the gitignored scratch dir:

```
.ab/<dir>/
  context.json      # manifest: build, phase, round, artifact revs,
                    #   required deposits, allowed terminal commands
  spec.md
  node-verification.json # node verify: exhaustive commit provenance index
  contributions/    # node verify: <build>/spec.md
  plan.md           # per phase needs (see table)
  findings.json     # current feedback, when round > 1
  history/          # prior-round artifacts where the phase needs them
  verify/           # failure reports routed back to implement
  assets/           # the ticket assets the build froze (§6.3), every phase:
                    #   assets/<kind>/<name>/…, folders keep their trees
```

Every build agent receives workspace-relative `AB_CONTEXT_DIR`. Core phases use
`.ab/plan`, `.ab/plan-review`, `.ab/implement`, `.ab/code-review`, `.ab/reconcile`
and `.ab/finalize`; agent verify and finalize post-steps use `.ab/verify-<step>`
and `.ab/finalize-<step>`. Step names contain ASCII letters, digits, `.`, `_`,
and `-`, excluding exactly `.` and `..`.

`ab context` prints this directory and records `contextDir` in its manifest.
Hydration replaces only that directory's disposable files, retaining tracked
content and sibling directories. Sessions may read each other's directories;
these directories provide scratch separation, not filesystem isolation.
`materialized` keys are directory-relative; manifest, notes, asset, provenance
index and contribution spec paths remain workspace-relative. Implement receives
routed verify reports under its own `$AB_CONTEXT_DIR/verify/`.

The manifest tells the agent its contract — `required` deposits and
`allowedTerminals` — so skills are self-checking against the same data the
CLI validates with. When the build pinned ticket assets, every phase also gets
them under `$AB_CONTEXT_DIR/assets/<kind>/<name>/` and the manifest lists each as
`assets: [{kind, name, revision, layout, size, path}]`; a `file` asset is the
single file inside its directory. A build with no assets gets no `assets` key
and no directory. `ab build asset get <slug> <kind> <name> <dest>` downloads a
pinned asset by build, also after the build has finished. Per-phase inputs and
terminals:

| Phase | Materialized inputs | Terminal |
|---|---|---|
| `plan` | ticket, spec; prior plan rev + findings (round > 1) | `done` (requires `plan` artifact) |
| `plan-review` | spec, plan@latest, all prior rounds' findings (for `persists` marking) | `verdict` (requires notes artifact) |
| `implement` | spec, approved plan, feedback (findings **or** verify report), own prior notes | `done` (requires clean worktree + notes) |
| `code-review` | spec, plan, commit range `{base, head}`, prior findings, implement-notes | `verdict` |
| `verify:<step>` (agent) | spec (acceptance criteria), step config, commit range; node contribution specs and provenance | `verdict pass` \| `verdict fail --report` \| `verdict skip --reason` |
| `finalize` | spec, plan, verify reports, PR template config | `done` (requires `pr-description` artifact) |
| `reconcile` | spec, plan, implement-notes, conflict `{baseSha}` and kernel-prepared replay transaction | `done` (requires one replayed commit on the frozen base) |

In node `verify:*` context, `nodeVerification` in the manifest identifies the frozen
`range`, `indexPath`, `contributions`, `handPushedCommits` and `unattributedCommits`. Each contribution
has `build`, its preparation-time stored `ticket` identity, `spec: {kind: 'spec', rev}`,
`specPath` and `commits`. The JSON index repeats this metadata and adds the
exhaustive ordered `commits: [{sha, build?}]` mapping. Paths are workspace-relative
and reflect scratch allocation, including legacy tracked-file collisions.
Contribution specs normally live at `$AB_CONTEXT_DIR/contributions/<build>/spec.md`; the index
normally lives at `$AB_CONTEXT_DIR/node-verification.json`. These files are marked `derived`
in `materialized`, with their source build and revision recorded in the metadata.

Membership comes from build identity trailers on every commit reachable in the
frozen parent-to-head range, including earlier cycles and merge side history.
The dispatcher gathers contributor material with repository authority while
preparing the exact cycle head, before launching verification. Specs use the
event-authorized revision at preparation, never an unsanctioned latest deposit
or mutable ticket body. Unknown identities, ambiguous or invalid trailers, and
missing source data prevent preparation. A versioned node-owned
`node-verification-context` artifact is deposited atomically with
`integration.prepared`, which cites its exact revision. Context hydration reads
only that citation, validates its cycle and range, and allocates public paths;
it needs no contributor reads or Git provenance discovery. Concurrent members
and resumed sessions retain the same frozen specs; a new cycle collects fresh
inputs. Missing, corrupt or mismatched inputs fail without publishing a manifest.
Historical agent cycles without a citation require a new prepared cycle;
check-only cycles do not require contributor inputs. Session and build scope
permissions remain unchanged. Commits without a build trailer are
listed as unattributed, a mechanical absence of a trailer rather than an authorization verdict.
`handPushedCommits: [{sha, originalSha, message}]` identifies node-owned hand-pushed
commits in the frozen range. Ownership uses the durable first-parent contribution
boundary; inherited and merge-side history are not automatically owned. Confirmed
rewrite aliases preserve original identity, and `message` is the full commit message.
These messages express maintainer-authorized intent: judge quality and consistency;
never fail these commits solely for lacking a covering spec.
Other node changes are authorized when the node spec or the spec of the contribution
that introduced it covers it; use the commit mapping to find that spec.
Leaf verification omits node provenance.

The current manifest deliberately selects phase-appropriate inputs: the planner
is not given code-review rounds, while a reviewer receives prior findings.
Sibling directories remain readable; this selection is not an isolation boundary.

### 8.4 Terminal discipline [D5]

Classified session deferrals consume no phase failures. Unsupported decisive
facts retain the mixed-version wait gate and durable compatibility diagnostic.
When the scoped `ab context` initial own-build read fails, the CLI best-effort
writes `session.build-read-failed` with exact session, phase, round, operation
`context`, reason `own-build-read`, and diagnostic. A valid terminal from that
session wins if the agent recovers. Otherwise settlement records `phase.deferred`
and `phase.deferral-escalated`, immediately projecting ordinary blocked attention.
The raise cites `own-build-read:<evidenceSeq>`; replay repairs either settlement
crash gap before launching another agent. An `escalation.answered` retry or
guidance authorizes one fresh session without resetting genuine phase failures;
a new classified failure parks again. There are zero automatic paid retries
after this deferral. If evidence cannot be written, ordinary recovery applies;
agent output and `no-terminal` alone never classify a read failure.

Ordinary silence, provider failures and session timeouts retain the runner's
phase failure limit (`BuildRunnerOpts.maxPhaseAttempts`, default 2). This is
an internal runner option, not an accepted `[policy]` TOML key. Reconcile
execution and unchanged-base progress budgets retain their existing accounting.

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
Authentication, permission, and local runtime-configuration failures do not, with one exception: a runtime whose CLI executable is not installed is skipped like any other eligible failure, so the phase runs on the first declared target whose CLI is present. An unsupported installed version is still a stopping configuration failure. If no target's CLI is installed, the chain ends in one non-retried `configuration` failure carrying the last target's missing-CLI message.
Each failed target's transcript is deposited. Only a stopped or exhausted chain
emits one `phase.failed` with the final provider message verbatim; that final
failure controls retry policy. Provider exhaustion skips the retry budget and
raises a policy escalation, while availability uses the existing bounded
budget. Every build-agent session also has a kernel-owned active-time budget,
resolved from its logical role and then `[policy].sessionBudgetSeconds`. Expiry
aborts the turn, ends any available handle, drops producer continuation state,
and emits retryable `phase.failed` with `phase session budget expired after
<seconds> seconds`; it is kernel policy and therefore does not select a provider
alternate. The existing phase-attempt guard retries and then raises an
answerable policy escalation. Operator cancellation and the captured deadline
remain independent safeguards: an operator request aborts the adapter promptly,
but the deadline still releases the wait if the adapter ignores cancellation.
When the operator request arrived first, that release remains an abort control
outcome and appends no phase failure or provider substitution. Agent finalize
post-step expiry remains failure-tolerant. Harvest sessions and direct check
commands are outside this budget. If the turn already wrote a valid typed
terminal, that terminal remains authoritative and no contradictory failure is
appended.

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

The forge is authoritative for every publication: after writing or on recovery,
its branch head must equal the frozen intended SHA. Local branch refs are caches
and are refreshed unconditionally after confirmation, without changing checkout
contents. Explicit remote expected-head leases and durable writer reservations
still fence concurrent writers. In local-git the shared ref database is itself
the forge, so its authoritative writes retain compare-and-swap guards.

All `git push`, PR creation, and forge API calls happen kernel-side. `ab done`
in `implement` validates the recorded effective base, freezes HEAD, pushes that
exact SHA, and confirms the authoritative branch head before recording
`{base, head}`. A local push or readback failure writes no completion or publication
request and leaves `ab done` retryable in the same session; `ab done` in `finalize` has the kernel open the PR
using the deposited `pr-description` artifact. After a successful
content-producing `finalize:*` step, the runner
requires a clean worktree and a descendant local `HEAD`, then regular-pushes
the exact validated SHA and confirms forge readback before recording that head and completing the step.
A no-op step has no push. Agents only ever commit locally. Consequences: forge
credentials **never enter the sandbox** (load-bearing once builds run on
remote sandboxes), ordinary implementation history is extended and reconcile
uses exact expected-head guarded rewrites with archived evidence, and the
push-at-boundary rule from [D3] is enforced by construction rather than
convention. The same rule bounds an external operator's small fixes: an operator
sandbox publishes work only through the `sandbox.publish` tool, whose push and
PR creation are kernel-side plumbing executed by the sandbox service through
the workspace provider's publication capability — the only publication path
from an operator sandbox, always to a dedicated operator branch and a pull
request, never to the base branch.

### 8.7 Walkthroughs

**Happy path, one code-loop round-trip:**

```
implementer:  ab context → (work, commit) → ab observe --kind refactor "…"
              → ab done --notes "$AB_CONTEXT_DIR/implement-notes.md"
                  ⇒ validates clean worktree and focused review boundary,
                    pushes branch, emits implement.completed {commits, artifact}
reviewer:     ab context   (gets spec, plan, {base,head}, prior findings)
              → ab verdict revise --findings f.json --notes review.md
                  ⇒ stamps finding ids, stores artifact,
                    emits code-review.verdict
implementer:  ab context   (findings.json now materialized) → …
```

**Failure paths:**

- *Classified own-build read failure, no terminal* → `phase.deferred`, then
  `phase.deferral-escalated`; blocked until an explicit answer, with no phase failure.
- *Completed turn, no terminal and no classified deferral* → `phase.failed {no-terminal}`, retry per
  policy [D5].
- *Session budget expiry* → abort and best-effort `end`, then retryable
  `phase.failed {error: "phase session budget expired after … seconds"}`; retry
  from the primary and escalate under the existing attempt cap. If operator
  abort already owns cancellation, the same deadline only bounds the wait and
  the runner acknowledges abort without a phase failure [D5].
- *Provider rejection* → transcript deposited; eligible failures walk the
  role's declared alternates within one attempt. A stopped/exhausted chain
  emits one `phase.failed` with the final verbatim error and every tried target;
  credentials/configuration stop immediately, final exhaustion escalates
  instead of retrying, and final availability uses bounded retry [D5].
- *Malformed deposit* → rejected in-session with schema + error; agent
  corrects and retries [D6].
- *Crash after deposits, before terminal* → artifacts are revisioned; the
  re-run phase deposits fresh revs; orphaned revs are harmless history.
- *Wrong-resource access or wrong-session agent write* → the applicable
  build-scoped or ambient-session Store handle rejects it at the interface;
  a remote token enforces the same scope over the wire [D8].
- *Store unreachable* → CLI retries with backoff; when read-failure evidence can be deposited, the own-build-read attention
  protocol applies. If writes also fail, no durable classifier can be guaranteed;
  ordinary runner recovery applies.

### 8.8 Outer-loop namespace

Human/pre-build ticket grooming uses one configured-source namespace
(`ab ticket create|update|block|unblock|list|show|move`, plus the ticket-asset
forms below). Migration adds `ab ticket export <dir>` and `ab ticket import <dir>`,
plus `ab ticket migration record <dir>`
(see [Ticket source migration](#ticket-source-migration)). These commands are
sessionless, source-agnostic, and never available as a mid-build spec
mutation path. The CRUD subcommands accept `--json` and then writes exactly one
bare value: `list` emits `Ticket[]`; every other form emits the complete
created, read, or post-mutation `Ticket`. Human-readable confirmations are not
a data format and callers must not parse ids from them.

`block` and `unblock` accept a comma-separated blocker-id list. The CLI
first deduplicates and validates the complete list, including blocker existence
for both operations and direct self-block rejection when adding, then applies
the existing idempotent one-edge port methods; invalid input writes no edge.
Dependencies gate only the dispatcher's claim. Changing blockers after a ticket
has already been claimed does not stop its active build. A repository that
creates tickets directly in its ready state must therefore create a dependency
chain in dependency order, carrying each predecessor id into the next create,
before a later ticket can be claimed.

**Ticket assets** (§7.1) attach files to a ticket. Hosted tickets use their
ticket service storage independently of the selected build store; file tickets use
native storage with legacy fallback, and sources without native assets use the
selected BuildStore:

- `ab ticket attach <id> <kind> <path> [--name <name>] [--store <ref>] [--json]`
  stores a file or a whole folder (its relative tree preserved) as an asset.
  `--name` defaults to the path's basename. Attaching again under the same kind
  and name creates a new revision. The CLI asks the source first, so an unknown
  id stores nothing; it refuses symlinks and non-regular files, and refuses a
  bundle over the store's limit from `stat` sizes before reading any bytes. The
  store write precedes the note: if the note then fails, the error says the
  asset was stored as revision N, and the write is not rolled back.
- `ab ticket asset get <id> <kind> <name> <dest> [--rev <n>]` writes the exact
  bytes of the latest (or a named) revision: a file asset to `<dest>` (or into
  `<dest>` when it is an existing directory), a folder asset into the directory
  `<dest>`, empty directories included. Stored paths are re-checked against
  traversal on write.
- `ab ticket asset rm <id> <kind> <name>` removes it from the ticket's current
  assets; revisions a build has pinned stay retrievable.
- `ab ticket show <id>` lists the current assets (kind/name, revision, size);
  with `--json` the `Ticket` is extended with an `assets` array.

Observation harvest uses a separate typed, repository-scoped namespace
(`ab harvest context|submit|verdict|status`), mirroring the build session
commands: context hydration, a producer terminal, a reviewer terminal, and a
sessionless read-only status projection.

`ab repository status [--json] [--store <ref>]` is the sessionless read-only
projection of the repository journal's dispatcher controls: ticket intake, the
repository-wide pause, and the harvest gate. It uses the same
dispatch-settings reducer as dispatcher decisions and the dashboard. An absent
repository stream reduces as an empty journal and reports intake on, repository
pause off; the query does not create that stream,
append an event, claim a ticket, attach a runner, or start dispatcher work.
The CLI additionally loads mutable advisory `operator.registrations`, with each
live registration's ID, host, PID, original startedAt, heartbeatAt and heartbeatAgeMs.
Human output includes one `operator: absent` or `operator: present (N registrations)` line.

`ab watch --operator` opts into repository-wide advisory presence. Named slugs
and ambient build/scoped sessions are usage errors. Unflagged watches remain
read-only, including resumes of flagged cursors. Flagged watches register before
watch initialization, renew independently every 30 seconds and attempt one final
renewal at orderly exit. Presence expires 300,000ms after the last successful
heartbeat and never appends a build/repository event or claims a lease. Multiple
registrations coexist. The opaque watch cursor preserves registration ID and start
across re-arms, including revival after withdrawal or expiry. SIGINT, SIGTERM,
SIGHUP and stdout EPIPE attempt one store withdrawal, with a shared approximately
2-second shutdown budget that cancels and drains pending heartbeats before removal.
Withdrawal failure is reported on stderr and falls back to TTL expiry; a remote
service without the route falls back silently. Timeout/count completion retains
presence and its final renewal for re-arming. SIGKILL cannot be caught and still
relies on TTL expiry. `ab wait` does not
renew or preserve this identity. MCP presence and dashboard display are deferred.

Filing agents check CLI repository status before ready filing. With a live
operator they put intent, rejected alternatives and out-of-scope reasons into
ticket bodies, file, tell the human the existing operator will pick it up, and
stop without a watch. Otherwise they load `ab-operate`. Before registering, an
operator checks for another live operator and reports it rather than registering
unless directed. Explicit human instructions override these defaults. The role
covers the builds the repository's dispatcher dispatches, including new builds;
finishing an initially queued set does not end it.

Agents never receive TicketSource credentials. Only the deterministic file
step creates/adopts approved proposals and commits ledger facts.

### 8.9 The agent tool registry

`packages/core/src/operator/registry.ts` is the agent tool surface: one typed,
closed table of tools — each naming the tool, describing it for a model,
declaring its input schema and MCP annotations, carrying an approval class, and
binding a handler that calls the same operator services the operator API routes
call. It is the single source of truth for the agent-facing operator surface,
and every binding is generated from it; the table never widens beyond the
operator services, and a contract suite proves, tool by tool, that each
handler's result equals the corresponding route's.

The shipped binding is `ab mcp`, a stdio MCP server over the registry: the CLI
remains the primary local interface for agents that have a shell, while the
binding exists so the registry can be exercised end to end from a local
install, for dogfooding, and for local agents that cannot run commands. It
fails closed inside a phase session — repository-wide operator authority cannot
be narrowed to the ambient build — and `--repo` constrains every call to one
repository. Mutating tools attribute their writes to the sessionless operator
identity, exactly as the other operator commands do.

### 8.10 Hosted project connection

`ab connect <service-url>` requests owner browser approval for the normalized
origin, registers the project, and saves a project credential outside the
checkout. `ab connect` reports its status; `ab disconnect` revokes and removes
only that credential, retaining project data. Store precedence is `--store`,
nonblank `AB_STORE`, `[store] url`, then local state. `AB_TOKEN` overrides saved
credentials. Configured services without credentials fail closed. Connection
commands require a network origin and are unavailable in phase sessions.

A valid browser code link opens approval directly, returning there after sign-in
when needed; missing or malformed codes retain entry. Approval always shows the
organization. Assigned projects show a read-only name and cannot move during
approval. Every unassigned approval requires an explicit eligible organization
ID, including fresh, legacy and removed projects, even for super users. A sole
choice is visibly selected; multiple choices require selection; no choices block
approval. Assignment, registration, credential and approval commit atomically
after current access checks. Retained unassigned history remains super-user-only
until assignment. Denial requires no organization and changes no assignment.


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
  resume?(nativeHandle, message, freshOpts): ResumeResult
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
`configuration` failure flagged `missingExecutable` (the runtime's CLI is not
installed) is the one configuration failure that is alternate-eligible; it is
still permanent and never retried. A
legacy plugin may omit `cause`; `permanent: false` remains alternate-eligible
and `permanent: true` remains a stopping failure. A failed `start` still returns
an endable session handle, guaranteeing transcript deposition.

Native session identity is observed through an awaited `onNativeSession` callback
on start and live continue, independently of UI streaming. The kernel appends
`session.native-handle-recorded {session, phase, round?, handle}` before
consuming further native output. Handles are versioned JSON facts containing
adapter kind, native id, execution host, absolute workspace, and optional native
state path; they contain no credentials or transcript. Requested/generated ids
are not proof of a native session. No reported identity means no handle.
The reducer exposes `sessions.nativeHandles` (retained after session end) and
`nativeHandle` on matching open sessions. Legacy logs retain an empty map.

Local git-worktree runners suspend an interrupted agent turn on dispatcher
SIGINT/SIGTERM. A conditional artifact deposit records `session.suspended`
with cause `shutdown`, the native handle, active milliseconds, partial transcript
and any known incremental usage. A terminal fact that lands first prevents
suspension; suspension fences the old session's terminal credentials permanently.
Graceful shutdown waits for provider cleanup and durable suspension without a
wall-clock force-exit deadline. Only after the runner leader exits does bounded
process-group cleanup reap remaining descendants. Abnormal parent loss retains
the detached reaper recovery path.

On attachment the runner retains an eligible current phase/round session and
records takeover. Matching host, workspace and runtime permit native resume;
remote workspaces, missing handles, unsupported runtimes and unavailable native
state produce a reasoned `session.resume-fallback` and fresh execution. Provider
failures retain ordinary retry/alternate policy. Native state is an optimization;
the Store remains authoritative for durable resumption.

A continuation is a new Autobuild bracket with fresh credentials and a new
stream. `session.started.continuation` durably records its predecessor, logical
root, inherited handle, interruption cause and accumulated budget before launch.
This is write-ahead resume intent, not a handshake: the prompt may execute and
its terminal may land before the adapter reports native acceptance through
`session.resumed`. Recovery retries an unaccepted attempt using the inherited
handle; a superseded attempt's late acceptance is marked stale and changes no
lifecycle state. The interruption prompt names pause, shutdown or runner loss and asks
the agent to re-check the worktree and re-run anything in flight. Phase and round
are retained, including uncommitted local work.

The original budget ceiling persists across interruptions. Monotonic elapsed
milliseconds charge each live segment; suspended intervals are excluded. An
abruptly lost segment is conservatively charged from its recorded start to
recovery. Interrupted and continuation transcripts remain separate artifacts;
logical totals sum known segment usage once and preserve every transcript ref.
Unknown crash usage is not fabricated.

Pause immediately cancels a live agent turn and records suspension with cause
`pause`, including remote sessions and sessions without a native handle.
Acknowledgement follows adapter stop and durable suspension (or a winning phase
terminal). Remote and unsupported recovery records a reasoned fresh-session
fallback. No-live-session and check-only steps retain boundary-based pause.
Abort takes precedence. A resume before cancellation prevents interruption;
after cancellation starts the runner finishes suspension, then honors the latest
request. Pause acknowledgement uses compare-and-append so it cannot overwrite
a newer resume. Repository pause settles when all affected live builds settle.

The optional `resume` capability continues native state in a fresh process,
using explicit new execution options and environment. Success returns
`{kind: 'resumed', session, result}` with a normal turn result and an endable
local session. Unsupported capability, wrong adapter/host/workspace, or missing
native state returns `{kind: 'not-resumable', reason, message}` through the
`resumeAgent` compatibility helper. Provider failures remain normal failed
turns. Adapters never replay transcripts or silently start fresh sessions.
This records capability only: pause behavior and §15.6 recovery remain unchanged;
recovery still reclaims open brackets and reruns the phase from its start.

Narrow non-phase judgments do not widen this contract. A runtime may
separately register an optional one-shot completion capability (tool-free,
non-resumable), used for slug naming (§6.3) and vendored-skill conflict
resolution (§16.3). A runtime without it is valid; each caller owns its
deterministic fail-safe.

- **Adapters:** three builtins sit behind the interface: the locally installed
  Claude Code CLI in headless mode for Claude models; the locally installed
  Codex CLI for unqualified `gpt-*` models; and the locally installed pi CLI
  (minimum version 0.84.3), driven headlessly through `--mode rpc`, for every
  provider-qualified model that installation resolves. Each adapter uses its
  CLI's local authenticated login; pi also owns its local model catalog and
  keeps one persistent RPC process alive across review-loop continuations. All
  three provide tool-free one-shot completion. Plugins may register additional
  adapters, each under a *distinct runtime name*, never
  as a mode flag on an existing one. Plugin adapters must pass the exported
  AgentRunner contract suite.
- **Routing — explicit role inheritance (§16.1):** runtime, model, extra CLI
  arguments (`args`), and build-session budget live in one open `[roles]` map whose
  reserved `default` entry is the inheritance base and must explicitly name a
  runtime. The budget inherits independently, then falls back to
  `[policy].sessionBudgetSeconds`; it belongs to the logical role, so provider
  alternates cannot override it.

  **Which key a session selects.** One rule for both kinds of agent step: an
  agent verify step and an agent finalize step each select `[roles.<step>]` by
  their *logical step name*; core phases select `[roles.<phase>]`.

  ```toml
  [verify.acceptance]
  kind = "agent"
  skill = "verify-acceptance" # repository-authored skill

  [roles.acceptance]        # the STEP name — not "verify-acceptance"
  runtime = "pi"
  ```

  The step's configured skill name remains a deprecated alias for existing
  configurations and will be removed in a future release. It is consulted only
  when `[roles.<step>]` is undeclared, so the step name always wins.

  **What is and is not a fallback**, stated separately so the mechanisms are
  not conflated:

  1. Primary field resolution never hunts for a compatible substitute. Every
     concrete role merges runtime, model, and `args` over `default`
     independently; an incompatible merged pair is an eager error. A declared
     `args` list, including `[]`, replaces the inherited list wholesale.
  2. A **requested** role key that no `[roles.<key>]` declares resolves to
     `[roles.default]` wholesale. That is undeclared-key fallback, not outage
     routing.
  3. A role may declare `alternates = [{ runtime?, model?, args? }, …]`.
     The list is independently inherited: a role's own list,
     including `[]`, replaces the default list wholesale. Each entry overlays
     that concrete role's effective primary axes and is resolved and validated
     eagerly with indexed problems in the aggregate startup error.
  4. A **declared** key that nothing ever requests is resolved, validated, and
     then never used. `ab dispatch` reports it at startup as a warning.

  Each `args` string is one argv token, preserved in order and appended to
  every phase and tool-free one-shot invocation for that role. Adapters reject
  only model selection and the machine-readable mode they emit and parse:
  Claude owns `-p`/`--print`, `--output-format`, and `--model`; Codex owns
  `--json` and `--model`/`-m`; Pi owns `--mode` and `--model`. An effective
  primary or alternate list containing one (including `--option=value` or a
  documented compact short alias) joins the aggregate eager startup error.
  Every other option passes through without Autobuild validation, even when it
  changes sandbox, approval, session, tool, skill, thinking, extension, or
  lifecycle behavior or supplements another adapter-emitted option. Pi always
  disables ambient extension discovery and explicitly loads the Autobuild
  bridge; a role can add repeatable `--extension <path>` tokens through `args`,
  and all tools from that explicitly loaded extension are available alongside
  the bridge. With no such args, Pi loads no operator-installed extensions.
  The deprecated `extensions` field remains schema-valid but has no effect and
  produces a startup warning directing the operator to `args`.

  All roles
  resolve **eagerly, before any session launches**, with problems aggregated
  into one error. A missing default diagnostic includes a copyable table and
  every materialized runtime name. Builtin and plugin registrations use the same model-family,
  default-model, session, and optional one-shot capability path; adding a
  runtime touches only the adapter registry, never the kernel. Mixing models
  across roles is intentional — a different reviewer catches more. The
  Within one agent-session attempt, eligible failures try the primary then each
  alternate in order without spending another phase attempt. A runtime whose CLI executable is not installed is skipped the same way;
  credential, permission, and other configuration failures stop the chain. Each target has a
  fresh session bracket. A failed producer continuation may therefore continue
  on a different runtime only by rehydrating durable context, not by inheriting
  the failed conversation. Selection is non-sticky: every later phase, loop
  continuation, and retry starts from the primary. The final failure controls
  retry/permanent behavior. This applies to core phases, agent verify/finalize,
  and Harvest, but not tool-free one-shots. Every selected runtime/model/args
  tuple is recorded on `session.started`; fallback starts cite the preceding target and
  verbatim error, while exhausted `phase.failed`/`harvest.failed` facts carry
  the complete ordered attempt list.
- **Transcripts come back through the interface**, not scraped from disk, so
  every adapter must produce one whenever its owning runner reaches the session
  end boundary, including turns rejected by a provider after a handle exists.
  A runner process that dies before deposition is the explicit exception: a
  takeover records transcriptless reclamation rather than fabricating corpus
  bytes it cannot recover.
- **Session streams (the live view).** While a session runs, its runner
  translates the harness's native output into AI SDK UI Message Stream parts
  (`ai-ui-message-stream/v1`) and appends them to a session stream (§7.6) as
  they happen — the live counterpart of the transcript guarantee above. The
  stream sink is a builtin-runner responsibility expressed as an optional
  `openSessionStream` capability on the runtime registration (beside the
  optional one-shot capability; the frozen `AgentRunner` port is untouched):
  the build-runner creates a store-backed sink per session bracket, opens the
  stream before the session's first turn with label `session:<sessionId>`
  keyed to the Autobuild session id (never a harness-native session, thread,
  or runtime id), appends `session.started` carrying the returned stream id,
  and closes the stream at the session end boundary — before the
  `session.ended` event lands — with outcome `completed` when the final turn
  completed, `aborted` when it failed or was cancelled. A session that ends on
  a substituted runtime keeps the stream opened for its own bracket. The
  harvest runner does the same for its synthesize and review session brackets
  with the identical protocol and part vocabulary: streams are scoped
  `{ kind: 'repo', repo }` instead of build-scoped, `harvest.session.started`
  carries the returned stream id, `phase` is spelled `harvest:<step>`, each
  revise round is its own bracket and its own stream, and a closed stream
  finalizes onto the repository scope. Harvest journal events
  (`harvest.step.*`, `harvest.proposals.submitted`, `harvest.review.verdict`,
  and their kin) are deliberately not translated into parts — they are typed
  journal facts, observable via `ab watch --repository`, not harness output.

  The part vocabulary: the stream's first part is always a `data-ab-session`
  part naming the session id, role, runner, model, phase, and round; each
  turn's prompt (the skill invocation on turn 1, the continuation message on
  later rounds) is a `data-ab-prompt` part before that turn's output; while a
  turn runs the runner emits `start-step`/`finish-step` around each harness
  step, assistant text as `text-start`/`text-delta`/`text-end` at the finest
  granularity the harness exposes (partial-message deltas for Claude Code and
  Pi, whole messages where the harness only reports completed messages),
  reasoning parts when the harness exposes reasoning,
  `tool-input-available` and `tool-output-available` per tool call, and
  `finish` on completed turns. A turn that ends in a provider or runtime
  failure emits an `error` part before the stream closes; a turn cancelled by
  the caller emits an `abort` part. Text, reasoning, prompt, and tool
  payloads serialized above 65,536 UTF-8 bytes are truncated on a UTF-8
  boundary and followed by a `data-ab-truncation` part naming the omitted
  byte count. Parts reach the store within one second of the harness emitting
  them under normal conditions: the runner batches appends on a short cadence
  rather than one request per delta.

  Streams are presentation, never routing: no kernel, engine, reducer, or
  dispatcher decision reads stream content or presence, and the phase outcome
  still travels only the typed CLI. A failing stream path never fails a turn:
  an append error retries on the next batch, a writer that keeps failing
  stops streaming the session, closes the stream `aborted` when it can,
  reports once on the build runner's diagnostics, and the phase proceeds
  exactly as it would without streams; the transcript artifact is deposited
  regardless. A plugin runtime that declares no capability yields sessions
  with no stream, and every consumer treats those sessions exactly as before;
  tool-free one-shot completions produce no stream. A closed session's
  finalized document is the `stream:<id>` artifact (§7.6).
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
- **Round ceiling:** `policy.maxReviewRounds` is the default absolute cap for
  each loop. Once its `review-round-limit` escalation is open, a human may
  answer it with an optional positive `reviewRoundCeiling`. That value replaces
  the configured cap for only the escalation's plan or code loop and current
  spec revision. It is absolute, durable, and cleared by `spec.revised`; the
  stall check retains precedence.

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
`$AB_CONTEXT_DIR/guidance.json`. The citation remains the durable carrier across any crash
before launch; only a later `session.started` with the same phase and attempt
consumes it. Producer guidance uses the same phase-and-round launch boundary. A
bare retry reruns the step without guidance. The intentionally different policy
escalation after an exhausted failed verify report feeds `implement`, where its
guidance outranks
the pending report.

Answering with `--revise-spec-from-ticket` also re-pins the build's ticket assets
(§6.3): the sampled set rides on the answer and on `spec.revised`. A supplied
body file changes the spec only.

Only an operator answering an open `review-round-limit` policy escalation may
set `escalation.answered.reviewRoundCeiling`. The same event both clears the
external judgment gate and replaces the cap; no standalone or pre-emptive form exists. A
ceiling cannot accompany a spec revision because `spec.revised` resets both
loops to the configured default. The value is attached only to the matching
review-limit answer, so unrelated blockers answered in the same command do not
acquire it and build-phase agents cannot widen their own build's loop.

Every open escalation remains an external judgment gate until an operator answers
it. The answer may come from the operator agent or a human; build-phase agents
cannot answer their own escalations. This includes all policy and setup causes;
human authorization requirements still apply. Starting either `ab dispatch` or
`ab dispatch --once` never appends `escalation.answered` and never re-arms a
budget. Startup still recovers every actionable current build and delivers
pending operator commands, whose decisions take precedence over a blocked wait;
an otherwise blocked build is reported as parked and left unchanged.

Crash-gap and exhaustion deduplication is exact to the escalation's source/class,
target, and any durable scope that distinguishes policy conditions. Every new
policy-authored `escalation.raised` names a closed `policyCause`; `round` scopes
the occurrence but does not identify the policy class. A triggering event is
considered acknowledged only by a later raise matching those dimensions;
another cause, target, or required scope cannot suppress it. The triggering
event's sequence is the boundary, so newer qualifying failure, verdict, or
conflict evidence re-arms that exact condition after an answer.

Occurrence scope and phase-runner failure-budget reset scope are separate.
Answering `phase-attempt-limit` or `non-retryable-phase-failure` re-arms only
the matching phase and `round`; a missing round cannot broaden either cause.
`review-round-limit` retains the same matching-round effect.
`verify-failure-limit` is the explicit phase-level case and re-arms every
phase-runner failure round for its verify target. `reconcile-no-progress` and
`setup-failure-limit` have no phase-runner failure-budget effect (setup's own
answer/retry accounting remains separate). Agent and stall raises, and
cause-less historical policy raises, retain the legacy shape rule: a matching
round resets that round and an absent round resets all rounds for the target.
The closed `policyCause` union has an exhaustive reset-scope mapping, so adding
a policy cause requires choosing matching-round, all-round, or no-reset
semantics rather than acquiring behavior by omitting `round`.

Reconcile has two distinct policy scopes. Runner retry exhaustion and
non-retryable failures at progress-check or base-refresh boundaries are scoped
to a concrete reconcile `round`. Unchanged-base no-progress exhaustion is
scoped to the current conflict, omits `round`, and has `policyCause =
"reconcile-no-progress"`. Only a later open or answered raise with that cause
acknowledges the no-progress guard; an explicitly different cause does not,
even if it is also roundless. Cause-less historical roundless
`policy`/`reconcile` raises retain their former no-progress meaning on replay,
without migration. Routing uses these typed event fields and never parses the
human-facing `question`.

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
  closed-unmerged PRs must still merge where the next tick will not reclaim
  them — a bounce filed into Ready is claimed and bounced again forever.

## 13. Ticket source policy

**Hosted tickets are project-scoped.** A project credential selects one registered
repository; an owner selects a registered repository explicitly. Team and state
fields from clients convey no authority or lifecycle policy. Tickets, comments,
blockers, creation-key deduplication and assets are isolated by repository.
Independent project ticket policy supplies hosted lifecycle names: triage, ready,
doing, done (`doneState`), and create/proposal equal to triage by default. Hosted
readyState defaults to ready; other sources require it. Legacy clients without
independent policy use uploaded dispatcher config and its old defaults. Configured roles may overlap.
The service has no Linear backend and never relays external ticket sources.
Projects using Linear, files or plugins keep their direct dispatcher connection;
service ticket surfaces refuse with project/source feedback instead of empty data.


The TicketSource **initiates and receives projections; it is never consulted
mid-build and never used as artifact storage.** Dispatch reads the ticket
(including the spec) as part of initiation — at claim time, or on a later tick
while an interrupted dispatch still lacks its imported spec. After import, the
build never reads the tracker again. Human-legibility projections (spec
posted as a comment, final summary, status transitions) flow outward only.
This keeps the abstraction honest: a file-based TicketSource with nowhere to
put blobs must be fully workable.

**Ticket assets follow the same rule.** The contents of a ticket asset (§7.1)
live in the ticket service for hosted tickets, independently of build storage;
file sources keep portable bundles and source-local history, while sources without
native assets keep them in the BuildStore. Attaching,
replacing, or removing an asset instead leaves a note on the ticket through the
existing `comment()` port — the outward projection every source, including the
plugin surface, already supports. The note names the asset, its revision, file
count, and size, and gives the `ab ticket asset get` command that fetches it, so
a person reading the ticket in Linear, the hosted service, or a local file knows
the asset exists. The note is a projection outward only; nothing reads it back,
and existing sources and plugins need no asset capability.

**Claim lifecycle.** Claim acquires nonterminal work: it returns `true` and
moves a claimable ticket to the source's claimed state. It returns `false` for
an unknown ticket, an already-claimed or contested ticket, and a ticket that
the source considers terminal. Refusing a terminal ticket performs no state
transition and never implicitly reopens completed work. An explicit transition
back to a nonterminal state makes a later claim possible again.

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

In repositories with integration nodes, a blocker that has a build resolves only
when its change identity is present in the dependent's sampled target head
(the configured root branch when no target is set). Source completion or an
aggregate source blocker flag cannot substitute for presence. Confirmed merge
SHAs prove identity through Git reachability even without a build trailer;
confirmed node merges transport their frozen whole contribution, including
node-owned foreign changes and nested contributions. Inherited parent history
is excluded. An empty completed node contributes nothing; missing or ambiguous
completion evidence does not mean empty. The newest build generation is used,
with ties diagnosed rather than falling back to older successful work.

Demand-driven restacking supplies ancestor changes to descendants. Sibling changes
wait for their node to merge in the common ancestor and presence demand into the target;
descendant changes wait for their node to merge into the target ancestor. Same-node
merges satisfy presence directly. Unknown evidence leaves source work queued,
with diagnostics naming the blocker and destination. Blockers with no build,
and repositories without nodes, retain source done-state resolution. Presence
is checked only at claim, with the sampled destination revalidated before claim;
later movement never interrupts an existing build.

**Crash-safe filing.** Creation supports a state override (harvest targets
Triage explicitly) and an idempotency key that must adopt the same ticket on
retry across process restarts. Ticket projections may carry this stable
external creation key separately from their source-facing identifier; adapters
that support idempotent creation preserve it through create, adoption, get, and
ready listing. The reservation fact precedes the external side effect — that
ordering, not provider behavior, is what makes filing crash-safe. Dispatch
uses the key only to withhold unfinished Autobuild creates; its absence fails
open for legacy/plugin tickets and introduces no new readiness gate.

### 13.1 Node tickets and targets

Tickets have `kind = "work"` by default, or `kind = "node"` for a named
integration point. The optional `target` is a node ticket id in the same source;
omission means the configured `baseBranch` root. Nodes may target other nodes.
A ready node ticket opens an integration build on `ab-node/<slug>`, cut
from its parent's sampled head. Opening intent and acknowledgement are durable;
the branch is open to targeting tickets immediately, without a PR. Idle integration
builds use no provisioned workspace, runner, execution lease, or dispatch capacity.

A node requesting reconcile or verification is admitted before new ticket
claims. Its candidate occupancy excludes itself and capacity-bearing blocked or
paused descendants, following accepted source-qualified build target ancestry.
Running descendants and unrelated builds still count; ordinary blocked and
paused work retains its slot for every other admission. Provisioning reserves
node occupancy before the runner starts. This exception never raises the budget
for new claims. Status and both dashboards report actual occupancy, configured
capacity, effective display capacity and the nodes using descendant-held slots.
Idle collecting nodes remain free.

An empty node has no PR and reports `integration`, `target`, and `empty`.
Once it holds commits its current parent lacks, the dispatcher opens or adopts
its PR. No placeholder commit is created; parent-only advancement is still empty.

Claims targeting an open node freeze its build identity and branch as their base.
Their PR, merge and reconcile all use that frozen base, even after source
metadata changes. Missing, unopened, merged, closed or aborted targets remain
queued with a diagnostic. The newest generation wins; a closed generation never
falls back to an older open one. Blockers remain a separate graph.

A node is complete when exhaustive native ticket enumeration finds no unresolved
ticket targeting it, no unsettled frozen child claim remains, and a merged
contribution is durably known. Triage, backlog and ready children keep it open;
done and cancelled children do not. Listing diagnostics fail closed. Completeness
is sampled again before verification and publication. Source edits cannot be
transactional with a forge write.

The kernel verifies the exact node head and sampled parent with all configured
verify steps and normal path applicability. A moved head or parent invalidates
eligibility, including a clean restack. Failure blocks the node; file a repair
child targeting it. Repair children remain admissible, and their merged head
supersedes the failed cycle. Reports retain their actual head/base citations.

Merge follows ordered `[[merge]]` rules (§15.7), defaulting to node consent.
Auto mode authorizes complete, verified nodes; consent mode waits for `ab merge`.
Merge refuses incomplete nodes and names open children; `ab hold` remains available.
Node parents and local-git roots receive guarded fast-forwards, preserving one
commit and identity trailer per contributing build. GitHub shared roots use the
PR rebase endpoint guarded on verified head, after a final parent freshness read.
Authoritative enforced up-to-date protection records fenced merge; uncertainty
records unfenced merge and triggers immutable merged-tree comparison. A mismatch
raises operator attention and never rewrites the shared parent.
The repository build digest carries an additive optional pending-audit signal from
`integration.landed` with an operation until `integration.audited` settles it.
Settled nodes without that signal require no full build reads; completion does
not suppress retries for an outstanding audit. Pending audits
survive completion. Merge gates are never bypassed; unsupported transports defer.

Human forge merges are an explicit escape hatch, even while incomplete, paused
or unverified. The janitor records human provenance and whether the actual merged
head had a successful cycle, then completes the node ticket.
Closing without merge or aborting closes admission and returns the ticket to
triage; children already claimed retain their frozen base. Nested nodes work.
A forge plugin needs node branch creation, comparison and
head-read capabilities to admit node tickets.

**Changing a node's parent.** Updating an open node ticket's target moves it to
another open node generation, or to the configured root when cleared. The node
branch replays only its contribution above the last completed boundary onto the
new parent. Former-parent-only history is excluded; owned foreign changes and
source build identities survive. Existing review identity is retained and its PR
base changes after branch publication. Empty and same-head moves need no new
commit or PR. Descendants keep targeting the moved node and follow its head
through independent demand-driven restacks, including source-aware conflict reconciliation.

A supported ticket mutation records `node.parent-requested` before the provider
write under node writer authority. The dispatcher reads back the source and
records `node.parent-accepted` with old/new target, branch, destination build
generation and observed ticket revision. Only acceptance changes the effective
node ancestry; `build.created` and `node.opening` remain historical provenance.
Replay completion, `node.parent-pr-retargeted`, and `node.parent-completed`
acknowledge independent effects. Pending requests and accepted moves fence
verification and merge, and keep both old and new parents incomplete. Leases
alone do not represent outstanding work. Recovery rereads ambiguous writes,
cancels unconfirmed requests, resumes frozen replay, and retries PR retargeting
without replaying unrelated ticket edits. Later edits wait for the reserved
operation to settle. Native auto-merge is cancelled before changing the base.
Accepted node re-parenting revokes prior merge consent through the recorded
`node.parent-accepted` fact. Holds survive. Readiness evaluates merge policy
against the new effective parent before another merge can proceed.

Parent identity changes invalidate eligibility even at identical SHAs; historical
verification evidence remains immutable.

Self/ancestor cycles (including pending effective ancestry), unopened or terminal
destination generations, merging/closing sources and unsupported forge retargeting
are refused with a reason. Busy writer reservations defer external changes and
refuse synchronous mutations. Direct provider edits receive durable, revision-
deduplicated `node.parent-rejected` diagnostics when invalid, preserving effective
ancestry. Restoring the effective target records `node.parent-rejection-cleared`,
removing the current refusal while retaining its historical fact. Rejection deduplication
compares revision, target and reason independently of persistence key order.
Missing source reads withhold parent acceptance; ordinary cascade and PR handling
continue against durable effective ancestry. Accepted moves finish their reserved
Git and PR effects independently of tracker availability. A PR merged or closed
by a human follows ordinary terminal handling. Changing a claimed work ticket's target is
refused before any combined patch is written: abort and re-dispatch is the
supported path. Unclaimed tickets retain ordinary target editing.

**Demand-driven restacking and node writers.** Nodes observe parent movement durably but restack only on demand: before a
complete nonempty node verifies; before merge if its parent moved; when queued
dependency presence requires an ancestor change; on `ab restack <node>`; or on
accepted re-parenting. There is no eager mode or cadence option. Nested nodes
need their own demand. Existing frozen transactions, including ones reserved
before upgrade, finish first; later demand coalesces onto the latest parent.
Leaves keep verify-entry and awaiting-merge restacks for every target.

Presence demand uses change identities, never ticket resolution alone. It follows
only the path from the nearest proven ancestor source down to the dependent's
actual destination, processing ancestors first. Unrelated siblings stay idle;
changes absent from all ancestors cannot trigger a speculative replay. Tickets
remain queued until presence is observed in their destination.

`ab restack <node>` (operator tool `builds.restack`, input `{repo, slug}`) records
a durable request, coalescing pending demand. It refuses leaves, terminal nodes,
and unopened nodes. Paused or blocked nodes wait for their normal safety gates.
A request arriving during replay survives until its parent and required identities
are covered. Re-parenting invalidates requests for the old destination.

Both dashboards use `+N` beside the destination for commits it has that the
build lacks, no suffix when current, and `+?` when unknown. Merged and closed
builds omit the suffix. Terminal list rows put `→ destination +N` on the slug
line; work steps follow immediately and integration progress keeps only the
bar and child counts. Detail target/Parent fields use the same suffix. Distance counts commits reachable from the observed
parent but not the last confirmed contribution base; it is not elapsed time or
poll count. Samples are invalidated by replay or re-parenting. A stale node
cannot verify or merge; inventory and child merges continue while it collects.

Node branches have one writer at a time. A distinct mutable node writer lease
(serialized independently of runner execution leases) guards both restacks and
controlled child merges. A revision-checked `node.writer-reserved` fact freezes
the operation, original expected head, parent snapshot, previous contribution
boundary, immutable archives, ordered changes, and merge proofs. Expiry permits
recovery of that reservation, never an incompatible operation. Each change has
prepared, conflicted, or replayed receipts. Resolved objects are retained in the
BuildStore before their receipts. `node.publish-intended`, `node.rewritten`, and
`node.writer-settled` distinguish intent, proven effect, and completion. The forge
is authoritative: exact intended-head readback confirms publication, while local
refs are caches refreshed without CAS. An unconfirmed descendant is contention;
a durable confirmed receipt can preserve a historical write. Exact
expected-head replacement and immutable archive refs preserve displaced history;
contention retains the previous contribution boundary and retries the complete
observed contribution. An untagged commit, including an empty commit, is foreign.
`node.inventory` retains the sampled source boundary without promoting the confirmed
restack base. It reports reachable build identities separately from node-owned
foreign commits above the durable boundary; inherited foreign history is excluded
from the owned count.

Only a conflicted replay item attaches the integration build's reconcile runner.
Its context names the integration owner separately from the original source
build and supplies that source's pinned spec, approved plan and implement-notes.
Missing source artifacts or invalid identities escalate. Foreign conflicts supply
commit metadata and a diff, with escalation when intent is unclear. Completion
validates exactly one commit on that item's replay base, retaining its original
identity or foreign status. The agent never publishes the stack; the dispatcher
resumes only after session and execution settlement. Automatic merge policy
remains outside this grammar.

**Foreign merge safety for node replay.** A node contribution is enumerated
oldest first along first-parent history above its durable previous contribution
base (initially the opening SHA). Parent movement never makes inherited foreign
commits into node-owned contributions. The boundary advances only on confirmed
restack completion.

Before replaying any contribution or publishing a replacement, preflight every
merge against the frozen new parent's full reachable build identity set. For
each merge, inspect the union reachable from every non-first parent but not the
first parent, including nested side history. Flattening is allowed only when
the merge itself has no terminal `Autobuild-Build` trailer and every side-history
identity is already reachable through the sampled parent, regardless of commit
SHA. The safe merge becomes one linear foreign change carrying its first-parent
delta, including merge-resolution content and an empty result when necessary;
its side identities remain inherited from the parent.

A merge carrying its own identity is anomalous: the kernel never creates merges,
and legacy reconcile merges were squashed at merge. It is refused regardless
of side-history safety. Never strip, move or reinterpret its identity trailer.
An absent upstream side identity, ambiguous or malformed identity, or an
identity-bearing merge refuses the entire restack before replay or publication.
Leave the public node branch untouched and escalate on the integration build,
naming each offending merge and its missing or own build identities. The kernel
never preserves merge topology or automatically decomposes a foreign merge.
Refusal never promotes the contribution boundary; an authorized later retry
samples the parent anew and repeats the proof.

Use `ab ticket create "Integration" --body spec.md --kind node`, then
`ab ticket update <id> --target <node-id>`. Clear a target with `--no-target`;
reset kind with `--kind work`. Omitted fields preserve existing values.
`ab ticket show <id> [--json]` exposes both fields; `ab ticket tree [--json]`
shows the configured root and every ticket, including completed work and empty
nodes, nested by target with state. Siblings are sorted by id. Invalid external
graphs and listing diagnostics are reported explicitly.

Targets must exist and be nodes in the configured source. Self-targeting,
ancestor cycles and demoting a node with targeting tickets are refused before
any part of the requested update is written, regardless of ticket state.
Clear or reparent its children before demotion. File frontmatter persists the
fields; `ab ticket edit` displays them read-only. Change them through update.
Kind and target participate in content revisions and revision-checked writes.
File writes retain their existing best-effort, unlocked concurrency semantics.

Linear uses the exact `node` issue label for kind and the parent relation for
target, only when the parent carries that label. Ordinary grouping parents do
not impose targets and survive unrelated updates. Explicit target clear clears
the parent relation. Label replacements can demote nodes and receive the same
guards; explicit kind and label instructions must agree about `node`. Label
and parent connections are fully paginated. Linear still refuses guarded writes.

Hosted sources support kind and target with project-scoped transactional validation.
Existing tickets default to work with no target. Metadata changes increment the
revision once; equivalent aliases and unchanged values do not. Node demotion
checks all targeting tickets, including completed work. Legacy plugins without
integrationTree support read as work with no target and refuse metadata writes.



## 14. Operator UI

The UI layer is defined by the seam, not any implementation: **subscribe to
events, render, send commands** — commands being events appended to the
applicable build or repository log (§15.2.7). The event vocabulary *is* the
UI API; forge mutation remains kernel/dispatcher plumbing. Anything a UI
displays is a reduction of the logs, and anything it does is an event — so
every frontend (terminal today, web later) is the same adapter pattern
against the same store, and a dead runner still receives commands on resume.

Within the immutable generation, interactive `ab dispatch` owns the terminal in a frontend process and supervises
one private child containing the dispatcher, build runners, Harvest, config and
plugin loading, and every ticket/forge/workspace/runtime adapter. The frontend
has no handle on those adapters: it reads build and repository streams plus
referenced artifacts, writes operator commands, and keeps only presentation
state (selection, scroll, composer text, confirmation) in memory. The child
publishes a run-correlated effective-config artifact before its first tick and
records tick/queue diagnostics, reload outcomes, runner coordination, and
normal/abnormal lifecycle as repository facts. Thus a rejected on-disk reload
cannot change the displayed effective capacity, and a frontend restart can
reconstruct every operational notice from the Store. Observation pressure is a
separate display-only reduction: the interactive frontend scans the shared
BuildStore directly, pairs the current unclaimed count with the effective
config's `policy.harvestThreshold`, and retains the last successful count while
showing a refresh diagnostic after a failed read. It appends no event and does
not use `dispatcher.tick-completed` to transport the sample; the headless child
therefore runs ticks without a dashboard, terminal, or frontend connection.
Before the first successful sample the frontend renders only the diagnostic,
never a fabricated zero. Non-interactive dispatch performs no frontend-only
sampling. Repository polling advances from the last observed sequence rather
than replaying the growing journal on every frame. SIGINT, SIGHUP, SIGQUIT, and
SIGTERM restore terminal modes immediately and ask the child to stop; repeated
signals remain graceful while a dispatcher tick is crossing the ticket-claim
boundary. The frontend reaps the child before finishing, and for SIGHUP,
SIGQUIT, or SIGTERM only then restores the default disposition by re-signalling
itself. A child also stops when its terminal-owning parent dies. A timed-out
child is terminated unless such a tick is open, in which case that tick first
reaches a recoverable durable boundary. The run-stopped fact and frontend result
distinguish a graceful drain, an actual forced termination requested by the
operator, and an unsolicited abnormal exit, retaining available exit-code,
signal, and error evidence. Resident `--plain` and non-TTY generations run
the line-oriented kernel directly. `--once` bypasses the launcher, performs
one tick and drains its in-flight work. The launcher forwards stop signals and
waits for the generation to drain before returning.

Interactive watch presentation enables xterm focus reporting (mode 1004) only
while it owns terminal input. Local-store reads keep the same cadence regardless
of focus. Network stores (remote HTTP and Postgres) use 5-second polling while
unfocused, including session feeds and automatic session recovery. Focus-in
refreshes immediately. Terminals that send no reports remain focused. Every operator key requests an immediate refresh
unless one is already running and holds the 500 ms cadence for at least 30
seconds while focused (or on a local store). Otherwise retained nonterminal
builds (including abort cleanup) use 500 ms polling and an empty dashboard uses 5 seconds. Cached elapsed counters
may repaint without reads. Focus never pauses the dispatcher kernel. Job-control
suspension restores owned terminal modes and raw input before stopping; resume
reenables them, assumes focus, and refreshes immediately. Teardown disables focus
reporting even when no frame painted, with synchronous process restoration for
catchable faults. Plain, non-TTY, and once runs never enable focus reporting.

Interactive frames first read `BuildStore.getRepoChangePosition(repo)`, a canonical
unsigned decimal string used only for invalidation. Unknown repositories return
`"0"` without creating state. Each repository's durable position advances in the
same transaction as build creation, build/repository event insertion (including
artifact-backed and tick writes), or a stored dispatcher lease holder transition.
Other repositories, failed writes, denied claims, same-holder renewals, heartbeats,
and passive expiry do not advance it. It is separate from journal sequence cursors.
Unchanged positions reuse the complete presentation snapshot; an ordinary refresh, focused or unfocused,
then makes exactly one store request. Discovery uses required exact-repo
`listBuildsForRepo(repo)`, never a global listing. Initial hydration, position or
configuration changes, and at most ten seconds between full reads refresh the
snapshot, including mutable lease/stream/artifact/ticket enrichment. Failed or
cancelled reads do not acknowledge the sampled position. Open session feeds poll
independently; kernel ticks and watch/wait retain their existing reads.

SQLite installs an additive counter table and transactional triggers on open.
PostgreSQL installs the corresponding additive table/functions/triggers through
explicit migration before deploying the new service; the core schema version
and checksum stay unchanged. Existing data starts at zero, with no replay or
backfill, and migration reruns preserve counters. Hosted reads use one GET
`/repos/:repo/change-position` returning only `{ position: string }`, and
`/repos/:repo/builds` returns scoped build records. Both routes authorize the
repository before reading and support repositories with builds but no journal.

Durable operator settings (intake, repository pause, harvest gate) survive
restarts through the repository journal. Per-merge hold and merge commands
live in the build log. Merge policy is declarative dispatcher configuration
(§15.7); there is no writable repository auto-merge default.

The **operator sandbox** is the third execution kind beside build and harvest
executions: a persistent, credential-free, per-session-owner-per-repository
environment behind registry tools (`sandbox.*`, AUT-340), provisioned like a
build workspace and exposed to operator agents only through those tools. The
typed tools are the only route to state from inside it — the environment
receives no store, forge, ticket-provider, or model credential, and
`[orchestrator].sandbox.environmentVariables` may never name one. Its lifecycle
is repository-journal fact: provisioned/resumed/activity/stopped/released facts
bracket one deterministic environment per session owner × repository, the
 dispatcher tick's idle settlement stops an environment whose evidence is
stale (settling an orphan exactly as harvest executions are settled), and
`ab repository status` reports each session owner's sandbox. A session owner's work
leaves the sandbox only through `sandbox.publish`, which takes the checkout's
head (or an explicit commit) to a deterministic operator branch and a pull
request against the base branch and records published/publish-failed journal
facts.

Successful dispatcher ticks with no effects, counters, diagnostics, queue change,
or attention transition append no tick boundary events. The first queue baseline,
failed ticks, meaningful ticks, diagnostic clearing, failure recovery, and the
first retry after a source cooldown remain recorded. Recorded starts may arrive
with completion; optional `startedAt` preserves the actual start time, falling
back to envelope time for historical journals.

Repository tick telemetry is bounded mutable operational metadata, like leases.
`beginRepoTick` persists the open boundary before unsafe work; `finishRepoTick`
atomically replaces it with actual completion time and outcome and appends any
validated tick boundaries. Both are fenced by the unexpired repository lease,
and neither renews it. Quiet completions advance telemetry without advancing the
journal. Readers refresh telemetry independently of event cursors, correlate it
by run, and merge with historical completions by actual time; heartbeat never
stands in for tick completion. Telemetry survives lease release. Safe shutdown
uses the matching run's open observation, historical journal boundaries when
absent, and refuses forced termination when the observation cannot be read.

Both dashboards show each accepted unfinished generation handoff, naming its source
and target runtimes (version and abbreviated commit), mode and drain deadline
(`unknown` for missing historical facts). A drain-mode outstanding execution
adds `(draining)` to its build without replacing lifecycle status. Matching
settlement clears the marker; accepted completion clears the banner. Takeover,
an expired deadline and an empty outstanding set do not clear the banner.

The operator's job across many concurrent builds: see status at a glance,
act on a selected build, find blocked builds, answer escalations, and inspect
any build's trail. Each dashboard build row spends its header on identity and
lifecycle status, with the pipeline and its per-step elapsed values below it;
controls and diagnostic lines expose actions, pending dispatch, abort cleanup,
setup failures, and blockers. Dashboard rows derive from build and repository events and
effective configuration only, so heartbeat or lease renewal without an event
does not alter them. Every nonterminal build, including `queued`, has a
dashboard row; a pre-run row names its pending dispatch boundary or latest
durable failure. A human may discard only such a queued build. Discard is
dispatcher cleanup, returns the ticket to its
configured Ready state, and completes with
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
`packages/core/src/events/payloads.ts`, repository workflow and control payloads in
`packages/core/src/events/repository.ts`. Every adapter validates before append. The
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
  "compatibility": { "writerVersion": "1.0.0-beta.1", "classification": "decisive" },
  "type": "code-review.verdict",
  "payload": { /* per-type, frozen in packages/core/src/events/ */ }
}
```

`actor.kind ∈ kernel | agent | human | dispatcher | ingester`. Agents carry
`role` and `session`; humans carry `user`. The store assigns `seq` and `ts`
so producers can't fake ordering. Repository-journal events use the same
shape with `repo` in place of `build` and their own per-repository sequence,
validated by the separate repository catalog so build reducers cannot
accidentally interpret repository state.

A human actor may carry an optional `via` marker for delegated writes —
`{kind: "session", id}` (the human account's operator-agent session) or
`{kind: "mcp", client}` (an MCP client) — so a team's audit trail can
distinguish "the human did this" from "the human’s delegated session
did this" or "an MCP client did this" forever. `via` is valid only on human
actors and only on build and repository events (session events are the
delegate's own log); validation rejects it anywhere else. The hosted service
stamps `via` from the authorizing token and rejects a write claiming a `via`
the token does not carry; events without it replay unchanged. Over a
transport with token authority (the hosted HTTP store) that rejection is an
authority failure — 403 `auth` (`AuthError` on the remote client), applied
after token verification and before catalog validation, so "not your
delegate" (403) stays distinguishable from "malformed event" (422
`validation`). A token without a `via` claim may not write delegated events
at all: any human write claiming a `via`, valid or malformed, rejects the
same way. Local adapters and the open (no-secret) remote server have no
token authority; there the backing catalog is the only `via` gate and every
rejection is `EventValidationError`.

### 15.2 Conventions

1. **Closed vocabularies live in type names; open ones live in payloads.**
   Phases are a closed set → `plan.completed`. Verify and finalize steps are
   config-defined (open) → `verify.completed {step: "acceptance"}`.
2. **Events carry facts, never derived state.** Build status is a reduction
   (§15.5); no event ever says "status is now X".
3. **Blobs live in artifacts; events carry refs** `{kind, rev}`.
4. **[D3] Code travels through the Forge, never the store.**
   `implement.completed` pushes the branch; events carry commit SHAs only.
   This is what makes cross-sandbox resume work (§15.6-C) and keeps the
   store lean. SHAs are momentary evidence, not change identity: a forge
   or future history rewrite can mint a new object id for the same change.
   The immutable build slug in the merged commit's terminal Git trailer
   `Autobuild-Build: <slug>` identifies the build's change across such rewrites
   (RFC 0001 §5). Branch presence is determined by exact parsed trailer values
   in reachable history, not recorded SHA ancestry. Kernel-owned single-change
   replay, durable rewrite facts and immutable forge archive refs preserve
   historical SHAs (§15.7); the original no-rebase rationale does not prohibit
   this archived replay standard.
5. **Append-only; corrections are new events.**
6. **Liveness is not history.** Heartbeats and runner leases are mutable
   columns on the `builds` table, never events — they would drown the log.
7. **[D2] Operator commands are events in the same log.** Operators (agents or humans) append
   `*-requested`/`*-cancelled` events (including queued-only discard), `escalation.answered`, and dispatcher
   setting facts; kernel or dispatcher plumbing acknowledges effects that
   require a boundary. The store is the *only* coordination surface — no side
   channel — and polling covers commands exactly the way it covers
   `subscribe`. A runner that is dead still receives pause/resume/abort
   commands and escalation answers on resume. While a turn is live, the runner
   subscribes from its session boundary and forwards pause or abort as caller-owned
   cancellation to the AgentRunner; it closes the session transcript without
   recording `phase.failed`, records suspension for pause, and acknowledges the
   current control. The supervising execution
   retains the lease until the build's complete process tree has been reaped.

### 15.3 Catalog

Authoritative in code (`packages/core/src/events/payloads.ts`,
`packages/core/src/events/repository.ts`, and the session catalog in
`packages/core/src/events/sessions.ts` — the third catalog, validated
separately like the repository journal's). The build and repository families,
with illustrative members:

| Family | Examples |
|---|---|
| Build lifecycle | `build.created` (carrying `assets`, the claim-time pin, §6.3), `workspace.provisioned`, `workspace.released`, `execution.started`, `execution.ended`, `infrastructure.failed`, `infrastructure.cleanup-attempted`, `dispatch.comment-posted`, `dispatch.failed`, `runner.attached`, `runner.runtime-recorded`, `runner.setup-failed`, `abort.remote-branch-deleted`, `abort.local-branch-deleted`, `abort.ticket-returned`, `build.completed` |
| Operator commands [D2] | `build.pause-requested` → `build.paused`; `build.discard-requested`; `build.hold-requested`; `build.land-requested` → `landing.command-acknowledged`; `escalation.answered` (optionally carrying a validated `reviewRoundCeiling`, or the `assets` sampled with a revise-from-ticket authorization) |
| Merge policy | `landing.decided` (candidate, matched rule/default, labels, target, mode); `landing.native-enable-started`; `landing.native-applied` |
| Spec | `spec.imported`, `spec.authored`, `spec.revised` (either positive `escalation` sequence or exclusive `operator: {user, via?}` provenance for an idle node; optionally carrying `assets`, a re-pin of the ticket's assets, §6.3) |
| Sessions | `session.started` (including optional write-ahead continuation intent and budget ceiling); `session.suspended` with partial transcript and active duration; `session.resumed` acceptance (stale reports are inert); reasoned `session.resume-fallback`; kernel-only `session.native-handle-recorded` with bracket and native execution identity; `session.ended` with transcript ref and usage (ordinary completion — the analysis corpus), or `session.ended {outcome: reclaimed, reclaimedBy: {instance, resumedFromSeq}}` (explicit transcriptless takeover) |
| Plan/code loops | `plan.started` … `plan-review.verdict`; `implement.started` … `code-review.verdict` |
| Verify/finalize | `verify.started {step, attempt, feedback?, baseSha?, headSha?, restackId?}`, `verify.completed {step, outcome, skipCause?, baseSha?, headSha?, restackId?}`, `verify.cancelled {step, attempt, cause: {step}, baseSha?, headSha?, restackId?}`, `verify.stage-failed {attempt, cycle, stage, failed, cancelled, baseSha?, headSha?, restackId?}`, `verify.reconcile-policy-captured {reconcileSeq, steps}`, `finalize.completed {pr}`, `finalize.step-started {step}`, `finalize.step-completed {step, ok, headSha?}` |
| Integration attention | Kernel/dispatcher `integration.verification-failed {id, head, parent, steps, guidance}`: one durable failed-cycle notification, recovered from exact verification receipts |
| PR summary | Kernel-authored `pr-summary.requested {occurrence, boundary}`, `pr-summary.attempted {occurrence, boundary, pr}`, `pr-summary.result {attempt, outcome, eligibleAfter?}`, `pr-summary.settled {request, disposition}`; sequence identities correlate durable starts, completed boundaries, attempts, and handoffs (§7.5) |
| PR attachments | `pr-attachment.designated`, `pr-attachment.hosted`, `pr-attachment.reclaimed`, `pr-attachment.reclaim-failed` |
| Leaf restacking | `target.moved {branch, sha}`, advisory `target.distance {branch, sha, head, count}`, `restack.prepared`, `restack.replayed`, `restack.publish-intended`, `restack.rewritten`, `restack.contended`, `restack.completed` |
| Post-PR [D1] | `pr.merged`, `pr.conflicted`, `reconcile.progress-checked`, `reconcile.started`, `reconcile.prepared`, `reconcile.replayed`, `reconcile.publish-intended`, `reconcile.rewritten`, `reconcile.contended`, `reconcile.completed` |
| Cross-cutting | `observation.recorded`, `escalation.raised`, `phase.failed`, `session.build-read-failed`, `phase.deferred`, `phase.deferral-escalated` |
| Repository journal | dispatcher setting facts; run lifecycle, effective config, tick/queue diagnostics, reload and runner outcomes; the `harvest.*` workflow, recovery, and ledger facts |

Abort cleanup is a dispatcher-owned ordered saga. While an execution lease is
live, the janitor defers the saga so it cannot race process-tree teardown. Once
that supervisor releases the lease, or an abruptly orphaned lease expires, cleanup
closes an open unmerged PR without overriding a racing merge, releases the workspace,
deletes the exact published remote branch and exact local branch, unions the
`autobuild:aborted` label into the current ticket labels, posts an abort notice, and returns the ticket to
configured Triage, and only then completes as `abandoned`. External effects are
idempotent and the three `abort.*` facts checkpoint projections across crashes;
missing Forge capabilities or outages leave the remainder due on the next tick.

One deliberate subtlety worth recording: `pr.conflicted.baseSha` is
detection-time evidence, while `reconcile.progress-checked.baseSha` is the
kernel's authoritative observation for deciding whether a completed attempt
made progress and `reconcile.started.baseSha` is the separately refreshed replay
target for the next attempt. Agent context uses only the started fact, so a
reconcile never runs against a persisted or known-stale observation.

### 15.4 Finding schema and stall mechanics [D4]

```jsonc
Finding {
  "id": "f_3a91",                 // kernel-assigned at deposit, stable for the build
  "severity": "blocking" | "important" | "minor",
  "file": "packages/core/src/auth.ts",          // optional
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

The reducer retains every outstanding verifier keyed by step and attempt,
independent of the compatibility `currentPhase`/`currentStep` projection. Each
completion or cancellation clears only its member. Occurrence ownership comes
from the raising agent's session and its durable phase start, never a phase name
alone. Cancellation tombstones supersede delayed escalation raises and answers;
only effective escalations contribute to blocked status or engine routing.
Grouped stage failures use the decisive `verify.stage-failed` receipt. Existing
`Feedback.verify` stays a single `{step, report}` object on every known event.
The additive `implement.started.verifyStageFailure` sequence references the
complete receipt, retained across crashed implement reruns and guidance rounds.
Both new event types are decisive under version-tolerant reads, fencing older
engines while their known event payloads remain valid after projection.


**Mixed-version reads.** Within the supported client window, readers that
implement this contract preserve raw unknown facts and skip them in functional
reducers. Known payloads project away added fields recursively while retaining
validation of all known fields, required fields, enums and refinements. Writes
remain strict. Every build and repository catalog type has an explicit
`advisory` or `decisive` classification. Producers stamp their own release and
classification in envelope `compatibility` metadata before transport; backing
stores check supplied classifications against their catalog. Legacy known types
use the local catalog; legacy unknown types are conservatively decisive with
an unavailable-writer-version diagnostic. Added fields on existing types must
be advisory; new semantics requiring old kernels to stop use a new decisive type.

Build reductions retain reader-relative unknown and decisive counts, unsupported
types and producer versions. Unknown facts advance raw cursors, including when
they trail the last known fact. Unknown decisive facts defer claims, phase
routing, integration and merge/publication decisions for that build only;
read-only status/context/dashboard reads retain the lifecycle status. The
kernel or dispatcher records advisory `build.compatibility-deferred` with the
decisive boundary, types, versions and diagnostic, deduplicated per boundary.
Default `ab watch` attention includes it. An unsettled dispatcher-written
`execution.drain-authorized` in the build's own log suppresses that attention
only for the matching execution instance and predecessor runtime during an
accepted draining handoff. The decisive-fact fence and exit-for-relaunch remain.
`execution.ended` or matching `execution.drain-settled` settles authorization;
a later unrelated execution never inherits it. Diagnostics request a build that
understands the unsupported types and name the writer releases, even when
writer and reader share a release string. Upgrading clears deferral through
local replay without answering an escalation. Repository unknown counts do
not invent per-build blockers.

Event-derived caches require both the exact reducer version and a deterministic
read-catalog identity, including build/repository type classifications and a
read-decoder revision. Named and generic checkpoints use catalog-specific keys;
legacy/foreign-catalog snapshots are misses and are preserved. Unrecognized
reducer versions replay without repairing their cache. No lower-version write
replaces a higher-version row, even at a later cursor. Corrupt caches of the
reader's own version may be conditionally repaired. Hosted named answers are canonical: the client accepts a representable finished
value at its reducer version regardless of catalog identity. Version mismatches,
invalid envelopes and invalid finished values fail with a typed incompatibility
error naming the reducer and client/server versions. Remote clients never
reconstruct named answers from event logs. Catalog identity travels in response
header `x-autobuild-catalog-identity`; strict JSON bodies remain exactly
`{version, cursor, value}`. Missing/malformed headers do not reject an answer.
Repository digest batches are also canonical, with no client discovery or
per-build fallback.
A service omits identity for a backend without one. This guarantee excludes
readers predating this contract and does not widen the supported client window.


A nonterminal integration with `node.opened` derives `collecting` (below paused
and blocked in precedence); it requires no attached runner. Empty/holding changes
comes from `node.compared`, independently of admission openness. Integration
identity and target are immutable claim-time facts in `build.created`;
historical absence means work/root. The resolved `baseBranch` stays frozen.

`node.opening {branch, parent, sha}` is the dispatcher's durable mutation intent.
`node.opened {sha}` acknowledges creation or adoption without resetting advanced
history. `node.compared {parentSha, headSha, ahead}` retains a changed observation;
only positive ahead counts permit creating a PR. `pr.opened {pr}` records its
identity without a fabricated finalize completion. All four facts are
dispatcher-authored. Existing merged/closed PR, abort and completion facts close admission.

Node transaction state reduces `node.writer-reserved`, `node.item-prepared`,
`node.item-conflicted`, `node.item-replayed`, `node.publish-intended`,
`node.rewritten`, `node.writer-settled`, and `node.inventory` (§13.1 integration
restacking). Durable `node.restack-requested` facts retain operator/presence demand,
including destination, sampled parent, dependent ticket and required identities.
Reservations freeze covered request ids; confirmed settlement acknowledges only
that coverage, and `node.restack-satisfied` records coverage or destination change.
`target.distance` records advisory leaf distance with immutable destination and
build tips; null count means unknown (a known count requires a head).
`node.parent-distance` records immutable base/parent/branch and count (null when unknown).
It retains the previous contribution boundary, latest parent
observation, complete replay prefix, active source item and merge proofs.
`integration.observed` optionally carries display-only `children` entries
(source/id, optional title and contribution build identity). Open-child and
contribution arrays remain the membership authorities; resolved tickets without
contributions do not become merged children. Dashboards list open children first
with current live phase or `queued`, then contributions as `merged`. They show
expected verification steps with exact current-cycle/head/parent outcomes and
merge mode/rule/consent instructions. Optional `files` on `node.item-conflicted`
and conflicted `restack.replayed` records unmerged paths at replay. Legacy events
remain readable with explicit unavailable-title/file fallbacks; display metadata
never authorizes collection or merge.
A rewrite receipt alone never promotes the boundary; only completed settlement
does. CLI status exposes pending/active work, reachable build identities and
node-owned foreign changes. A node stays `collecting` while its narrow reconcile
runner is attached; it does not acquire a leaf pipeline.

`status ∈ queued | running | collecting | paused | blocked | done | aborted`, plus
`{phase, round, openEscalations[], reviewRoundCeilings?, pr?, autoMerge,
lastEvent}`. `blocked` ≡ an `escalation.raised` without a matching
`escalation.answered`, matched by id. `reviewRoundCeilings` projects valid
review-limit answers independently for the plan and code loops after the latest
`spec.revised`; status and dashboard surfaces expose any projected values.
`paused` ≡ a `build.paused` without a later `build.resumed`, and takes
reducer precedence over blocked. Auto-merge state tracks the latest human
*desired* value separately from the latest *applied* fact, settled only when
both match — a stale acknowledgement can never erase newer intent.

Queued state additionally retains ordered `dispatch.failed` diagnostics and an
outstanding `build.discard-requested` fact. `build.completed {outcome:
"discarded"}` settles that intent without changing the status vocabulary.
Runner state retains ordered `runner.setup-failed {command,attempt,exitStatus,
output}` facts and projects the latest one until a later `runner.attached`
proves successful setup recovery. A legacy `session.started` with no ending
continues to project as open. On takeover, the recovering runner explicitly
retains the eligible current native session and reclaims unrelated open
brackets at its captured resume boundary before `runner.attached`. Without a
usable native candidate, only a subsequently started fresh session can be open.

Every projection — operator UI, CLI status, dispatcher decisions — is a
reduction of the logs. `ab builds` and `ab build status` additionally present
the reduced last event as durable progress beside mutable heartbeat and lease
health. On those diagnostic CLI surfaces, a nonterminal build with a live lease
whose heartbeat is at least one hour newer than its last event is
presentation-marked `diverged`; terminal, no-lease, and expired-lease builds
are never marked. Progress age and that marker never feed a reducer or engine
decision. Caches serving those liveness-aware consumers may key a reduction by
last event sequence, but record-only heartbeat renewal must still refresh their
presentation inputs. No decision ever consults a snapshot in place of the
append-only log. Separate reducers
derive dispatcher settings and harvest state from the repository journal; each
ignores the other's facts.

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
verify.started{acceptance} → pr-attachment.designated{artifact,filename,mediaType} → verify.completed{outcome:pass}
finalize.started → pr-attachment.hosted{designationSeq,asset} → finalize.completed{pr} → finalize.step-completed{release-notes}
(later, janitor:) pr.merged → workspace.released → build.completed{merged} → pr-attachment.reclaimed{hostedSeq}
```

**Interrupted dispatch:** if the log stops after `build.created`, a later
ordinary dispatcher tick provisions the workspace, atomically imports the spec,
posts the ticket notice once, and launches the runner. New claims do not
materialize auto-merge-default attribution as a human request. Merge policy
is recorded at readiness; consent is an explicit merge command. A failed boundary appends `dispatch.failed
{stage,attempt,error}` and stays queued for another tick until its budget is
exhausted. Dispatch failures share a `[policy].maxDispatchAttempts` budget
(default 3) across
create, workspace, spec, comment, and launch stages. Exhaustion raises one
`dispatch-failure-limit` policy escalation naming the latest stage and error,
and parks dispatch until answered. Both bare `ab answer <slug>` retries and
text guidance grant a fresh budget; abort does not. Confirmed runner attachment
clears the streak. Recovery-provider workspace failures belong exclusively to
the infrastructure budget. Exhaustion is repaired from durable facts on restart
before further dispatch work.

A discard request is honored only while the build remains queued; one that races with runner
attachment is inert and cannot tear down live work. A human discard waits out
any unexpired execution lease, then releases a partial workspace and stale
lease, returns the ticket to Ready, and appends `build.completed {outcome:
discarded}` last. No runner is required.

**A — grouped verification:** a failing member waits at its stage barrier for
all siblings unless a fail-fast member fails. After cancellation and confirmed
whole-execution teardown, a replacement execution records/reuses one complete
`verify.stage-failed` receipt and routes to implement. The receipt orders failed
reports by configuration and lists cancelled members as not run. An answered
verifier escalation reruns only its owner while other members continue; a
cancelled owner's escalation has no remaining blocked or routing effect.

**A — verify failure:** `verify.completed {step: acceptance, outcome: fail,
report}` → kernel routes back into the code loop: `implement.started
{round: 2, feedback: {verify: {step, report}}}` → fix → `code-review` round
2 → approve → verify re-runs **from the first step** (implement changed the
code; cheap checks first), `attempt: 2`. `policy.maxVerifyAttempts` counts distinct failed logical verify cycles since
the latest spec revision; duplicate failure evidence for one attempt counts once.
Passed or skipped target-movement, restack and reconcile cycles consume zero.
Cycle identifiers remain monotonic independently of this budget. The history
pass, pass, pass, fail uses one failure even when the failing cycle is attempt 4.
The third distinct failed cycle at the default limit escalates. Budget
exhausted → `escalation.raised {source: "policy"}`. Guidance answering that
policy escalation routes to `implement` and outranks the pending report. By
contrast, when the agent verifier itself uses `ab escalate`, guidance answering
it reruns that same step with `verify.started {feedback: {guidance}}`; `ab context`
writes `$AB_CONTEXT_DIR/guidance.json`. The start citation remains pending through repeated
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

Automatic upgrade repository facts are run- and launcher-lineage-correlated.
`dispatcher.upgrade-detected` is advisory; preparation, yield, acceptance,
terminal release, takeover, drain settlement/deadline, completion and upgrade
failure, `dispatcher.runtime-rolled-back` and `dispatcher.rollback-hold-cleared`
are decisive. Rollback is immediate repository attention naming failed and restored
runtimes. A run-start fact may carry its launcher lineage for effective-hold
projection; historical rollback remains visible after a hold clears or lineage changes.
Start and completion retain runtime/target provenance;
retirement completion is distinct from takeover. Failure is immediate repository
attention. A launcher consumes only its exact lineage/run's pending target and
never an operator-stopped run. See §3.3 for the draining protocol.

Every dispatcher run start is immediately followed by an advisory
`dispatcher.runtime-recorded {run, startedSeq, runtime}` fact. Every successful
runner attach is immediately followed by advisory
`runner.runtime-recorded {instance, attachedSeq, runtime}` before dispatch work
or phases begin. Persistence failure prevents that work. Existing lifecycle
facts remain decisive; older readers skip the advisory companions without
compatibility deferral. Interrupted pairs and historical logs remain readable
with runtime null in JSON and `runtime unrecorded` in human detail.

The runtime is captured once per executing process from its own distribution,
never the consuming repository or dispatcher on behalf of a runner. It includes
`version`, `commit` (a Git object id or explicit `unknown`), and
`source: {kind: source | package, location}` with an absolute distribution root
(realpath when available). A source distribution owns its Git top level,
including worktrees; nested package installs cannot inherit a consumer's HEAD.
Packages use valid manifest `gitHead` when available. Missing diagnostic metadata
never prevents startup. Capture survives later checkout movement.

Repository status reports the authoritative lease holder's runtime independently
of the newest invocation. Build detail reports chronological runner attaches;
each phase is attributable to the preceding attach boundary. Companions correlate
by exact start/attach sequence and run/instance, never by proximity or instance
alone. Writer-version stamping and runtime selection are unchanged.

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

**D — runner loss and sandbox death:** local git-worktrees first attempt the
native continuation described in §9. The following remote-sandbox recovery
retains its fresh-session fallback.

**Remote sandbox death:** log ends at `session.started {session: old}` after
`implement.started {round: 2}`; heartbeat goes stale → dispatcher expires the
lease, records the old execution identity, stops/deletes its exact deterministic
sandbox name, and confirms absence before recording `workspace.released` → it
provisions the next generation from the published build head (or the original
recorded branch-cut SHA when no checkpoint exists) → `workspace.provisioned
{base: {source: existing, sha}}` → the workspace execution capability starts a
fresh process and records the replacement sandbox/session identity. The
supervising kernel first claims the lease for that execution
instance; the process reads its workspace location from the durable event,
renews the same-holder lease, captures the current resume boundary, and appends
`session.ended {session: old, outcome: reclaimed, reclaimedBy: {instance,
resumedFromSeq}}` before `runner.attached {resumedFromSeq}`. The reducer now
shows no pre-boundary session as open and says implement r2
started-not-completed, so the process re-runs the phase from its start and opens
one fresh session. For a `publication.requested` fact issued before the old
`workspace.released`, the supervisor first compares its exact SHA with the
durable remote branch: a match repairs the missing completion fact before the
replacement starts, covering a lost post-push acknowledgement; otherwise the
commit existed only in the deleted sandbox, the request is abandoned, and the
phase rerun must issue a new request. A crash while closing several sessions
merges no attachment;
the next recovery closes only those still open, so repeated takeover converges.
Historical orphan-only logs remain valid and require no repair.

The re-run retains another `implement.started {round: 2}` as evidence of the
execution attempt. Duplicate starts for one logical round or attempt are not
policy units: review budget follows verdict rounds, phase retry budget follows
`phase.failed`, verify budget follows distinct failed cycle identifiers after the spec revision while a crashed step
reuses its attempt, and reconcile no-progress budget follows distinct completed
attempts. Recovery alone therefore consumes none of those budgets. The provider
restores the already-created branch at round 1's pushed head [D3]; the Git
adapter never re-cuts it from a newer base (§7.4). `ab context` rehydrates
scratch from the store into a fresh session. Uncommitted round-2 work is lost by
design (§7.3 — phase boundaries are the resume points).

The dispatcher also applies a fixed, non-configurable limit of three consecutive
executions that complete normally with exit code zero and no durable build
progress. Execution start/end, runner attachment and workspace lifecycle
bookkeeping do not count as progress. Pipeline, session, spec, publication/PR,
observation and acknowledged operator facts reset the streak; infrastructure,
budget and provider failures do not consume the allowance and retain their own
retry limits. Before a fourth actionable launch, the dispatcher raises one
setup-targeted `execution-no-progress` policy escalation naming the count and
the next action it expected the runner to take. Waiting, paused and terminal
builds are left parked, and pending operator commands remain executable.
Answering that escalation with guidance or a bare `ab answer <slug>` retry grants
three fresh executions. The guard is derived from durable facts, including on
supervisor restart, and uses the ordinary watch, dashboard and operator API
attention paths.

Two liveness rules complete the picture. Within one dispatcher process,
build-runner launches are single-flighted by slug through supervised process
liveness — execution completion means the complete environment has been reaped,
but remains only a liveness signal, never a pipeline outcome. Build progress,
config, diagnostics, and outcomes cross the process boundary only through
build-owned Store state. The kernel claims each execution's durable lease before
launch and releases that exact holder only after completion; the child renews it.
Recovered remote execution settlement requires confirmed whole-environment
teardown too: a guest command exit alone is insufficient. A failed or ambiguous
sandbox stop records no `execution.ended`, releases no lease, and permits no
publication or replacement execution; observation retries on a later tick.
The lease remains the cross-process recovery and workspace-teardown gate (the
in-memory guard is deliberately not durable: a dead process's memory disappears
with it). Ordinary dispatcher shutdown gracefully signals each local runner leader and
waits for it to finish suspension and exit. It then reaps remaining descendants
with bounded TERM-then-KILL process-group cleanup. The frontend waits for kernel
teardown without a wall-clock force-kill deadline.
Before every build-child terminal path exits — natural success or failure,
SIGINT/SIGTERM, or immutable-parent watchdog death — it launches one detached
group reaper while the leader still pins the group's identity. That owner
applies the same bounded TERM-then-KILL policy and survives abrupt dispatcher
death. The live local supervisor independently awaits full-group teardown before
publishing execution completion and releasing the lease; lease expiry remains
the durable recovery fallback when the dispatcher dies. A new `ab dispatch`
process attempts
every actionable build on its first tick rather than waiting for the sweep;
lease claiming stays the exclusivity gate, so a genuinely live old runner
wins harmlessly.

Verification's current result boundary also advances on `verify.config-captured`
and `verify.config-superseded` (§16.1). These facts do not change reconcile
identity or its policy snapshot; replay gates still refer to the code/reconcile
boundary. Superseded receipts remain historical evidence.

### 15.7 Post-PR lifecycle [D1 — confirmed]

Walking the happy path exposed a gap in the grammar: `finalize` creates the
PR, but *something* must watch it to merge/close, release the workspace, and
emit `build.completed`. Autobuild makes it a deterministic **janitor duty of the
dispatcher** (which already polls on cron): it checks open PRs for its
builds, emits `pr.merged`/`pr.closed`/`pr.conflicted`, releases workspaces,
and completes builds. Destructive discard, abort, and terminal-PR cleanup defer
while an unexpired execution lease exists, so no workspace is released under a
live process tree. After any terminal outcome it also reclaims every
pending hosted PR-attachment copy. Reclamation success and failure are durable
correlated facts; a failed delete remains pending and retries on later ticks,
including after the build is already done. A merged-PR fixup request is a *new
ticket*, never a reopened build.

**Merge standard: one change per build, replay at reconcile.**

- **Root-target leaf PR → configured root: squash merge.** One commit per
  leaf build keeps the root linear. Node-target children and nodes merge into
  local-git roots use guarded fast-forwards; GitHub root nodes use guarded PR
  rebase merge with fencing/audit provenance (§13.1), preserving contributions.
- **Conflicted build → refreshed base: restack.** The kernel collapses the
  contribution relative to its effective diff base into one commit with the
  original head's exact tree, then replays that change onto the freshly captured
  `reconcile.started.baseSha`. The result has exactly one parent equal to that
  frozen SHA and one `Autobuild-Build: <slug>` identity trailer, including when
  the resolved change is empty. No reconcile creates a merge commit.

This reverses the original rebase ban [D1, D3]. Replaying many WIP commits caused
repeated conflict loops; replaying one net change resolves the conflict once.
Rewrites used to sever event-recorded SHAs; immutable archives and durable
rewrite facts retain them. Ordinary per-WIP-commit rebase remains inappropriate.
Existing historical merge reconciliations retain their original replay/display
semantics and supply the promoted contribution base for a later restack. Resumed
builds use current engine routing at newly reached replay and merge boundaries;
there is no claim-version guarantee that in-flight builds finish under the old
merge standard. Execution configuration remains pinned, while merge policy
is live dispatcher configuration. Operators requiring old execution behavior
should drain work before upgrading rather than run mixed-version writers.

Before branch replacement the kernel publishes Git tips named by retained
history and rewrite facts, plus both heads and the temporary change, under immutable non-branch refs
`refs/autobuild/archive/<slug>/<sha>`. Archives must be fetchable by exact ref;
namespace or permission failures stop publication without a branch/tag fallback.
Publication requests and loss records alone are not retained Git history: their
unpublished objects may have died with a released sandbox. A separately published
or reviewed tip remains an archive requirement even when an earlier request named
that same SHA.
Restack and reconcile publication reject tracked modifications with the existing
clean-worktree error. Nonignored untracked files do not block publication and
remain unpublished and untouched; each publication that encounters them records
a path-bearing `observation.recorded` followup, deduplicated by operation,
transaction, candidate SHA and exact path list on recovery. The phase-terminal
D5 clean-worktree rule for `ab done` remains unchanged.

The branch replacement uses an explicit expected-old-head guard. A lost lease
fetches the observed contribution and prepares another correlated transaction on
the same occurrence's frozen base, preserving external work; deleted, divergent,
or ambiguous history requires operator resolution. It never changes the target
because upstream advances during contention. Only a later conflict occurrence
captures a new base. Replay occurs detached, leaving the named branch untouched
until publication. Confirmed publication reattaches the matching workspace HEAD
to the build branch so a later verify → implement cycle can publish normally.
Missing third-party forge capabilities refuse actionably.

Automatic leaf transactions use `restack.*`, independently of reconcile attempt
numbers. Preparation freezes the trigger, verify-cycle boundary, absorbed target
observation, old base/head, target base, single-change commit, workspace/local
branch tips and canonical message. Publication intent precedes guarded replacement;
`restack.rewritten` retains archives and proven writes even if readback observes a
later writer. Completion requires confirmed publication. Clean transactions start
no agent and do not fabricate `reconcile.completed`. A conflicted replay is adopted
by `reconcile.started {restackId}` without another collapse or target selection.
Resolver completion links back to the automatic transaction. Retained commit bytes
and replay object packs recover disposable-workspace objects before publication.

`reconcile.prepared` records transaction identity, attempt, branch, old head,
effective old base, target base and temporary single-change SHA before checkout.
Before that fact is appended, the exact temporary commit bytes are deposited as a
SHA-keyed BuildStore artifact. A replacement sandbox restores and verifies the
same object from those bytes, retaining the original transaction and frozen base
without requiring prepare-time remote write credentials. Retained trees and
parents supply the rest of its object graph; trusted publication still archives
the temporary commit before replacing the branch.
`reconcile.replayed` records whether replay conflicted. Notes and the resolved
head are deposited with `reconcile.publish-intended` before publication.
`ab done` records a publication request; local kernels wait for the resolver
session to end and remote kernels wait for guest teardown before replacement;
`reconcile.rewritten` records old/new heads, old/new change SHAs, frozen base,
conflict outcome and archive refs after confirmed publication. A successful CAS
that is overtaken before readback still records its receipt, with `observedHead`
naming the later head (or null for deletion). That observed head informs recovery;
it does not complete reconcile or promote the verification base. Recovery may
consume a durable confirmed write receipt; candidate ancestry alone never proves
an unconfirmed write. New completion is
`{headSha, rewriteId, artifact}`; historical `{mergeCommit, artifact}` remains
valid. Remote requests carry identical transaction inputs and use the provider's
trusted rewrite/archive capability only after execution teardown. Contention is
recorded durably and uses the existing runner-failure bound, without spending
unchanged-base no-progress budget before completion. Classified transient publication
failures instead use the independent durable publication retry budget described
in Forge failure recovery; publication intent and frozen target remain unchanged.

**Stable merged identity.** A root-target leaf kernel merge remains one squash commit and
preserves the forge's existing message except for normalizing terminal build
identity trailers to exactly one final `Autobuild-Build: <immutable slug>`.
Implementation commits and deposited PR descriptions are unchanged. The janitor
records `pr.merged { sha, buildTrailerPresent? }` from the actual merged message,
including human merges. True and false are successful observations; historical
logs, unsupported inspection, and transient read failures leave evidence absent.
A failed inspection records an actionable observation and never blocks merge
completion. This evidence does not change reduction or display semantics.

A node-target child merge instead fast-forwards its already canonical
single-change commit, preserving exactly one terminal source-build identity.
The guarded destination write is authoritative: its pushed SHA and identity
produce the durable merge receipt independently of forge PR state. PR
acknowledgement is best-effort: observe a provider-reported merge, or comment
with the merged SHA and close a still-open review. Acknowledgement failure never
retries or fails the merge.

GitHub uses its authoritative viewer squash headline and body with an expected
head guard. Native auto-merge messages are checked against fresh server defaults
on eligible polls even after consent acknowledgement, and repaired through
consent-guarded disable/enable. Repeated polling covers later head or metadata
changes; it cannot make a future push atomic with an already armed native merge.
Merge queues ignore message overrides, so identity-aware kernel merge defers
with `unproven-gate-state` rather than bypassing the queue. Human merges remain
observable regardless of trailer evidence.

Ordered `[[merge]]` rules in `autobuild.toml` decide authorization. Each rule
requires `mode = "auto" | "consent"` and may match `into = "root" | "node" |
<node-ticket-id>`, `from = "leaf" | "node"`, and an exact, case-sensitive
`label`. Predicates are ANDed; the first matching rule wins. Omitted predicates
match anything. With no match, leaves use auto and nodes require consent.
The target is the immutable destination frozen at claim, not a ticket's current
parent. Labels are sampled from a successful source-ticket read at readiness;
unavailable ticket data defers the decision instead of supplying empty labels.

A leaf becomes ready after verification and finalize on a current base; a node
must be complete and verified at its exact head and parent. `landing.decided`
records that candidate, the sampled labels, resulting mode, and the full matched
rule and index (or explicit default). Editing configuration cannot change this
recorded decision. A replacement candidate gets a new decision once ready.
Policy is live dispatcher configuration, outside the pinned execution pipeline.

`ab hold <slug>` durably suppresses merge and revokes previous consent, even
before readiness. `ab merge <slug>` requires readiness, clears hold, and consents
to this build/node merge into its frozen destination. Consent survives head
replacement, restacking, verification and re-finalization until another hold or
completion. It is consent to the merge, not approval of an immutable diff.
Commands and acknowledgements are sequence-correlated; hold acknowledgement
requires confirmed native cancellation, while merge acknowledgement accepts
consent without claiming that merge gates passed. The same actions are available
through the MCP/operator build-control tools. The terminal uses `l` for merge and
`o` for hold on the selected merge. The web offers **Merge** and **Hold** on a merge awaiting consent.

The repository auto-merge default and its fan-out are retired. Historical events
still replay; explicit old per-build commands map to consent/hold until a new
merge command supersedes them, while old default seeds confer no consent.
`ab upgrade` samples the target repository's configured journal and writes leaf
auto for old ON, leaf consent for old OFF (including no fact), and node consent
in either case. Explicit merge arrays remain byte-for-byte unchanged; explicit deprecated landing arrays are renamed to merge without changing policy values or order. Both spellings together are rejected. Missing
configuration or unavailable journals fail with recovery guidance. Fresh init
uses the no-rules fallback.

A classified transient native-enable failure records a candidate-specific
application failure even before the provider's mutation guard. An uncertain
enable after that guard requires confirmed cancellation before publication.
During forge cooldown it stays pending; cancellation makes no further provider
request until recovery. A confirmed cancellation's disabled receipt can retain
retry timing. Retries back off from 30 seconds exponentially to a five-minute
maximum interval, surviving dispatcher restarts, and honor any later repository
reset. A new candidate or merge command resets the application delay; hold wakes
janitor backoff but provider cancellation still honors repository cooldown.
Quiet polls append no attempt facts. Native application receipts and janitor
bookkeeping are not pipeline execution progress.

Native auto-merge is reconciled on every janitor poll against durable desired
merge state using the native state in the existing PR read, without additional
forge reads. A native write is issued only when observed and desired state disagree. It is disabled while held, unauthorized, unready, or replacement
publication is pending or just completed; enabling binds to the current head
through the forge's expected-head guard. Every replacement publication confirms
cancellation first, and its first following poll re-reads and reconciles native
state before other build actions. Native receipts bind to exact candidates;
consent does not. A stale enable completing after cancellation is repaired by
poll reconciliation. This is an explicitly bounded failure model: native merge
is used only behind a merge-blocking gate, and checks on a replacement head must
take far longer than one poll interval, allowing cancellation before they pass.
There is no durable native-effect reservation protocol. An undesired forge
merge is classified from the kernel's last durable native application state, without changing provider contracts. A confirmed disabled
state with no enable in flight or indeterminate means a deliberate human forge
merge, which supplies consent. Record whether it overrode a hold: an unheld
human merge needs no operator attention; overriding a hold is informational.
If native auto-merge was armed, or an enable was in flight or indeterminate,
record a possible stale-enable merge as contrary to policy and raise operator
attention. Autobuild never rewrites the target to undo either outcome. Merge
gates and the serialized node-writer publication rules remain authoritative.

**Merge gates are never bypassed.** Merge authorization comes from recorded
policy or explicit consent. For root-target leaves, whenever the base branch has
any real merge-blocking gate, authorization is applied as GitHub-native auto-merge, so the
forge's own checks decide when the PR merges. Only when the forge
authoritatively reports no gate may the janitor perform a normal,
head-guarded squash itself — never admin, force, or rebase — and only after
all verification and finalize work is complete. GitHub's exact documented
account-plan refusal for the branch-rulesets endpoint proves that no ruleset
can exist only when the independent classic-protection probe also
successfully reports no protection. Every near miss, generic authorization
failure, malformed or unknown response, and tooling failure remains unknown
and fails closed. Gate presence is decided by the mechanism actually in
effect: a ruleset probe that proves merge-blocking rules settles presence even
when the classic protection response is incomplete, while an incomplete classic
response with no proven ruleset gate still fails closed with a reason naming
the missing subsection.

Serialized node-target merge has a stricter path: native auto-merge is
cancelled and cancellation confirmed, never enabled. Under the destination
writer reservation, refresh the PR's actual base and head and inspect gates on
that exact frozen destination immediately before mutation. Only proved-ungated
branches permit the guarded fast-forward, regardless of token bypass privileges.
Gated branches defer with `gated-node-destination`; unknown or unreadable policy
defers with `unproven-gate-state`. Both leave the PR open with actionable human
guidance, and every later attempt obtains fresh proof. No native fallback can
participate in node serialization. Human node merge remains observable.

Inability to prove or apply auto-merge is nonfatal pipeline plumbing, not a PR
creation failure: finalize still records the open PR and completes, and consent
stays pending for later janitor polls, which re-examine it. Deferrals divide by
who resolves them. Merge conflicts and not-yet-computed mergeability are
pipeline-owned: a conflict re-enters the pipeline through `pr.conflicted` and
reconcile (below), and uncomputed mergeability resolves on a later poll —
neither records anything, and the reconcile step on the build row is the only
indication. A kernel-authored follow-up is recorded only for a deferral a
person must fix: the first such refusal for that PR and consent command records
one follow-up while the PR is open, and a later `reconcile.completed` or
`finalize.completed` supersedes it — the projection shows nothing until the
gate re-examines consent and records a fresh one. A repository
with native auto-merge disabled is left open for a human; Autobuild never
changes the setting. For root-target leaves, the local-git forge has no external
gate or native setting: authorization produces the same inspected-head guarded
squash candidate,
mergeability is recomputed against the current local base, and the exact
`pr-description` becomes the single-parent squash commit message. Its author and
committer are Git's ordinary resolved repository identity, exactly as for a plain
local commit; commit signing remains disabled. Before offering the candidate,
the adapter resolves both identities through Git. If either is unavailable,
consent remains pending and one reason-bearing follow-up names the missing
`user.name` / `user.email` configuration; later polls retry after the operator
configures it. When the base branch is checked out, Git's two-tree
`read-tree -m -u` transition preflights and merges the old-to-squash tree:
tracked/index changes on untouched paths and
untracked non-colliding files survive, while a tracked or untracked overwrite
leaves consent pending and records one path-bearing follow-up instead of failing
the dispatcher. Its durable pending-merge record is written before moving the
base ref. A poll after a crash retries that same old-to-merged transition without
rolling back the ref or overwriting operator work; the PR remains open and
retryable until checkout repair succeeds. No merge is ever assumed: a build
reaches `merged` only when a later poll observes the merge and any required
checkout synchronization. Without authorization, the local branch and PR record
remain open for inspection with ordinary Git.

**Conflicts re-enter the pipeline via `reconcile`.** When the janitor's
mergeability check fails it emits `pr.conflicted` and re-attaches a
build-runner (the dispatcher itself never runs agents). Immediately before
each attempt, the runner asks the Forge for its current authoritative base
snapshot when supported, otherwise fetching the build's frozen base branch
fresh from `origin`, and records the resolved SHA on `reconcile.started` — known-stale input is never
used (§15.3). The kernel prepares one replay on that frozen base. The agent
resolves it guided by the spec, plan, and implement-notes, with the explicit
charge to regress against neither side; the result is one commit, and because reconciliation
changed code, **`verify:*` starts a fresh cycle**, subject to the captured
post-reconcile policy (default: re-run all applicable steps). A resolution the agent judges
risky — semantic conflicts, spec-relevant choices — escalates rather than
guesses. Reconcile skips `code-review` by default (escalation covers the
judgment cases; policy can force it).

On each repeat conflict, the runner records a fresh authoritative base snapshot
on `reconcile.progress-checked`, tied to that conflict and the most recently
completed attempt. The kernel compares it with that attempt's matching latest
`reconcile.started.baseSha`. A different SHA proves that the reconcile lost a
race against a moving base, so another monotonic attempt runs regardless of the
configured limit. An equal SHA consumes `policy.maxReconcileAttempts`; reaching
the limit escalates because reconciliation made no progress against an unchanged
base. This no-progress escalation is conflict-scoped, roundless, and identified
by `policyCause = "reconcile-no-progress"`. By contrast, a runner retry
exhaustion or non-retryable failure while obtaining the progress check or
refreshing the base is scoped to the concrete next reconcile round and carries
its own cause. Answering that runner condition re-arms its phase-round failure
budget so the authoritative decision can complete, but it does not acknowledge
no-progress: if the unchanged-base budget is already exhausted, the separate
no-progress escalation is raised before another reconcile session starts.
Answering the matching no-progress escalation continues to authorize one
subsequent reconcile for the same conflict without resetting runner failures
already counted for any reconcile round. An explicitly different cause cannot
acknowledge that guard even when roundless. Cause-less historical roundless
`policy`/`reconcile` raises retain the former no-progress and phase-level
failure-reset interpretations on replay without migration. Routing uses cause
for class identity and reset semantics, `round` for occurrence scope, and never
`question` text.

The classification is reduced from the durable log, with the next attempt's
authoritative `reconcile.started` serving as the observation for historical logs
that predate the progress-check event. A started but incomplete attempt re-runs
at the same number and consumes nothing. Every completed reconcile still starts
a fresh, fully bounded `verify:*` cycle.

The grammar's tail is thus an epilogue loop, outside the mainline:

```
finalize → ( pr.conflicted → reconcile → verify:* )* → merged | closed
```

## 16. Per-repo configuration and installation

Decisions here continue the series: **[D9]** declarative repo config and
**[D11]** vendored editable skills.

### 16.1 `autobuild.toml` [D9]

`[verify].steps` accepts strings and nonempty arrays of strings. Names are unique
within and across stages and retain the configured flat order for selection and
role validation. Each verify table accepts optional boolean `failFast` (absent
means false); finalize remains a serial string list without that option.


One declarative file at the repo root. A running dispatcher owns an accepted
snapshot read from the **main checkout** and refreshes it before each dispatch
tick. Before launch and after each accepted revision, the dispatcher deposits
one composed snapshot into each affected build's artifact namespace: its
build-owned sections come from the build's own branch, and its deployment- and
dispatcher-owned sections from the live snapshot (the three ownership classes
are defined below). The child samples that durable artifact at setup and
pipeline-step boundaries, so a valid change to a deployment-owned section may
affect the next action of an in-flight build but never interrupts an agent turn
or deterministic command already running, and a change to a build-owned section
never retargets an in-flight build at all. Scoped phase CLI processes separately
read the build worktree's branch-owned file. Because the file is repo-versioned,
changes still flow through the pipeline itself: once a build's own branch
carries them, the system can adopt a retuned configuration without restarting
the dispatcher.

A missing or unreadable file and a malformed or routing-invalid candidate are
rejected atomically: the last valid snapshot, resolver, and revision remain in
force, and no action starts under missing, partial, or defaulted configuration.
The dispatcher emits an actionable operator notice without repeating it for the
same failure. Restoring a valid `autobuild.toml` clears the rejection and
ordinary boundary reload resumes.

Merge policy is an ordered `[[merge]]` array. Each rule requires
`mode = "auto" | "consent"` and may match `into = "root" | "node" | <node-ticket-id>`,
`from = "leaf" | "node"`, and an exact, case-sensitive `label`. Predicates
within a rule are ANDed; omitted predicates are wildcards; first match wins.
The destination is the frozen target identity, and labels are sampled when
readiness is recorded. No matching rule, including no rules, means leaf auto /
node consent. Policy is hot dispatcher-owned configuration, not pinned build
execution settings; each ready candidate retains its immutable `landing.decided`
rule snapshot and mode after config edits. Historical `build.auto-merge-requested`
and default-attribution fields remain replay-compatible but are not new controls.


```toml
baseBranch = "main"
capacity = 3                    # concurrent builds for this repo
ticketScanIntervalSeconds = 60  # positive integer; ready scans, with tick spacing as floor
forge = "github"                # builtin: github | local-git; or a plugin name
plugins = ["./plugins/local.ts", "@acme/autobuild-plugin"]

[upgrade]
automatic = true                # immediate/60-second target checks; false requires manual restart

#[workspace]                     # optional; default provider = "git-worktree"
#provider = "vercel-sandbox"    # shipped remote provider, or plugin name
#[workspace.config]
#image = "vercel/sandbox/universal:latest"
#vcpus = 4
#timeoutSeconds = 2700
#operationTimeoutMs = 30000       # provider calls, not VM/session lifetime
#environmentVariables = ["ANTHROPIC_API_KEY"]

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
steps = ["types", "unit", "acceptance"]
[verify.types]
kind = "check"                  # deterministic: command + pass/fail
command = "typecheck"           # ref into [commands]
[verify.unit]
kind = "check"
command = "test"
[verify.acceptance]
kind = "agent"                  # agent-verify: skill + pass|fail|skip verdict
skill = "verify-acceptance"       # repository-authored agent verifier
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
sessionBudgetSeconds = 7200       # optional role override

[policy]
upgradeDrainSeconds = 900         # local generation drain deadline, hot-reloaded
sessionBudgetSeconds = 3600       # non-infinite default for build agent sessions
stallRounds = 3
maxVerifyAttempts = 3
maxDispatchAttempts = 3
maxSetupAttempts = 3
maxInfrastructureAttempts = 3
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
envelope permits plugin-owned values under `[workspace.config]`; selecting the
Vercel builtin applies its closed image/vCPU/timeout/region/environment-name
schema. Unknown providers fail with the complete available-name list. A
workspace records provider `ref`, absolute execution-environment `path`, and an
optional dispatcher-reachable `localPath`. Vercel runs setup, all agent/check
phases, review/reconciliation, and finalize post-steps in its guest checkout.
Its child uses environment-owned supervision rather than a host-PID watchdog.
Remote publication is a durable request settled by the local supervisor only
after command exit, VM stop, and lease release; credentials are transformed by
the firewall only for an exact fixed push, and Forge/PR calls remain local.
Declarative (TOML), not executable config: the
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

`autobuild.toml` sections belong to one of three ownership classes, which
decide where a build's effective configuration is composed from:

| Class | Sections | Source at deposit |
|---|---|---|
| Build-owned (pinned) | `[verify]` and `[verify.<step>]`, `[finalize]` and `[finalize.<step>]`, `[commands]`, `[workspace]` (provider and config, including `provisioning` and `runtimeProvisioning`) | The execution checkout at each verification cycle; launch deposits use the branch head or recorded workspace base until a cycle capture exists. The exact commit is recorded once per deposit in the effective-config artifact metadata — except in checkout mode when the worktree read cannot be attributed to the branch-head commit: because the worktree file has uncommitted edits, because the clean/dirty comparison could not be performed (non-git workspace or a transient git error), or because the branch head never carried the file. The deposit then records the source `worktree-dirty` and no commit, because no commit claims the worktree bytes (the build still runs them). |
| Deployment-owned (live) | `[roles]` (runtime, model, args, alternates, per-role `sessionBudgetSeconds`) and `[policy]` (budgets, retry bounds, stall and harvest knobs) | The dispatcher's live snapshot; an accepted reload delivers these to active builds. |
| Dispatcher-owned | `baseBranch`, `capacity`, `ticketScanIntervalSeconds`, `forge`, `plugins`, `pr`, `tickets`, `orchestrator`, `merge`, `upgrade` | The dispatcher's live snapshot; the build runner never interprets them. |

A build's pipeline definition is therefore composed from the build's own
branch: in origin mode the dispatcher reads `autobuild.toml` at the build's
recorded base commit (or its branch head once the build has published commits)
through the forging adapter; in checkout mode it reads the workspace's file. The
effective-config artifact records the commit the build-owned sections were
taken from — except in checkout mode when the worktree read cannot be
attributed to the branch-head commit: because the worktree file has uncommitted
edits, because the clean/dirty comparison could not be performed (non-git
workspace or a transient git error), or because the branch head never carried
the file. The artifact then records the source `worktree-dirty` and no commit,
because attributing worktree bytes to a commit that has not been shown to carry
them would be false provenance. A base-branch change to `[verify]`, `[finalize]`, `[commands]`, or
the workspace provisioning after a build's base was cut does not change that
build's verify universe, finalize steps, commands, or provisioning; a build
that receives such a change in its execution checkout picks it up at the next settled verify boundary.
A live reload delivers only deployment-owned sections to active builds, so the
artifact deposited on reload changes only those sections. In-flight
environments are never re-provisioned; a fresh build from the new base is the
path for a changed provisioning definition.

At every verify-cycle entry, after restack or reconcile settles, the runner
reads `autobuild.toml` from the execution checkout at resolved `HEAD` (including
detached integration heads). `verify.config-captured` cites an immutable
`verify-cycle-config` artifact revision, checkout head, build-owned content
identity and truthful source metadata. Dirty worktree bytes carry
`worktree-dirty` without a commit. A settled stage boundary rechecks the
build-owned sections and the known source commit's ancestry. A change or
non-ancestor source records `verify.config-superseded` and starts a fresh cycle
before constructing any further member. Already launched siblings settle first.
A waiting leaf with completed verification retains its receipts after a clean
rewrite when build-owned config is unchanged, even when the rewrite replaces
the pin commit's ancestry. Changed config still supersedes while waiting; a
future verification cycle always captures fresh config before running steps.
Old pass/skip receipts cannot satisfy that cycle, and supersession creates no
failure or failure-budget charge. Unchanged config on a descendant head retains
its pin; every new cycle still rereads the checkout. Read, parse and Git evidence
failures block verification as infrastructure failures. Recovery and readiness
read the capture's exact revision, so a concurrent deployment reload cannot
replace its build-owned sections. Historical streams capture before further
verification. Deployment-owned reloads remain live; environments are not
re-provisioned.

Three configurable narrowing mechanisms govern which verify steps run, all
resolving to the ordinary `skipped` outcome so exclusions stay queryable:

- **Post-reconcile policy.** The cycle snapshot resolves repository and step
  `afterReconcile` settings before any plan or path exclusions, including for
  `always` steps. It applies only after a completed reconcile.
- **Plan selection.** An approved plan may declare the complete subset of
  optional verify steps warranted by the spec, in strict front matter
  validated at deposit. The selection paired with the approving review
  verdict is authoritative; `always = true` steps can never be deselected.
  Missing metadata means all configured steps, so historical builds keep
  their behavior. If the approved selection later names any step absent from
  the cycle's pinned configured universe, the entire selection falls back to
  all configured optional steps. The kernel records one observation per cycle
  and plan revision naming the unknown steps. Mandatory steps, paths and
  post-reconcile policy still apply. A valid selection continues to skip
  genuinely omitted optional steps. Strict new-plan validation is unchanged.
- **Path applicability.** A step may declare positive changed-path selectors,
  evaluated by the kernel immediately before the step on every verify cycle,
  diffing `HEAD` against the build's durable base (promoted by a completed
  reconcile, so upstream-merged work is not attributed to the build). No
  match skips without launching anything; a Git failure is infrastructure and
  fails closed, never a synthetic skip.


#### Post-reconcile verification policy

Post-reconcile verification defaults to enabled: `[verify].afterReconcile = true`.
Set it to `false` to retain pre-reconcile verification and skip all steps after
reconciliation. An optional boolean `[verify.<step>].afterReconcile` overrides
the repository setting in either direction; overrides require a configured step.
For example, set `afterReconcile = false` in `[verify]` and
`afterReconcile = true` in `[verify.types]` to keep only that step re-running.

The kernel freezes the resolved ordered policy in
`verify.reconcile-policy-captured` at the next engine action after reconcile
completion. A cycle already started keeps its policy through recovery.
Configuration supersession starts a fresh cycle and captures a new policy for
its configured universe, retaining the original reconcile identity. Historical cycles already started
without a captured policy retain the rerun-all behavior. Initial verification
and verification after subsequent code review always use ordinary applicability.
Policy exclusion precedes plan selection and paths, including `always = true`.
Enabled steps still follow plan selection and path rules. Excluded steps record
`verify.completed` with outcome `skipped`, `skipCause = "post-reconcile-policy"`,
and a reason naming the setting. Dashboards and PR summaries call this
"skipped by post-reconcile policy"; it is never a pass. Forge-side required
checks and branch protections still gate merge. For excluded steps, merged code
is not re-verified, so breakage that only exists in the combination can merge.

### 16.3 Skill installation: vendored, namespaced, editable [D11]

This project ships 11 canonical default skills for the fixed phases, the
non-phase surfaces (`spec`, `tickets`, and `guide`), and the outer-loop skills.
Repository setup guidance ships as `guide/references/setup.md`, not as a skill;
each repository authors its own acceptance-check skill. No generic verifier
skill ships. `ab init` installs into a repo:

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
  an acceptance-check skill selected from an agent verify step in every repository.
  Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite.
- **Model-invocation discipline.** Phase skills are installed
  non-agent-invocable: they are invoked explicitly by the runner or a human,
  never auto-triggered by a model pattern-matching a description — a model
  must not start a pipeline phase by accident. The model-invocable exceptions
  (`ab-spec`, `ab-tickets`, `ab-guide`, `ab-operate`) are exactly the four
  skills that **drive no phase**; membership is decided by that criterion, not taste.

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
network. A source checkout is identified by its `.git` marker. A managed Bun
install has one of two channels, both derived from the owning `package.json`
dependency and `bun.lock` record, never hardcoded. An npm registry install is
identified when the direct dependency is a semver range the installed version
satisfies and the lock resolves that name to the same registry version. A
movable Bun forge install is identified only when the distribution's
`.bun-tag`, its owning direct `github:owner/repository` dependency, and
`bun.lock` record agree; a fork install therefore follows its fork. Unknown or
contradictory provenance is a named refusal, never a guessed install command.

**Upgrades** run only on explicit `ab upgrade`. By default the command resolves
the latest published version on the installation's channel: the registry's
version document for an npm install, or the latest full GitHub Release of the
installation repository for a forge install. If newer, it
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

Before installation or project writes, upgrades targeting a hosted store probe
its public health range. An incompatible target produces a directional warning
(service first for a newer target, project upgrade for a stale target) and
continues. A legacy health response has an exact-version contract; different
targets warn that the service needs the compatibility-window release. Failed,
timed-out, or malformed probes warn that connectivity could not be verified
and may fail after upgrade, then continue. Merge-only and replacement-process
handoffs check the distribution actually applied before skill writes.

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
human. The skill-upgrade results and merge-derived exit status are unchanged.
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

## 17. Out of scope (explicitly)

- True push `subscribe` (interface reserved; polling implementation).
- Live transcript streaming for writers and readers (the stream primitive —
  SPEC §7.6 — has shipped; agent runners emitting parts and operator UIs
  rendering them remain future work).
- Web UI (seam designed; terminal first).
- Generic workflow DAGs (the grammar is fixed; extension via `verify:*` and
  `finalize:*` only).

## 18. Open threads

1. **[OPEN] Other-ingester detail** — observation harvest is decided (§8.8,
   §12); per-source filter design for scheduled `ingest:*` sources remains
   open.
2. **[OPEN] Retention/archival policy** — the pilot's archival gap, now a store
   config concern rather than a repo problem. Needs a default (e.g. prune
   blobs for merged builds after N months, keep events). Immutable reconcile
   archive refs are retained indefinitely for now; their retention policy is
   part of this open thread.
3. **[OPEN] Global capacity** — per-repo capacity is the top-level `capacity`
   scalar (§16.1); whether a cross-repo global cap is needed, and where it
   lives, is unresolved.
4. **[DECIDED] Hosted, multi-host deployment** — independently deployed
   kernels, build sessions, and operator clients reach the hosted HTTP service
   tier described in §7.2. The tier owns authentication, write-rule and version
   enforcement and will colocate later session-authenticated human routes.
   Artifacts remain content-by-value for now; direct-to-blob references are a
   possible later protocol revision, not a second current deployment path.

## Revision-checked ticket writes

Every ticket read includes an opaque `revision`. Pass it as `expectedRevision`
(on MCP/operator requests) or `--expected-revision <opaque>` on `ab ticket update`,
`move`, `block` and `unblock`. A stale write fails without changing anything and
reports the current revision. Omission preserves unguarded behavior. Blocker
checks cover the entire batch. Dispatcher moves remain unguarded and change the
revision. Sources without guarded writes, including Linear, refuse supplied
revisions rather than ignoring them.

`ab ticket edit <id>` opens `$VISUAL`, falling back to `$EDITOR`, using TOML
frontmatter and a Markdown body. Only title, body and labels are editable;
kind, target, id, blockers, creation key and reference comments are read-only. It saves only
changed fields with the opening revision. Unchanged or formatting-only edits
write nothing. On conflict, invalid input or editor failure, the error names an
absolute file path containing the edited text. Read the current ticket and
reapply the intended changes before retrying; conflicts are never merged.

File and Linear revisions fingerprint kind, target, title, body, canonical label/blocker sets
and state; reverting identical content restores its fingerprint. File checks
re-read immediately before writing, with the existing no-lock race window.
Direct file edits and state-directory moves change revisions. File revisions also
cover structured comments and portable attachments. Legacy file comments change
the body; structured comments preserve it. Separate hosted comments do not change
ticket revisions. Hosted revisions
are monotonic decimal bigint strings, and checks run under the same row lock
and transaction as all requested changes. Hosted reads return a coherent
snapshot of fields, blockers and revision.

### Independent hosted ticket service

`[tickets] url` selects hosted ticket transport independently of BuildStore selection;
without it, tickets use the selected remote build store. Local builds require an
explicit ticket URL. Project registration and ticket policy publication through
`ab connect --tickets URL` work before dispatch. Policy is a durable per-registration
record, outside BuildStore events/artifacts; legacy uploaded configuration remains
a compatibility fallback. Hosted lifecycle defaults are triage/ready/doing/done.
Independent harvest uses revocable, expiring, service-bound ticket grants with
read/create runner authority and read-only child authority. Build state and harvest
journals remain exclusively in the selected BuildStore.

### Ticket source migration

`ab ticket export <dir>` enumerates all states through TicketSource and writes a
portable file tracker atomically to an absent or empty destination.
`ab ticket import <dir>` preflights the entire tracker and target inventory, then
creates or adopts tickets, maps blockers, deduplicates comments by exact body and
restores current attachments. Both run sessionless without forge access.

TicketCreateOptions includes optional `requestedId`. Unsupported sources reject
it. File keeps safe ids exactly; hosted preserves canonical own-team positive
numbers and advances its counter above every occupied number. Creation-key
adoption precedes collision checks. Known kept-number clashes stop import before
any target mutation. Stable migration identities and atomic mapping files make
interrupted imports resumable without content-based adoption.

File frontmatter additionally supports optional structured `comments` (body,
createdAt, optional author) and `attachments` (kind, name, layout, entries with
file base64 bytes or directory paths). Legacy absent fields retain old behavior;
new creates use structured comments. Native file assets retain historical
revisions in hidden source-local metadata and compose with legacy BuildStore
assets. Build claims and spec re-pins freeze native assets into durable snapshots.

State normalization and the complete operator procedure are documented in
[Ticket migration](docs/ticket-migration.md). The same reference is delivered in
the installed guide. Export keeps lifecycle membership without inferring roles;
import reuses unique case-insensitive states and creates normalized missing ones.


Completed `ab ticket import <dir> [--store <ref>]` records a durable repository
`tickets.migration-recorded` fact after all ticket and asset work succeeds. The
fact carries the stable export identity, source/destination adapter names and
complete actual ID mapping. `ab ticket migration record <dir> [--store <ref>]`
verifies a manifest-backed export used directly as a file source, checking every
ID and creation key, and records the same continuity without importing. Tickets
filed afterward in the exported tracker are allowed; only original manifest IDs
enter that mapping.

Current operations resolve historical ticket references forward through recorded
mappings. Completeness, targeting, admission, ancestry and lifecycle writes
retain their gates. Missing routes, uncovered IDs and inconsistent evidence fail
closed at current-ticket and frozen-membership operation boundaries; unrelated
uncovered history does not block intake or alias current-source tickets. History
is never rewritten. Preserve the BuildStore and repository,
quiesce ticket writers during cutover, and resume in-flight builds after recording
and destination validation. See [the migration procedure](docs/ticket-migration.md).


### Tree and consent operator reads

The shared dashboard projection supplies root, node, target, integration build,
merge, restack and consent vocabulary. The terminal groups ready decisions in
one consent queue, retaining build-slug selection for merge/hold controls. Nodes
show stored open children/completeness diagnostics, restack state, current-cycle
verification and merge readiness. Ordinary repositories omit empty tree sections.
The web dashboard consumes shared terminology without introducing a tree surface.

`ab merges [--json] [--store <ref>]` and registry `merges.list` expose the
same deterministic, repository-scoped ready consent/held candidates. A recorded
current decision is required; auto-authorized and consented candidates are absent.
Source `ab ticket tree` / `tickets.tree` enumerate all ticket states with listing
diagnostics; effective build targets remain frozen independently of source metadata.

Default watch attention includes `integration.verification-failed`, `integration.landed`, `node.item-conflicted`,
and conflicted `restack.replayed`. Derived `build.consent-ready` observations
carry target, branch, candidate and the durable readiness entry position in the
existing cursor envelope. Cursor identities retain readiness episodes across
restart; a new candidate or exit/re-entry can wake again. Explicit event globs
remain event-only. Wait adds `consent`, `node-merged`, `restack-conflicted`, and
includes these in attention; current-state waits return immediately, backlog
replay retains event ordering, including merge before terminal completion.

Consent/hold readiness is signalled exclusively by `build.consent-ready`,
including first discovery in a repository-wide watch. `build.merge-decision`
reports current gate deferrals or unsafe forge outcomes, never a second consent
or hold wake. Readiness observations and queue entries share the effective
target shape `{kind, branch, ticket?, build?}`. Tree display labels are owned
by the shared projection vocabulary and reused by terminal and CLI text.

## Forge failure recovery

Leaf restack and reconcile publication retry classified transient forge or transport
failures six times after the initial attempt, waiting 30, 60, 120, 240, 300 and
300 seconds. `publication.retry-scheduled` records the operation, frozen rewrite
identity, episode anchor, failure ordinal, last error and absolute retry time;
restart resumes that schedule without rerunning the resolver. These retries do
not consume `maxPhaseAttempts`. A seventh transient failure records
`publication.retry-exhausted` and raises `publication-retry-limit`, naming the last
error and six retries. Answering that escalation opens a fresh publication episode
for the same retained intent without resetting agent phase failures. Pending
publication keeps its workspace through backoff and unresolved exhaustion.
Classified rate limits retain repository cooldown and consume no publication
retry allowance. Rejected pushes, lease conflicts, dirty trees and unclassified
errors retain their existing behavior.

Janitor failures are durable per-build episodes. Eligible failures retry after
30, 60, 120, 240 seconds, then at the configured cap (300 seconds by default).
Skipped polls preserve the episode across restart. After
`policy.janitorFailureAttentionSeconds` (600 by default), `build.janitor-failing`
notifies default watchers and appears on the build row. A successful attempt
clears it. `policy.janitorBackoffMaxSeconds` sets the positive integer cap.

A classified forge rate limit records repository degradation with `resetAt`.
Forge work waits during cooldown; passing the deadline permits a recovery
request, and only success clears degradation. A further limit extends cooldown.
Native merge application failures keep candidate-specific retry eligibility,
including automatic decisions without a human command. Retries recheck consent,
holds, verification and the exact candidate. Uncertain enables remain pending
until cancellation can be confirmed after cooldown. Publication retries reuse
cancellation receipts only when the forge confirms the same disabled state for
the same candidate and publication operation.

Tick telemetry counts provider wire requests, including failures. Counts are
unavailable for uninstrumented adapters. Attribution retains at most ten builds
ordered by descending count then build name; repository requests are unattributed.
Repository status names a hotspot only when one build makes at least two requests
and more than half of attributed requests. Telemetry never controls workflow.

GitHub shares in-flight and completed PR, branch/ref and comparison observations
across builds within one dispatcher tick. Opened nodes prime their tips and
commit distance with at most two reads: PR plus comparison, or parent branch
plus reversed comparison without a PR. Priming is best-effort: failures add a
diagnostic and ordinary parent/target observations continue, so a deleted parent
can still be replaced. Forge cooldowns and rate limits retain their gates.
Each admitted poll revalidates mutable resources
using exact-resource ETags; authenticated 304s spare the REST primary quota.
Adapter caches are bounded and restart/eviction falls back to fresh reads.
Writes, including Git publication and rewrites, invalidate observations before
attempting the mutation so acknowledgement reads remain fresh. Leaf PR polling
keeps its existing cadence. Readiness and merge inspections remain fresh.

Opened integration nodes poll every tick until their durable activity has been
quiet for `policy.nodeIdleAfterSeconds` (default 600 seconds), then poll every
`policy.nodeIdlePollSeconds` (default 120 seconds). Holds and waiting for consent
qualify normally. Child claims, PR and merge activity, operator commands
(including repeated holds), restack requests and answers wake the next tick.
GitHub-only changes are discovered on the next due check, within the idle
interval plus normal tick scheduling while the dispatcher is running; failure,
cooldown and transport-budget gates still apply. Pending operations retain
active polling and action-time readiness checks remain fresh. Successful
`node.poll-checked` facts preserve quiet history across restarts; missing facts
force a fresh check. `ab build status` reports active or idle cadence and the
last successful check (or unrecorded evidence).


The total includes all attempted requests. Optional `restPrimary`,
`restNotModified` and `graphql` counts distinguish REST responses charged to the
primary quota, REST 304s and GraphQL calls. Transport failures and historical or
legacy observations can remain unclassified; absent fields never imply zero.
Shared requests are attributed to their first requester; cache hits count zero.

## Integration verification attention

A failed node verification cycle records `integration.verification-failed` with its prepared cycle id, failed steps, exact head and parent, and guidance to file a repair child targeting the node. The kernel reports durable failed receipts; dispatcher housekeeping recovers missing reports for the current cycle using a per-cycle CAS guard. Superseded cycles are never backfilled with repair instructions: recovery requires the latest prepared cycle to match the node’s observed head and parent. This fact is decisive evidence and bookkeeping, and does not change verification or leaf routing.

Default `ab watch` includes this event. Watch cursors deliver each failed cycle once and baseline failures when first armed; reconcile build status after arming. `ab wait --for attention` also detects a current failed node cycle before the report is written. Historical facts remain queryable after repair without retaining current attention. Explicit event globs and existing stored wake choices are preserved.


### Project secrets

Project secrets are product-managed write-only project environment values,
separate from machine credentials and BuildStore artifacts. A connected member's
saved owner credential can list metadata, set/replace and remove; every operation
revalidates project membership. Build, dispatcher, delegated, internal and admin
credentials cannot manage them. The current setter is the owner; values serve all
builds of the project. Values and refresh/access state are authenticated-encrypted
under a deployment-held key; audit records contain only actor, time and operation.
No public surface returns material. Authority and process-control names are reserved.

Every hosted tick resolves a coherent complete set, overlays project values onto
its own deployment environment, and records revision-fenced supply timestamps at
kernel handoff. Encryption keys are excluded from child environments. A failed
resolution prevents intake and launches for that project. If ready credentials can
be read and revision-fenced, an observation-only recovery pass supplies them solely
to repair running execution policies, withholding unavailable names. Unrelated
account transforms remain active; no janitor, resume, lease-sweep, or harvest work
is launched. If the ready subset cannot be read, the project is skipped. Projects without secrets
resolve and hand off an empty set without encryption configuration; all secret
mutations still require a valid key. Adding a secret invalidates an earlier empty
snapshot before handoff. Local dispatch behavior
is unchanged. Refresh kinds serialize external rotation with a committed CAS
attempt, persist replacement state before delivery, and fail expired attempts
without takeover. A failed credential requires explicit replacement. Valid
credentials before their earliest refresh time remain usable, even inside a
requested future validity horizon. The first eligible five-minute hosted tick
refreshes and persists rotation before supply, including expired access state
after downtime when the refresh credential remains ready. Providers without an
earliest refresh time use a ten-minute pre-expiry margin. Failed or uncertain
refresh attempts prevent supply. A refresh window shorter than five minutes plus a one-minute
margin emits typed advisory metadata, never invalidates a valid credential and
never causes revocation. The public
CLI writes static values or typed ChatGPT registrations. The fifth web tab,
Settings, lets any project organization member or super user inspect metadata
and account credential slots, set static values, and remove secrets. Browser
writes use the unexpired cookie session and fresh project membership, attribute
the normalized signed-in email, and require same-origin JSON. Browser replacement
atomically refuses non-static credentials; renewing those stays in
`ab accounts login <account> --project`. Password fields are transient and clear
on acknowledgment; reads never refill them. Removal requires the shared
confirmation dialog. Secret management remains available without recorded
dispatcher configuration. See the project-secrets section of the remote-store protocol.

### Named billing accounts

Deployment-owned `[accounts.<name>]` descriptors contain `kind` and
`credentialEnv`, plus the closed Kimi `region` (`overseas` by default or `china`).
Role and alternate `account` axes inherit independently. Claude routes default
to the sole Claude subscription account; ambiguity, unknown references and
incompatible runtimes fail configuration. No accounts preserves legacy behavior.
Claude and Kimi accounts require the unmodified Claude Code runtime; ChatGPT
subscription accounts require explicit Codex selection. Use the user's own plan
for ordinary individual usage. Claude and Kimi credentials are provisioned
manually. ChatGPT credentials are authorized with `ab accounts login NAME
[--local|--project]`. The local dispatcher or hosted refreshing project secret
is the sole refresh owner; no sandbox refreshes. Local Codex uses a protected
loopback inference transport and isolated CODEX_HOME, preserving the shell HOME
and leaving ambient login untouched.
Hosted validation uses write-only metadata and states that the first hosted
build is the live check; local validation makes a minimal runtime request.

Local sessions resolve host credentials after ambient merging. Remote sessions
receive account placeholders; exact provider hostname and placeholder header
matches broker real credentials on the host. Both Kimi endpoint and host derive
from one closed regional mapping, without cross-region retry. Observation ticks
refresh the live egress policy from dispatcher environment values. Selected
account descriptors persist with sessions for continuation; configuration and
launch artifacts contain no secret values. Credential rejections require renewal
and bypass alternates; quota and availability retain existing fallback behavior.
Account secrets are redacted at persistence boundaries, including split streamed
deltas and prior values retained across rotation.


### Hosted project deletion

The Projects web surface allows super users and organization owners to preview
counts and permanently delete their authorized projects with the shared confirmation dialog.
PostgreSQL fences the registration generation before physical blob cleanup and
retains durable pending inventory for restart/retry. Upload ownership is reserved
in a separate committed transaction before provider I/O; transaction-scoped shared
blob locks cover upload/publication, and exclusive locks cover reference checks
and physical deletion. Other projects' references and reservations preserve shared
bytes. Completion removes all project rows except repository, actor, deletion time
and an opaque generation id in the deletion audit. Old credentials receive 401;
repository-established requests receive 403 project not registered. Approval of a
fresh connection starts empty and resets hosted ticket numbering. `ab disconnect`
revokes credentials only; admin `projects remove` unregisters without purging.
See [project deletion protocol](docs/operator-api.md#permanent-project-deletion).
