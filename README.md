# auto-build v2

An agent-driven software development lifecycle system: it takes work from
*"something should be done"* to a merged PR, with a human in the loop only
where judgment matters. `SPEC.md` is the design document; this README maps
it to the code.

## Constitution

1. **Judgment in skills, determinism in code.** Agents never decide phase
   transitions, signal identity, or state.
2. **Resumability is not a feature.** Re-running a build resumes it; every
   phase is a function of durable state.
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
| `src/ports/` | TicketSource / Workspace / Forge / AgentRunner / Telemetry interfaces, adapters, fakes | §3.2, §9, §13 |
| `src/cli/` | The `ab` CLI — the only agent↔store channel | §8 |
| `src/processes/` | build-runner, dispatcher (+ janitor duty) | §3.3, §15.7 |
| `src/config/` | `autobuild.toml` parsing and validation | §16.1 |
| `skills/` | Canonical default skills, vendored into repos by `ab init` | §16.3 |
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
