# Architecture

The contributor-facing map: how the codebase is organized and where the
seams are. `SPEC.md` is the source of truth for the design and terminology;
this document maps it to the code. For the user journey — install, configure,
operate — see [`README.md`](../README.md).

## Constitution

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state.
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

## Layout

| Path | Contents | SPEC |
|---|---|---|
| `src/ontology.ts` | The shared nouns — findings, verdicts, phases, refs | §4 |
| `src/events/` | Envelope, payload schemas (frozen), catalog + validation | §15 |
| `src/store/` | BuildStore interface, contract suite, memory + SQLite/blob adapters | §7 |
| `src/kernel/` | Phase table, reducer, converge, stall detection, engine, server lifecycle | §5, §10, §15.4–15.5, §16.2 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes. Two-axis runtime/model routing lives in `ports/runner/`: `runtime.ts` (the capability-carrying registry), `routing.ts` (the eager resolver), and the `claude.ts` / `pi.ts` adapters | §3.2, §9, §13 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel | §8 |
| `src/cli/dashboard/` | `ab dispatch`'s live build dashboard — pure reducer projection/rendering plus slug selection; TTY-interactive, with plain output for pipes/`--plain` | §14, §15.5 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty) | §3.3, §15.7 |
| `src/config/` | `autobuild.toml` parsing and validation | §16.1 |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` (Pi/Agent Skills) and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference covering the lifecycle, the complete `autobuild.toml` surface, and the other skills. Update it when the config surface changes; `src/cli/guide-skill.test.ts` fails if a schema field goes undocumented | §16.3 |
| `docs/spec-standard.md` | The definition of "buildable" every ticket surface cites | §6.1 |
| `templates/` | What `ab init` installs | §16.3 |

The dashboard is an operator command producer, not forge plumbing. Its `p` and
`m` handlers append human-actor events through the BuildStore; build-runner and
dispatcher code acknowledge pause/resume and reconcile native auto-merge via
the `Forge` port. `d` is the sole exception because drain is intentionally
process-local: it gates only the current dispatcher's ticket-claim stage and is
reset by restart. Raw input and live-region output have separate adapters so
keypresses cannot write into or tear a rendered frame.

## Development

```sh
bun install
bun test          # unit tests, colocated *.test.ts
bun typecheck     # tsc --noEmit
```

The seams are the contract: every `BuildStore` adapter must pass the suite
in `src/store/contract.ts`; every event write passes
`validateEventWrite`; phase behavior derives from the table in
`src/kernel/phases.ts`. When adding an adapter, start from the contract
tests, not the interface.
