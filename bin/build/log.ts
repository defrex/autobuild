/**
 * Append-only run log for build. `build/[feature]/build.log` records
 * what each phase did and when, so a human (or the /build skill) can read
 * progress without attaching to the process.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** Append a timestamped line to the run log, creating the dir if needed. */
export function appendLog(logPath: string, message: string, now: string): void {
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `[${now}] ${message}\n`)
}
