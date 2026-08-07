# Architecture

The contributor-facing map: how the codebase is organized and where the
seams are. `SPEC.md` is the source of truth for the design and terminology;
this document maps it to the code. For the user journey — install, configure,
operate — see [`README.md`](../README.md); for the complete declarative surface,
see [`docs/configuration.md`](configuration.md). Behavioral detail beyond what
a map needs lives with the code and its tests; when this document and the code
disagree, the code is authoritative.

## Constitution

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state. Narrow non-phase judgment such as
   slug naming and skill-conflict proposals remains behind deterministic
   validation and fail-safe fallback.
2. **Resumability is not a feature.** Re-running `ab dispatch` attempts every
   current build; each phase resumes as a function of durable state.
3. **Ingesters propose, humans dispatch.** Nothing auto-generated passes
   Triage without a human grooming it to Ready, unless the repository waives
   that gate explicitly with `[tickets].proposalState`.
4. **Every step leaves a paper trail** — queryable, not carried in the repo.

## Pipeline

```
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
       └────────────────── epilogue: (pr.conflicted → reconcile → verify:*)* → merged
```

The grammar is fixed; `verify:*` and `finalize:*` are the only extension
points, declared per-repo in `autobuild.toml`. Observation harvest is
adjacent, never a build phase:

```
K unclaimed observation.recorded events
  → scan → synthesize ⇄ review → file approved proposals in proposalState
                                  (Triage by default)
```

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs, the canonical verify outcome | §4 |
| `src/events/` | Separate build and repository envelopes/catalogs, frozen payload schemas, actor validation | §15 |
| `src/harvest/` | Structured occurrence, scan packet, proposal, and ledger schemas | §12 |
| `src/store/` | BuildStore plus repository-journal contract; interface-enforced build and local ambient-session scope wrappers; memory, SQLite/blob, and remote HTTP adapters | §7 |
| `src/kernel/` | Phase table, build reducer, engine; pure harvest, dispatcher-settings, dispatcher-status, and PR-attachment selectors; converge, stall detection, verify gating | §5, §7.5, §10, §12, §14, §15.4–15.5 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, and fakes; registry-aware builtin/plugin construction; eager primary/alternate runtime routing and provider-failure classification under `ports/runner/` | §3.2, §9, §13 |
| `src/plugins/` | Strict versioned plugin manifests, dual-root repository/package Bun loading, owner-aware adapter registration, contract/credential metadata, and runtime-factory materialization | §3.2.1, §9 |
| `src/plugin-sdk/` | The sole supported `autobuild/plugin-sdk` barrel: port/manifest types, contract suites, and reference fakes | §3.2.1 |
| `src/processes/` | build-runner and standalone child composition, durable execution config/diagnostics, dispatcher (+ janitor duty and harvest trigger), harvest deterministic core + runner | §3.3, §12, §15.7 |
| `src/cli/` and `bin/` | The `ab` CLI — the only agent↔store channel — plus init/upgrade, the Store-only dispatch frontend, its private supervised kernel entry, and `bin/ab-build-runner.ts` (one child per build) | §8, §14, §16.3 |
| `src/cli/dashboard/` | `ab dispatch`'s fixed live frame: pure projection, renderer, poll cache, and deterministic image renderer | §14 |
| `bin/agent/ab` | Private launcher placed first on agent-session `PATH`; delegates to the canonical `bin/ab.ts` | §8.1 |
| `src/config/` | `autobuild.toml` parsing and strict validation, plus the pure role-key consumability diagnostics `ab dispatch` reports at startup (`roles.ts`); user reference in `docs/configuration.md` | §9, §16.1 |
| `src/integration/` | End-to-end harness and product scenarios | — |
| `tools/` | This repository's local maintainer tooling, including verification, dashboard capture, and release cutting; not shipped product behavior | — |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference for the lifecycle and full config surface; `references/` is the shared installed-documentation seam for every vendored skill. Update it when config or shared guidance changes; `src/cli/guide-skill.test.ts` guards schema coverage and `src/cli/skill-self-containment.test.ts` guards installed references | §16.3 |
| `docs/spec-standard.md` | The standalone definition of "buildable" every ticket surface uses; kept byte-identical with `skills/guide/references/spec-standard.md` for installed agents | §6.1 |
| `templates/` | Valid setup-only config baseline with comment anchors rendered by `ab init` | §16.3 |

