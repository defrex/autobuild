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

## Verify outcome boundary

`src/ontology.ts` owns the canonical `pass | fail | skipped` outcome.
`src/events/payloads.ts` writes it as a strict `verify.completed` discriminated
payload; `skipped` requires a trimmed non-empty reason. The same schema retains
a separate strict legacy `{pass: boolean}` branch, and
`normalizeVerifyCompletion` maps historical booleans to pass/fail at consumer
boundaries without rewriting stored events. Mixed legacy/canonical shapes are
invalid.

`src/kernel/reducer.ts` projects outcome and skip reason as queryable state.
`src/kernel/engine.ts` uses exact predicates: only `fail` routes to implement or
consumes `maxVerifyAttempts`, while `pass` and `skipped` satisfy that one step.
A failure anywhere in the cycle wins. Skips retain cycle attempt identity but
are not passing evidence. `src/processes/build-runner.ts` still gives
exit-code checks only pass/fail; only an agent verifier can explicitly call
`ab verdict skip --reason ...`, with no fail-report artifact. No code in this
boundary decides that a step is inapplicable.

`src/cli/status.ts` exposes canonical outcomes and skip reasons in the detailed
text/JSON projection, `src/cli/terminals.ts` includes them in the PR audit
summary, and `src/cli/dashboard/model.ts` treats skip as satisfied while
attaching a literal `skipped` qualifier. The renderer therefore remains
non-color-only without inventing a new pipeline lifecycle state.

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

## Build-runner launch ownership

`src/cli/dispatch.ts` owns a process-local single-flight map keyed by build
slug. It reserves the slug before asynchronous runner setup and clears that
exact reservation on setup failure or when the tracked run settles. Thus a
watch tick that sees a transiently stale lease cannot construct another
`BuildRunner` while this dispatch process still owns one; the runner's own
no-terminal retry remains sequential inside the same tracked run.
`src/processes/dispatcher.ts` receives an explicit `scheduled` /
`already-active` launch result so `resumed` and `swept` count actual schedules,
not suppressed polls. The BuildStore lease remains the cross-process gate: a
dead process loses the map, after which lease expiry permits durable-state
recovery. Open `session.started` history is not a lock because process death can
leave it open forever.

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
boundary acknowledgements, automatic recovery request/ack history, claims,
UUID-v4 reservation facts written before external creates, per-proposal filing
facts, recovery exhaustion/attention, and the committed dedup ledger. Build
reducers therefore never interpret a non-build workflow.

The dispatcher asks the shared pure control decision what is due before any new
scan. An ordinary failed run selects a kernel-only monotonic automatic request;
the runner records it under the repository lease and settles it through the
same `harvest.resumed` fact used by manual resume. Request and acknowledgement
are distinct crash-safe boundaries, and the fixed outer budget of two reopen
attempts is independent of within-step attempts. Parking and reopening preserve
the run id, immutable claim, artifacts, attempt history, reservations, and
filing facts, so recovery skips every completed unit rather than rescanning or
re-filing.

After the second automatic reopen fails, `src/processes/harvest.ts` derives a
provider-free partition from frozen scan/proposal artifacts plus filing facts.
It commits only classifiable filed creates, still-valid frozen joins, and
suppressions; missing creates, tombstone/unknown joins, and malformed or
otherwise unclassifiable content fail safe to pending release. Rejected store
reads propagate as retryable infrastructure rather than being classified as
content. `harvest.recovery-exhausted` records that exact partition and raises an
attention barrier. Dispatcher launch is suppressed until a human resume
acknowledgement clears that barrier;
the acknowledgement does not reopen the exhausted run. Completed and deliberate
escalated runs remain terminal, with escalation snapshots still claimed. Typed
session deposits live under `ab harvest context|submit|verdict`; `ab harvest
status` projects full history, while the dashboard separates the durable gate
into its always-present header token and projects a selectable `Harvest` row
only for an open run or unresolved failure/escalation attention. The row omits
the internal run id; status retains it.

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

## Agent session command environment

`src/ports/runner/session-env.ts` is the shared per-turn environment boundary.
It copies defined ambient values, overlays the current session's scoped
identity, and only then forces the distribution-relative `bin/agent` directory
to the front of `PATH`. `bin/agent/ab` is a private executable launcher that
imports the canonical `bin/ab.ts`, so agent tools use the same CLI wiring as the
operator binary even when the inherited host path contains another `ab`.

