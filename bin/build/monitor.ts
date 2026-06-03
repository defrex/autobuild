/**
 * PR monitoring (phase 8): an explicit polling loop inside the script.
 *
 * GitHub has no general long-poll for PR events, so the loop polls on an
 * interval, reacts to whatever is blocking the PR (behind base, failing CI,
 * unresolved review threads), and stops when the PR is mergeable/clean or
 * reaches a terminal state. Thread *resolution* stays owned by the cloud review
 * agent (per `CLAUDE.md`); the builder only fixes or pushes back.
 *
 * See `build/build-flow/design.html` → "PR creation & monitoring".
 */

/** A single status check from `gh pr view --json statusCheckRollup`. */
export type StatusCheck = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
])
const FAILING_STATES = new Set(["FAILURE", "ERROR"])

/** Names of checks that have concluded in a failing state. (pure) */
export function failingCheckNames(rollup: StatusCheck[]): string[] {
  const names: string[] = []
  for (const check of rollup) {
    const failing =
      (check.conclusion && FAILING_CONCLUSIONS.has(check.conclusion)) ||
      (check.state && FAILING_STATES.has(check.state))
    if (failing) names.push(check.name ?? check.context ?? "unknown check")
  }
  return names
}

export type PrSnapshot = {
  state: string
  mergeable: string
  mergeStateStatus: string
  failingChecks: string[]
  unresolvedThreads: number
}

/** Shape of `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup`. */
export type PrViewJson = {
  state?: string
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: StatusCheck[]
}

/** Build a snapshot from `gh pr view` JSON + the unresolved-thread count. (pure) */
export function parsePrSnapshot(
  view: PrViewJson,
  unresolvedThreads: number,
): PrSnapshot {
  return {
    state: view.state ?? "UNKNOWN",
    mergeable: view.mergeable ?? "UNKNOWN",
    mergeStateStatus: view.mergeStateStatus ?? "UNKNOWN",
    failingChecks: failingCheckNames(view.statusCheckRollup ?? []),
    unresolvedThreads,
  }
}

export type MonitorAction =
  | { kind: "done"; reason: string }
  | { kind: "rebase" }
  | { kind: "fix-ci"; failingChecks: string[] }
  | { kind: "address-review" }
  | { kind: "wait" }

/**
 * Decide the single next action for one monitor pass, in priority order:
 * terminal/ready → rebase (behind) → fix CI → address review threads → wait.
 * (pure)
 */
export function decideMonitorAction(pr: PrSnapshot): MonitorAction {
  if (pr.state === "MERGED" || pr.state === "CLOSED") {
    return { kind: "done", reason: `PR ${pr.state.toLowerCase()}` }
  }
  if (
    pr.mergeable === "MERGEABLE" &&
    pr.mergeStateStatus === "CLEAN" &&
    pr.unresolvedThreads === 0
  ) {
    return { kind: "done", reason: "mergeable and clean" }
  }
  if (pr.mergeStateStatus === "BEHIND") return { kind: "rebase" }
  if (pr.failingChecks.length > 0) {
    return { kind: "fix-ci", failingChecks: pr.failingChecks }
  }
  if (pr.unresolvedThreads > 0) return { kind: "address-review" }
  return { kind: "wait" }
}

export type MonitorPrArgs = {
  poll: () => Promise<PrSnapshot>
  act: (
    action: Exclude<MonitorAction, { kind: "done" } | { kind: "wait" }>,
  ) => Promise<void>
  sleep: (ms: number) => Promise<void>
  intervalMs?: number
  /** Soft budget: log a warning past this many passes (no hard stop). */
  onSoftBudget?: (passes: number) => void
  softBudgetPasses?: number
  /** Hard backstop to avoid an infinite loop in pathological cases. */
  maxPasses?: number
}

/**
 * Outcome of the monitor loop. `done` means a true terminal state was reached
 * (mergeable+clean / merged / closed); `gave-up` means the loop hit its hard
 * backstop while the PR was still not mergeable — the caller must escalate, NOT
 * treat the run as complete.
 */
export type MonitorResult =
  | { outcome: "done"; reason: string }
  | { outcome: "gave-up"; reason: string }

/**
 * Poll the PR until it is mergeable/clean or terminal, performing one action
 * per pass. Returns a terminal `done` outcome, or `gave-up` if the hard
 * backstop is hit before the PR becomes mergeable.
 */
export async function monitorPr({
  poll,
  act,
  sleep,
  intervalMs = 45_000,
  onSoftBudget,
  softBudgetPasses = 40,
  maxPasses = 1_000,
}: MonitorPrArgs): Promise<MonitorResult> {
  for (let pass = 1; pass <= maxPasses; pass++) {
    if (onSoftBudget && pass === softBudgetPasses) onSoftBudget(pass)
    const pr = await poll()
    const action = decideMonitorAction(pr)
    if (action.kind === "done")
      return { outcome: "done", reason: action.reason }
    if (action.kind !== "wait") await act(action)
    await sleep(intervalMs)
  }
  return {
    outcome: "gave-up",
    reason: `PR still not mergeable after ${maxPasses} polling passes`,
  }
}
