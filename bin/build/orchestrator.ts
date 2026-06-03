/**
 * The build orchestrator: a resumable state machine over `build/[feature]/`.
 *
 * Reads `state.json`, runs the current phase as a fresh subprocess (claude for
 * builder phases, codex for reviewer phases, the script itself for the
 * deterministic gates), applies the pure `transition()`, persists the new
 * state, and loops — until the pipeline reaches `done` or parks in `blocked`
 * (writing `NEEDS-INPUT.md` for a human). Re-running resumes from `state.json`;
 * there is no separate resume path.
 *
 * See `build/build-flow/design.html` — that `.html` is build's OWN design doc.
 * The per-feature input this pipeline reads and builds against is always
 * `build/[feature]/design.md` (what `/spec` produces); don't conflate the two.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { builderArgs, reviewerArgs, runHarness } from "./harness"
import { appendLog } from "./log"
import { writeScopedNextDevtoolsConfig } from "./mcp-config"
import { monitorPr } from "./monitor"
import {
  buildPrompt,
  monitorAddressReviewPrompt,
  monitorCiFixPrompt,
  planPrompt,
  planReviewPrompt,
  prPrompt,
  reviewPrompt,
  reviewResponsePrompt,
} from "./prompts"
import {
  commitAndPushArtifacts,
  detectBranch,
  detectPrNumber,
  detectRepoRoot,
  fetchPrSnapshot,
  rebaseOntoBase,
} from "./repo"
import {
  type BuildState,
  buildDir as buildDirOf,
  type HarnessEntry,
  initState,
  readState,
  writeState,
} from "./state"
import {
  type Transition,
  type TransitionSignal,
  transition,
} from "./transitions"
import {
  type RunValidateArgs,
  runValidate,
  validateFailuresPath,
} from "./validate"
import {
  type BuilderVerdict,
  type CodeReviewVerdict,
  parseBuilderVerdict,
  parseCodeReviewVerdict,
  parsePlanReviewVerdict,
} from "./verdicts"

const BASE_BRANCH = "main"
/** Log a bell + warning past this many same-phase iterations (soft budget). */
const SOFT_BUDGET = 25
/** Hard backstop: escalate if a fix↔revalidate loop won't converge. */
const REVALIDATE_CAP = 50

/** Thrown by a phase that cannot proceed; the main loop parks the run in `blocked`. */
export class EscalateError extends Error {
  constructor(
    readonly phase: string,
    readonly reason: string,
  ) {
    super(`${phase}: ${reason}`)
    this.name = "EscalateError"
  }
}

export type StartupInputs = {
  designExists: boolean
  state: BuildState | null
  needsInputExists: boolean
}

export type StartupDecision =
  | { kind: "halt"; message: string }
  | { kind: "start"; state: BuildState }

/**
 * Decide how to begin a run from on-disk facts. (pure)
 *
 * - No state + no design → halt (run /spec first).
 * - No state + design → start fresh.
 * - Blocked with NEEDS-INPUT.md still present → halt (human must resolve + delete it).
 * - Already done → halt.
 * - Otherwise → resume: flip status to running, keep the phase.
 */
export function decideStartup(
  inputs: StartupInputs,
  feature: string,
  branch: string,
  now: string,
): StartupDecision {
  if (!inputs.state) {
    if (!inputs.designExists) {
      return {
        kind: "halt",
        message: `no design.md for "${feature}" — run /spec ${feature} first`,
      }
    }
    return { kind: "start", state: initState(feature, branch, now) }
  }

  if (inputs.needsInputExists) {
    return {
      kind: "halt",
      message:
        "NEEDS-INPUT.md is present — resolve the blocker, delete the file, then re-run /build",
    }
  }
  if (inputs.state.status === "done" || inputs.state.phase === "done") {
    return { kind: "halt", message: `"${feature}" is already done` }
  }
  return { kind: "start", state: { ...inputs.state, status: "running" } }
}

type Ctx = {
  repoRoot: string
  feature: string
  buildDir: string
  logPath: string
  baseBranch: string
  env: NodeJS.ProcessEnv
  now: () => string
}

const noVerdictEscalate = (phase: string): BuilderVerdict => ({
  kind: "escalate",
  reason: `${phase} phase produced no completion sentinel (incomplete or crashed run)`,
})

