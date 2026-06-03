/**
 * build: autonomous plan → build → review → PR pipeline.
 *
 * Takes a human-approved design at `build/[feature]/design.md` through a
 * resumable, multi-harness pipeline to a mergeable PR — no supervision. All
 * state lives on disk in `build/[feature]/`, so re-running resumes.
 *
 * Usage:
 *   bun run bin/build.ts <feature>
 *
 * Typically launched as a background process by the /build skill.
 * See `build/build-flow/design.html`.
 */

import { run } from "./build/orchestrator"

const feature = Bun.argv[2]?.trim()

if (!feature) {
  console.error("Usage: bun run bin/build.ts <feature>")
  process.exit(1)
}

const state = await run({ feature })

// Exit non-zero when parked on a blocker so a supervising process notices.
process.exit(state.status === "blocked" || state.status === "failed" ? 2 : 0)
