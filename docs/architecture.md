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
   Triage without a human grooming it to Ready.
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
  → scan → synthesize ⇄ review → file approved proposals in Triage
```

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs, the canonical verify outcome | §4 |
| `src/events/` | Separate build and repository envelopes/catalogs, frozen payload schemas, actor validation | §15 |
| `src/harvest/` | Structured occurrence, scan packet, proposal, and ledger schemas | §12 |
| `src/store/` | BuildStore plus repository-journal contract; memory, SQLite/blob, and remote HTTP adapters | §7 |
| `src/kernel/` | Phase table, build reducer, engine; pure harvest, dispatcher-settings, and PR-attachment selectors; converge, stall detection, verify gating, server lifecycle | §5, §7.5, §10, §12, §15.4–15.5, §16.2 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, and fakes; runtime/model routing under `ports/runner/` | §3.2, §9, §13 |
| `src/plugins/` | Strict versioned plugin manifests, repository-rooted Bun loading, and owner-aware adapter registration | §3.2.1 |
| `src/plugin-sdk/` | The sole supported `autobuild/plugin-sdk` barrel: port/manifest types, contract suites, and reference fakes | §3.2.1 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty and harvest trigger), harvest deterministic core + runner | §3.3, §12, §15.7 |
| `src/cli/` and `bin/ab.ts` | The `ab` CLI — the only agent↔store channel — plus init/upgrade and the dispatch loop | §8, §16.3 |
| `src/cli/dashboard/` | `ab dispatch`'s fixed live frame: pure projection, renderer, poll cache, and deterministic image renderer | §14 |
| `bin/agent/ab` | Private launcher placed first on agent-session `PATH`; delegates to the canonical `bin/ab.ts` | §8.1 |
| `src/config/` | `autobuild.toml` parsing and strict validation; user reference in `docs/configuration.md` | §16.1 |
| `src/integration/` | End-to-end harness and product scenarios | — |
| `tools/` | This repository's local verification tooling, including its dashboard-capture scene; not shipped product behavior | — |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference for the lifecycle and the full config surface. Update it when config changes; `src/cli/guide-skill.test.ts` fails if a schema field goes undocumented | §16.3 |
| `docs/spec-standard.md` | The definition of "buildable" every ticket surface cites | §6.1 |
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

**Phase decisions.** `src/kernel/phases.ts` owns the phase table,
`src/kernel/engine.ts` the deterministic transitions;
`src/processes/build-runner.ts` executes the decisions. Agents reach state
only through `src/cli/` terminals, which convert artifact deposits into
event facts atomically — the engine never reads blobs.

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
never a synthetic skip.

**Launch ownership.** `src/cli/dispatch.ts` single-flights build-runner
launches per slug within one process; the BuildStore lease remains the
cross-process gate. `src/processes/dispatcher.ts` counts actual schedules,
not suppressed polls. Open session history is never a lock — a dead session
may never close.

**Harvest.** The dispatcher owns the threshold trigger and starts runs
fire-and-forget; `src/processes/harvest.ts` is the deterministic core (scan,
occurrence identity, the exhaustion partition), `harvest-runner.ts` executes
the staged workflow under the heartbeated repository lease, and
`src/kernel/harvest.ts` reduces runs, claims, recovery history, and the
committed ledger with ordered parked/exhaustion/open selectors. The recovery
invariants are SPEC §12; the mechanics live in the reducer and its tests.

**Ticket sources.** `src/ports/tickets/`. `listReady` is an explicit
partial-listing seam: individually malformed records come back as
diagnostics (surfaced by the dispatcher's tick report and `ab ticket list`
stderr) while tracker-wide invariant violations stay fatal — one broken
ticket never blocks unrelated dispatch, but nothing that could permit double
dispatch is tolerated.

**Workspace and review base selection.**
`src/ports/workspace/git-worktree.ts` selects the branch-cut base once at first
creation, fetching into a build-scoped private ref; re-provisioning resumes at
the branch tip and never re-cuts, so the first provisioning fact remains
immutable provenance. Separately, each successful implementation terminal in
`src/cli/terminals.ts` privately refreshes the frozen target branch and records
the unique merge-base of that snapshot and `HEAD` in `implement.completed`.
It fails before publication/deposit on fetch, ref, ancestry, or ambiguity
errors and writes neither `FETCH_HEAD` nor operator refs. Reconcile's
execution-time target refresh in `src/processes/build-runner.ts` remains a
third, deliberately separate boundary and also fails closed.

**Agent runtimes.** `src/ports/runner/`: `runtime.ts` (capability-carrying
registry), `routing.ts` (eager role resolver), `production.ts` (shipped
Claude/Pi registrations), `one-shot.ts` (optional tool-free non-phase
completions — slug naming via `src/cli/dispatch.ts`, skill-conflict
proposals via `src/cli/upgrade-agent.ts`), `provider-error.ts` (positive-only
permanent-failure classifier), and `session-env.ts` (per-turn environment
merge that fronts `bin/agent/ab` on `PATH`). Adapters own SDK-native error
extraction; processes own durable failure policy — the transcript is always
deposited, and a turn's typed terminal always beats a late failure signal.

**Plugin bootstrap and CLI composition.** `src/plugins/load.ts` resolves every
configured relative or package module from the consuming repository, validates
its default manifest/API range, and atomically registers its factories before
production wiring or the first dispatch tick. `src/ports/forge/create.ts`
resolves the root `forge` selector, constructs GitHub or lazily invokes the
registered plugin factory, and preserves the returned adapter's optional
attachment capability. Dispatch constructs one selected adapter before opening
the store and threads it through runners, epilogue, and janitor work. Scoped
`src/cli/binary.ts` processes independently load the build worktree's immutable
config/plugins and resolve the same name for phase terminal plumbing. The other
plugin selectors remain builtin-only. `src/cli/repo-state.ts` owns
repository identity and store precedence (`--store` > `AB_STORE` >
`.autobuild/`); `src/cli/store-opening.ts` is the production composition boundary;
`src/cli/args.ts` parses command-scoped flag contracts; `src/cli/binary.ts`
classifies build/harvest session tuples and routes sessionless invocations,
so phase-only commands report their complete runner context when run by hand.

**PR attachments.** `src/cli/artifact.ts` atomically turns an explicit
`artifact put --attach` into an exact artifact plus designation fact.
`src/kernel/pr-attachments.ts` selects current designations, hosted
correlations, and pending cleanup without coupling to a producer or verify-step
name. `src/cli/pr-attachments.ts` performs optional image hosting through the
narrow Forge capability, while `src/cli/pr-summary.ts` renders the same complete
text projection for finalize and late designations. The GitHub release transport
lives in `src/ports/forge/github-pr-attachments.ts`; terminal-build reclamation
and retry facts remain dispatcher janitor duty.

**Dashboard.** `src/cli/dashboard/model.ts` is the only build-row projection;
`render.ts` composes the ASCII frame; `live.ts` owns the alternate-screen
region and teardown; `poll.ts` is a display-only incremental cache (the logs
remain authoritative — cache loss just rehydrates); `frame-image.ts` renders a
deterministic PNG with pinned fonts. The dashboard is an operator command
producer: every keypress that
does anything appends a human event to the applicable log, and the header
shows acknowledged durable state, never optimistic intent. Forge mutation
stays in dispatcher plumbing.

**Init and upgrade.** `src/cli/init.ts` renders first config as a pure
template render seeded from the target's package scripts and never
reconciles existing config, even with `--force`. `src/cli/upgrade.ts` owns
the pristine × local × incoming skill merge and all writes: agent output is
an untrusted proposal validated before anything touches disk, and every
failure path leaves live and pristine byte-untouched.

## Development

```sh
bun install
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

The seams are the contract. Four reusable contract families run the same
behavioral assertions against every implementation:

- `src/store/contract.ts` — `BuildStore` and `BlobStore`;
- `src/ports/tickets/contract.ts` — `TicketSource`;
- `src/ports/workspace/contract.ts` — `WorkspaceProvider`;
- `src/ports/forge/contract.ts` — `Forge`.

A normal `bun test` runs the memory/fake/local registrations, including the
real filesystem and real local-git adapters. The Linear and GitHub
registrations are present in the same run but reported as skipped: live
provider mutation requires both credentials and an explicit opt-in. When
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
configured project. The team needs a claimable `unstarted` or `backlog`
state, a `started` state, a `completed` or `canceled` state, and at least one
issue label the contract can replace/clear. Every issue gets a reserved UUID,
is attached to that project, and is archived during best-effort cleanup. Use
a project with no real work in it.

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

Provisioning or scheduling these credentials/resources in CI is deliberately
out of scope; live runs remain explicit.