/**
 * Choose a code-review verdict, preferring the bare sentinel the reviewer
 * writes as the last line of `round-N.md` (the `reviewPrompt` contract) over
 * the verdict parsed from its chat message / stdout. The round file is the
 * reliable artifact; the message phrasing varies (e.g. "...with verdict
 * `BLOCKING`.") and can bury the token mid-sentence where the line parser
 * misses it, which would otherwise false-park the run as "no verdict". Falls
 * back to escalation only when neither source yields a verdict.
 */
export function chooseReviewVerdict(
  fromFile: CodeReviewVerdict | null,
  fromMessage: CodeReviewVerdict | null,
  round: number,
): CodeReviewVerdict {
  return (
    fromFile ??
    fromMessage ?? {
      kind: "escalate",
      reason: `code-review round ${round} produced no CLEAN/BLOCKING/ESCALATE verdict`,
    }
  )
}

async function invokeBuilder(
  ctx: Ctx,
  harness: HarnessEntry,
  prompt: string,
  doneToken: "PLAN_DONE" | "BUILD_DONE",
  builderOpts: { mcpConfig?: string; strictMcp?: boolean } = {},
): Promise<BuilderVerdict> {
  const argv = builderArgs(harness, prompt, builderOpts)
  const { output } = await runHarness({
    bin: harness.bin,
    argv,
    cwd: ctx.repoRoot,
    logPath: ctx.logPath,
  })
  return parseBuilderVerdict(output, doneToken) ?? noVerdictEscalate(doneToken)
}

async function invokeReviewer<T>(
  ctx: Ctx,
  harness: HarnessEntry,
  prompt: string,
  parse: (output: string) => T | null,
): Promise<T | null> {
  const lastMessage = join(ctx.buildDir, ".build", "last-message.txt")
  mkdirSync(join(ctx.buildDir, ".build"), { recursive: true })
  // Clear any stale message from a previous phase so a crash before the
  // reviewer writes can't surface an old APPROVED/CLEAN/BLOCKING verdict.
  rmSync(lastMessage, { force: true })

  const argv = reviewerArgs(harness, prompt, { outputFile: lastMessage })
  const { code, output } = await runHarness({
    bin: harness.bin,
    argv,
    cwd: ctx.repoRoot,
    logPath: ctx.logPath,
  })
  // A non-zero exit means the reviewer failed — return null so the caller
  // escalates rather than acting on a partial/empty (or stale) verdict.
  if (code !== 0) {
    appendLog(
      ctx.logPath,
      `reviewer (${harness.bin}) exited ${code}`,
      ctx.now(),
    )
    return null
  }
  const fromFile = existsSync(lastMessage)
    ? readFileSync(lastMessage, "utf-8")
    : ""
  return parse(fromFile) ?? parse(output)
}

/**
 * The e2e step of the validate gate. Runs by default: brings up the dev server
 * (launch-only-if-not-running) and dispatches the builder to drive real flows
 * via the next-devtools browser MCP. Opt out with `BUILD_SKIP_E2E=1`.
 *
 * The builder is scoped to ONLY the project's `next-devtools` MCP server
 * (via `--mcp-config <scoped> --strict-mcp-config`), so the autonomous browser
 * run never boots the rest of `.mcp.json` (notably the prod-PII Convex server).
 * `BUILD_E2E_MCP` overrides the config path if you need a custom one.
 */
function makeE2e(ctx: Ctx, state: BuildState): RunValidateArgs["e2e"] {
  if (ctx.env.BUILD_SKIP_E2E === "1") {
    appendLog(
      ctx.logPath,
      "validate: e2e skipped (BUILD_SKIP_E2E=1)",
      ctx.now(),
    )
    return undefined
  }
  const scopedPath = join(ctx.buildDir, ".build", "e2e.mcp.json")
  const mcpConfig =
    ctx.env.BUILD_E2E_MCP ??
    writeScopedNextDevtoolsConfig(ctx.repoRoot, scopedPath) ??
    undefined
  if (!mcpConfig) {
    appendLog(
      ctx.logPath,
      "validate: e2e skipped (no next-devtools MCP server in .mcp.json)",
      ctx.now(),
    )
    return undefined
  }

  return async () => {
    const { deriveDevUrl, withDevServer } = await import("./dev-server")
    const devUrl = deriveDevUrl(ctx.env, ctx.repoRoot)
    const design = join(ctx.buildDir, "design.md")
    const verdict = await withDevServer({
      devUrl,
      repoRoot: ctx.repoRoot,
      run: async (url) => {
        const prompt = [
          `You are the e2e step of build for the "${ctx.feature}" feature.`,
          `Read the canonical design at ${design} to learn the key user flows it introduces or changes.`,
          `Drive a real browser against ${url} with the next-devtools browser MCP (mcp__next-devtools__browser_eval).`,
          "Authenticate first by navigating to /api/auth/dev-login, then exercise the primary happy path and every flow the design calls out.",
          "If everything works, output the exact line: BUILD_DONE",
          "If a flow is broken, output: ESCALATE: <what broke>",
        ].join("\n")
        return invokeBuilder(
          ctx,
          state.harnessMap.build,
          prompt,
          "BUILD_DONE",
          {
            mcpConfig,
            strictMcp: true,
          },
        )
      },
    })
    // Unlike other phases, an e2e ESCALATE does NOT block the run — a broken
    // flow is a validation failure that routes back to the builder via the
    // validate gate (the failure text becomes validate-failures.md input).
    return {
      name: "e2e",
      ok: verdict.kind === "done",
      output: verdict.kind === "done" ? "" : verdict.reason,
    }
  }
}

