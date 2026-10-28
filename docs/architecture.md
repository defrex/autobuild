# Architecture

The contributor-facing map: how the codebase is organized and where the
seams are. `SPEC.md` is the source of truth for the design and terminology;
this document maps it to the code. For the user journey — install, configure,
operate — see [`README.md`](../README.md); for the complete declarative surface,
see [`docs/configuration.md`](configuration.md). The hosted sessionless control
surface is specified in the [operator API reference](operator-api.md). Behavioral detail beyond what
a map needs lives with the code and its tests; when this document and the code
disagree, the code is authoritative.

## Constitution

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state. Narrow non-phase judgment such as
   slug naming and skill-conflict proposals remains behind deterministic
   validation and fail-safe fallback.
2. **Resumability is not a feature.** Re-running `ab dispatch` attempts every
   actionable current build; each phase resumes as a function of durable state.
   Open escalations remain parked until a human answer is recorded, while
   pending operator commands remain actionable.
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

## Workspace ownership

The repository is a Bun 1.4 workspace. The private root package, `autobuild`, is
still the sole Git-installed compatibility distribution: it owns the public and
private `bin/` entries, the `@defrex/autobuild/plugin-sdk` export, and the shipped
`skills/`, `templates/`, and documentation. Its implementation is included as
unbundled TypeScript from the private `@defrex/autobuild-core` workspace at
`packages/core`; the root repeats core's runtime dependencies so a packed or
Git installation never requires a separately published core package.

`packages/core` owns the CLI, kernel, adapters, shared types, dashboard
projection, plugin SDK, and reusable contract suites. The optional
`packages/hosted-store-service` workspace composes the public remote-server
surface with `packages/postgres-store`; the separate optional
`packages/hosted-dispatcher` workspace owns the cron-driven hosted dispatcher
(the `/api/dispatch` route driver, the deploy-time `pack-distribution` command,
and the packed-distribution trace helper) and peers on both the core and the
store service. The optional `packages/vercel-sandbox` workspace publishes the
`@defrex/autobuild-vercel-sandbox` provider plugin (AUT-517): while the
builtin hosts the implementation, its manifest re-registers the provider name
over the shared capability object and the loader skips it with a notice.
Neither optional package enters an ordinary CLI
installation's runtime dependency closure. `tools/` is repository-only
maintainer tooling. All workspace manifests share one version because the
remote-store protocol requires matching client and server versions.

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `package.json` | Private `autobuild` compatibility distribution and Bun workspace orchestrator; owns bins and shipped assets | — |
| `packages/core/package.json` | Private `@defrex/autobuild-core` implementation workspace | — |
| `packages/core/src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs, the canonical verify outcome | §4 |
| `packages/core/src/events/` | Separate build, repository, and operator-session envelopes/catalogs, frozen payload schemas, actor validation, the `via` attribution marker | §15 |
| `packages/core/src/harvest/` | Structured occurrence, scan packet, proposal, and ledger schemas | §12 |
| `packages/core/src/store/session-reducer.ts` | The operator-session reducer: status, open turn, pending approval, wake settings and cursors, and the turn list, reduced purely from the session event log | §7.1.1 |
| `packages/core/src/store/` | BuildStore contract spanning builds, the repository journal, and operator sessions; interface-enforced build, operator-session, and local ambient-session scope wrappers; memory, SQLite/blob, and remote HTTP adapters | §7 |
| `packages/core/src/store/streams/` | The stream primitive's shared core (§7.6): record/chunk types and the `ai-ui-message-stream/v1` constants, SDK-backed close-time `UIMessage[]` assembly, and the uniform bounded-wait read loop | §7.6 |
| `packages/hosted-store-service/` | Environment-only hosted Fetch handler, lazy PostgreSQL/blob composition, offline token binary, the Next.js operator web app (`app/`, `server.ts`, `next.config.ts`, `vercel.json`), tests, and deployment guide | §7.2, §18 |
| `packages/hosted-dispatcher/` | The optional cron-driven hosted dispatcher: endpoint driver, deploy-time `pack-distribution` binary, packed-distribution trace helper, tests, and operator guide | §7.2, §12, §18 |
| `packages/vercel-sandbox/` | Published `@defrex/autobuild-vercel-sandbox` provider plugin: transitional manifest over the shared capability object with a guarded factory (implementation stays builtin-hosted until AUT-505) | §3.2.1 |
| `packages/hosted-store-service/server.ts`, `packages/hosted-store-service/vercel.json` | One host-neutral Bun listener used locally and by Vercel's Bun preset | §7.2 |
| `packages/core/src/kernel/` | Phase table, build reducer, engine; pure harvest, dispatcher-settings, dispatcher-status, and PR-attachment selectors; converge, stall detection, verify gating | §5, §7.5, §10, §12, §14, §15.4–15.5 |
| `packages/core/src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, and fakes; registry-aware builtin/plugin construction; eager primary/alternate runtime routing and provider-failure classification, awaited native identity observation and optional fresh-process native resume under `ports/runner/` | §3.2, §9, §13 |
| `packages/core/src/plugins/` | Strict versioned plugin manifests, dual-root repository/package Bun loading, owner-aware adapter registration, contract/credential metadata, and runtime-factory materialization | §3.2.1, §9 |
| `packages/core/src/plugin-sdk/` | The sole supported `@defrex/autobuild/plugin-sdk` barrel: port/manifest types, contract suites, and reference fakes | §3.2.1 |
| `packages/core/src/processes/` | build-runner and standalone child composition, durable execution config/diagnostics, dispatcher (+ janitor duty, sandbox idle settlement and harvest trigger), harvest deterministic core + runner | §3.3, §7.1.2, §12, §15.7 |
| `packages/core/src/cli/` and `bin/` | The `ab` CLI — the only agent↔store channel — plus the shared presentation-only durable-progress projection, init/upgrade, the filesystem-only dispatch launcher and immutable generation cache, the Store-only dispatch frontend, its private supervised kernel entry, and `bin/ab-build-runner.ts` (one child per build) | §8, §14, §16.3 |
| `packages/core/src/cli/dashboard/` | `ab dispatch`'s fixed live frame: pure projection, renderer, poll cache, and deterministic image renderer | §14 |
| `bin/agent/ab` | Private launcher placed first on agent-session `PATH`; delegates to the canonical `bin/ab.ts` | §8.1 |
| `packages/core/src/config/` | `autobuild.toml` parsing and strict validation, plus the pure role-key consumability diagnostics `ab dispatch` reports at startup (`roles.ts`); user reference in `docs/configuration.md` | §9, §16.1 |
| `packages/core/src/scenarios/` | In-memory end-to-end harness and product scenarios | — |
| `tools/` | This repository's local maintainer tooling, including verification, dashboard capture, and release cutting; not shipped product behavior | — |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference for the lifecycle and full config surface; `references/` is the shared installed-documentation seam for every vendored skill. Update it when config or shared guidance changes; `packages/core/src/cli/guide-skill.test.ts` guards schema coverage and `packages/core/src/cli/skill-self-containment.test.ts` guards installed references | §16.3 |
| `docs/spec-standard.md` | The standalone definition of "buildable" every ticket surface uses; kept byte-identical with `skills/guide/references/spec-standard.md` for installed agents | §6.1 |
| `templates/` | Valid setup-only config baseline with comment anchors rendered by `ab init` | §16.3 |

## Key boundaries

**Hosted store service.** `@defrex/autobuild/remote-store` is the supported protocol
export for the remote store's client half, wire schemas, and token minting; the
protocol servers (the remote BuildStore HTTP server, the operator API server,
and the hosted ticket-source server) ship in
`@defrex/autobuild-hosted-store-service`, which builds against core's
`remote-store`, `operator`, and `hosted-tickets` subpaths only. The hosted
workspace validates its environment,
serves health without touching persistence, and lazily retains one
`openPostgresBuildStoreFromEnv` promise per warm process. Its Fetch handler has
no Vercel branch; the package's `server.ts` is the sole `Bun.serve()` composition point.
The fixed 2.5 MiB decoded artifact policy is enforced before backing mutation.
The `ab-hosted-store` binary signs admin or build/session tokens offline from
`AB_STORE_SECRET`; the running service exposes no mint endpoint. Machine routes
and later server-session human routes intentionally share one deployment.


Where each mechanism lives, and the one rule worth knowing at the seam. The
full behavior is specified by each owner's colocated tests.

**Events and state.** `packages/core/src/events/payloads.ts`, `packages/core/src/events/repository.ts`,
and `packages/core/src/events/sessions.ts`
are the frozen catalogs; every write passes `validateEventWrite` /
`validateRepositoryEventWrite` / `validateSessionEventWrite`. `packages/core/src/kernel/reducer.ts` derives all build
status; `packages/core/src/kernel/harvest.ts` and `packages/core/src/kernel/dispatch-settings.ts` reduce
the repository journal independently of each other; `packages/core/src/store/session-reducer.ts` reduces an operator
session's status, open turn, pending approval, and wake cursors from its own
closed catalog. No decision anywhere
consults a snapshot in place of the append-only log.

**Incremental reducers.** Every pure projection of an event array is a fold plus
a final derivation, defined once with `defineReducer` in
`packages/core/src/kernel/incremental.ts`: `initial()` builds an empty
accumulator, `advance(acc, events)` folds in only the events newer than the
accumulator, and `finish(acc)` derives the public state. The whole-array
functions (`reduceBuild`, `reduceHarvest`, `reduceSession`, and the rest) are
wrappers over the same fold, so results cannot diverge, and a property test
checks every split point of fixture and generated logs. The accumulator is plain
JSON, so it survives a serialize-and-parse round trip. `advance` never mutates
its input: it clones, then folds, so a state derived earlier is never disturbed
by a later advance. Each reducer publishes a `version`; bump it whenever the
accumulator shape or the fold semantics change, because a cached accumulator is
only valid for the version that wrote it. `kernel/reducer-registry.ts` lists
every reducer with its version, and its snapshot test fails when an accumulator
shape changes without a bump. Current-state consumers use the typed persisted
read helpers in `store/reduced-reads.ts`; whole-array reducers remain pure
reference projections for tests and explicit historical output.