## Key boundaries

Where each mechanism lives, and the one rule worth knowing at the seam. The
full behavior is specified by each owner's colocated tests.

**Events and state.** `src/events/payloads.ts` and `src/events/repository.ts`
are the frozen catalogs; every write passes `validateEventWrite` /
`validateRepositoryEventWrite`. `src/kernel/reducer.ts` derives all build
status; `src/kernel/harvest.ts` and `src/kernel/dispatch-settings.ts` reduce
the repository journal independently of each other. No decision anywhere
consults a snapshot in place of the append-only log.

**Session Store authority.** `src/cli/binary.ts` validates a complete build or
Harvest ambient tuple before opening its phase Store through
`src/cli/store-opening.ts`. `src/cli/env.ts` also classifies optional ambient
identity for the finite `builds`, `build status`, and `artifact download` read
shells: no identity retains operator authority, while any partial, malformed,
shared-only, or mixed identity fails closed before Store opening. Remote
references keep the existing token-backed client unchanged. Local references
are wrapped by `src/store/session-scope.ts`, which permits only the exact
ambient build or repository resource and rejects agent-attributed event writes
for any session other than `AB_SESSION`. The wrapper deliberately allows
non-agent actors because phase terminals also run trusted kernel plumbing in
that CLI process; resource authority still applies to every operation. Generic
sessionless opening remains unwrapped; only those three reads use the dedicated
ambient-aware finite opener.

**Phase decisions.** `src/kernel/phases.ts` owns the phase table,
`src/kernel/engine.ts` the deterministic transitions;
`src/processes/build-runner.ts` executes the decisions. Agents reach state
only through `src/cli/` terminals, which convert artifact deposits into
event facts atomically — the engine never reads blobs. Engine crash-gap and
exhaustion guards query the event log for a later escalation raise with the
exact same source/class and target phase; the triggering sequence remains the
re-arm boundary. `BuildRunner` applies the same independent targeting at the
setup seam, where only a setup-targeted policy raise can satisfy setup
exhaustion.

**Phase-session budgets.** `src/ports/runner/routing.ts` resolves one inherited
`sessionBudgetSeconds` value for each logical role, with the policy default as
its final fallback. `BuildRunner` captures it at the session action boundary,
starts an unref'ed timer after `session.started`, and composes expiry with the
existing operator `AbortController`. Expiry stops waiting even if an adapter
ignores cancellation, best-effort ends an available or late-returning handle,
drops producer continuation state, and reuses retryable `phase.failed`; it does
not enter the provider-alternate classifier. The event log is checked before
failure so a typed terminal racing the deadline wins. Finalize agent post-steps
reuse the timer but drain expiry through their existing failure-tolerant
completion and observation path. Harvest and deterministic commands do not use
this build-phase timer.

