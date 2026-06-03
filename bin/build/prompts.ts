/**
 * Phase prompt builders for build.
 *
 * Every prompt references the feature's build dir by path (cwd is the repo root,
 * so it's already in scope — no `--add-dir` needed) and ends with an explicit
 * instruction to emit a verdict sentinel the orchestrator parses. `design.md`
 * is the canonical target for every downstream phase.
 *
 * Prompts deliberately avoid memory of prior phases: each runs in a fresh
 * subprocess, so the build dir is the only shared context.
 */

import { join } from "node:path"

/**
 * Standing instruction (shared by the build + code-review phases) inviting the
 * agent to jot down OUT-OF-SCOPE observations — latent bugs, refactors, tech
 * debt, missing tests, perf issues it happens to notice — into an append-only
 * `observations.md` in the build dir. A later skill mines these into a backlog.
 *
 * The hard rule is that observations never affect the current run: the agent
 * must not act on them, let them block, or expand scope. An absent/empty file
 * is the normal case.
 */
function observationsInstruction(buildDir: string): string {
  const observations = join(buildDir, "observations.md")
  return [
    "While working you may notice problems that are OUT OF SCOPE for this feature —",
    "pre-existing latent bugs, refactors worth doing, tech debt, missing tests, or",
    'perf issues in code you happen to read. "Out of scope" means not required by the',
    `approved plan/design for this feature. Capture each in ${observations} (create it`,
    "if absent; skim the existing entries first and skip anything already recorded) by",
    "appending a Markdown entry:",
    "",
    "## <short title>",
    "- **kind:** bug | refactor | tech-debt | test-gap | perf",
    "- **where:** path/to/file.ts:42",
    "- **why out of scope:** <one line>",
    "- **suggestion:** <what a future engineer should do>",
    "",
    "Rules: do NOT act on them, do NOT let them block or expand the current task, and",
    "only record things genuinely worth a future engineer's time. If nothing stands",
    `out, leave ${observations} untouched — an absent or empty file is normal.`,
  ].join("\n")
}

export type PlanPromptArgs = {
  feature: string
  buildDir: string
  /** True when re-planning after a NEEDS_REVISION verdict. */
  revising: boolean
}