**Reducer snapshots.** The `BuildStore` port can keep, per scope (one build log
or the repository journal) and registered reducer, that reducer's accumulator as
of a cursor: `getReducerSnapshot(scope, reducer, version)` and
`putReducerSnapshot(scope, reducer, {version, cursor, state})`
(`packages/core/src/store/snapshots.ts`). The log stays the only authority. The
store enforces the invariants: the stored cursor never decreases (a write whose
cursor does not advance is a no-op, so concurrent writers cannot undo each
other), a row of another reducer version reads as absent, and a lower-version
writer never replaces a higher-version row even after advancing its cursor, and a cursor beyond the log's tail is refused and never
returned. Every consumer treats a missing, mismatched, ahead-of-log, malformed
or unreadable snapshot as a miss and replays the log, with identical results;
deleting all snapshots changes no observable output (the integration harness
audits this for every scenario at cleanup). Memory, SQLite, Postgres and the
remote client implement it, and the hosted store service serves it on
`GET|PUT /builds|repos/{id}/snapshots/{reducer}`
(`docs/remote-store-protocol.md`). SQLite creates the `reducer_snapshots` table
at open. Postgres keeps it outside the versioned schema: `reducer_snapshots` is
created by the idempotent `SNAPSHOT_SCHEMA_DDL` in `migratePostgres`, with no
marker, version or checksum change, so a deployment at the current schema keeps
serving across the upgrade, a new client against a database that lacks the table
reads every snapshot as missing and replays (SQLSTATE `42P01` is never an
error), and an older client never asks. Run `bun run postgres:migrate` once to
gain the table; until then the dispatcher and every other reader replay in full.

**Mixed-version event decoding.** `events/compatibility.ts` separates opaque
stored facts from the known event unions. Strict producer schemas stay in
`events/payloads.ts` and `events/repository.ts`; `events/policy.ts` exhaustively
classifies every type and stamps writer release metadata. Named read boundaries
project known payloads before adapting selector rows, while build and repository
facts retain compatibility counts across incremental resumes. Unknown facts
still advance sequence cursors. `kernel/mixed-version.ts` guards affected build
decisions and deduplicates the default-watch attention fact. Other builds and
read-only queries continue. The [hosted upgrade guarantee](remote-store-protocol.md)
describes recovery and the supported-window boundary.

All event-derived checkpoints include the combined read-catalog fingerprint in
their keys, independently of numeric reducer versions. Snapshot envelopes validate
that fingerprint; another catalog's rows remain untouched. Remote named values
are canonical regardless of `x-autobuild-catalog-identity`, keeping their strict
three-field JSON body unchanged. A reducer version mismatch, invalid envelope or
unrepresentable finished shape raises `ReducerValueIncompatibilityError` with
client/server versions and validation detail. No remote named read replays events.
Repository digest batches likewise return the server batch with one scoped
request and no discovery or per-build fallback.

**Named reducer values.** `BuildStore.getReducerValue(scope, {reducer, args?})`
returns `{version, cursor, value}` for each eligible entry in the executable
reducer registry. Eligible reducers consume build or repository events and finish
as plain JSON; raw journal-event lists, operator-session reducers, collections,
selector functions, and top-level optional results are explicitly excluded with
reasons. Factory arguments are validated and participate in a bounded digest
cache key. The persisted envelope also records the canonical scope, arguments,
name and version, and nested accumulator shapes are validated before restore.
The `value.*` namespace is reserved: public snapshot reads and writes reject it,
and the engine persists through private adapter hooks. Versioned cache keys
exclude checkpoints produced while the old namespace was publicly writable.
`tools/reducer-value-shapes.ts` regenerates those structural validators from the
declared accumulator types.

Memory, SQLite and Postgres use the same algorithm: capture the authoritative
high-water, load persisted state on every call, fold the indexed contiguous delta
through that boundary, persist, and return an independent JSON value. There is
no process-local accumulator cache. A foreign checkpoint newer than the initial
boundary causes a fresh high-water check. Normal writes are monotone; corrupt,
wrong-version or ahead-of-log rows are repaired only by comparing the exact row
observed, atomically with the log boundary. A losing writer still returns its
correct prefix. Missing or unreadable cache state replays; log failures propagate.

The remote adapter makes one value request; only the finished answer crosses the
wire. The service uses named effective-configuration references for hosted ticket
operations (including policy publication) and semantic build/harvest lifecycle
facts for delegated authentication and issuance. Lifecycle snapshots keep session,
execution and terminal evidence, including historical endings, without dispatcher
tick tails. Anchor membership follows the contiguous log prefix. The legacy
state-events route remains a deprecated compatibility endpoint. Public generic
snapshot routes remain compatible, but current consumer reads do not restore the
former dispatcher work bundles.

**Dispatcher repository view.** `RepoViewStore`
(`packages/core/src/processes/repo-view.ts`) coordinates repository metadata and
source promise chains. Its build and journal facts come from persisted reduced
values. Reads after an append or lost conditional append consult that boundary
again, so no process-local memo suppresses a required delta. The adapter owns
cache persistence and recovery; the view neither writes work bundles nor hydrates
whole logs for decisions. Discovery uses persisted build digests, including for
settled builds. Raw methods forward actual cursor event output.

JSON-safe companion projections preserve collection and optional-value contracts.
The build facts projection returns one prefix for engine routing; its log-index
rounds and finalize steps reconstruct Maps and Sets explicitly, while publication
selectors reconstruct from a JSON ledger. Repository facts retain configuration,
control, Harvest, and dispatcher run correlations. Lease metadata and clocks stay
outside event reducers: liveness combines durable run facts with the current
repository record and observation time, including an older lease holder hidden
by a newer run. The shared repository value keeps a bounded recent-run window, including the
latest started and stopped runs. Fresh invocations use those shared facts for
first-tick publication, liveness and supervision without creating a cold
parameterized cache. Older holder correlations can use `dispatcherRunFacts` for
the requested historical run. A never-started fresh invocation does not request
historical correlation. Stopped dispatcher history is not copied into every
current read.

Consumer validation failures report the reducer name, scope, returned store
cursor, structural field path and expected shape without persisted values.
Dispatcher tick warnings and stored failures add the running distribution's
version and source commit, captured at startup (or `unknown` without metadata).

Hosted project build listings use the optional backing-store
`listBuildsForRepo` capability with the authenticated repository. Postgres filters
build rows in SQL before hosted ticket readable-id projection. Admin listings
remain global; adapters without the capability retain application filtering.

**Operator and CLI reads.** Build listings and details, repository and Harvest
status, dispatcher decisions, operator API queries, MCP delegation and web
dashboard refreshes use the same typed persisted read helpers. Shared projection
functions render those facts; whole-array overloads remain reference oracles.
Operator passes are single-flight per repository, with requests arriving during a
pass queued for one trailing pass. Fresh readers use persisted cache rows too;
steady-state event-row cost depends on newly appended events at fixed build/run
cardinality, not on log length. Reduced collections may legitimately grow in JSON
size. Cache loss or corruption can replay history once to recover the same answer.

Watch and wait register from a compound persisted `buildStreamSeed` at cursor C.
Its build accumulator, deferral ledger and insertion-ordered historical PR
eligibility describe that same prefix. Ordinary polling, including the first
batch on an old build, reads only events after the cursor and advances that seed
event by event, preserving state at event N in each emitted record. Watch uses
historical eligibility for baseline suppression; wait retains its separate
current-attention registration policy. Only an explicit `--since` older than C
reconstructs a historical prefix once in `cli/historical-build-state.ts`.
Actual event listings, transcripts and cursor streams remain raw reads. The
interactive terminal frontend retains its independently established incremental
feed. `tools/persisted-reduced-reads.test.ts` scans production TypeScript calls
and maintains precise, reason-bearing exceptions for these boundaries and pure
reference projections; stale exceptions fail the check.

**Session Store authority.** `packages/core/src/cli/binary.ts` validates a complete build or
Harvest ambient tuple before opening its phase Store through
`packages/core/src/cli/store-opening.ts`. `packages/core/src/cli/env.ts` also classifies optional ambient
identity for the finite `builds`, `build status`, and `artifact download` read
shells: no identity retains operator authority, while any partial, malformed,
shared-only, or mixed identity fails closed before Store opening. Remote
references keep the existing token-backed client unchanged. Local references
are wrapped by `packages/core/src/store/phase-session.ts`, which permits only the exact
ambient build or repository resource (this is the phase-session wrapper, not the
operator-session scope handle in `session-handle.ts`) and rejects
agent-attributed event writes
for any session other than `AB_SESSION`. The wrapper deliberately allows
non-agent actors because phase terminals also run trusted kernel plumbing in
that CLI process; resource authority still applies to every operation. Generic
sessionless opening remains unwrapped; only those three reads use the dedicated
ambient-aware finite opener.

**Phase decisions.** `packages/core/src/kernel/phases.ts` owns the phase table,
`packages/core/src/kernel/engine.ts` the deterministic transitions;
`packages/core/src/processes/build-runner.ts` executes the decisions. Repeated phase starts
left by recovery are execution evidence, not policy counters: logical verdict
rounds, `phase.failed`, failed verify completions, and distinct completed
reconcile attempts own their respective budgets. Agents reach state only
through `packages/core/src/cli/` terminals, which convert artifact deposits into event facts
atomically — the engine never reads blobs. Engine crash-gap and
exhaustion guards query the event log for a later escalation raise with the
exact same source/class and target phase; the triggering sequence remains the
re-arm boundary. `BuildRunner` applies the same independent targeting at the
setup seam, where only a setup-targeted policy raise can satisfy setup
exhaustion.

**Phase-session budgets.** `packages/core/src/ports/runner/routing.ts` resolves one inherited
`sessionBudgetSeconds` value for each logical role, with the policy default as
its final fallback. `BuildRunner` captures it at the session action boundary,
starts an unref'ed timer after `session.started`, and composes expiry with the
existing operator `AbortController`. Operator abort and deadline remain
independent: abort cancels promptly, while the captured deadline still stops
waiting if the adapter ignores that cancellation. First cause owns
classification, so an operator-first deadline release returns to abort
acknowledgement without `phase.failed` or provider substitution. Ordinary
expiry best-effort ends an available or late-returning handle, drops producer
continuation state, and reuses retryable `phase.failed`; it does not enter the
provider-alternate classifier. The event log is checked before failure so a
typed terminal racing either boundary remains authoritative. Finalize agent
post-steps reuse the timer but drain expiry through their existing failure-tolerant
completion and observation path. Harvest and deterministic commands do not use
this build-phase timer.

**Human guidance delivery.** The routing fact is an `escalation.answered`
event carrying `resolution: "guidance"`; nothing else routes an answer. `ab
answer` and the dashboard's blocked-build resume control are two surfaces over
the one `packages/core/src/cli/build-control.ts` operation that appends it, so delivery is
identical whichever a human used.
`packages/core/src/kernel/engine.ts` routes answers from `plan` and `plan-review` to the next
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
Build agent environments carry `AB_CONTEXT_DIR`, a workspace-relative directory
under `.ab/`: core phases use their phase name, agent verifiers use
`verify-<step>`, and agent finalize post-steps use `finalize-<step>`. Hydration
replaces only the receiving directory's disposable files. The manifest records
`contextDir`; `materialized` keys are directory-relative, while manifest path
fields remain workspace-relative. Sibling contexts remain readable.