**Human guidance delivery.** The routing fact is an `escalation.answered`
event carrying `resolution: "guidance"`; nothing else routes an answer. `ab
answer` and the dashboard's blocked-build resume control are two surfaces over
the one `src/cli/build-control.ts` operation that appends it, so delivery is
identical whichever a human used.
`src/kernel/engine.ts` routes answers from `plan` and `plan-review` to the next
`plan` round, and answers from `implement` and `code-review` to the next
`implement` round. An agent verifier's own escalation is the deliberate
exception to producer routing: its answer returns to that same step on
`verify.started.feedback`, and `PHASE_SPECS.inputs.currentFeedback` makes `ab
context` the delivery channel. When a failed verify report instead exhausts
policy, guidance answering that policy escalation takes precedence over the
pending report as the failure routes to the next `implement` round. For these
engine-routed destinations, `engine.ts` chooses the newest answered guidance
for the requested destination before checking whether its durable carrier
reached a matching session launch. That ordering makes supersession durable:
delivering the winner cannot reveal an older same-destination answer, while
plan, code, and exact-verifier destinations remain independent and a new answer
after delivery remains eligible. The projection uses only event history, so
restart and decision replay agree.
`finalize` and `reconcile` have no producer round, so
`PHASE_SPECS.inputs.answeredGuidance` makes `ab context` their delivery channel
for the latest answer addressed to that phase. On every receiving path,
`src/cli/context.ts` materializes `.ab/guidance.json` with the escalation id and
answer text. For producer and verifier feedback routes, `src/kernel/engine.ts`
indexes each guidance-bearing phase start as a durable carrier and pairs only
the latest carrier for an exact phase plus round/attempt with a subsequent
matching `session.started`. An unpaired carrier remains deliverable across
recovery; the matching launch consumes it once without process-local state. A
producer round's feedback is a discriminated union — findings, a
failed verify report, or guidance — and a round may carry none, so a round with
guidance writes no `.ab/findings.json`. The receiving skills document their
corresponding input, and `src/cli/skill-guidance.test.ts` derives that
requirement from the phase table.

**Finalize publication.** Content-producing `finalize:*` checks or agents
select and commit files locally and leave a clean worktree. `build-runner.ts`
derives the last published head from event facts, rejects a non-descendant
`HEAD`, and uses the `Forge.pushBranch` port for a regular kernel-side push
before checkpointing the new head on `finalize.step-completed`. An unchanged
head is a no-op; Git/Forge failures stay failure-tolerant observations.

**Verify gating.** `src/ontology.ts` owns the canonical
`pass | fail | skipped` outcome (only `fail` routes back to implement or
consumes attempts; a skip satisfies one step without being passing
evidence). Two kernel-authored skip sources narrow the configured universe:
`src/kernel/plan-verify-selection.ts` resolves an approved plan's front-matter
selection (applied at the planner's `ab done` in `src/cli/terminals.ts`,
snapshotted by the engine at approval), and
`src/kernel/verify-applicability.ts` matches changed paths against a step's
selectors, resolved by the build runner via `git diff` against the initial
branch-cut base (or the refreshed base promoted by a completed reconcile).
This verify-only base is deliberately independent from implementation's
focused review range. Both narrowing mechanisms produce the ordinary
queryable skipped outcome; Git failure is infrastructure and fails closed,
never a synthetic skip. Verify escalation routing is also explicit in the
engine: guidance answering an agent verifier's own `ab escalate` returns to the
same step on `verify.started.feedback`, which `ab context` materializes as
`.ab/guidance.json`; that cited start remains recoverable before launch, and the
matching `session.started` for the same step and attempt consumes the answer
once. Guidance answering the policy escalation after failed-report exhaustion
instead routes to `implement` and outranks the pending report. A bare retry carries no
feedback.

**Launch ownership.** `src/cli/dispatch.ts` is the kernel owner and
single-flights supervised build executions per slug within its process. It
publishes effective config into the build artifact namespace, then calls the
workspace-adjacent `BuildExecution` capability; it never constructs a
`BuildRunner`. The shipped local capability starts `bin/ab-build-runner.ts`
with ignored stdio. That child immediately scopes its Store handle, discovers
its workspace from durable events, and composes the existing runner. Config and
instance-correlated diagnostics remain build artifacts; process exit is only a
liveness/reaping signal. Interactive `ab dispatch` runs the kernel owner in the
private `bin/ab-dispatch-kernel.ts` child;
`dispatch-frontend.ts` owns only terminal/Store adapters and
`dispatch-process.ts` owns child supervision. SIGINT, SIGHUP, SIGQUIT, and
SIGTERM restore terminal modes immediately and begin one supervised drain;
persistent frontend and child handlers keep repeated signals graceful until the
kernel child is reaped, after which a non-SIGINT terminating signal is replayed
in the frontend. A parent-liveness watch remains the detached-kernel fallback.
Timeout escalation is held while a durable `tick-started` fact remains open,
because force-killing the ticket claim before build creation would not be
recoverable. The supervisor rechecks kernel-child liveness at the force boundary
and projects the same normal, forced, or abnormal result (with available
process/error detail) that the repository run-stopped evidence records. Ordinary
kernel teardown stops and reaps all build children; their own parent-death
watch and lease expiry recover an abrupt kernel death. The BuildStore lease
remains the cross-process gate. `src/processes/dispatcher.ts` counts actual
schedules, not suppressed polls. Open session history is never a lock — a dead session
may never close.