The adapters propagate that fresh map through their runtime-specific seams.
`claude.ts` supplies it as SDK `options.env`, which is the complete spawned
process environment; `pi.ts` supplies it to each prompt and its custom bash
`spawnHook` overlays it last onto Pi's shell environment. Continued turns
therefore receive both refreshed `AB_PHASE`/`AB_SESSION` values and the stable
managed prefix. Neither adapter mutates `process.env`, preserving isolation
between concurrent builds. This is CLI availability plumbing only; tool and
command authorization remain unchanged.

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
{willRetry:false}` at the stopped boundary. A human request or one of the two
durable automatic recovery requests is acknowledged through `harvest.resumed`.
Historical within-step attempts remain monotonic, while each acknowledgement
permits one actual session re-entry even when the old occurrence exhausted its
ordinary budget. Exhaustion is a separate atomic fact, not inferred from stdout
or a mutable counter.

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
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes. Runtime/model/extension routing lives in `ports/runner/`: `runtime.ts` (the capability-carrying registry), `routing.ts` (the eager resolver), `one-shot.ts` (optional pre-build completion), `provider-error.ts` (shared permanent-failure classifier), `session-env.ts` (per-turn ambient/scoped merge plus managed CLI PATH), and the `claude.ts` / `pi.ts` SDK error extractors/adapters | §3.2, §6.3, §8.1, §9, §13 |
| `bin/agent/ab` | Private executable launcher placed first on agent-session PATH; delegates to canonical `bin/ab.ts` | §8.1 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel; `init.ts` owns first-config package-script detection and rendering | §8, §16.3 |
| `src/cli/dashboard/` | `ab dispatch`'s fixed live frame — pure reducer projection/rendering, discriminated global/harvest/build row selection, contextual controls, status overlay pixels, and alternate-screen replacement | §14, §15.5 |
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
operator-facing identity, while its run id stays in the journal. The header
projects process-local intake and auto-merge-default plus the repository
reducer's acknowledged durable harvest gate as explicit ON/OFF tokens. Pending
harvest commands do not optimistically change that token. Per-build auto-merge
reduction retains four states, but rendering collapses the three active states to `auto merge` with cyan/green/yellow
emphasis and omits the token for `off`.

The dashboard is an operator command producer, not forge plumbing. Its model
tracks selection as `{kind: 'global'} | {kind: 'harvest'} | {kind: 'build',
slug}` over global first, optional harvest second, and slug-sorted builds. The
always-present global identity and structural reconciliation prevent repaint,
insertion, or removal from retargeting by row index. When a completed or
acknowledged harvest row disappears, its old index chooses the valid successor
or final predecessor. The legend derives from identity plus the run's currently
safe action. `m` branches by identity: global toggles the process-local
claim-time auto-merge default, builds append their normal durable control event,
and harvest remains explanatory. `p` branches by identity: global toggles
process-local intake, builds append human events to their stream, and a harvest
row only writes `harvest.resume-requested` for an ordinary failed run or
unresolved exhaustion/escalation. Running and pending-acknowledgement rows write
nothing; a paused gate directs the operator to the header rather than emitting a
run action. `h` is global-only: it re-reduces the repository journal, treats the
newest pending command as requested state so rapid presses oppose, and appends
the corresponding pause/resume request. The header remains acknowledged-only.

The harvest projection independently filters the latest run. Running stays
visible (with timing frozen when the gate is paused), completed is absent,
ordinary failure is visible until reopened, and exhausted failure is absent
after `attentionAcknowledgedSeq`. Escalation is absent only after a display-only
pair: a human resume request with seq after `terminalSeq`, followed by the kernel
resume that acknowledges it. The request alone remains visible and no reducer
lifecycle changes. This intentionally means a header resume can both open a
paused gate and settle visible run attention through the shared event
vocabulary. `FAILED` stays distinct from `RUNNING`: an ordinary stop names its step and
automatic progress, while exhaustion clearly names the attention barrier and
pending count. Exhaustion acknowledgement does not reopen the old run, and
escalation remains terminal. Build-runner and harvest-runner acknowledge
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
after launch; it is never persisted. The sibling auto-merge default is likewise
process-local: `--auto-merge`/`--no-auto-merge` seed it (default off), and
global-row `m` toggles it. Each serialized tick samples it only inside the fresh
ticket-claim path. When on, `Dispatcher` appends the existing human-authored
`build.auto-merge-requested` immediately after `build.created` and before
provision/runner launch. Resume, adoption, janitor, lease sweep, and direct
creation never consult it, while the ordinary reducer and build-row
cancellation path own all behavior after that seed. Dispatcher notices are a
process-local latest-status overlay reapplied after every asynchronous
projection; dashboard
mode never routes them to line sinks or scrollback, while plain mode keeps those
sinks.
The live region therefore owns alternate-screen frame replacement. Every
effective paint clears that display and anchors the frame from the terminal's
current height, so a resize never depends on rows from the prior frame. During
teardown it restores the normal display, copies the final snapshot there, and
restores the cursor. Raw input and live output remain separate adapters so
keypresses cannot write into or tear a rendered frame.

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

The seams are the contract. Four reusable contract families run the same
behavioral assertions against every implementation:

- `src/store/contract.ts` — `BuildStore` and `BlobStore`;
- `src/ports/tickets/contract.ts` — `TicketSource`;
- `src/ports/workspace/contract.ts` — `WorkspaceProvider`;
- `src/ports/forge/contract.ts` — `Forge`.

A normal `bun test` runs the memory/fake/local registrations, including the
real filesystem and real local-git adapters. The Linear and GitHub
registrations are present in the same test run but reported as skipped: live
provider mutation requires both credentials and an explicit opt-in.

To run the Linear contract manually against a destructive scratch target:

```sh
AB_RUN_LIVE_PORT_CONTRACTS=1 \
LINEAR_API_KEY=… \
AB_LINEAR_CONTRACT_TEAM_KEY=SCRATCH \
AB_LINEAR_CONTRACT_PROJECT_ID=… \
bun test src/ports/tickets/linear.live.test.ts
```

The token must be able to create, update, relate, and archive issues in the
configured project. The team needs a claimable `unstarted` or `backlog` state,
a `started` state, and a `completed` or `canceled` state. Every issue gets a
reserved UUID, is attached to that project, and is archived during best-effort
cleanup. Use a project with no real work in it.

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
out of scope; live runs remain explicit. Every event write still passes
`validateEventWrite` or `validateHarvestEventWrite`, and phase behavior derives
from `src/kernel/phases.ts`. When adding an adapter, start from its contract
suite, not only the interface.
