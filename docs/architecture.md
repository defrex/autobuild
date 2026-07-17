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
| `src/events/` | Envelope, payload schemas (frozen), catalog + validation | §15 |
| `src/store/` | BuildStore interface, contract suite, memory + SQLite/blob adapters | §7 |
| `src/kernel/` | Phase table, reducer, converge, stall detection, engine, server lifecycle | §5, §10, §15.4–15.5, §16.2 |
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes. Two-axis runtime/model routing lives in `ports/runner/`: `runtime.ts` (the capability-carrying registry), `routing.ts` (the eager resolver), `one-shot.ts` (optional pre-build completion), and the `claude.ts` / `pi.ts` adapters | §3.2, §6.3, §9, §13 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel | §8 |
| `src/cli/dashboard/` | `ab dispatch`'s live build dashboard — a read-only projection of the reducer; plain-by-default, interactive only on a TTY | §14, §15.5 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty) | §3.3, §15.7 |
| `src/config/` | `autobuild.toml` parsing and validation | §16.1 |
| `skills/` | Canonical defaults; `ab init` vendors them to `.agents/skills/ab-*` (Pi/Agent Skills) and links `.claude/skills/ab-*` | §16.3 |
| `skills/guide/` | `ab-guide` — the model-invocable reference covering the lifecycle, the complete `autobuild.toml` surface, and the other skills. Update it when the config surface changes; `src/cli/guide-skill.test.ts` fails if a schema field goes undocumented | §16.3 |
| `docs/spec-standard.md` | The definition of "buildable" every ticket surface cites | §6.1 |
| `templates/` | What `ab init` installs | §16.3 |

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
