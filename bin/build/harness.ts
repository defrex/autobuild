/**
 * Harness invocation for build phases.
 *
 * Builds the spawn argv for each harness CLI and runs it headless, streaming
 * stdout to both the console and the run log. Builder phases use
 * `claude --print` (like `bin/ralph.ts`); reviewer phases use `codex exec`.
 * Each phase's verdict is parsed from the captured stdout.
 */

import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { HarnessEntry } from "./state"

export type BuilderArgsOpts = {
  /** Path to an MCP config JSON (e.g. next-devtools for e2e). */
  mcpConfig?: string
  /** With `mcpConfig`, ignore all other MCP configs (`--strict-mcp-config`). */
  strictMcp?: boolean
}

/**
 * Argv for a builder phase. Defaults to the `claude --print` headless pattern
 * from `bin/ralph.ts`. The prompt is passed positionally; cwd is the repo root.
 */
export function builderArgs(
  harness: HarnessEntry,
  prompt: string,
  opts: BuilderArgsOpts = {},
): string[] {
  if (harness.bin !== "claude") {
    throw new Error(`unsupported builder harness: ${harness.bin}`)
  }
  return [
    "--print",
    "--dangerously-skip-permissions",
    ...(harness.model ? ["--model", harness.model] : []),
    ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
    ...(opts.mcpConfig && opts.strictMcp ? ["--strict-mcp-config"] : []),
    prompt,
  ]
}

export type ReviewerArgsOpts = {
  /** Path to write the agent's final message to, for clean verdict parsing. */
  outputFile?: string
}

/**
 * Argv for a reviewer phase. Defaults to `codex exec` with approvals + sandbox
 * bypassed (headless automation), mirroring the builder's skip-permissions.
 */
export function reviewerArgs(
  harness: HarnessEntry,
  prompt: string,
  opts: ReviewerArgsOpts = {},
): string[] {
  if (harness.bin !== "codex") {
    throw new Error(`unsupported reviewer harness: ${harness.bin}`)
  }
  return [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    ...(harness.model ? ["-m", harness.model] : []),
    ...(opts.outputFile ? ["-o", opts.outputFile] : []),
    prompt,
  ]
}

export type RunResult = { code: number | null; output: string }

export type RunHarnessArgs = {
  bin: string
  argv: string[]
  cwd: string
  logPath: string
}

/**
 * Spawn a harness binary, streaming stdout to the console and appending it
 * (with stderr) to the run log. Resolves with the exit code and captured
 * stdout (used for verdict parsing). Rejects only on spawn error.
 */
export function runHarness({
  bin,
  argv,
  cwd,
  logPath,
}: RunHarnessArgs): Promise<RunResult> {
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `\n$ ${bin} ${argv.join(" ")}\n`)

  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    })

    let output = ""

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      process.stdout.write(text)
      appendFileSync(logPath, text)
      output += text
    })

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      process.stderr.write(text)
      appendFileSync(logPath, text)
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
}