async function runValidateGate(ctx: Ctx, state: BuildState): Promise<boolean> {
  const result = await runValidate({
    repoRoot: ctx.repoRoot,
    logPath: ctx.logPath,
    e2e: makeE2e(ctx, state),
  })
  const failures = validateFailuresPath(ctx.buildDir)
  if (result.pass) {
    rmSync(failures, { force: true })
    return true
  }
  writeFileSync(failures, `${result.failureText}\n`)
  return false
}

// --- phase handlers ---------------------------------------------------------

async function planPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const revising = existsSync(join(ctx.buildDir, "plan-review.md"))
  const prompt = planPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    revising,
  })
  const verdict = await invokeBuilder(
    ctx,
    state.harnessMap.plan,
    prompt,
    "PLAN_DONE",
  )
  return { phase: "plan", verdict }
}

async function planReviewPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const prompt = planReviewPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
  })
  const verdict = await invokeReviewer(
    ctx,
    state.harnessMap["plan-review"],
    prompt,
    parsePlanReviewVerdict,
  )
  return {
    phase: "plan-review",
    verdict: verdict ?? {
      kind: "escalate",
      reason:
        "plan-review produced no APPROVED/NEEDS_REVISION/ESCALATE verdict",
    },
  }
}

async function buildPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const failures = validateFailuresPath(ctx.buildDir)
  const prompt = buildPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    validateFailuresPath: existsSync(failures) ? failures : undefined,
  })
  const verdict = await invokeBuilder(
    ctx,
    state.harnessMap.build,
    prompt,
    "BUILD_DONE",
  )
  return { phase: "build", verdict }
}

async function validatePhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  return { phase: "validate", pass: await runValidateGate(ctx, state) }
}

async function reviewPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  if (state.reviewRound === 0) {
    state.reviewRound = 1
    writeState(ctx.repoRoot, state, ctx.now())
  }
  const round = state.reviewRound
  mkdirSync(join(ctx.buildDir, "review"), { recursive: true })

  const roundFile = join(ctx.buildDir, "review", `round-${round}.md`)
  const roundVerdict = () =>
    existsSync(roundFile)
      ? parseCodeReviewVerdict(readFileSync(roundFile, "utf-8"))
      : null

  // Resumability: if this round's findings file already exists with a verdict,
  // the reviewer already ran — recover the verdict from disk instead of
  // re-invoking (which would overwrite any in-file builder responses).
  let verdict = roundVerdict()
  if (!verdict) {
    const fromMessage = await invokeReviewer(
      ctx,
      state.harnessMap.review,
      reviewPrompt({
        feature: ctx.feature,
        buildDir: ctx.buildDir,
        round,
        baseBranch: ctx.baseBranch,
      }),
      parseCodeReviewVerdict,
    )
    // Prefer the bare sentinel the reviewer just wrote to the round file over
    // its chat-message phrasing (see chooseReviewVerdict).
    verdict = chooseReviewVerdict(roundVerdict(), fromMessage, round)
  }

  if (verdict.kind !== "blocking") return { phase: "review", verdict }

  // Blocking: the builder responds in-file, then the validate gate re-runs.
  const response = await invokeBuilder(
    ctx,
    state.harnessMap.build,
    reviewResponsePrompt({
      feature: ctx.feature,
      buildDir: ctx.buildDir,
      round,
    }),
    "BUILD_DONE",
  )
  if (response.kind === "escalate") {
    return {
      phase: "review",
      verdict: { kind: "escalate", reason: response.reason },
    }
  }

  let attempt = 0
  while (!(await runValidateGate(ctx, state))) {
    attempt++
    if (attempt >= SOFT_BUDGET)
      softBudgetWarning(ctx, `review round ${round} revalidation`, attempt)
    if (attempt >= REVALIDATE_CAP) {
      return {
        phase: "review",
        verdict: {
          kind: "escalate",
          reason: `validation still failing after ${attempt} fix attempts in review round ${round} — not converging`,
        },
      }
    }
    const fix = await invokeBuilder(
      ctx,
      state.harnessMap.build,
      buildPhasePrompt(ctx),
      "BUILD_DONE",
    )
    if (fix.kind === "escalate") {
      return {
        phase: "review",
        verdict: { kind: "escalate", reason: fix.reason },
      }
    }
  }
  return { phase: "review", verdict: { kind: "blocking" } }
}

