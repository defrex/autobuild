import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { builderArgs, reviewerArgs, runHarness } from "./harness"

describe("builderArgs", () => {
  test("claude --print headless with model and prompt", () => {
    const argv = builderArgs({ bin: "claude", model: "opus" }, "do the thing")
    expect(argv).toEqual([
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "do the thing",
    ])
  })

  test("omits --model when unset and threads --mcp-config", () => {
    const argv = builderArgs({ bin: "claude" }, "p", {
      mcpConfig: "/tmp/mcp.json",
    })
    expect(argv).toEqual([
      "--print",
      "--dangerously-skip-permissions",
      "--mcp-config",
      "/tmp/mcp.json",
      "p",
    ])
  })

  test("adds --strict-mcp-config alongside --mcp-config", () => {
    const argv = builderArgs({ bin: "claude" }, "p", {
      mcpConfig: "/tmp/mcp.json",
      strictMcp: true,
    })
    expect(argv).toContain("--strict-mcp-config")
    // strict is meaningless without a config, so it's dropped when absent
    expect(
      builderArgs({ bin: "claude" }, "p", { strictMcp: true }),
    ).not.toContain("--strict-mcp-config")
  })

  test("rejects a non-claude builder", () => {
    expect(() => builderArgs({ bin: "codex" }, "p")).toThrow()
  })
})

describe("reviewerArgs", () => {
  test("codex exec headless with output file", () => {
    const argv = reviewerArgs({ bin: "codex" }, "review it", {
      outputFile: "/tmp/last.txt",
    })
    expect(argv).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      "/tmp/last.txt",
      "review it",
    ])
  })

  test("includes -m when a model is set", () => {
    const argv = reviewerArgs({ bin: "codex", model: "gpt-5" }, "p")
    expect(argv).toContain("-m")
    expect(argv).toContain("gpt-5")
  })

  test("rejects a non-codex reviewer", () => {
    expect(() => reviewerArgs({ bin: "claude" }, "p")).toThrow()
  })
})

describe("runHarness", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "build-flow-harness-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("captures stdout, logs the command, and returns the exit code", async () => {
    const logPath = join(dir, "build.log")
    const result = await runHarness({
      bin: "bash",
      argv: ["-c", "echo hello; echo PLAN_DONE"],
      cwd: dir,
      logPath,
    })
    expect(result.code).toBe(0)
    expect(result.output).toContain("hello")
    expect(result.output).toContain("PLAN_DONE")
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("$ bash -c")
    expect(log).toContain("PLAN_DONE")
  })

  test("propagates a non-zero exit code", async () => {
    const result = await runHarness({
      bin: "bash",
      argv: ["-c", "exit 3"],
      cwd: dir,
      logPath: join(dir, "build.log"),
    })
    expect(result.code).toBe(3)
  })
})
