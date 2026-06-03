/**
 * Thin git/gh shell wrappers for the PR + monitor phases.
 *
 * Kept separate from the orchestrator so the pure decision logic in
 * `monitor.ts` stays testable; these are integration glue around the local
 * `git` and `gh` binaries.
 */

import { spawnSync } from "node:child_process"
import { type PrSnapshot, parsePrSnapshot } from "./monitor"

export type ShResult = { code: number; stdout: string; stderr: string }

/** Run a command synchronously, capturing stdout/stderr. */
export function sh(cmd: string[], cwd: string): ShResult {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" })
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

/** Absolute path to the repo root, or throw if not in a git repo. */
export function detectRepoRoot(cwd: string = process.cwd()): string {
  const r = sh(["git", "rev-parse", "--show-toplevel"], cwd)
  if (r.code !== 0) throw new Error("build must run inside a git repository")
  return r.stdout.trim()
}

/** Current branch name. */
export function detectBranch(repoRoot: string): string {
  return sh(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
  ).stdout.trim()
}

/** The PR number for the current branch, or null if none exists yet. */
export function detectPrNumber(repoRoot: string): number | null {
  const r = sh(
    ["gh", "pr", "view", "--json", "number", "-q", ".number"],
    repoRoot,
  )
  if (r.code !== 0) return null
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isNaN(n) ? null : n
}

// first: 100 caps the count — a PR with >100 review threads under-reports
// unresolved threads. That's far beyond any realistic Dispatch PR; revisit only
// if monitor declares "done" while threads remain open.
const UNRESOLVED_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`

/** Poll the live PR state into a snapshot (gh pr view + unresolved-thread count). */
export function fetchPrSnapshot(
  repoRoot: string,
  prNumber: number,
): PrSnapshot {
  const view = sh(
    [
      "gh",
      "pr",
      "view",
      "--json",
      "state,mergeable,mergeStateStatus,statusCheckRollup",
    ],
    repoRoot,
  )
  const json = view.code === 0 ? JSON.parse(view.stdout || "{}") : {}

  const nameWithOwner = sh(
    ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    repoRoot,
  ).stdout.trim()
  const [owner, name] = nameWithOwner.split("/")
  const graph = sh(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
      "--jq",
      "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length",
    ],
    repoRoot,
  )
  const unresolved = Number.parseInt(graph.stdout.trim() || "0", 10) || 0
  return parsePrSnapshot(json, unresolved)
}

/**
 * Snapshot the feature's build dir into a single commit and push it to the PR.
 *
 * The pipeline writes artifacts (plan, review findings, build.log, state.json)
 * throughout the run — including phases that run *after* the build phase's own
 * commit — so without this step they'd be left uncommitted in the worktree.
 * Called as the final action of a successful run, after the build.log/state.json
 * tail is written, so the commit captures the complete record and the worktree
 * ends clean. Scoped to `build/<feature>` (the transient `.build/` scratch dir is
 * gitignored). A no-op when nothing changed; never pushes if the commit fails.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function commitAndPushArtifacts(
  repoRoot: string,
  feature: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  const dir = `build/${feature}`
  exec(["git", "add", "--", dir], repoRoot)
  // `git diff --cached --quiet` exits 0 when nothing is staged → nothing to do.
  const staged = exec(
    ["git", "diff", "--cached", "--quiet", "--", dir],
    repoRoot,
  )
  // Self-describing no-op result (don't surface the diff probe's output).
  if (staged.code === 0) return { code: 0, stdout: "", stderr: "" }
  const commit = exec(
    [
      "git",
      "commit",
      "-m",
      `build(${feature}): capture final pipeline artifacts`,
      "--",
      dir,
    ],
    repoRoot,
  )
  if (commit.code !== 0) return commit
  return exec(["git", "push"], repoRoot)
}

/**
 * Rebase the branch onto its base and force-push (with lease). On conflict the
 * rebase is aborted (so the worktree is never left mid-rebase for a later
 * builder to trip over) and the failed result is returned for the caller to
 * escalate — an unattended pipeline can't resolve conflicts itself.
 */
export function rebaseOntoBase(repoRoot: string, baseBranch: string): ShResult {
  sh(["git", "fetch", "origin", baseBranch], repoRoot)
  const rebase = sh(["git", "rebase", `origin/${baseBranch}`], repoRoot)
  if (rebase.code !== 0) {
    sh(["git", "rebase", "--abort"], repoRoot)
    return rebase
  }
  return sh(["git", "push", "--force-with-lease"], repoRoot)
}
