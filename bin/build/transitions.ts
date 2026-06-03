/**
 * The build state machine: pure (phase, signal) → next phase/status.
 *
 * Mirrors the pipeline table in `build/build-flow/design.html`. The orchestrator
 * runs each phase, normalises its result into a `TransitionSignal`, and applies
 * `transition()` to compute where to go next. Inner loops (build↔validate on
 * failure, the reviewer↔builder code-review rounds) are driven by the
 * orchestrator; this function only encodes the top-level transitions.
 */

import type { Phase, Status } from "./state"
import type {
  BuilderVerdict,
  CodeReviewVerdict,
  PlanReviewVerdict,
} from "./verdicts"

export type TransitionSignal =
  | { phase: "plan"; verdict: BuilderVerdict }
  | { phase: "plan-review"; verdict: PlanReviewVerdict }
  | { phase: "build"; verdict: BuilderVerdict }
  | { phase: "validate"; pass: boolean }
  | { phase: "review"; verdict: CodeReviewVerdict }
  | { phase: "pr"; verdict: BuilderVerdict }
  | { phase: "monitor"; done: boolean }

export type Transition = {
  phase: Phase
  status: Status
  /** When true, the orchestrator bumps `reviewRound` before the next iteration. */
  bumpReviewRound?: boolean
}

const blocked = (phase: Phase): Transition => ({ phase, status: "blocked" })
const running = (phase: Phase): Transition => ({ phase, status: "running" })

/**
 * Compute the next phase/status from the current phase and its result signal.
 * `escalate` always parks the pipeline in `blocked` (the orchestrator writes
 * `NEEDS-INPUT.md` and halts); a human edits artifacts and re-runs to resume.
 */
export function transition(signal: TransitionSignal): Transition {
  switch (signal.phase) {
    case "plan":
      return signal.verdict.kind === "escalate"
        ? blocked("plan")
        : running("plan-review")

    case "plan-review":
      switch (signal.verdict.kind) {
        case "approved":
          return running("build")
        case "needs_revision":
          return running("plan")
        default:
          return blocked("plan-review")
      }

    case "build":
      return signal.verdict.kind === "escalate"
        ? blocked("build")
        : running("validate")

    case "validate":
      // Failure routes back to the builder with the captured output.
      return signal.pass ? running("review") : running("build")

    case "review":
      switch (signal.verdict.kind) {
        case "clean":
          return running("pr")
        case "blocking":
          // Stay in review; the orchestrator has the builder respond + revalidate,
          // then bumps the round and re-invokes the reviewer.
          return { ...running("review"), bumpReviewRound: true }
        default:
          return blocked("review")
      }

    case "pr":
      return signal.verdict.kind === "escalate"
        ? blocked("pr")
        : running("monitor")

    case "monitor":
      return signal.done
        ? { phase: "done", status: "done" }
        : running("monitor")
  }
}
