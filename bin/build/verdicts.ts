/**
 * Verdict parsing for build phases.
 *
 * Each phase ends by emitting a sentinel line the orchestrator parses to decide
 * the transition. Builder phases emit `PLAN_DONE` / `BUILD_DONE` / `ESCALATE: <reason>`;
 * the plan-review phase emits `APPROVED` / `NEEDS_REVISION` / `ESCALATE`; the
 * code-review phase emits `CLEAN` / `BLOCKING` / `ESCALATE`. The last matching
 * line wins, so trailing summary prose before the sentinel is fine.
 */

export type BuilderVerdict =
  | { kind: "done" }
  | { kind: "escalate"; reason: string }

export type PlanReviewVerdict =
  | { kind: "approved" }
  | { kind: "needs_revision" }
  | { kind: "escalate"; reason: string }

export type CodeReviewVerdict =
  | { kind: "clean" }
  | { kind: "blocking" }
  | { kind: "escalate"; reason: string }

/**
 * Normalise a line before sentinel matching: strip an optional `Verdict:`
 * label (with optional markdown bold) and surrounding markdown emphasis or
 * code backticks. Reviewers (e.g. codex) phrase their summary as
 * "Verdict: `BLOCKING`" rather than a bare sentinel line, so without this a
 * legitimate verdict in the final message / stdout is missed and the run
 * false-parks. The round file's bare sentinel still parses unchanged.
 */
function normalizeSentinelLine(line: string): string {
  return line
    .trim()
    .replace(/^[`*\s]*verdict[`*\s]*:[`*\s]*/i, "")
    .replace(/^[`*]+/, "")
    .replace(/[`*]+$/, "")
    .trim()
}

/**
 * Find the last line that is exactly one of `tokens`, or begins with
 * `<token>:` (the `ESCALATE: <reason>` form). Lines are normalised first (see
 * `normalizeSentinelLine`) so a `Verdict: `TOKEN`` summary line also matches.
 * Returns the matched token and the trailing text after a colon, if any.
 */
function lastSentinel(
  output: string,
  tokens: readonly string[],
): { token: string; rest: string } | null {
  const lines = output.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = normalizeSentinelLine(lines[i])
    for (const token of tokens) {
      if (line === token) return { token, rest: "" }
      if (line.startsWith(`${token}:`)) {
        return { token, rest: line.slice(token.length + 1).trim() }
      }
    }
  }
  return null
}

/**
 * Parse a builder phase's output. `doneToken` is `PLAN_DONE` for the plan phase
 * and `BUILD_DONE` for build/response phases. Returns `null` if no sentinel was
 * emitted (treated by the orchestrator as an incomplete run / failure).
 */
export function parseBuilderVerdict(
  output: string,
  doneToken: "PLAN_DONE" | "BUILD_DONE",
): BuilderVerdict | null {
  const match = lastSentinel(output, [doneToken, "ESCALATE"])
  if (!match) return null
  if (match.token === "ESCALATE") {
    return { kind: "escalate", reason: match.rest || "no reason given" }
  }
  return { kind: "done" }
}

/** Parse the plan-review reviewer's verdict. `null` if no sentinel was emitted. */
export function parsePlanReviewVerdict(
  output: string,
): PlanReviewVerdict | null {
  const match = lastSentinel(output, ["APPROVED", "NEEDS_REVISION", "ESCALATE"])
  if (!match) return null
  switch (match.token) {
    case "APPROVED":
      return { kind: "approved" }
    case "NEEDS_REVISION":
      return { kind: "needs_revision" }
    default:
      return { kind: "escalate", reason: match.rest || "no reason given" }
  }
}

/** Parse the code-review reviewer's verdict. `null` if no sentinel was emitted. */
export function parseCodeReviewVerdict(
  output: string,
): CodeReviewVerdict | null {
  const match = lastSentinel(output, ["CLEAN", "BLOCKING", "ESCALATE"])
  if (!match) return null
  switch (match.token) {
    case "CLEAN":
      return { kind: "clean" }
    case "BLOCKING":
      return { kind: "blocking" }
    default:
      return { kind: "escalate", reason: match.rest || "no reason given" }
  }
}
