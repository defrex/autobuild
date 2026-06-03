# auto-build

A snapshot of the `/spec` and `/build` skills (and the orchestrator that powers
`/build`), copied out of the Dispatch monorepo for sharing/reference.

These are [Claude Code](https://claude.com/claude-code) skills plus a headless
TypeScript pipeline that takes a feature from a design doc to a mergeable PR
autonomously.

## What's here

```
skills/
  spec/SKILL.md        # /spec — design a feature through conversation → build/[feature]/design.md
  build/SKILL.md       # /build — drive a design to a mergeable PR autonomously
bin/
  build.ts             # entry point: `bun run bin/build.ts <feature>`
  build/               # the orchestrator (state machine, harness routing, phases)
    orchestrator.ts    #   top-level run loop
    state.ts           #   on-disk resumable state (state.json)
    transitions.ts     #   phase → phase state machine
    harness.ts         #   shells out to claude / codex per phase
    prompts.ts         #   per-phase prompt construction
    monitor.ts         #   watches a running phase
    validate.ts        #   gate checks (typecheck/lint/test/etc.)
    verdicts.ts        #   parses reviewer verdicts
    repo.ts            #   git/PR helpers
    dev-server.ts      #   owns the dev server for the e2e step
    mcp-config.ts      #   scopes a minimal MCP config for the e2e step
    log.ts             #   build.log helper
    *.test.ts          #   Bun unit tests for each module
build/
  build-flow/design.html   # the design doc for the build pipeline itself
```

## How the two skills relate

- **`/spec`** is for *designing* a feature through conversation. It writes
  `build/[feature]/design.md` and stops — no planning or implementation.
- **`/build`** is for *shipping*. Given a design (from `/spec`, or a short one it
  writes itself from your instructions), it launches `bin/build.ts <feature>` as a
  background OS process that runs headless through **plan → build → review → PR**.
  All state lives on disk under `build/[feature]/` (`state.json`, `build.log`,
  intermediate artifacts), so re-running resumes where it left off.

## Runtime

The orchestrator is written for the [Bun](https://bun.sh) runtime and shells out
to the `claude` and `codex` CLIs to run each phase. Harness routing is configurable
in `state.json → harnessMap` (default: claude/opus plans & builds, codex reviews).

## Notes / caveats for reading this in isolation

This was lifted out of a larger monorepo, so a few things won't run standalone
without adaptation:

- The build/review prompts invoke other Dispatch skills by name at runtime (e.g.
  `/address-review`, `/code-review`) — those aren't included here.
- `mcp-config.ts` reads the project's `.mcp.json` to scope the `next-devtools`
  browser MCP for the e2e step.
- The pipeline assumes repo conventions (commands like `bun run typecheck`,
  `bun run lint`, `bun run test`; a GitHub remote for PRs).

It's meant for reading and reference, not drop-in execution.
