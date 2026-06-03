import { describe, expect, test } from "bun:test"
import { commitAndPushArtifacts, type ShResult } from "./repo"

/** A fake `sh` that records calls and replays scripted results by command index. */
function fakeSh(results: ShResult[]) {
  const calls: string[][] = []
  let i = 0
  const exec = (cmd: string[]): ShResult => {
    calls.push(cmd)
    return results[i++] ?? { code: 0, stdout: "", stderr: "" }
  }
  return { exec, calls }
}

const ok: ShResult = { code: 0, stdout: "", stderr: "" }
const dirty: ShResult = { code: 1, stdout: "", stderr: "" } // diff --quiet exits 1 when changes exist

describe("commitAndPushArtifacts", () => {
  test("commits the scoped build dir and pushes when artifacts changed", () => {
    // add → diff(dirty) → commit → push
    const { exec, calls } = fakeSh([ok, dirty, ok, ok])
    const result = commitAndPushArtifacts("/repo", "my-feature", exec)

    expect(result.code).toBe(0)
    // staged only the feature's build dir
    expect(calls[0]).toEqual(["git", "add", "--", "build/my-feature"])
    // committed scoped to that pathspec, with the conventional message
    const commit = calls.find((c) => c[1] === "commit")
    expect(commit).toBeDefined()
    expect(commit).toContain("build/my-feature")
    expect(commit?.join(" ")).toContain(
      "build(my-feature): capture final pipeline artifacts",
    )
    // and pushed
    expect(calls.some((c) => c[1] === "push")).toBe(true)
  })

  test("is a no-op when nothing changed (does not commit or push)", () => {
    // add → diff(clean, code 0) → stop
    const { exec, calls } = fakeSh([ok, ok])
    const result = commitAndPushArtifacts("/repo", "my-feature", exec)

    expect(result.code).toBe(0)
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("does not push when the commit fails", () => {
    // add → diff(dirty) → commit(fail) → stop
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      { code: 1, stdout: "", stderr: "boom" },
    ])
    const result = commitAndPushArtifacts("/repo", "my-feature", exec)

    expect(result.code).toBe(1)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })
})
