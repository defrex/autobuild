# Architecture

The contributor-facing map: how the codebase is organized and where the
seams are. `SPEC.md` is the source of truth for the design and terminology;
this document maps it to the code. For the user journey — install, configure,
operate — see [`README.md`](../README.md).

## Constitution

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state. Narrow pre-build judgment such as
   slug naming remains behind deterministic validation and fallback.
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
points, declared per-repo in `autobuild.toml`.

The reconcile boundary intentionally has two durable snapshots.
`pr.conflicted.baseSha` is what the janitor observed at conflict detection;
the pure engine uses it only as conflict sequence evidence. Immediately before
each real run, `src/processes/build-runner.ts` fetches the frozen
`build.created.baseBranch` from `origin` into a slug-scoped internal ref and
records the resolved commit in `reconcile.started.baseSha`. That matching
phase-start fact is what `src/cli/context.ts` gives the agent. Same-attempt
crash recovery refreshes again; movement after startup is handled by another
conflict/reconcile loop. Refresh failures are `phase.failed` infrastructure
facts and never fall back to the stale detection snapshot.

Observation harvest is adjacent, never added to that grammar:

```
K unclaimed observation.recorded events
  → scan → synthesize ⇄ review → file approved proposals in Triage
```

`ab dispatch` owns the back-pressure trigger. `src/processes/harvest.ts` scans
raw build envelopes by canonical `{build, seq}` occurrence; `harvest-runner.ts`
executes the staged workflow under a heartbeated repository lease. The dispatch
loop starts it fire-and-forget, keeps one process-local in-flight handle, and
drains that handle only for `--once`, so watch ticks and SIGINT remain
responsive. `src/events/harvest.ts` and `src/kernel/harvest.ts` define and reduce
a separate repository journal, including human pause/resume requests, kernel
boundary acknowledgements, claims, UUID-v4 reservation facts written before
external creates, per-proposal filing facts, and the committed dedup ledger.
Build reducers therefore never interpret a non-build workflow. The dispatcher
suppresses launch for either an acknowledged pause or a latest non-retrying
`failed` run when no resume is pending. The runner settles commands under the
repository lease and checks control between durable scan, synthesize, review,
filing, and escalation units. `harvest.resumed` opens the gate and reopens only
the latest failed run; completed and escalated runs remain terminal. Parking
leaves the run id, claimed occurrence snapshot, artifacts, attempt history,
reservations, and filing facts untouched, so resume skips every completed unit
rather than rescanning or re-filing. A repeated problem writes another failed
fact and parks again, preventing a watch-tick hot loop. Typed session deposits
live under `ab harvest context|submit|verdict`; `ab harvest status` and the
selectable `Harvest` dashboard row read the same facts. The row omits the
internal run id; that remains available through status and the repository
journal.

## Pre-build identity

After the spec gate, the dispatcher chooses a build slug once from the final
spec and then provisions branch `ab/<slug>`. Runtime registrations may expose
the optional, tool-free one-shot contract in
`src/ports/runner/one-shot.ts`; this stays separate from the resumable
`AgentRunner` session contract and is not a phase. `src/cli/dispatch.ts` routes
the internal `slug` role through the normal runtime/model resolver.
`src/processes/dispatcher.ts` owns the hard deadline, strict one-to-three-token
validation, deterministic title fallback, and store-wide numeric collision
suffix. Existing build records have no mutation path and are never re-slugged.

## Workspace base selection

`src/ports/workspace/git-worktree.ts` owns creation-time Git base selection.
For a missing build branch it fetches the configured base from `origin` into
`refs/autobuild/provision/<branch>/base` with no tags, `FETCH_HEAD`, configured
refmap, or operator-ref updates; resolves that private ref; and creates from the
immutable SHA. The raw branch path makes the destination unique across
concurrent builds. A remote fetch/resolution failure falls back to the fully
qualified local base and retains the Git diagnostic; failure to resolve that
local commit remains fatal.

