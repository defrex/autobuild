import { describe, expect, test } from "bun:test"
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

const buildDir = "/repo/build/build-flow"

describe("planPrompt", () => {
  test("references design + plan paths and the PLAN_DONE sentinel", () => {
    const p = planPrompt({ feature: "build-flow", buildDir, revising: false })
    expect(p).toContain(`${buildDir}/design.md`)
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain("PLAN_DONE")
    expect(p).toContain("ESCALATE:")
    expect(p).toContain("Explore the codebase")
  })
  test("revising mode points at the prior critique", () => {
    const p = planPrompt({ feature: "build-flow", buildDir, revising: true })
    expect(p).toContain(`${buildDir}/plan-review.md`)
    expect(p).toContain("revision")
  })
})

describe("planReviewPrompt", () => {
  test("treats design as canonical and lists all three verdicts", () => {
    const p = planReviewPrompt({ feature: "build-flow", buildDir })
    expect(p).toContain("CANONICAL")
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain(`${buildDir}/plan-review.md`)
    expect(p).toContain("APPROVED")
    expect(p).toContain("NEEDS_REVISION")
    expect(p).toContain("ESCALATE:")
  })
})

describe("buildPrompt", () => {
  test("base build references plan, design, implementation notes", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir })
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain(`${buildDir}/implementation.md`)
    expect(p).toContain("BUILD_DONE")
  })
  test("validate-failure loop points at the captured failures", () => {
    const failures = `${buildDir}/validate-failures.md`
    const p = buildPrompt({
      feature: "build-flow",
      buildDir,
      validateFailuresPath: failures,
    })
    expect(p).toContain(failures)
    expect(p).toContain("FAILED")
  })
  test("invites out-of-scope observations without blocking the build", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir })
    expect(p).toContain(`${buildDir}/observations.md`)
    expect(p).toContain("OUT OF SCOPE")
    expect(p).toContain("do NOT let them block")
  })
})

describe("reviewPrompt", () => {
  test("round 1 reviews the diff against the design", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain("git diff main...HEAD")
    expect(p).toContain(`${buildDir}/review/round-1.md`)
    expect(p).toContain("[blocking]")
    expect(p).toContain("CLEAN")
    expect(p).toContain("BLOCKING")
  })
  test("later rounds reference the previous round file", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      round: 3,
      baseBranch: "main",
    })
    expect(p).toContain(`${buildDir}/review/round-3.md`)
    expect(p).toContain(`${buildDir}/review/round-2.md`)
  })
  test("records out-of-scope observations separately from review findings", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain(`${buildDir}/observations.md`)
    expect(p).toContain("OUT OF SCOPE")
    // must not be conflated with the blocking/nit/question findings
    expect(p).toContain("separate from your review findings")
  })
})

describe("reviewResponsePrompt", () => {
  test("responds in the same round file with fix/pushback and BUILD_DONE", () => {
    const p = reviewResponsePrompt({
      feature: "build-flow",
      buildDir,
      round: 2,
    })
    expect(p).toContain(`${buildDir}/review/round-2.md`)
    expect(p).toContain("FIX")
    expect(p).toContain("PUSHBACK")
    expect(p).toContain("BUILD_DONE")
  })
})

describe("prPrompt", () => {
  test("invokes /pr open and ends with BUILD_DONE", () => {
    const p = prPrompt("build-flow")
    expect(p).toContain("/pr open")
    expect(p).toContain("BUILD_DONE")
  })
})

describe("monitor prompts", () => {
  test("CI fix names the failing checks and tells the builder to fetch logs", () => {
    const p = monitorCiFixPrompt("build-flow", ["test", "typecheck"])
    expect(p).toContain("test, typecheck")
    expect(p).toContain("--log-failed")
    expect(p).toContain("BUILD_DONE")
  })
  test("address-review invokes the skill with the PR number", () => {
    const p = monitorAddressReviewPrompt("build-flow", 456)
    expect(p).toContain("/address-review 456")
    expect(p).toContain("BUILD_DONE")
  })
})
