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
a separate repository journal,
including claims and the committed dedup ledger. Build reducers therefore
never interpret a non-build workflow. Typed session deposits live under
`ab harvest context|submit|verdict`; `ab harvest status` and the nonselectable
`HARVEST` dashboard row read the same facts.

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

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs | §4 |
| `src/events/` | Build and repository-harvest envelopes, frozen payload schemas, actor validation | §15 |
| `src/harvest/` | Structured occurrence, scan packet, proposal, and ledger schemas | §12 |
| `src/store/` | BuildStore plus repository-journal contract; memory, SQLite/blob, and remote HTTP adapters | §7 |
| `src/kernel/` | Phase table/build reducer/engine plus the separate pure harvest reducer; converge, stall detection, server lifecycle | §5, §10, §12, §15.4–15.5, §16.2 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes. Runtime/model/extension routing lives in `ports/runner/`: `runtime.ts` (the capability-carrying registry), `routing.ts` (the eager resolver), `one-shot.ts` (optional pre-build completion), and the `claude.ts` / `pi.ts` adapters | §3.2, §6.3, §9, §13 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel | §8 |
| `src/cli/dashboard/` | `ab dispatch`'s live build + nonselectable harvest dashboard — pure reducer projection/rendering plus build-slug selection | §14, §15.5 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty and harvest trigger), harvest deterministic core + runner | §3.3, §12, §15.7 |
| `src/config/` | `autobuild.toml` parsing and validation | §16.1 |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` (Pi/Agent Skills) and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference covering the lifecycle, the complete `autobuild.toml` surface, and the other skills. Update it when the config surface changes; `src/cli/guide-skill.test.ts` fails if a schema field goes undocumented | §16.3 |
| `docs/spec-standard.md` | The definition of "buildable" every ticket surface cites | §6.1 |
| `templates/` | What `ab init` installs | §16.3 |

The dashboard is an operator command producer, not forge plumbing. Its `p` and
`m` handlers append human-actor events through the BuildStore; build-runner and
dispatcher code acknowledge pause/resume and reconcile auto-merge via the
`Forge` port. On a blocked row, `p` instead opens slug/escalation-bound process
state: Enter appends one human `escalation.answered` per captured id (`retry`
for blank input, `guidance` for text), then requests resume too if the reduced
build was paused. Escape writes nothing. The field is overlaid on the pure
dashboard model, so blocker rows and polling remain live while terminal input
edits synchronously; only submission joins the serialized operation queue.
Reattachment remains the ordinary dispatcher lease sweep. The GitHub adapter
combines exact-branch classic protection and active ruleset probes with the
complete PR merge-state enum: a real gate keeps native auto-merge ownership,
while only two successful negative probes can return a guarded direct-squash
candidate. `Dispatcher.checkPr` is the sole fallback owner and additionally
requires positive mergeability, unchanged latest intent, and
`decideNext(...)=awaiting-pr`; the normal non-admin merge is head-SHA guarded
and completion remains an observed `pr.merged` fact on the next poll. The
automatic startup path in `src/processes/dispatcher.ts` is unchanged and
retries only an all-policy escalation set without input. `d` is the other
process-local state: it gates only the current dispatcher's ticket-claim stage
and resets on restart. Raw input and live-region output have separate adapters
so keypresses cannot write into or tear a rendered frame.

## Development

```sh
bun install
bun test          # unit tests, colocated *.test.ts
bun typecheck     # tsc --noEmit
```

The seams are the contract: every `BuildStore` adapter must pass the suite
in `src/store/contract.ts`; every event write passes
`validateEventWrite` or `validateHarvestEventWrite`; phase behavior derives from the table in
`src/kernel/phases.ts`. When adding an adapter, start from the contract
tests, not the interface.