The port returns `WorkspaceProvisionResult.base`, whose shared schema lives in
`src/ontology.ts`. `src/processes/dispatcher.ts` copies it into the strict
`workspace.provisioned` payload in `src/events/payloads.ts`, so the event log
records both the actual SHA and `remote | local | existing` source. Existing
worktree and branch checks precede the fetch, preserving resume at the branch's
current tip without refresh, rewind, or re-cut. This path is intentionally
separate from `BuildRunner.refreshReconcileBase`: reconcile refreshes an
in-flight PR's merge target and fails closed, whereas first provisioning falls
back locally so dispatch remains available.

## Agent turn failures

`src/ports/types.ts` makes an agent turn a discriminated completed/failed
result. Adapters own SDK-native extraction: `src/ports/runner/pi.ts` retains
the final assistant error after Pi's internal retries settle, while
`src/ports/runner/claude.ts` interprets the SDK result/error fields. Both feed
`src/ports/runner/provider-error.ts`, the shared positive-only classifier for
permanent authentication, permission, quota, and billing signals, and both
retain an endable handle for rejected turns.

Processes own durable policy rather than adapters. `src/processes/build-runner.ts`
deposits the transcript and `session.ended`, writes the provider message to
`phase.failed`, and derives immediate policy escalation from durable
`willRetry: false` before another session can start. A completed turn without a
typed terminal remains the separate `no-terminal` case. `harvest-runner.ts`
uses the same result contract; its reducer parks `harvest.failed
{willRetry:false}` until a human resume acknowledgement clears the reduced
error. Historical attempt counts remain monotonic, but that cleared boundary
permits one actual session re-entry even when the old occurrence exhausted its
ordinary budget. A new failure consumes the grant and parks again.

## Repository initialization

`src/cli/init.ts` treats first config creation as a pure render over
`templates/autobuild.toml`, which is itself a valid setup-only, zero-verify
baseline. Three comment anchors receive fragments from one fixed descriptor
table: exact root-package scripts `lint`, `type-check`, and `test` generate
`bun run` commands; only `type-check` and `test` generate the matching `types`
and `unit` check tables. Anchor cardinality is validated so template drift
cannot silently omit a declaration or leave a dangling verify reference.