**Store authority.** `src/store/build-scope.ts` wraps every adapter with one
build's authority. Own-build record/event/artifact/lease/subscription calls
delegate; foreign-build, collection/admin, close, and repository-journal calls
raise `BuildScopeError`. The shared Store suite applies these checks to memory,
SQLite, and remote clients, while HTTP token scope remains defense in depth.

**Live configuration.** `src/config/live.ts` owns the running dispatcher's
immutable last-valid main-checkout snapshot, exhaustive hot/restart field
classification, and eager role resolver. The watch loop refreshes it before
each tick and publishes the exact accepted TOML and the composed effective JSON
atomically with a run-correlated `dispatcher.config-reloaded` repository fact
before making the snapshot visible. Startup similarly publishes the effective
artifact before the first tick. Missing, unreadable, malformed, and
routing-invalid candidates retain that snapshot with a durable deduplicated
operator notice; restoring a valid file resumes ordinary reload. Dispatcher
ticks and build/harvest actions capture one snapshot at their own boundary; the
dashboard validates and projects only the referenced effective artifact, so an in-progress
turn or command is never interrupted. Scoped phase CLI processes retain their
separate build-worktree config boundary. Startup-built plugin, forge, ticket,
and workspace adapter fields stay pinned; changed values are durable restart
notices rather than partial adapter swaps. `--once` retains static startup
configuration.

**Harvest.** The dispatcher owns the threshold trigger and starts runs
fire-and-forget; `src/processes/harvest.ts` is the deterministic core (scan,
source-aware originating-ticket lifecycle projection, filing-time blocker
resolution, occurrence identity, and the exhaustion partition),
`harvest-runner.ts` executes the staged workflow under the heartbeated
repository lease, records declared/derived blocker provenance, and
`src/kernel/harvest.ts` reduces runs, claims, recovery history, and the
committed ledger with ordered parked/exhaustion/open selectors. Its pure
creation selectors pair reservation/filing facts, bound unmatched keys to
active runs, and conservatively union reservations first seen between the
repository snapshots bracketing a ready listing. `src/processes/dispatcher.ts`
correlates those keys before dependency reads or claims, retaining queue depth
and emitting creation-specific tick diagnostics. The recovery
invariants are SPEC §12; the mechanics live in the reducer and its tests.

**Ticket sources.** `src/ports/tickets/`. `listReady` is an explicit
partial-listing seam: individually malformed records come back as
diagnostics (surfaced by the dispatcher's tick report and `ab ticket list`
stderr) while tracker-wide invariant violations stay fatal — one broken
ticket never blocks unrelated dispatch, but nothing that could permit double
dispatch is tolerated. `Ticket.creationKey` is the optional stable external
create/adoption correlation, distinct from `Ticket.ref.id`; Linear projects its
issue UUID and file/fake preserve their idempotency metadata through create,
adoption, get, and list paths. Legacy/plugin tickets may omit it and dispatch
unchanged.