`packages/core/src/cli/context.ts` materializes `$AB_CONTEXT_DIR/guidance.json` with the escalation id and
answer text. For producer and verifier feedback routes, `packages/core/src/kernel/engine.ts`
indexes each guidance-bearing phase start as a durable carrier and pairs only
the latest carrier for an exact phase plus round/attempt with a subsequent
matching `session.started`. An unpaired carrier remains deliverable across
recovery; the matching launch consumes it once without process-local state. A
producer round's feedback is a discriminated union — findings, a
failed verify report, or guidance — and a round may carry none, so a round with
guidance writes no `$AB_CONTEXT_DIR/findings.json`. The receiving skills document their
corresponding input, and `packages/core/src/cli/skill-guidance.test.ts` derives that
requirement from the phase table.

**Finalize publication.** Content-producing `finalize:*` checks or agents
select and commit files locally and leave a clean worktree. `build-runner.ts`
derives the last published head from event facts, rejects a non-descendant
`HEAD`, freezes that SHA, and uses the Forge port for a regular kernel-side push
and exact authoritative readback before checkpointing the new head on `finalize.step-completed`. An unchanged
head is a no-op; Git/Forge failures stay failure-tolerant observations.

**Verify gating.** `packages/core/src/ontology.ts` owns the canonical
`pass | fail | skipped` outcome (only `fail` routes back to implement or
consumes attempts; a skip satisfies one step without being passing
evidence). Three kernel-authored skip sources narrow the configured universe:
post-reconcile policy, approved plan selection, and changed paths.
The engine captures the ordered effective `afterReconcile` policy in
`verify.reconcile-policy-captured` at the action after reconciliation completes,
before verification starts. Log-index replay keeps it scoped to that completion;
subsequent config changes cannot replace it mid-cycle. Historical already-started
cycles without a snapshot retain rerun-all behavior. A later code-review approval
restores ordinary verification. Policy exclusions precede plan/path applicability
and carry `skipCause: "post-reconcile-policy"` plus a setting-specific reason.
The shared dashboard model renders that reason, as does the PR summary.
Excluded steps do not re-verify merged code, so combination-only breakage can
merge; forge requirements and reconcile budgets remain independent.
For enabled steps,
`packages/core/src/kernel/plan-verify-selection.ts` resolves an approved plan's front-matter
selection (applied at the planner's `ab done` in `packages/core/src/cli/terminals.ts`,
snapshotted by the engine at approval), and
`packages/core/src/kernel/verify-applicability.ts` matches changed paths against a step's
selectors, resolved by the build runner via `git diff` against the initial
branch-cut base (or the effective base promoted by successful restack/reconcile publication).
This verify-only base is deliberately independent from implementation's
focused review range. All narrowing mechanisms produce the ordinary
queryable skipped outcome; Git failure is infrastructure and fails closed,
never a synthetic skip. Verify escalation routing is also explicit in the
engine: guidance answering an agent verifier's own `ab escalate` returns to the
same step on `verify.started.feedback`, which `ab context` materializes as
`$AB_CONTEXT_DIR/guidance.json`; that cited start remains recoverable before launch, and the
matching `session.started` for the same step and attempt consumes the answer
once. Guidance answering the policy escalation after failed-report exhaustion
instead routes to `implement` and outranks the pending report. A bare retry carries no
feedback.

The dispatcher launch boundary uses `processes/execution-no-progress.ts` to
project clean empty execution streaks through `RepoViewStore` snapshots and
conditionally raise an ordinary setup policy escalation before a fourth launch.

**Launch ownership.** `packages/core/src/cli/dispatch.ts` is the kernel owner and
single-flights supervised build executions per slug within its process. It
publishes effective config into the build artifact namespace, claims the exact
execution-instance lease, then calls the workspace-adjacent `BuildExecution`
capability; it never constructs a `BuildRunner`. The shipped local capability
starts `bin/ab-build-runner.ts` with ignored stdio as a detached POSIX
session/process-group leader. That child immediately scopes its Store handle, discovers
its workspace from durable events, and composes the existing runner. Config and
instance-correlated diagnostics remain build artifacts. Local completion first
reaps the complete inherited process group, escalating group-wide from SIGTERM
through the existing bounded delay to SIGKILL; only then is it a liveness signal
and only then does the kernel release the exact lease. Interactive `ab dispatch` runs the kernel owner in the
private `bin/ab-dispatch-kernel.ts` child;
`dispatch-launcher.ts` freezes the invoking distribution and installed production
dependencies offline under `.autobuild/runtime/`, then starts
`bin/ab-dispatch-generation.ts` using the pinned v1 process contract. It loads
only filesystem/process helpers and never opens a Store. The generation's
frontend, kernel, local runners and agent CLI use one completed immutable root;
`dispatch-runtime-use.ts` protects current/previous/held/live entries during
spawn and pruning. Source guest archives are captured at installation. Source generations deliver
the exact packed source archive; registry generations keep a separate,
digest-validated GitHub release asset matching the cached manifest version,
resolved and atomically cached at first guest use. Local launch remains offline.
Installation provenance uses Bun store/lock evidence across isolated and hoisted
layouts, preserving source/forge markers before staging.
The normalized host archive retains its independent compiler boundary. Guest
archive delivery uses the authenticated provider transport after launcher startup,
keeping HTTP code outside the resident launcher’s eager filesystem/process graph.
`--once`, origin/hosted paths and injected hot dashboard rendering remain direct.
`dispatch-upgrade-target.ts` reads manifest and lock blobs from one authoritative
base snapshot, or rereads the original install pathname when unpinned. Frozen
launcher eligibility selects source mode for a source root sharing the dispatched
repository's Git common directory. `dispatch-upgrade-source.ts` exports exact
commits into private cache staging and fingerprints actual packed contents and
the production-reachable Bun lock closure. Source preparation installs with the
frozen lock and scripts disabled, then publishes through the existing immutable
runtime cache. Neither resolution nor installation changes an operator/build
worktree. Excluded-file commits change observed provenance without adoption.
`dispatch-upgrade-install.ts` stages and validates exact targets;
`dispatch-upgrade-controller.ts` checks immediately and every 60 seconds, suppresses
failed target inputs and publishes durable prepared targets. `dispatch-preflight.ts`
checks target configuration, provider compatibility and actual protocol-write
admission before requesting yield. `kernel/dispatch-upgrade.ts` folds correlated
acceptance, terminal release, takeover, per-execution retirement and completion.
The runtime-owned `dispatch-handoff.ts` reader lets the filesystem-only launcher
supervise overlapping generations without owning Store or config decisions.
A runtime-owned repository-record projection binds the journal transport before
initial spawn and across handoffs, including when later config edits are invalid.
The optional conditional `--read-upgrade` environment extension in
`dispatch-launch-contract.ts` is versioned independently of launch/overlap v1.
The launcher caches only the current successful projection, guard inputs and
pre-read position for each exact runtime/journal/run/lineage/recovery query.
`dispatch-handoff.ts` checks `getRepoChangePosition` before any metadata or
reducer reads on a bound query: unchanged helpers make one request and read zero
event rows, including with cold process/store facades. Changed helpers share one
store handle and attach the earlier position, so concurrent appends invalidate
the following check. Durable handoff selection is separate from local target
identity and rollback-retention guards, which run on every check. Errors clear
conditional state; a separate predecessor-reader cache uses the active run's
journal context when the target cannot load. Old peers keep full v1 responses.
Polling stays at 1 second idle / 250 ms pending, and cached projections still
pass through ordinary child-exit, pending-preflight and recovery handling.
`dispatch-frontend.ts` acknowledges terminal release only after joining input
and rendering. The old kernel releases repository authority but retains local
execution supervision until completion or the hot policy deadline. Build-log
execution authorization permits expected mixed-version deferral without restart
attention. Accepted authorization also carries the target runtime.
`processes/execution-relaunch.ts` compares immutable identities from existing
boundary facts; local and remote runners finish the phase, record an instance-correlated
relaunch request and clean up. Confirmed teardown records a neutral relaunch
outcome. The current owner's ordinary lease sweep resumes durable work promptly,
including after an ownership gap. Remote captures authorize exact guest runtimes
independently of local retirement, including late attachment after completion.
The existing repository execution digests bound recovery and handoff capture reads
to open executions; multiple historical captures share one read per live build.
Guests detach without losing leases; re-attachment refreshes their archive before
the next phase. Deadline suspension applies only to local runners. `kernel/dispatch-drain-recovery.ts` reconstructs unfinished retirement
after a predecessor dies. Cutover suspends immediately when provider evidence
cannot establish safe overlap. Automatic upgrades can be disabled; targets
without preflight capability require manual restart.

**Automatic runtime rollback.** The filesystem/process-only launcher in
`cli/dispatch-launcher.ts` owns the crash budget, anchored to durable takeover.
`cli/dispatch-crash-budget.ts` counts three failed exits within ten minutes;
`cli/dispatch-launch-contract.ts` negotiates a separate rollback capability while
preserving v1 launch/overlap compatibility. Generation-owned readers expose takeover
and capability evidence. `cli/dispatch-handoff.ts` validates recovery against that
evidence and deposits the idempotent rollback fact after lease acquisition.
`kernel/dispatch-upgrade.ts` reduces lineage holds and historical rollback;
`cli/dispatch-upgrade-controller.ts` clears a hold only after resolving a different
target. `cli/dispatch-runtime-use.ts` transfers reservations to generation-owned
hold retention under the pruning lock. Existing runner leases and decisive-read
deferrals remain the boundary recovery authority.

Local harvest suspends durably before repository lease release on handoff or
clean stop. The next generation resumes eligible native sessions with fresh
logical credentials, or records a reasoned `harvest.session.resume-fallback`
and starts fresh. Orderly suspension spends no recovery attempt; real crashes
retain recovery accounting.

The advisory
`dispatcher.upgrade-target-resolved` fact independently retains each run's latest
successful mode/base/SHA observation without clearing failure evidence; repeated
identical observations append nothing. `dispatch-frontend.ts` owns only terminal/Store adapters and
`dispatch-process.ts` owns child supervision. SIGINT, SIGHUP, SIGQUIT, and
SIGTERM restore terminal modes immediately and begin one supervised drain;
persistent frontend and child handlers keep repeated signals graceful until the
kernel child is reaped, after which a non-SIGINT terminating signal is replayed
in the frontend. A parent-liveness watch remains the detached-kernel fallback.
The repository record carries constant-size, lease-holder-fenced tick telemetry:
`beginRepoTick` opens the unsafe boundary, and `finishRepoTick` atomically closes
it and appends selected tick facts. Successful unchanged ticks append nothing;
queue transitions, counters, diagnostics, attention resets/retries, and failures
retain their journal evidence. Buffered starts preserve actual `startedAt` for
attention cooldowns; old starts use their envelope time. Liveness reads refresh
the repository record even with an unchanged event cursor, merging matching-run
completion samples with journal ticks. Heartbeat renewal cannot invent progress.
The memory, SQLite, Postgres and remote adapters share this contract, including
no mutation after lease expiry and no partial publication on validation failure.
Repository read failures fail a watch tick and retry on the next iteration;
continuous failures use the existing five-minute persistent-tick attention.
Failure settlement writes through the fenced backing store without reading the
failed projection. Repository view writes distinguish a committed result from a
subsequent refresh failure, retaining the last complete snapshot while propagating
the read error to the operational caller. Exact metadata confirmation acknowledges
lost finish responses without requiring another projection read or duplicating
boundaries. Every operational tick refreshes facts before routing work. Startup
configuration errors, fatal forge publication errors, lease fencing and once-mode
failure behavior retain their existing semantics.