export function planPrompt({
  feature,
  buildDir,
  revising,
}: PlanPromptArgs): string {
  const design = join(buildDir, "design.md")
  const planReview = join(buildDir, "plan-review.md")
  const plan = join(buildDir, "plan.md")
  return [
    `You are the PLAN phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "",
    `1. Read the approved design at ${design} — it is the canonical target. Everything you plan must serve it.`,
    revising
      ? `2. This is a revision. Read the reviewer's critique at ${planReview} and address every point it raises.`
      : "2. Explore the codebase to ground the plan in real files, patterns, and conventions.",
    `3. Write a concrete, step-by-step coding plan to ${plan}. Reference actual files (path:line), describe the changes, call out tests (red/green TDD), and note any risks or sequencing constraints.`,
    "",
    "Do NOT write production code in this phase — only the plan.",
    "",
    "When the plan is complete and faithful to the design, output the exact line:",
    "PLAN_DONE",
    "If you genuinely cannot produce a plan (the design is internally contradictory, or a decision needs human product judgment), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

export type PlanReviewPromptArgs = {
  feature: string
  buildDir: string
}

export function planReviewPrompt({
  feature,
  buildDir,
}: PlanReviewPromptArgs): string {
  const design = join(buildDir, "design.md")
  const plan = join(buildDir, "plan.md")
  const out = join(buildDir, "plan-review.md")
  return [
    `You are the PLAN-REVIEW phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer with no knowledge of how the plan's author reasoned — that independence is the point.",
    "",
    `1. Read ${design} — this is the CANONICAL target. Judge strictly against it.`,
    `2. Read the coding plan at ${plan}.`,
    `3. Critique the plan: does it fully and faithfully realise the design? Look for missing steps, hidden dependencies, incorrect assumptions, scope creep, untested paths, and simpler alternatives.`,
    `4. Write your critique to ${out}.`,
    "",
    "This is a hard gate: no code is written until the plan is APPROVED.",
    "",
    "End your output with exactly one of these lines:",
    "APPROVED            — the plan faithfully realises the design and is ready to build",
    "NEEDS_REVISION      — the plan must change first (your critique file says how)",
    "ESCALATE: <reason>  — you cannot judge without human input (genuine ambiguity / product call)",
  ].join("\n")
}

export type BuildPromptArgs = {
  feature: string
  buildDir: string
  /** Present when re-entering build after a failed validate gate. */
  validateFailuresPath?: string
}

export function buildPrompt({
  feature,
  buildDir,
  validateFailuresPath,
}: BuildPromptArgs): string {
  const design = join(buildDir, "design.md")
  const plan = join(buildDir, "plan.md")
  const impl = join(buildDir, "implementation.md")
  return [
    `You are the BUILD phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "",
    `1. Read the approved plan at ${plan} and the canonical design at ${design}.`,
    validateFailuresPath
      ? `2. The validation gate FAILED on the last build. Read the captured failure output at ${validateFailuresPath} and fix the root cause — do not weaken tests or silence errors.`
      : "2. Implement the plan. Follow the repo's conventions (red/green TDD, Biome style, CLAUDE.md rules).",
    `3. Record what you built and any divergences from the plan in ${impl}.`,
    "4. Commit your work with clear messages.",
    "",
    observationsInstruction(buildDir),
    "",
    "When the implementation is complete, output the exact line:",
    "BUILD_DONE",
    "If you are genuinely blocked (the plan is unbuildable as written, or a decision needs human judgment), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

export type ReviewPromptArgs = {
  feature: string
  buildDir: string
  round: number
  baseBranch: string
}

export function reviewPrompt({
  feature,
  buildDir,
  round,
  baseBranch,
}: ReviewPromptArgs): string {
  const design = join(buildDir, "design.md")
  const impl = join(buildDir, "implementation.md")
  const out = join(buildDir, "review", `round-${round}.md`)
  const prev = join(buildDir, "review", `round-${round - 1}.md`)
  return [
    `You are the CODE-REVIEW phase (round ${round}) of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer — you did not write this code.",
    "",
    `1. Read the diff: \`git diff ${baseBranch}...HEAD\`.`,
    `2. Read the canonical design at ${design} and the build notes at ${impl}.`,
    round > 1
      ? `3. Read the previous round at ${prev}: the builder responded to each finding (fix + SHA, or pushback). Confirm fixes, weigh pushbacks fairly, and only re-raise what is still genuinely wrong.`
      : "3. Review the diff against the design for correctness, faithfulness, and quality.",
    `4. Write your findings to ${out}. Tag each finding [blocking], [nit], or [question]. Be specific (file:line + why).`,
    `5. Make the verdict line below the LAST line of ${out} as well, so the run can recover it on resume.`,
    "",
    // The distinctness clause lives here, not in the shared helper, because only
    // the review phase produces gated [blocking] findings to keep observations apart from.
    `${observationsInstruction(buildDir)}\nThese are separate from your review findings — never promote an observation into a [blocking] finding to force it into this feature, and conversely never downgrade a real defect in THIS diff to an observation: anything wrong with the diff under review is a finding, not an observation.`,
    "",
    "End your output (and the findings file) with exactly one of these lines:",
    "CLEAN               — no blocking findings remain; ready for PR",
    "BLOCKING            — at least one [blocking] finding the builder must address",
    "ESCALATE: <reason>  — you cannot converge (genuine disagreement / repeated thrash / product call)",
  ].join("\n")
}

export type ReviewResponsePromptArgs = {
  feature: string
  buildDir: string
  round: number
}

export function reviewResponsePrompt({
  feature,
  buildDir,
  round,
}: ReviewResponsePromptArgs): string {
  const roundFile = join(buildDir, "review", `round-${round}.md`)
  return [
    `You are the BUILDER responding to code-review round ${round} for the "${feature}" feature.`,
    "",
    `1. Read the reviewer's findings at ${roundFile}.`,
    "2. For each [blocking] finding, respond IN THE SAME FILE, immediately under the finding, with one of:",
    "   - FIX: make the change and commit it, then note the commit SHA.",
    "   - PUSHBACK: explain why it's intentional, wrong, or out of scope (be specific and respectful).",
    "3. Address [nit]s where cheap; you may note [question]s briefly. Blocking items are mandatory.",
    "",
    "Make real code changes and commit them — the validation gate re-runs after you finish.",
    "",
    "When you have responded to every blocking finding, output the exact line:",
    "BUILD_DONE",
    "If you cannot converge with the reviewer (genuine disagreement or repeated thrash on the same point), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

/** The PR phase reuses the existing /pr open skill, then signals completion. */
export function prPrompt(feature: string): string {
  return [
    `You are the PR phase of the autonomous build pipeline for the "${feature}" feature.`,
    "Open the pull request for this branch by running the /pr skill in open mode:",
    "",
    "/pr open",
    "",
    "It rebases/merges main, pushes, and opens (or updates) the PR. After it finishes successfully, output the exact line:",
    "BUILD_DONE",
    "If it cannot open the PR (e.g. unresolved merge conflicts that need a human call), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

/** Builder prompt for a failing-CI fix during the monitor loop. */
export function monitorCiFixPrompt(
  feature: string,
  failingChecks: string[],
): string {
  return [
    `You are the BUILDER fixing failing CI for the "${feature}" PR during build monitoring.`,
    "",
    `Failing checks: ${failingChecks.join(", ")}`,
    "",
    "1. For each failing check, run `gh run view <run-id> --log-failed` (find run ids via `gh run list`) to read the failure.",
    "2. Fix the root cause locally — do not disable tests or weaken assertions.",
    "3. Run the relevant local checks (bun run lint, bun run typecheck, targeted tests).",
    "4. Commit with a message naming what failed and why the fix works, then push.",
    "",
    "When the fix is pushed, output the exact line:",
    "BUILD_DONE",
    "If the failure needs human judgment, instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

/** Builder prompt that delegates unresolved-thread handling to /address-review. */
export function monitorAddressReviewPrompt(
  feature: string,
  prNumber: number,
): string {
  return [
    `You are the BUILDER addressing PR review threads for the "${feature}" PR during build monitoring.`,
    "",
    `Run the /address-review skill for PR #${prNumber}:`,
    "",
    `/address-review ${prNumber}`,
    "",
    "It reads unresolved threads, classifies each as Fix or Pushback, commits and pushes fixes, and posts pushback replies. Do NOT resolve threads — the cloud review agent owns resolution.",
    "",
    "When it finishes, output the exact line:",
    "BUILD_DONE",
    "If a thread needs human product judgment, instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}