**Workspace, execution, and review base selection.**
`src/ports/workspace/create.ts` resolves `[workspace].provider` against the
builtin-plus-plugin registry once during production wiring and pairs it with a
`BuildExecution` capability. A provider-supplied capability substitutes at
that seam; otherwise the shipped local subprocess capability is used. The builtin stays
store-root-aware; selected plugin factories receive their nested config,
environment, and absolute repository root. `WorkspaceHandle.ref` remains a
provider identifier while `path` is the locally reachable working copy used by
runners and forge calls; both are recorded, with `ref` as the historical-event
fallback. `src/ports/workspace/git-worktree.ts` selects the branch-cut base once
at first creation, fetching into a build-scoped private ref; re-provisioning
resumes at the branch tip and never re-cuts, so the first provisioning fact
remains immutable provenance. Separately, each successful implementation terminal in
`src/cli/terminals.ts` asks the Forge to snapshot its authoritative base when
that optional capability exists; otherwise it privately refreshes the frozen
target branch from `origin` and records
the unique merge-base of that snapshot and `HEAD` in `implement.completed`.
It fails before publication/deposit on fetch, ref, ancestry, or ambiguity
errors and writes neither `FETCH_HEAD` nor operator refs. Reconcile's
execution-time target refresh in `src/processes/build-runner.ts` remains a
third, deliberately separate boundary and also fails closed.

**Agent runtimes.** `src/ports/runner/`: `runtime.ts` (capability-carrying
registry plus boundary validation), `routing.ts` (eager role resolver),
`production.ts` (shipped Claude/Codex/Pi registrations), `codex.ts` (direct
Codex `exec --json` subprocess protocol with native thread resume), `one-shot.ts` (optional
tool-free non-phase completions — slug naming via `src/cli/dispatch.ts`,
skill-conflict proposals via `src/cli/upgrade-agent.ts`), `provider-error.ts`
(positive-only permanent-failure classifier), and `session-env.ts` (per-turn
environment merge that fronts `bin/agent/ab` on `PATH`). Adapters own SDK-native
error extraction; processes own durable failure policy — the transcript is
always deposited, and a turn's typed terminal always beats a late failure
signal.

**Plugin bootstrap and CLI composition.** `src/plugins/load.ts` resolves
repository-path modules from the config-bearing root and bare packages from an
explicit package root (defaulting to that same root), validates each default
manifest/API range, and atomically registers normalized factories, provenance,
ticket credential metadata, and optional contract descriptors before production
wiring or the first dispatch tick. Its structured single-module attempt feeds
two policies: `loadPlugins` remains fail-fast for dispatch, while
`diagnosePlugins` collects ordered failures and retains later healthy
registrations for `ab plugin doctor`. `src/cli/plugin.ts` owns the sessionless
list/doctor/test grammar and live gate; `src/plugins/contract-entry.ts` reloads
one selected registration inside a real `bun test` process and registers exactly
one unchanged port suite.

`src/ports/forge/create.ts` resolves the root `forge` selector, constructs the
shipped GitHub or local-git adapter, or lazily invokes a registered plugin
factory, and preserves the returned adapter's optional capabilities. The
local-git adapter in `src/ports/forge/local-git.ts` stores versioned JSON PR
records as blobs behind private `refs/autobuild/local-git/` refs in the shared
Git database. It computes mergeability with `git merge-tree`, leaves the build
branch reachable, and lands a guarded single-parent squash locally. For a
checked-out base, dry-run and real `git read-tree -m -u <old> <landed>` calls
let Git carry forward non-overlapping operator changes and report colliding
paths. The pending landing precedes the guarded ref update; a later poll retries
the same two-tree checkout transition across the crash window and observes the
PR as merged only after synchronization succeeds. Forge-native base snapshotting lets
it pin the current local base without `origin`, while capability-less adapters
retain the legacy private-ref fetch path. Dispatch constructs one
selected adapter before opening the store and threads it through runners,
epilogue, and janitor work. Scoped `src/cli/binary.ts` processes independently
load immutable config and repository-path plugins from the build worktree, use
`resolveMainRepo` to locate the consuming checkout only for bare-package lookup,
and resolve the same adapter name for phase terminal plumbing. This keeps
package availability independent of local-store/worktree placement without
redirecting branch-owned plugin source or factory `repoRoot` away from the
worktree. `src/ports/workspace/create.ts` similarly resolves
`[workspace].provider`, retaining host-owned git-worktree construction while
passing plugin config, environment, and repository root to registered
factories. Ticket-source selection is registry-backed in
`src/ports/tickets/create.ts`; dispatch and sessionless `ab ticket` commands
load plugins before constructing it.