Timeout escalation is held while the matching repository tick observation is open
(with historical `tick-started` journal fallback when no observation exists),
because force-killing the ticket claim before build creation would not be
recoverable. After a build child claims a takeover lease, it reduces one
captured event prefix, retains an eligible local native recovery candidate, and
appends transcriptless reclaimed `session.ended` facts for unrelated open
sessions before `runner.attached` cites that same boundary. Partial closure is
retry-safe; historical orphan-only logs keep their
old projection until an actual takeover records those facts. The supervisor
waits for graceful kernel-child teardown without a force-kill deadline
and projects the same normal, forced, or abnormal result (with available
process/error detail) that the repository run-stopped evidence records. Ordinary
kernel teardown stops and reaps all build groups. Every build-child terminal
path — natural completion, failure, SIGINT/SIGTERM, and parent-watch death —
first starts exactly one detached `bin/ab-process-group-reaper.ts` while the
leader still pins its process-group identity. The helper targets only that
negative group id and applies the same bounded TERM-then-KILL teardown, so it
survives abrupt kernel death. The live local supervisor independently awaits
full-group disappearance before publishing completion and releasing its exact
lease; lease expiry remains the durable recovery fallback. The BuildStore lease
remains the cross-process and workspace-release gate. `packages/core/src/processes/dispatcher.ts`
counts actual schedules, not suppressed polls. Open session history is never a
lock: a legacy dead session may remain open, while an actual takeover closes it
explicitly.

**Store authority.** `packages/core/src/store/build-scope.ts` wraps every adapter with one
build's authority. Own-build record/event/artifact/lease/subscription calls
delegate; foreign-build, collection/admin, close, and repository-journal calls
raise `BuildScopeError`. The shared Store suite applies these checks to memory,
SQLite, and remote clients, while HTTP token scope remains defense in depth.

**Live configuration.** `packages/core/src/config/live.ts` owns the running dispatcher's
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

Lease sweeps in `processes/dispatcher.ts` retain at most 128 parsed build
effective-config pins in deterministic LRU order. Each sweep probes
`BuildStore.getLatestArtifactMeta` (one latest metadata row, no blob or revision
listing) before reuse; artifact-only revision changes force a full reread.
Current facts, live deployment settings and cycle captures are composed afresh.
Errors invalidate reuse and retain diagnostic/refusal and repair behavior.
Launch, resume and merge boundaries still read fresh artifacts. Restart,
eviction and adapters lacking metadata support preserve decisions with full
reads. Remote clients remember explicit unsupported-route/operation responses
per client and fall back to full artifact reads, never event replay.

`config/pipeline-source.ts` strictly reads the runner's execution checkout.
`processes/verify-cycle-config.ts` deposits immutable cycle config and checks
build-owned identity and source ancestry at settled stage boundaries. Typed
`verify.config-captured` and `verify.config-superseded` facts advance the result
boundary in the reducer and log index, independently of reconcile identity.
The runner refreshes after workspace mutation and before constructing members;
concurrent siblings settle before another stage is selected. Recovery and
readiness compose live deployment settings onto the captured artifact revision.
`kernel/plan-verify-selection.ts` keeps strict plan deposit validation separate
from runtime drift resolution: unknown approved names select all optional steps
and an explicit engine action deposits a deduplicated observation.

**Harvest.** The dispatcher owns the threshold trigger and starts runs
fire-and-forget; `packages/core/src/processes/harvest.ts` is the deterministic core (scan,
source-aware originating-ticket lifecycle projection, filing-time blocker
resolution, occurrence identity, and the exhaustion partition),
`harvest-runner.ts` executes the staged workflow under the heartbeated
repository lease, records declared/derived blocker provenance, and
`packages/core/src/kernel/harvest.ts` reduces runs, claims, recovery history, and the
committed ledger with ordered parked/exhaustion/open selectors. Its pure
creation selectors pair reservation/filing facts, bound unmatched keys to
active runs, and conservatively union reservations first seen between the
repository snapshots bracketing a ready listing. `packages/core/src/processes/dispatcher.ts`
correlates those keys before dependency reads or claims, retaining queue depth
and emitting creation-specific tick diagnostics. The recovery
invariants are SPEC §12; the mechanics live in the reducer and its tests.

**Ticket sources.** `packages/core/src/ports/tickets/`. `listReady` is an explicit
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
`packages/core/src/ports/workspace/create.ts` resolves `[workspace].provider` against the
builtin-plus-plugin registry once during production wiring and pairs it with a
`BuildExecution` capability. A provider-supplied capability substitutes at
that seam; otherwise the shipped local subprocess capability is used. The builtin stays
store-root-aware; selected plugin factories receive their nested config,
environment, and absolute repository root. `WorkspaceHandle.ref` remains a
provider identifier, `path` is absolute inside the execution environment, and
optional `localPath` explicitly identifies dispatcher reachability. Local Forge
operations fall back to the main checkout when `localPath` is absent.
`packages/core/src/ports/workspace/git-worktree.ts` selects the branch-cut base once
at first creation, fetching into a build-scoped private ref; re-provisioning
resumes at the branch tip, so the first provisioning fact remains immutable
original provenance. A remote workspace lost before its branch is published
can be freshly cut again; the latest `remote` or `local` provisioning base is
the fallback review boundary, while `existing` facts only describe resumes.
Each implementation terminal in `packages/core/src/cli/terminals.ts` records
its proven contribution boundary verbatim: the projected implementation/replay
base, falling back to the latest fresh cut. Branch-cut target sampling remains
separate from review provenance. The immutable boundary must belong to HEAD's
history; missing or invalid provenance fails before publication or notes deposit.
There is no review-time target fetch or destination merge-base. Successful leaf
rewrite facts project `targetBase..headSha` for context, review and agent verify
steps without changing historical ranges. Node cycles retain separate semantics.
Reconcile's execution-time target refresh remains a separate boundary.

The builtin `vercel-sandbox` adapter provisions an exact GitHub revision into a
fixed guest path. Fresh-environment bootstrap scrubs clone authority, installs
and verifies pinned Bun, serially runs repository-declared named system
provisioning through `sh -c` with provider root authority, installs the running
Autobuild distribution and repository dependencies, and only then writes the
readiness marker. Thus marked environments run the list once, while every new
replacement generation reproduces it before `[commands].setup` or any phase.
Step failures retain command/status/stdout/stderr, leave no marker, and flow
through durable `infrastructure.failed`, its bounded retry budget, shared status
and dashboard projection, and setup-targeted escalation; nested cleanup failure
does not erase the original diagnostic. Readiness uses the same bootstrap helper
in an always-deleted temporary sandbox and reports declared step names before
guest setup checks. The adapter then starts the same private build child with
environment supervision. Local children carry a positive parent PID and retain their
watchdog/process-group reaper; remote children cannot see a meaningful host PID,
so the detached SDK command plus VM stop owns full teardown. Scoped Store facts
are the only state channel. Remote terminals append `publication.requested` and
park. Only confirmed VM teardown plus execution-lease release permits the local
supervisor to use the provider's exact SHA/branch publication capability; a
rejected/uncertain executor completion leaves the request pending. Recovery from
supervisor loss applies the same gate: observing guest exit must stop the entire
sandbox before returning terminal evidence. Stop failure retains the open
execution and its lease for retry. The supervisor
verifies the remote head and records the ordinary completion; PR API operations
remain on the dispatcher. A failed finalize post-step publication records the
ordinary failure-tolerant step outcome and follow-up observation rather than
wedging the green build. Every guest launch first reasserts the normal
receive-pack-free network policy, so even a failed publication-policy restore
fails closed before setup or plugin code runs. Normal VM sessions never receive
Forge credentials.