Package inspection occurs only after init establishes that `autobuild.toml` is
absent. Missing `package.json` or `scripts` means an empty detected set, while
malformed JSON and invalid recognized declarations fail with the manifest
path. Once config exists, later package changes — or even an unreadable
manifest — are irrelevant: init skips rendering and never reconciles config,
including under `--force`.

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs | §4 |
| `src/events/` | Build and repository-harvest envelopes, frozen payload schemas, actor validation | §15 |
| `src/harvest/` | Structured occurrence, scan packet, proposal, and ledger schemas | §12 |
| `src/store/` | BuildStore plus repository-journal contract; memory, SQLite/blob, and remote HTTP adapters | §7 |
| `src/kernel/` | Phase table/build reducer/engine plus the separate pure harvest reducer; converge, stall detection, server lifecycle | §5, §10, §12, §15.4–15.5, §16.2 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes. Runtime/model/extension routing lives in `ports/runner/`: `runtime.ts` (the capability-carrying registry), `routing.ts` (the eager resolver), `one-shot.ts` (optional pre-build completion), `provider-error.ts` (shared permanent-failure classifier), and the `claude.ts` / `pi.ts` SDK error extractors/adapters | §3.2, §6.3, §9, §13 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel; `init.ts` owns first-config package-script detection and rendering | §8, §16.3 |
| `src/cli/dashboard/` | `ab dispatch`'s fixed live frame — pure reducer projection/rendering, discriminated global/harvest/build row selection, contextual controls, status overlay pixels, and in-place replacement | §14, §15.5 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty and harvest trigger), harvest deterministic core + runner | §3.3, §12, §15.7 |
| `src/config/` | `autobuild.toml` parsing and validation | §16.1 |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` (Pi/Agent Skills) and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference covering the lifecycle, the complete `autobuild.toml` surface, and the other skills. Update it when the config surface changes; `src/cli/guide-skill.test.ts` fails if a schema field goes undocumented | §16.3 |
| `docs/spec-standard.md` | The definition of "buildable" every ticket surface cites | §6.1 |
| `templates/` | Valid setup-only config baseline with comment anchors rendered by `ab init` | §16.3 |

The renderer reserves one selectable `Auto Build` title row, one always-present
status row, a blank separator before the harvest/build body, and another before
the contextual legend/modal controls. It shares the selection marker and
right-pinned status column across harvest and build rows; `Harvest` is
operator-facing identity, while its run id stays in the journal. Auto-merge
reduction retains four states, but rendering collapses the three active states
to `auto merge` with cyan/green/yellow emphasis and omits the token for `off`.

The dashboard is an operator command producer, not forge plumbing. Its model
tracks selection as `{kind: 'global'} | {kind: 'harvest'} | {kind: 'build',
slug}` over global first, optional harvest second, and slug-sorted builds. The
always-present global identity and structural reconciliation prevent repaint,
insertion, or removal from retargeting by row index. The legend derives from
that identity. `m` narrows it to a build and remains explanatory on global and
harvest. `p` branches by identity: global toggles process-local intake, builds
append human events to their stream, while harvest appends
`harvest.resume-requested` when the reduced gate is paused or the latest run is
failed, and otherwise appends `harvest.pause-requested`.
`FAILED` stays distinct from `RUNNING`, marks the exact stopped step, and uses a
distinct error-resume status message. An escalated run is never treated as this
recoverable infrastructure state. Build-runner and harvest-runner acknowledge
pause/resume at their respective safe boundaries;
dispatcher code reconciles auto-merge via the `Forge` port. On a blocked build,
`p` instead opens slug/escalation-bound process state: Enter
appends one human `escalation.answered` per captured id (`retry` for blank
input, `guidance` for text), then requests resume too if the reduced build was
paused. Escape writes nothing. The field is overlaid on the pure dashboard
model, so blocker rows and polling remain live while terminal input edits
synchronously; only submission joins the serialized operation queue.
Reattachment remains the ordinary dispatcher lease sweep. The GitHub adapter
combines exact-branch classic protection and active ruleset probes with the
complete PR merge-state enum: a real gate keeps native auto-merge ownership,
while only two successful negative probes can return a guarded direct-squash
candidate. `Dispatcher.checkPr` is the sole fallback owner and additionally
requires positive mergeability, unchanged latest intent, and
`decideNext(...)=awaiting-pr`; the normal non-admin merge is head-SHA guarded
and completion remains an observed `pr.merged` fact on the next poll. The
automatic startup path in `src/processes/dispatcher.ts` is unchanged and
retries only an all-policy escalation set without input. Intake is process-local
state that gates only the current dispatcher's ticket-claim stage. CLI
`--intake`/`--no-intake` seed it (default on), and global-row `p` toggles it
after launch; it is never persisted. Dispatcher notices are a process-local
latest-status overlay reapplied after every asynchronous projection; dashboard
mode never routes them to line sinks or scrollback, while plain mode keeps those
sinks.
The live region therefore owns only in-place frame replacement and cursor
restoration. Raw input and live output remain separate adapters so keypresses
cannot write into or tear a rendered frame.

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
to `src/cli/dashboard/render.ts` and presentation-only dependencies imported by
it therefore appear without restarting runners, releasing leases, or stacking
input handlers. Changes to dispatcher logic, dashboard model/controller logic,
keyboard handling, or build-runner code still require a restart. Ctrl-C follows
the normal CLI teardown path, including raw-mode cleanup and cursor restoration.
The installed `ab` binary remains the non-watching production entry.

The seams are the contract: every `BuildStore` adapter must pass the suite
in `src/store/contract.ts`; every event write passes
`validateEventWrite` or `validateHarvestEventWrite`; phase behavior derives from the table in
`src/kernel/phases.ts`. When adding an adapter, start from the contract
tests, not the interface.