`src/plugins/runtimes.ts` invokes plugin runtime factories in registration
order, validates their capability-bearing registrations, and returns one fresh
registry containing builtins and plugins. Dispatch performs that composition
before eager role resolution and shares the result with build, harvest, and
slug routing. Upgrade performs the same composition lazily at its first merge
conflict.

`src/cli/repo-state.ts` owns repository identity and store precedence
(`--store` > `AB_STORE` > `.autobuild/`); `src/cli/store-opening.ts` is the
production store composition boundary shared by finite sessionless queries and
phase sessions. Its shared scoping primitive preserves remote token composition
and adds local ambient authority only for filesystem stores. The dedicated
ambient-read opener classifies identity before repository or Store opening and
is adopted only by `ab builds`, `ab build status`, and `ab artifact download`;
all other sessionless commands keep the generic unwrapped opener.
`src/cli/repository-status.ts` consumes that boundary and the kernel's
`reduceDispatchSettings` projection to report journal-backed dispatcher
controls without ensuring a repository stream or starting dispatcher work.
`src/cli/args.ts` parses command-scoped flag contracts; `src/cli/binary.ts`
classifies build/harvest session tuples and routes sessionless invocations, so
phase-only commands report their complete runner context when run by hand.

**PR attachments.** `src/cli/artifact.ts` atomically turns an explicit
`artifact put --attach` into an exact artifact plus designation fact.
`src/kernel/pr-attachments.ts` selects current designations, hosted
correlations, and pending cleanup without coupling to a producer or verify-step
name. `src/cli/pr-attachments.ts` performs optional image hosting through the
narrow Forge capability, while `src/cli/pr-summary.ts` renders the same complete
text projection for finalize and late designations. The GitHub release transport
lives in `src/ports/forge/github-pr-attachments.ts`; terminal-build reclamation
and retry facts remain dispatcher janitor duty.

**Abort control and cleanup.** CLI and dashboard call the same
`src/cli/build-control.ts` service. A confirmed dashboard `a` action appends only
the durable abort request. After claiming the build lease, `build-runner.ts`
acknowledges an already-pending pause or abort before workspace setup, without
appending `runner.attached`; resume and workspace-using decisions stay behind
successful setup. For a request arriving during an AgentRunner turn, the runner
observes the BuildStore subscription, forwards an `AbortSignal`, deposits/ends
the session without a phase failure, acknowledges abort, and releases its lease.
`dispatcher.ts` then resumes the unchanged event-checkpointed janitor saga that
closes an unmerged PR, releases the workspace, deletes exact remote/local branch
refs, unions `autobuild:aborted` into current ticket labels, returns the ticket to
Triage, and appends abandoned completion last. Forge close/delete operations are
optional API 1.2 capabilities so older plugins load but leave cleanup visibly due.
AgentRunner failure causes and the exhaustion contract fixture are additive
plugin API 1.3 surfaces; legacy failures without a cause retain permanent-bit
behavior.

**Dashboard.** `src/cli/dispatch-frontend.ts` is a Store-only terminal adapter:
it has no ticket, forge, workspace-provider, LiveConfig, or runtime dependency.
It follows one dispatch run's repository facts incrementally through
`src/kernel/dispatch-status.ts`, retaining only low-volume settings/Harvest
facts for their replay reducers, validates/caches its effective-config artifact,
and polls build streams independently while elapsed paints continue from cached
intervals. The same polling path calls the canonical
`scanUnclaimedObservations` BuildStore reduction for the header's current count
and pairs it with the effective config's `policy.harvestThreshold`. That sample
is process-local presentation state: a failed refresh preserves the last
successful value and adds a local diagnostic, while an initial failure delays
the complete frame rather than inventing zero. No repository fact transports
it, and the headless child does not scan for presentation. Navigation is
synchronous presentation state; only Store reads and writes enter its UI action
queue. The supervised kernel child owns every slow
adapter operation, so slug naming, provisioning, runners, and Harvest cannot
block input.

