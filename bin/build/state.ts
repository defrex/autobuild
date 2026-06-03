/**
 * build orchestrator state.
 *
 * `build/[feature]/state.json` is the durable state for the autonomous
 * plan → build → review → PR pipeline. Re-running build reads this file
 * and continues from `phase` — resuming *is* re-running, because all state is
 * on disk. See `build/build-flow/design.html`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

/** Pipeline phases, in order. `done` is terminal. */
export const PHASES = [
  "plan",
  "plan-review",
  "build",
  "validate",
  "review",
  "pr",
  "monitor",
  "done",
] as const

export const phaseSchema = z.enum(PHASES)
export type Phase = z.infer<typeof phaseSchema>

export const statusSchema = z.enum(["running", "blocked", "done", "failed"])
export type Status = z.infer<typeof statusSchema>

/** One harness binary + optional model, e.g. `{ bin: "claude", model: "opus" }`. */
export const harnessEntrySchema = z.object({
  bin: z.string().min(1),
  model: z.string().min(1).optional(),
})
export type HarnessEntry = z.infer<typeof harnessEntrySchema>

/** Which harness runs each agent-driven phase (validate/monitor are script-run). */
export const harnessMapSchema = z.object({
  plan: harnessEntrySchema,
  "plan-review": harnessEntrySchema,
  build: harnessEntrySchema,
  review: harnessEntrySchema,
  pr: harnessEntrySchema,
})
export type HarnessMap = z.infer<typeof harnessMapSchema>

export const buildStateSchema = z.object({
  feature: z.string().min(1),
  phase: phaseSchema,
  status: statusSchema,
  /** Current code-review round (1-based once review starts; 0 before). */
  reviewRound: z.number().int().nonnegative(),
  branch: z.string().min(1),
  harnessMap: harnessMapSchema,
  updatedAt: z.string(),
})
export type BuildState = z.infer<typeof buildStateSchema>

/**
 * Default harness assignment: claude/opus plans & builds, codex reviews.
 * Overridable per-feature by editing `state.json` → `harnessMap`.
 */
export function defaultHarnessMap(): HarnessMap {
  return {
    plan: { bin: "claude", model: "opus" },
    "plan-review": { bin: "codex" },
    build: { bin: "claude", model: "opus" },
    review: { bin: "codex" },
    pr: { bin: "claude", model: "opus" },
  }
}

/** Absolute path to a feature's build dir, given the repo root. */
export function buildDir(repoRoot: string, feature: string): string {
  return join(repoRoot, "build", feature)
}

/** Absolute path to a feature's `state.json`. */
export function statePath(repoRoot: string, feature: string): string {
  return join(buildDir(repoRoot, feature), "state.json")
}

/** A fresh state object at the start of the pipeline. */
export function initState(
  feature: string,
  branch: string,
  now: string,
): BuildState {
  return {
    feature,
    phase: "plan",
    status: "running",
    reviewRound: 0,
    branch,
    harnessMap: defaultHarnessMap(),
    updatedAt: now,
  }
}

/** Read + validate `state.json`, or `null` if it doesn't exist yet. */
export function readState(
  repoRoot: string,
  feature: string,
): BuildState | null {
  const path = statePath(repoRoot, feature)
  if (!existsSync(path)) return null
  return buildStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")))
}

/** Persist state to `state.json`, stamping `updatedAt`. Creates the build dir if needed. */
export function writeState(
  repoRoot: string,
  state: BuildState,
  now: string,
): BuildState {
  const stamped = { ...state, updatedAt: now }
  const path = statePath(repoRoot, state.feature)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`)
  return stamped
}