**Forge readiness.** `ports/forge/readiness.ts` owns the portable check inventory,
classification, plugin fallback, and formatting; `github-readiness.ts` performs
read-only settings/policy inspection, keeping incomplete evidence unknown. Host
init validation invokes the configured registry forge outside guest probes.
Dispatch inspects after acquiring its repository lease and writes validated
`dispatcher.forge-readiness-failed` facts once per run/check for known hard
failures. `kernel/dispatch-status.ts` retains their typed collection across ticks
and reloads; the independent frontend and operator query project the same warnings.
`ab watch` follows these repository attention events for external orchestrators.
See [setup](setup.md#forge-readiness) for requirements and access guidance.

**Forge credentials.** `packages/core/src/ports/forge/github-transport.ts` owns the
REST transport seam and credential resolution for the builtin GitHub forge:
`GITHUB_TOKEN`, then `GH_TOKEN`, then the gh CLI's stored login read through
`gh auth token --hostname github.com` under a bounded deadline. A transport resolves
lazily on its first request and asks its resolver again at most once per bounded
interval — after a miss, or after a `401` past that interval (a rotated login) — so a
miss is never frozen into anonymous access and nothing is re-probed per request. Nothing is probed at construction time; a request that had to
go out anonymously carries the miss reason (gh missing, not logged in to github.com,
timed out) in its error, in every process that holds a forge. Origin-mode dispatch — and therefore the hosted
dispatcher — requires an exported token before any side effect and never consults gh:
a checkout-less host has neither gh nor a keyring, and `vercel-sandbox` publication
injects that same token.

**Hosted sandbox lifetime.** `createHostedOperatorSandboxService` owns its default
local scratch root and removes it on construction failure or asynchronous,
idempotent `dispose()`. Explicit caller scratch remains caller-owned. Disposal
cleans local composition resources, independently of durable remote sandbox
`release`. The operator archive handler disposes a backend acquired through
`sandboxFor` after each request, including failure; a static backend retains its
caller's lifetime. Distribution packing likewise protects both temporary roots
from allocation onward and awaits both cleanup attempts before returning bytes
or reporting failure.

**Stable build identity.** The forge merge seam accepts optional build identity at operation time. Both
built-in adapters preserve their squash message and normalize a final
`Autobuild-Build: <slug>` trailer through `packages/core/src/kernel/build-identity.ts`. The GitHub
adapter reads the viewer's squash headline/body and head in one GraphQL query;
it never reconstructs server defaults from repository settings. The janitor
maintains native request message freshness after acknowledgement. A matching
request costs one GraphQL freshness query and no extra consent or pipeline read;
full gate inspection and refreshed durable consent/engine eligibility precede
any repair. Body comparison tolerates provider trimming of trailing whitespace
while preserving the complete headline, body content, and squash method.

Optional `Forge.readCommitMessage` and `Forge.containsBuild` capabilities expose
actual merged messages and exact trailer presence in reachable branch history.
The janitor records optional `pr.merged.buildTrailerPresent` for normal and abort
cleanup observations. Unsupported or failed inspection leaves evidence unknown;
a read failure also records an observation without preventing completion. Old
logs need no migration and keep the same status and presentation.

GitHub merge queues ignore squash-message overrides. The message query also
reads `repository.mergeQueue(branch:)`, covering classic protection and rulesets.
Its branch hint is checked against the PR's actual base, with a bounded re-query
after a retarget rather than assuming the repository default is the base.
Kernel auto-merge therefore
returns an actionable `unproven-gate-state` deferral for queue-protected bases;
it never bypasses the queue. Human queue merges still settle normally with
inspected trailer evidence when available. Expected-head guards and recurring
polls bound native message freshness, but cannot prevent a push and automatic
merge from both completing between polls.

**Agent runtimes.** `packages/core/src/ports/runner/`: `runtime.ts` (capability-carrying
registry plus boundary validation), `routing.ts` (eager role resolver),
`production.ts` (shipped Claude/Codex/Pi registrations), `codex.ts` (direct
Codex `exec --json` subprocess protocol with native thread resume), `pi.ts` and
`pi-rpc.ts` (the local pi CLI prerequisite/auth probe and long-lived headless
RPC protocol, minimum version 0.84.3), `one-shot.ts` (optional tool-free
non-phase completions — slug naming via `packages/core/src/cli/dispatch.ts`, skill-conflict
proposals via `packages/core/src/cli/upgrade-agent.ts`), `provider-error.ts` (positive-only
permanent-failure classifier), and `session-env.ts` (per-turn environment merge
that fronts `bin/agent/ab` on `PATH`). The pi CLI owns its login and model
catalog; the shipped bridge limits tools and refreshes each turn's subprocess
environment without writing session state into the workspace. Adapters own
native error extraction; processes own durable failure policy — the transcript
is always deposited, and a turn's typed terminal always beats a late failure
signal.

**Plugin bootstrap and CLI composition.** `packages/core/src/plugins/load.ts` resolves
repository-path modules from the config-bearing root and bare packages from an
explicit package root (defaulting to that same root), validates each default
manifest/API range, and atomically registers normalized factories, provenance,
ticket credential metadata, and optional contract descriptors before production
wiring or the first dispatch tick. Its structured single-module attempt feeds
two policies: `loadPlugins` remains fail-fast for dispatch, while
`diagnosePlugins` collects ordered failures and retains later healthy
registrations for `ab plugin doctor`. `packages/core/src/cli/plugin.ts` owns the sessionless
list/doctor/test grammar and live gate; `packages/core/src/plugins/contract-entry.ts` reloads
one selected registration inside a real `bun test` process and registers exactly
one unchanged port suite.

`packages/core/src/ports/forge/create.ts` resolves the root `forge` selector, constructs the
shipped GitHub or local-git adapter, or lazily invokes a registered plugin
factory, and preserves the returned adapter's optional capabilities. The
local-git adapter in `packages/core/src/ports/forge/local-git.ts` stores versioned JSON PR
records as blobs behind private `refs/autobuild/local-git/` refs in the shared
Git database. It computes mergeability with `git merge-tree`, leaves the build
branch reachable, and merges a guarded single-parent squash locally. Immediately
before offering an ungated merge candidate, `git var GIT_AUTHOR_IDENT` and
`git var GIT_COMMITTER_IDENT` prove that ordinary Git identity resolution can
succeed; a failure becomes a reason-bearing, retryable consent deferral. The
`git commit-tree` seam inherits that resolved identity without injecting an
Autobuild author or committer, while `-c commit.gpgSign=false` keeps the merge
unsigned. For a checked-out base, dry-run and real
`git read-tree -m -u <old> <merged>` calls
let Git carry forward non-overlapping operator changes and report colliding
paths. The pending merge precedes the guarded ref update; a later poll retries
the same two-tree checkout transition across the crash window and observes the
PR as merged only after synchronization succeeds. Forge-native base snapshotting lets
it pin the current local base without `origin`, while capability-less adapters
retain the legacy private-ref fetch path. Dispatch constructs one
selected adapter before opening the store and threads it through runners,
epilogue, and janitor work. Scoped `packages/core/src/cli/binary.ts` processes independently
load immutable config and repository-path plugins from the build worktree, use
`resolveMainRepo` to locate the consuming checkout only for bare-package lookup,
and resolve the same adapter name for phase terminal plumbing. This keeps
package availability independent of local-store/worktree placement without
redirecting branch-owned plugin source or factory `repoRoot` away from the
worktree. `packages/core/src/ports/workspace/create.ts` similarly resolves
`[workspace].provider`, retaining host-owned git-worktree construction while
passing plugin config, environment, and repository root to registered
factories. Ticket-source selection is registry-backed in
`packages/core/src/ports/tickets/create.ts`; dispatch and sessionless `ab ticket` commands
load plugins before constructing it.

`packages/core/src/plugins/runtimes.ts` invokes plugin runtime factories in registration
order, validates their capability-bearing registrations, and returns one fresh
registry containing builtins and plugins. Dispatch performs that composition
before eager role resolution and shares the result with build, harvest, and
slug routing. Upgrade performs the same composition lazily at its first merge
conflict.

`packages/core/src/cli/repo-state.ts` owns repository identity and store precedence
(`--store` > `AB_STORE` > `[store] url` > `.autobuild/`); `packages/core/src/cli/store-opening.ts` is the
production store composition boundary shared by finite sessionless queries and
phase sessions. Its shared scoping primitive preserves remote token composition
and adds local ambient authority only for filesystem stores. The dedicated
ambient-read opener classifies identity before repository or Store opening and
is adopted only by `ab builds`, `ab build status`, and `ab artifact download`;
all other sessionless commands keep the generic unwrapped opener.
`packages/core/src/cli/repository-status.ts` consumes that boundary and the kernel's
`reduceDispatchSettings` projection to report journal-backed dispatcher
controls without ensuring a repository stream or starting dispatcher work.
`packages/core/src/cli/args.ts` parses command-scoped flag contracts; `packages/core/src/cli/binary.ts`
classifies build/harvest session tuples and routes sessionless invocations, so
phase-only commands report their complete runner context when run by hand.

**PR attachments.** `packages/core/src/cli/artifact.ts` atomically turns an explicit
`artifact put --attach` into an exact artifact plus designation fact.
`packages/core/src/kernel/pr-attachments.ts` selects current designations, hosted
correlations, and pending cleanup without coupling to a producer or verify-step
name. `packages/core/src/cli/pr-attachments.ts` performs optional image hosting through the
narrow Forge capability, while `packages/core/src/cli/pr-summary.ts` renders the same complete
text projection for finalize and late designations. `cli/pr-summary-publication.ts`
coalesces these at completed phase boundaries with durable attempt, result,
cooldown, request, and disposition facts. Built-in forges upsert one hidden
per-build marker; legacy plugins keep the existing bounded `commentOnPr` API.
Oversized bodies become a compact pinned download of a full `pr-summary`
store artifact. Local runners publish under their lease; remote guests request
and yield, and dispatcher settlement fences ended execution and owns the
publication lease before launching replacement work. Summary failure never
changes phase outcomes. The GitHub release transport
lives in `packages/core/src/ports/forge/github-pr-attachments.ts`; terminal-build reclamation
and retry facts remain dispatcher janitor duty.

**Abort control and cleanup.** CLI and dashboard call the same
`packages/core/src/cli/build-control.ts` service. A confirmed dashboard `a` action appends only
the durable abort request. After claiming the build lease, `build-runner.ts`
acknowledges an already-pending pause or abort before workspace setup, without
appending `runner.attached`; resume and workspace-using decisions stay behind
successful setup. For a request arriving during an AgentRunner turn, the runner
observes the BuildStore subscription, forwards an `AbortSignal`, deposits/ends
the session without a phase failure, and acknowledges abort. The execution
supervisor keeps the lease until every local descendant is reaped. `dispatcher.ts`
defers destructive abort, discard, and terminal-PR cleanup while that lease is
live, then resumes the event-checkpointed janitor saga that closes an unmerged PR,
releases the workspace, deletes exact remote/local branch
refs, unions `autobuild:aborted` into current ticket labels, returns the ticket to
Triage, and appends abandoned completion last. Forge close/delete operations are
optional API 1.2 capabilities so older plugins load but leave cleanup visibly due.
AgentRunner failure causes and the exhaustion contract fixture are additive
plugin API 1.3 surfaces; legacy failures without a cause retain permanent-bit
behavior.

**Dashboard.** `packages/core/src/cli/dispatch-frontend.ts` is a Store-only terminal adapter:
it has no ticket, forge, workspace-provider, LiveConfig, or runtime dependency.
It follows one dispatch run's repository facts incrementally through
`packages/core/src/kernel/dispatch-status.ts`, retaining only low-volume settings/Harvest
facts for their replay reducers, validates/caches its effective-config artifact,
and polls build streams independently while elapsed paints continue from cached
intervals. The same polling path samples the header's current count from build
digests plus the repository journal — one journal read plus one repo-scoped
digest read, plus a journal-record probe — paired with the effective config's
`policy.harvestThreshold`. A journal record that does not yet exist reads as an
empty journal: the sample, the operator query, the dispatcher's
repository-wide journal reads (controls, settlement stages, and ready
scans), and the operator sandbox service's journal reads all go through
the same shared missing-record journal read (the AUT-524 helper in
`packages/core/src/processes/harvest.ts`), which writes nothing (no
`ensureRepo` from a display path). That sample
is process-local presentation state: a failed refresh preserves the last
successful value and adds a local diagnostic, while an initial failure delays
the complete frame rather than inventing zero. No repository fact transports
it, and the headless child does not scan for presentation. Navigation is
synchronous presentation state; only Store reads and writes enter its UI action
queue. The supervised kernel child owns every slow
adapter operation, so slug naming, provisioning, runners, and Harvest cannot
block input.

The frontend's `dispatchFrontend` checkpoint retains dashboard facts plus only
the latest run-started fact and the sampled lease holder's start (deduplicated).
Identity history is always partial, including normalized legacy version-4
caches; a missing holder is resolved through the bounded per-run reduced read.
Successful lease samples select or clear the retained holder; failed metadata
reads preserve the last selection. Snapshot saves track cursor and effective
retained-state changes locally: written, refused and unsupported attempts settle
that projection and are never repeated unchanged. Ordinary dirty saves are at
least 30 seconds apart. Transport/store failures retry without new events after
30, 60, 120, 240, then 300 seconds (capped). Concurrent saves share one request;
only its captured projection is acknowledged. Teardown forces a dirty save past
the time gate, while settled state stays quiet. Equal-cursor refusal does not
make correlation durable: restart reconstructs it through bounded holder lookup,
and the next advancing-cursor checkpoint carries it without relaxing snapshot
ordering. A validated, already normalized restored checkpoint starts clean.

`packages/core/src/cli/dashboard/refresh.ts` owns the shared presentation read
scheduler for both terminal paths: focused by default, independent of focus for
local stores, and 5-second polling when unfocused for network stores,
immediate on focus-in or keys, 500 ms with retained builds or during a 30-second
interaction hold, and 5 seconds when idle. The optional BuildStore.networkReads
capability identifies remote HTTP and Postgres adapters, including wrapped stores.
Session feeds and automatic recovery follow the same cadence; unchanged network
polls retain the change-position savings and bounded enrichment exception. Presentation store facades check
admission at every asynchronous read stage; the kernel uses its original store
and independent tick timers. Cached clock paints perform no reads. The mode
ledger owns focus reporting through teardown and catchable faults; job-control
suspension restores modes and input before stopping and reactivates with assumed
focus on resume. Plain, non-TTY, and once runs never enable focus reporting. The active
`processTerminalInput` subscription synchronously reasserts raw mode on activation
and every 100 ms with adjacent false/true calls, bypassing Bun's cached `isRaw`
after a retired generation restores shared termios at exit. Its unreferenced
timer is disarmed before cleanup restores prior raw/flow state; release,
suspension and shutdown therefore leave no raw-mode maintenance behind. Timer
failures tear down the subscription best-effort; activation failures propagate.

`packages/core/src/cli/build-progress.ts` projects the exact last-event, heartbeat, and lease
inputs shared by the diagnostic `ab builds` and `ab build status` surfaces. Its
one-hour `diverged` predicate is presentation-only: reducer status, engine
routing, and lease health remain independent. `packages/core/src/cli/dashboard/model.ts` is
the event-derived build-row projection; `poll.ts` reprojects rows for event or
effective-config changes and bounded enrichment refreshes while retaining the
cached log and reduction. `repository-poll.ts` serializes the complete presentation
snapshot in both terminal paths. It samples `getRepoChangePosition` before reads,
acknowledges it only after complete admitted reads, and reuses unchanged snapshots
for up to ten seconds. Scoped discovery uses `listBuildsForRepo`; unchanged focused
frames make one counter request. Session feeds remain independent.

The memory adapter maintains independent bigint counters; SQLite and PostgreSQL
increment `repo_change_positions` transactionally through triggers on build,
build-event, repository-event insertion and null-safe repository lease holder
changes. Reads return decimal text (unknown repos: `"0"`) without journal creation.
The hosted counter route returns only that position; scoped build discovery has
its own repository-authorized route before the journal-existence gate. PostgreSQL
counter DDL is additive, outside the guarded core schema/checksum, and must be
explicitly migrated before the service rollout. Existing writers use the same
triggers; rerunning migration preserves positions without replaying old events.
`detail.ts` projects chronological session history from the same retained log,
including a distinct transcriptless `reclaimed` ending, and `transcript.ts`
heuristically presents ordinary opaque transcript artifacts with a raw
fallback. `render.ts` composes the list, build-detail, and transcript as
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

**Agent tool registry.** `packages/core/src/operator/registry.ts` is the agent-facing
face of the operator services: one closed table of typed tools whose handlers call
the same control, query, ticket, and artifact services the operator API routes call
(`operator/control.ts`, `operator/query.ts`, `operator/tickets.ts`), with the
route-level glue re-derived beside it in `operator/requests.ts` and tool/route parity
proven per tool by `operator/registry.contract.test.ts`. Every binding is generated
from the table and never widens beyond the operator services: the shipped one is
`packages/core/src/cli/mcp.ts` (`ab mcp`, a stdio MCP server over the registry that
fails closed inside a phase, exactly as repository-wide `ab builds` does); the
hosted HTTP and MCP transports register from the same table. Checked-in
risk classes live in `operator/annotations.ts` (SPEC §8.9).

**Init and upgrade.** `packages/core/src/cli/init.ts` owns deterministic skill vendoring,
ignore maintenance, runtime probes, and the stack-neutral first config. It then
launches an interactive agent CLI, or prints the identical short prompt, telling
the setup agent to read the installed
`.agents/skills/ab-guide/references/setup.md`; this bypasses all build and
BuildStore session plumbing. Existing config is never reconciled, even with
`--force`. `packages/core/src/cli/upgrade.ts` owns the pristine × local × incoming skill merge,
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
bun run dev:cli -- dispatch
# Generic form: bun run dev:cli -- <ab arguments>
```

Bun keeps the original CLI promise and its `DispatchLoop` alive while hot
module evaluation replaces only the renderer used by the next repaint. Edits
to `packages/core/src/cli/dashboard/render.ts` and presentation-only dependencies imported
by it appear without restarting runners, releasing leases, or stacking input
handlers. Changes to dispatcher logic, dashboard model/controller logic,
keyboard handling, or build-runner code still require a restart. The
installed `ab` binary remains the non-watching production entry.

### Contract suites

The seams are the contract. Five reusable contract families run the same
behavioral assertions against every implementation:

- `packages/core/src/store/contract.ts` — `BuildStore` and `BlobStore`, including the streams block (§7.6) and the ticket-asset block (§7.1.3) every adapter runs;
- `packages/core/src/ports/tickets/contract.ts` — `TicketSource`;
- `packages/core/src/ports/workspace/contract.ts` — `WorkspaceProvider`;
- `packages/core/src/ports/forge/contract.ts` — `Forge`, including idempotent PR close and
  branch deletion with merged-race preservation;
- `packages/core/src/ports/runner/contract.ts` — `AgentRunner` session/continuation,
  transcript metadata and usage, typed failure permanence/cause, per-turn
  ambient environment refresh and cancellation, distribution-managed `ab`
  resolution, and the optional tool-free one-shot capability.

`packages/core/src/ports/runner/routing.ts` eagerly resolves every role's primary, ordered
alternate targets, and independently inherited build-session budget.
`build-runner.ts` and `harvest-runner.ts` own the deterministic
primary-first attempt loop: each substitution opens a new session bracket,
records provenance on its start, and only complete-chain exhaustion consumes an
existing phase/session attempt. A suspended harvest turn first tries its recorded
route, then the remaining targets in configured order; provider evidence retains
configured indexes, and only the primary stays live for producer revisions.
This keeps runtime availability routing out of
agent judgment while preserving transcript and artifact actor attribution.

A normal `bun test` runs the memory/fake/local registrations, including a fake
selected through the plugin ticket-source registry, the real filesystem and
local-git adapters, the injected Claude and Codex CLI subprocess contracts,
and the injected Pi CLI/RPC contract.
Ticket assets (SPEC §7.1.3) are files attached to a ticket and kept in the
ticket service for hosted tickets, independently of build storage, and in the
BuildStore for other sources. `packages/core/src/store/ticket-assets.ts`
holds the types, the limits, and the one validator every adapter calls;
`packages/core/src/cli/ticket-assets.ts` holds the filesystem walk, the download
writer, and the note builder; `ab ticket attach`, `asset get`, and `asset rm`
live in `packages/core/src/cli/ticket.ts`. The optional hosted source asset
capability reuses RemoteBuildStore transport with the ticket URL and credential.
Other sources retain the existing store path.
A claim freezes the ticket's current assets into the build (SPEC §6.3):
`build.created.assets` (and, when a spec is revised from the ticket,
`spec.revised.assets`) record the pinned revisions, `state.pinnedAssets` in the
reducer projects them, `getPinnedTicketAsset` reads them back by pinned revision,
and `ab context` writes them under `$AB_CONTEXT_DIR/assets/`.

For hosted tickets, `store/ticket-asset-snapshots.ts` copies exact revisions
into chunked immutable repository artifacts in the build store before pinning.
Reads use explicit manifest/chunk revisions without a ticket connection. Old
pins retain ticket-row reads; existing service attachments need no migration,
and attachments in old local stores are not moved.

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

Both `ab dispatch` and sessionless `ab ticket` load the repository's plugins
before selecting their TicketSource; dispatch passes that one adapter instance
through readiness, dependency, harvest, and completion paths. The Linear,
GitHub, and real-runtime AgentRunner registrations are present in the same run
but reported as skipped: live provider access requires credentials/resources
and an explicit opt-in. When
adding an adapter, start from its contract suite, not only the interface.

The two remote clients get client-only unit coverage in core itself:
`RemoteBuildStore` (`store/remote/client.test.ts`, which also pins scoped-token
minting/verification) and `HostedTicketSource` (`ports/tickets/remote.test.ts`)
run against an injected `fetchFn` with responses built from the protocol's wire
schemas. The full over-the-wire seam suites (client → HTTP → server) run in
`packages/hosted-store-service` in the same `bun test`.

To run the Linear contract manually against a destructive scratch target:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
LINEAR_API_KEY=… \
AB_LINEAR_CONTRACT_TEAM_KEY=SCRATCH \
AB_LINEAR_CONTRACT_PROJECT_ID=… \
bun test packages/core/src/ports/tickets/linear.live.test.ts
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
bun test packages/core/src/ports/forge/github.live.test.ts
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
bun test packages/core/src/ports/runner/claude.live.test.ts

AB_RUN_LIVE_PORT_CONTRACTS=1 \
AB_CODEX_CONTRACT_MODEL=gpt-… \
bun test packages/core/src/ports/runner/codex.live.test.ts

AB_RUN_LIVE_PORT_CONTRACTS=1 \
AB_PI_CONTRACT_MODEL=openai/gpt-… \
bun test packages/core/src/ports/runner/pi.live.test.ts
```

Claude uses the locally installed Claude Code CLI and its configured login; the
live command therefore requires an installed `claude` executable whose browser
login has already completed. Its offline suite injects a subprocess executor
and covers direct argv, native resume, stream-json parsing, usage, transcripts,
and failure classification without launching the CLI. The one-shot argument
set was checked against Claude Code 2.1.245 `--help` and [Anthropic's CLI
reference](https://code.claude.com/docs/en/cli-reference): `-p` produces one
non-interactive result, `--no-session-persistence` prevents resumable storage,
`--tools ""` disables built-in tools, and `--disallowedTools "mcp__*"` denies
MCP tools. This is compatibility evidence, not a repository-wide minimum
version. Codex similarly uses the locally installed `codex` executable after
`codex login`; its offline suite
pins direct argv, `$skill` invocation, JSONL parsing, native thread resume,
startup diagnostics, and tool-free one-shot rejection.

Pi requires a locally installed `pi` executable at version 0.84.3 or newer. The
full AgentRunner smoke uses that installation's login and model catalog for the
authenticated provider named in `AB_PI_CONTRACT_MODEL`. The same live file also
checks production extension gating against two packages installed and enabled
in the operator's user-visible Pi settings:

```sh
pi install npm:pi-subagents
pi install npm:pi-web-access
```

That package probe does not invoke a provider and can be selected without
`AB_PI_CONTRACT_MODEL`:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
bun test packages/core/src/ports/runner/pi.live.test.ts -t 'gates tools discovered'
```

Once opted in, the probe fails with the missing expected tool and its exact
`pi install` remediation if either package is not discoverable; it never skips
and implies package coverage ran. The live fixtures create isolated temporary
project skills, extensions, and probe files and remove them after each run;
provider failures remain in the deterministic injected adapter contracts
because they cannot be manufactured safely against a live account.

Provisioning or scheduling these credentials/resources in CI is deliberately
out of scope; live runs remain explicit.

## Hosted project registry

`packages/postgres-store/src/projects.ts` owns a narrow project registry port
beside BuildStore. Schema v10 adds an independent append-only project journal
and singleton mutation/bootstrap lock and marker, with no build/ticket foreign
keys. Active entries reduce the latest sequence per origin; timestamps are
metadata, not ordering. Runtime opens assert schema and never run DDL.
`ab-hosted-store projects` administers registrations using database authority.
The service exposes one lazy live reader to the operator server, web gateway,
MCP and server-rendered repository picker. Initialization failures clear the
cached promise for retry. The dispatcher opens its own shared pool and queries
membership each invocation. See [owner workflow](remote-store-protocol.md#7-authentication-and-project-authority).

## Delegated execution authority

`store/remote/credentials.ts` owns the credential exchange client independently
of the BuildStore persistence port. The hosted service's `delegated-authority.ts`
validates issuance, durable lifecycle bindings and the 60-second terminal grace;
`machine-auth.ts` authenticates these signed version-2 grants as delegated
principals. `remote-store-server.ts` enforces resource mutations before deposits,
including body-selected and addressed-stream resources. Operator routes reject
these principals. Build-runner and build-phase grants may append only the
kernel's `dispatcher.forge-degraded` repository fact, in their own project,
so runner/CLI guards can record a newly observed rate limit and wait for
durable dispatcher recovery. This exception grants no repository administration,
recovery, lease, or other journal writes. The agent-visible build-scoped Store
still denies repository writes. Ticket routes deny build grants and allow harvest grants only the reads and
runner filing operations they require. Ticket sources and assets are partitioned
by the authenticated project.

Dispatch prepares harvest claims using `HarvestRunner.run(true)` before issuing
an execution grant. `harvest.execution.authorized` binds the selected run,
execution and adopted lease holder; the guest resumes only that prepared run.
Local completion records `harvest.execution.ended`; hosted completion retains
its provider release fact. Recovery controls remain trusted dispatcher work.
Execution launch auth is transient and separate from serialized identity. Runners
request exact phase grants after session-start facts and before runtime calls.
Workspace plugin factories receive an exchange callback and a scrubbed environment,
while local children and sandbox bootstrap/launch replace inherited authority.
Service requests reread durable state; detached executions need neither renewal
secrets nor their original dispatcher. Local stores retain their existing path.
Project onboarding uses `cli/connect.ts`, user-level `cli/project-credentials.ts`,
the shared `connection.ts` wire types, and Postgres `connections.ts`. Approval
commits registry membership, organization assignment, a credential digest, and
the outcome atomically. Assignment classification is independent of registry
history; every unassigned approval requires an explicit eligible organization.
The web connection routes authenticate the existing Better Auth session and
reuse the sign-in/consent layout. Valid code links look up approval immediately,
including on return from sign-in; the view shows selected destinations or the
read-only assigned organization. CLI polling uses a separate private capability.

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
Direct file edits and state-directory moves change revisions. File comments
change the body and revision; separate hosted comments do not. Hosted revisions
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
Hosted state initialization checks only the distinct configured role names through
an indexed project/name lookup. Already-present names require no state mutation
lock or writes. Missing names are rechecked under the project advisory lock and
inserted in the same transaction. Custom-state creation and policy publication
always take that lock; publication reads the previous policy under it and retains
former role names atomically. Ordinary service requests do not eagerly list state
counts; explicit state listings and legacy policy materialization still do.

Independent harvest uses revocable, expiring, service-bound ticket grants with
read/create runner authority and read-only child authority. Build state and harvest
journals remain exclusively in the selected BuildStore.

Hosted ticket detail reads expose complete, oldest-first structured comments in
`ticket.comments`, preserving exact bodies. Scans do not fetch comments. Hosted
HTTP clients opt in with `x-autobuild-ticket-comments: 1` so historical strict
decoders retain compatible responses. File comments remain embedded in the body;
Linear comment reads are unchanged.

Ticket integration metadata lives in `ports/tickets/tree.ts`: source compatibility
normalization, capability refusal, graph validation and the pure tree projection.
File/fake/Linear adapters validate metadata at write boundaries; `operations.ts`
and CLI/operator source opening wrap injected or plugin sources with the same
compatibility facade. Metadata is excluded from hosted persistence/protocols.


### Integration node dispatch

The product dispatcher owns the workspace-free node lifecycle:
spec → node.opening → node.opened → collecting → complete → verify:* → consent → merge.
The ordinary work pipeline is unchanged. `build.created` freezes kind, target
ticket/build identity and resolved parent in `baseBranch`. Integration facts
are projected by the shared reducer and digests, including collecting/empty
state. Admission resolves same-source targets through repository read facts;
integration identities remain active for deduplication but consume no work slot.

Optional Forge node branch creation and comparison capabilities let GitHub
operate without a checkout and local-git operate directly on its shared refs.
Opening intent retains the sampled SHA across retries; adoption requires that
commit in the existing branch's history. Comparison uses reachability, so an
advanced parent never makes an empty node nonempty. The janitor opens PRs lazily
and reuses terminal cleanup without leaf reconcile or auto-merge.

### Leaf and reconcile restacking

The kernel prepares a detached replay of one net build change on the base frozen
by `reconcile.started`. The contribution baseline is the initial branch-cut base
or latest successfully published restack/reconcile base. The resolver continues that one replay;
completion requires one parent at the frozen base and the build identity trailer.
Historical merge completions retain their original shape and semantics.

The optional grouped Forge rewrite capability owns authoritative head snapshots,
immutable `refs/autobuild/archive/<slug>/<sha>` publication and expected-head CAS.
GitHub uses explicit Git transport leases; local-git uses shared-database
`update-ref` CAS without network calls. Exact authoritative readback acknowledges
publication. Remote-backed local refs are caches refreshed without expected-old
CAS after confirmation, even if absent or recreated; checkout files are untouched. Trusted remote publication archives before
replacement after guest teardown; it never uses ordinary append-only publication
for restacks. Prepared, replayed, intended and rewritten facts support recovery.
A contended rewrite preserves the observed work and retries on the same base.

`kernel/leaf-restack-state.ts` projects target observations, frozen transactions
and cycle gates into the log index and persisted build facts. The engine selects
automatic kernel work before any verify action and after finalize post-steps when
the target moves. `reconcile-restack.ts` shares collapse, detached replay,
archive-before-replacement and expected-head publication mechanics. Automatic
transactions emit `restack.*`; clean completion never starts a reconcile cycle.
Pre-PR conflicts adopt the prepared replay through ordinary reconcile. Initial
verification remains mandatory; waiting conflicts use post-reconcile policy.

The dispatcher observes targets without changing workspaces; execution ownership
and session settlement fence mutation. Transaction targets stay frozen while
later moves coalesce. `publication.requested` carries automatic transaction
identity through trusted remote teardown and publication. The runner settles
local resolver intent only after its session ends. Verification facts
cite the cycle's base/head. Clean waiting leaf rewrites preserve completed
verification when build-owned config is unchanged, even when the old pin commit
is no longer an ancestor. Changed config still supersedes while waiting.
Ancestry gates cycles that run further steps; those cycles capture fresh config.
Object packs retain newly introduced replay trees/blobs as well as commit bytes.

GitHub archive push/fresh-fetch and rewrite contracts are manual opt-in cases in
`ports/forge/github.live.test.ts`, using `AB_RUN_LIVE_PORT_CONTRACTS=1` and an
explicit disposable `AB_GITHUB_CONTRACT_REPO`. Offline transport tests are not
live provider evidence.

### Descendant node restacking

`kernel/node-restack.ts` inventories the contribution above the durable previous
base, proves foreign merge safety against the sampled parent's full identity set,
and replays individual changes. `kernel/node-restack-state.ts` reduces writer
reservations, ordered receipts, conflicts, publication intent, confirmed effects,
and inventory. `kernel/node-restack-transaction.ts` retains replay objects and
archives before expected-head publication. The dispatcher polls all open nodes,
including empty nodes, and advances clean cascades without agent calls. Only the
active conflicted item attaches a reconcile runner, using source-build artifacts
materialized by the dispatcher into the integration owner's store scope.

`kernel/node-parent.ts` coordinates lifecycle-aware target mutations for CLI
and operator requests. It canonicalizes source aliases, checks the latest build
generation and proposed/effective/pending ancestry, and reserves a durable
`node.parent-requested` before provider mutation. Claimed work targets stay frozen;
a changed target requires abort and re-dispatch before any mixed patch is written.
The dispatcher reads node tickets independently of readiness and activates a
confirmed, revalidated request with `node.parent-accepted`. Provider edits use
the same validation; refusals are deduplicated by revision, target and reason.
Uncertain writes recover by source readback rather than replaying a caller patch.
Tracker observation errors are contained within that observation, preserving
ordinary cascade and PR handling against durable ancestry. Already accepted moves
complete their PR effects without another tracker read. Rejection comparisons use
revision, target and reason fields so JSONB key ordering cannot defeat deduplication;
`node.parent-rejection-cleared` removes a current refusal after correction while
preserving its history.

Accepted parent facts update node target/base projections while creation facts
remain provenance. Pending requests and moves fence verification, child merge
and source merge, and count against both parents' completeness. Existing writer
reservations settle before activation. The existing replay transaction freezes the
new destination and retains the old contribution boundary until completion, even
for distinct parents at the same SHA. Afterwards the dispatcher retargets the same
PR through the optional `Forge.retargetPr` capability, inspects its acknowledged
base/head, records a receipt and completes the parent operation. GitHub uses the
[documented PR update endpoint](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request)
with a branch-name `base`. Publication and PR acknowledgement retry separately;
terminal human PR changes keep their ordinary handling. Children retain the moved
node's identity and branch, so the usual target observations cascade the move.

In origin mode, node plumbing uses the forge's trusted `kernelExec` transport.
The GitHub adapter supplies its token through subprocess-only Git configuration,
scoped to the repository's HTTPS URL; credentials are absent from argv, saved
remote URLs, repository configuration and agent environments. Parent snapshots,
archives and expected-head writes use this same transport. The dispatcher checks
parent and node heads through the forge API before acquiring a repository: an
unchanged inventory needs no clone or Git commands. A required temporary clone
completes before the node writer lease is acquired, so download time cannot
expire writer authority. Build sandbox publication retains its separate trusted
receive-pack path.

`kernel/node-landing.ts` shares the node writer lease and reservation with
restacking. It cancels native auto-merge, refreshes actual PR refs, proves the
exact destination ungated and fast-forwards the canonical child commit under
CAS. The destination write proves merge; provider PR reconciliation is
best-effort and never decides or retries that write. Root merge retains squash
semantics. Store adapters expose node writer claim, renewal and holder-checked
release separately from execution leases; Postgres schema version 15 adds their
columns. Reservations live in the event stream and survive lease expiry.

The contribution boundary advances only on completed restacks. Reachable build
identities include inherited parent changes; foreign counts include only the
node's own contribution, preventing a parent rewrite from inflating descendants'
hand-pushed inventory (node-owned foreign commits). Status text and JSON expose
both inventory and active items, retaining original identities after rewrites.


Integration completion is sampled by `kernel/integration-completeness.ts` from
exhaustive source listings, frozen claims and retained contribution identities.
`integration.*` events retain observations, immutable cycle inputs, merge
intents, provenance and tree audits. The build reducer projects these facts and
`engine.ts` routes nodes directly through verification, without producer phases.
The shared `cli/dashboard/integration-detail.ts` projection supplies both
dashboards with all child titles/states, current verification outcomes, merge
rule explanations and restack files. Optional `integration.observed.children`
metadata stores source/id, title and contribution identity without changing the
authoritative membership arrays. Completed build records supply legacy title
fallbacks; missing historical titles remain explicit. Optional `files` on
`node.item-conflicted` and conflicted `restack.replayed` are captured as
NUL-delimited unmerged Git paths; historical missing filenames remain explicit.
Repository enrichment refreshes live child phases even without a parent delta.
Failed cycles park for repair children. The dispatcher temporarily provisions
verification resources and rechecks head, parent, controls and completeness
before publication. `integration-landing.ts` owns source-reserved root merge
and immutable result audits; nested nodes use the destination writer transaction
in `node-landing.ts`. GitHub uses guarded PR rebase; local-git validates
fast-forward shape against the frozen parent. Exact authoritative head readback
or a durable confirmed receipt establishes publication; ancestry alone cannot
acknowledge an unconfirmed candidate. Shared status vocabulary exposes provenance
and mismatch attention in both frontends. Human forge merges remain observable
escape hatches independent of completeness and verification.

### Merge authorization

The pure evaluator in `kernel/landing-policy.ts` chooses the first matching
`[[merge]]` rule. `kernel/landing-state.ts` reduces immutable candidate
decisions and persistent hold/merge commands. The dispatcher owns readiness,
ticket label sampling and native-state convergence. `kernel/landing-publication.ts`
confirms native cancellation at local and trusted remote head-publication seams.
Node merges retain the existing writer serialization and gate proof.

Build native session handles are kernel-authored `session.native-handle-recorded`
facts. The build reducer retains them by bracket session id after session end;
absence means no harness identity was reported. Adapters guard host/workspace
and resume only native persisted state with fresh execution options.

Operator pause immediately cancels live turns, records suspension with cause
`pause` (with or without a native handle, including remote workspaces), then
acknowledges the still-current request. A newer resume supersedes pause; abort
wins. Check-only steps and builds without a live agent retain boundary behavior.

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
Unknown crash usage is not fabricated. Pause interrupts live turns and retains
the suspension cause through continuation.

### Failure budgets and own-build read deferrals

`policy.maxVerifyAttempts` counts distinct failed logical verify cycles after
the latest spec revision. Passing and skipped cycles, including target movement
through restack or reconcile, consume zero. Cycle identifiers remain monotonic;
pass, pass, pass, fail at cycle 4 spends one failure. Duplicate completion
evidence for a failed cycle does not charge it twice.

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

## Forge failure recovery

`kernel/publication-retry.ts` selects eligibility from the publication ledger
and shares the policy between `processes/build-runner.ts` and trusted
`cli/publication-settlement.ts`. The lease sweep skips ineligible retained intents;
`ForgeRequestDeferred` also prevents release from recording publication loss.

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

For node cadence, durable wakes, restart behavior and CLI evidence, see
[node polling and status](integration-tree.md#polling-and-status).

The total includes all attempted requests. Optional `restPrimary`,
`restNotModified` and `graphql` counts distinguish REST responses charged to the
primary quota, REST 304s and GraphQL calls. Transport failures and historical or
legacy observations can remain unclassified; absent fields never imply zero.
Shared requests are attributed to their first requester; cache hits count zero.

Ticket-source continuity is reduced by `kernel/ticket-migrations.ts` from durable
repository `tickets.migration-recorded` facts. Import publishes only complete
mappings; current-operation resolvers leave build records and old events intact.

## Integration verification reporting

A failed node verification cycle records `integration.verification-failed` with its prepared cycle id, failed steps, exact head and parent, and guidance to file a repair child targeting the node. The kernel reports durable failed receipts; dispatcher housekeeping recovers missing reports for the current cycle using a per-cycle CAS guard. Superseded cycles are never backfilled with repair instructions: recovery requires the latest prepared cycle to match the node’s observed head and parent. This fact is decisive evidence and bookkeeping, and does not change verification or leaf routing.

Default `ab watch` includes this event. Watch cursors deliver each failed cycle once and baseline failures when first armed; reconcile build status after arming. `ab wait --for attention` also detects a current failed node cycle before the report is written. Historical facts remain queryable after repair without retaining current attention. Explicit event globs and existing stored wake choices are preserved.

`packages/core/src/kernel/integration-state.ts` retains reported cycle identities and selects missing failures from exact receipts. `kernel/integration-attention.ts` owns their CAS append; `processes/build-runner.ts` reports after verification and `processes/dispatcher.ts` recovers missing facts before per-build janitor gates. The shared `cli/dashboard/model.ts` projects current failure as blocked attention for both frontends.

## Operator node spec revisions

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

Verification stages are planned purely in `kernel/verify-stages.ts`, shared by
leaf and integration decisions in `kernel/engine.ts`. The build runner keeps
only live per-member handles and recovery contexts; durable starts, outcomes,
cancellations and failed-stage receipts drive every barrier and restart.
Fail-fast cancellation records facts before whole-execution teardown and
replacement. `kernel/verify-stage-state.ts` owns occurrence/session associations,
including escalation supersession and complete implement feedback references.

Human access uses `postgres-store/src/organizations.ts` and the shared hosted
`web/access.ts` policy. Auth schema v4 adds Better Auth organizations/member rows,
an authoritative normalized-email grant ledger and one project-to-org assignment.
Successful identity persistence materializes grants into member rows without
placeholder users or invitations. Mutations and connection decisions serialize
through the project registry singleton (after the connection row where relevant).
Admission and project filtering read durable state on each browser request and
MCP callback; session claims and activeOrganizationId confer no authority.

## Operator presence

A standing CLI operator operates the builds the repository's dispatcher dispatches.
`ab watch --operator` upserts mutable `(repo, id)` liveness rows in each BuildStore
adapter; a cursor carries the registration ID and original start time. Heartbeats
run independently of watch discovery and held reads. A final best-effort renewal
anchors orderly-exit grace; rows expire after 300,000ms. Neither registration,
renewal nor removal appends events, creates a repository journal or claims a lease.
SIGINT, SIGTERM, SIGHUP and stdout EPIPE cancel pending presence writes and attempt
one idempotent repository/ID removal within a shared two-second shutdown budget.
Failures retain TTL fallback (silently for an unsupported remote route); SIGKILL
remains TTL-only. Timeout/count completion retains presence for routine re-arming.
Reads on an unknown repository return an empty collection. Status loads presence separately
from fact reduction. Build/session/phase authority cannot register; remote routes
require repository operator authority. Concurrent advisory registrations coexist.
Unflagged watch and `ab wait` remain read-only; MCP and dashboards do not register.

Dashboard destination distance is projected from durable `target.distance`
(work) and `node.parent-distance` (integration) observations. Shared suffixes
are `+N`, empty when current, and `+?` when unknown, suppressed after merge or
close. Terminal headers reserve space for the destination before the slug;
web views keep their own layout and share the wording.


## Project-secret boundary

`packages/core/src/project-secrets.ts` owns the write-only DTO; browser-safe reserved-name
rules and the shared public explanation live in `packages/core/src/secret-name.ts`. `packages/postgres-store/src/project-secrets.ts` stores authenticated encrypted
payloads outside the BuildStore namespace, with metadata, mutation audit, a deployment
key verifier and generation/revision fences. Short transactions implement refresh
claim/completion CAS; provider HTTP occurs after the claim commits, with no backend
session affinity. An expired pending rotation fails without token reuse.

The separate `packages/hosted-store-service/src/web/project-secrets.ts` handler
uses fresh cookie-session organization membership or super-user authority for
Settings metadata and static writes. Its durable effective-config projection
returns only account names, kinds, credential slots and readiness. Browser writes
use the same transaction and project lock through `setStaticOnly`, refusing an
existing refreshing kind atomically. The Settings client fences stale polls and
keeps write acknowledgments separate from failed metadata rereads.

`packages/hosted-store-service/src/project-secrets.ts` authenticates owner-purpose
credentials and fresh membership before reading write bodies. It returns metadata
or acknowledgments and fixed safe errors. `ab secrets` uses saved connection
credentials directly and hidden input. The hosted dispatcher internally resolves
the complete set per tick, validates the handoff under the mutation lock, overlays
a fresh project environment, strips the encryption key, and redacts supplied
values in output/errors. Effective-config artifacts serialize declarative config,
not the process environment. Empty snapshots bypass decryption/key validation only
after reading and validating the complete version set under the project lock;
new secrets invalidate an earlier empty handoff. Writes always validate the key.
No operator/MCP/raw-store accessor resolves plaintext.

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
See [project deletion protocol](operator-api.md#permanent-project-deletion).

The ticket-source port optionally exposes `listPage(criteria, page)` for paged operator reads. PostgreSQL counts matches and applies SQL LIMIT/OFFSET; other sources retain exhaustive-read slicing. CLI and dispatcher reads stay exhaustive. See [ticket source contract](ticket-sources.md#writing-your-own).