`src/cli/dashboard/model.ts` is the build-row projection;
`detail.ts` projects chronological session history from the same retained log,
and `transcript.ts` heuristically presents opaque transcript artifacts with a
raw fallback. `render.ts` composes the list, build-detail, and transcript as
cell-honest Unicode frames; `keyboard.ts` owns Kitty keyboard-protocol
negotiation and CSI-u decoding, while `live.ts` owns normal teardown and
sequences its push and pop with the alternate-screen region because the
terminal's keyboard flag stack is per-screen. Every mode enters and leaves through
the declarations and active ledger in `terminal-restore.ts`; `binary.ts` installs a dispatch-only synchronous
process-boundary fallback over that same ledger for faults and terminating
signals that bypass normal teardown. `poll.ts` is a display-only incremental
cache (the logs remain authoritative — cache loss just
rehydrates); `frame-image.ts` renders a deterministic PNG with pinned fonts.
`composer.ts` owns the text geometry the blocked-resume panel edits against —
display-cell wrapping and caret layout, plus cursor motions expressed as UTF-16
string offsets normalized to extended-grapheme boundaries — as pure, ANSI-free
arithmetic shared by `render.ts` and `dispatch.ts`.
Nested navigation, session selection, and pinned artifact retrieval are
read-only process-local UI concerns. Build actions still use the shared control
service and append human facts; the header shows acknowledged durable state,
never optimistic intent. Forge mutation stays in dispatcher plumbing.

**Init and upgrade.** `src/cli/init.ts` owns deterministic skill vendoring,
ignore maintenance, runtime probes, and the stack-neutral first config. It then
launches an interactive agent CLI, or prints the identical short prompt, telling
the setup agent to read the installed
`.agents/skills/ab-guide/references/setup.md`; this bypasses all build and
BuildStore session plumbing. Existing config is never reconciled, even with
`--force`. `src/cli/upgrade.ts` owns the pristine × local × incoming skill merge,
the provenance-safe fixed retirement of obsolete defaults, and all writes:
agent output is an untrusted proposal validated before anything touches disk,
and every failure path leaves live and pristine byte-untouched.

## Development

```sh
bun install
bun run check     # Biome lint + format, zero diagnostics
bun test          # unit tests, colocated *.test.ts
bun typecheck     # tsc --noEmit
```

For dashboard presentation work, run the repository-only hot CLI:

```sh
bun run dev -- dispatch
# Generic form: bun run dev -- <ab arguments>
```

Bun keeps the original CLI promise and its `DispatchLoop` alive while hot
module evaluation replaces only the renderer used by the next repaint. Edits
to `src/cli/dashboard/render.ts` and presentation-only dependencies imported
by it appear without restarting runners, releasing leases, or stacking input
handlers. Changes to dispatcher logic, dashboard model/controller logic,
keyboard handling, or build-runner code still require a restart. The
installed `ab` binary remains the non-watching production entry.

### Contract suites

The seams are the contract. Five reusable contract families run the same
behavioral assertions against every implementation:

- `src/store/contract.ts` — `BuildStore` and `BlobStore`;
- `src/ports/tickets/contract.ts` — `TicketSource`;
- `src/ports/workspace/contract.ts` — `WorkspaceProvider`;
- `src/ports/forge/contract.ts` — `Forge`, including idempotent PR close and
  branch deletion with merged-race preservation;
- `src/ports/runner/contract.ts` — `AgentRunner` session/continuation,
  transcript metadata and usage, typed failure permanence/cause, per-turn
  ambient environment refresh and cancellation, distribution-managed `ab`
  resolution, and the optional tool-free one-shot capability.