function buildPhasePrompt(ctx: Ctx): string {
  const failures = validateFailuresPath(ctx.buildDir)
  return buildPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    validateFailuresPath: existsSync(failures) ? failures : undefined,
  })
}

async function prPhase(ctx: Ctx, state: BuildState): Promise<TransitionSignal> {
  const verdict = await invokeBuilder(
    ctx,
    state.harnessMap.pr,
    prPrompt(ctx.feature),
    "BUILD_DONE",
  )
  return { phase: "pr", verdict }
}

async function monitorPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const prNumber = detectPrNumber(ctx.repoRoot)
  if (prNumber === null) {
    throw new EscalateError(
      "monitor",
      "no PR found for the branch — the pr phase did not open one",
    )
  }
  const result = await monitorPr({
    poll: async () => fetchPrSnapshot(ctx.repoRoot, prNumber),
    act: async (action) => {
      // A thrown EscalateError propagates out of monitorPr → the main loop,
      // parking the run in `blocked` rather than spinning the poll forever.
      if (action.kind === "rebase") {
        appendLog(ctx.logPath, "monitor: rebasing onto base", ctx.now())
        const rebaseResult = rebaseOntoBase(ctx.repoRoot, ctx.baseBranch)
        if (rebaseResult.code !== 0) {
          throw new EscalateError(
            "monitor",
            "rebase onto base hit conflicts that need a human to resolve",
          )
        }
      } else if (action.kind === "fix-ci") {
        appendLog(
          ctx.logPath,
          `monitor: fixing CI (${action.failingChecks.join(", ")})`,
          ctx.now(),
        )
        const verdict = await invokeBuilder(
          ctx,
          state.harnessMap.build,
          monitorCiFixPrompt(ctx.feature, action.failingChecks),
          "BUILD_DONE",
        )
        if (verdict.kind === "escalate") {
          throw new EscalateError("monitor", verdict.reason)
        }
      } else if (action.kind === "address-review") {
        appendLog(ctx.logPath, "monitor: addressing review threads", ctx.now())
        const verdict = await invokeBuilder(
          ctx,
          state.harnessMap.build,
          monitorAddressReviewPrompt(ctx.feature, prNumber),
          "BUILD_DONE",
        )
        if (verdict.kind === "escalate") {
          throw new EscalateError("monitor", verdict.reason)
        }
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onSoftBudget: (passes) => softBudgetWarning(ctx, "PR monitoring", passes),
    softBudgetPasses: SOFT_BUDGET,
  })
  if (result.outcome === "gave-up") {
    // The loop exhausted its backstop without reaching a mergeable state —
    // escalate rather than falsely marking the whole build done.
    throw new EscalateError("monitor", result.reason)
  }
  appendLog(ctx.logPath, `monitor: ${result.reason}`, ctx.now())
  return { phase: "monitor", done: true }
}

function softBudgetWarning(ctx: Ctx, label: string, count: number): void {
  process.stdout.write("\x07")
  appendLog(
    ctx.logPath,
    `⚠ soft budget: ${label} has run ${count} iterations without converging`,
    ctx.now(),
  )
}

function runPhase(ctx: Ctx, state: BuildState): Promise<TransitionSignal> {
  switch (state.phase) {
    case "plan":
      return planPhase(ctx, state)
    case "plan-review":
      return planReviewPhase(ctx, state)
    case "build":
      return buildPhase(ctx, state)
    case "validate":
      return validatePhase(ctx, state)
    case "review":
      return reviewPhase(ctx, state)
    case "pr":
      return prPhase(ctx, state)
    case "monitor":
      return monitorPhase(ctx, state)
    case "done":
      return Promise.resolve({ phase: "monitor", done: true })
  }
}

/** The escalate reason carried by a signal, if any. */
function escalateReason(signal: TransitionSignal): string | null {
  if ("verdict" in signal && signal.verdict.kind === "escalate") {
    return signal.verdict.reason
  }
  return null
}

function writeNeedsInput(ctx: Ctx, phase: string, reason: string): void {
  const body = [
    "# build needs input",
    "",
    `**Feature:** ${ctx.feature}`,
    `**Blocked at phase:** ${phase}`,
    `**Reason:** ${reason}`,
    "",
    "## How to resume",
    "",
    "1. Resolve the blocker — edit the relevant artifact in this build dir, or add your decision below.",
    "2. Delete this file (`NEEDS-INPUT.md`).",
    `3. Re-run \`/build ${ctx.feature}\` — it resumes from \`state.json\`.`,
    "",
    "## Your decision",
    "",
    "",
  ].join("\n")
  writeFileSync(join(ctx.buildDir, "NEEDS-INPUT.md"), body)
  process.stdout.write("\x07") // terminal bell
}

export type RunArgs = {
  feature: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  now?: () => string
}

/**
 * Run (or resume) the pipeline for `feature` to completion or a blocker.
 * Returns the terminal state.
 */
export async function run({
  feature,
  cwd = process.cwd(),
  env = process.env,
  now = () => new Date().toISOString(),
}: RunArgs): Promise<BuildState> {
  const repoRoot = detectRepoRoot(cwd)
  const branch = detectBranch(repoRoot)
  const buildDir = buildDirOf(repoRoot, feature)
  const ctx: Ctx = {
    repoRoot,
    feature,
    buildDir,
    logPath: join(buildDir, "build.log"),
    baseBranch: BASE_BRANCH,
    env,
    now,
  }

  const decision = decideStartup(
    {
      designExists: existsSync(join(buildDir, "design.md")),
      state: readState(repoRoot, feature),
      needsInputExists: existsSync(join(buildDir, "NEEDS-INPUT.md")),
    },
    feature,
    branch,
    now(),
  )

  if (decision.kind === "halt") {
    // Only log into the build dir for a real feature; don't create one for a typo.
    if (existsSync(buildDir))
      appendLog(ctx.logPath, `halt: ${decision.message}`, now())
    process.stdout.write(`build: ${decision.message}\n`)
    return readState(repoRoot, feature) ?? initState(feature, branch, now())
  }

  let state = writeState(repoRoot, decision.state, now())
  appendLog(ctx.logPath, `start: phase=${state.phase} branch=${branch}`, now())

  while (state.status === "running" && state.phase !== "done") {
    appendLog(ctx.logPath, `▶ phase: ${state.phase}`, now())

    let signal: TransitionSignal
    try {
      signal = await runPhase(ctx, state)
    } catch (error) {
      const phase = error instanceof EscalateError ? error.phase : state.phase
      const reason =
        error instanceof EscalateError
          ? error.reason
          : `unexpected error: ${(error as Error).message}`
      state = writeState(repoRoot, { ...state, status: "blocked" }, now())
      writeNeedsInput(ctx, phase, reason)
      appendLog(ctx.logPath, `BLOCKED: ${reason}`, now())
      break
    }

    const next: Transition = transition(signal)

    state = writeState(
      repoRoot,
      {
        ...state,
        phase: next.phase,
        status: next.status,
        reviewRound: next.bumpReviewRound
          ? state.reviewRound + 1
          : state.reviewRound,
      },
      now(),
    )
    appendLog(
      ctx.logPath,
      `→ phase=${state.phase} status=${state.status}`,
      now(),
    )

    if (state.status === "blocked") {
      const reason = escalateReason(signal) ?? "phase could not proceed"
      writeNeedsInput(ctx, signal.phase, reason)
      appendLog(ctx.logPath, `BLOCKED: ${reason}`, now())
    }
  }

  if (state.status === "done") {
    // Log BEFORE committing so the final build.log line lands inside the
    // artifact commit. This must be the last write to the build dir: nothing
    // below may touch build.log/state.json, or it would leave the worktree
    // dirty again. Push failures go to stderr (not build.log) for that reason.
    appendLog(ctx.logPath, "✓ done — PR is mergeable and clean", now())
    const pushed = commitAndPushArtifacts(repoRoot, feature)
    if (pushed.code !== 0) {
      process.stderr.write(
        `build: artifacts committed locally but push failed (${pushed.stderr.trim()}); push manually\n`,
      )
    }
  }
  return state
}