`src/ports/runner/routing.ts` eagerly resolves every role's primary, ordered
alternate targets, and independently inherited build-session budget.
`build-runner.ts` and `harvest-runner.ts` own the deterministic
primary-first attempt loop: each substitution opens a new session bracket,
records provenance on its start, and only complete-chain exhaustion consumes an
existing phase/session attempt. This keeps runtime availability routing out of
agent judgment while preserving transcript and artifact actor attribution.

A normal `bun test` runs the memory/fake/local registrations, including a fake
selected through the plugin ticket-source registry, the real filesystem and
local-git adapters, the injected Claude and Codex CLI subprocess contracts,
and the injected Pi SDK contract.
Both `ab dispatch` and sessionless `ab ticket` load the repository's plugins
before selecting their TicketSource; dispatch passes that one adapter instance
through readiness, dependency, harvest, and completion paths. The Linear,
GitHub, and real-runtime AgentRunner registrations are present in the same run
but reported as skipped: live provider access requires credentials/resources
and an explicit opt-in. When
adding an adapter, start from its contract suite, not only the interface.

To run the Linear contract manually against a destructive scratch target:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
LINEAR_API_KEY=… \
AB_LINEAR_CONTRACT_TEAM_KEY=SCRATCH \
AB_LINEAR_CONTRACT_PROJECT_ID=… \
bun test src/ports/tickets/linear.live.test.ts
```

The token must be able to create, update, relate, and archive issues in the
configured project, and to create and delete issue labels in the configured
team. The team needs a claimable `unstarted` or `backlog` state, a `started`
state, a `completed` or `canceled` state, and at least one issue label the
contract can replace/clear. Every issue gets a reserved UUID and is attached to
that project. Cleanup archives those issues and deletes the fresh team labels
created by the unknown-label contract cases; failures are reported so leaked
fixtures can be removed manually. Use a project with no real work in it.

To run the GitHub contract manually:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
GH_TOKEN=… \
AB_GITHUB_CONTRACT_REPO=owner/destructive-scratch-repo \
bun test src/ports/forge/github.live.test.ts
```

`GITHUB_TOKEN` may be used instead of `GH_TOKEN`. The repository must have
native auto-merge enabled, an initialized default branch, no inherited
merge-blocking rule that catches the UUID-namespaced contract branches, and a
token with repository admin, contents, pull-request, comment, and branch
protection permissions. The fixture creates and deletes temporary branches,
PRs, comments, and a required-check protection rule; it never pushes to or
merges into the default branch. Use a dedicated scratch repository only.

The deterministic Claude, Codex, and Pi adapter contracts run offline in every
normal test run. Their live registrations add real transport/authentication smoke
coverage for successful start, continue, end, environment refresh, managed CLI
execution, and one-shot completion:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
AB_CLAUDE_CONTRACT_MODEL=claude-sonnet-4-… \
bun test src/ports/runner/claude.live.test.ts

AB_RUN_LIVE_PORT_CONTRACTS=1 \
AB_CODEX_CONTRACT_MODEL=gpt-… \
bun test src/ports/runner/codex.live.test.ts

AB_RUN_LIVE_PORT_CONTRACTS=1 \
AB_PI_CONTRACT_MODEL=openai/gpt-… \
bun test src/ports/runner/pi.live.test.ts
```

Claude uses the locally installed Claude Code CLI and its configured login; the
live command therefore requires an installed `claude` executable whose browser
login has already completed. Its offline suite injects a subprocess executor
and covers direct argv, native resume, stream-json parsing, usage, transcripts,
and failure classification without launching the CLI. Codex similarly uses the
locally installed `codex` executable after `codex login`; its offline suite
pins direct argv, `$skill` invocation, JSONL parsing, native thread resume,
startup diagnostics, and tool-free one-shot rejection. Pi uses the credentials
required by the provider named in `AB_PI_CONTRACT_MODEL`. The live fixtures
create isolated temporary project skills and probe files and remove them after
each run; provider failures remain in the deterministic injected adapter
contracts because they cannot be manufactured safely against a live account.

Provisioning or scheduling these credentials/resources in CI is deliberately
out of scope; live runs remain explicit.
