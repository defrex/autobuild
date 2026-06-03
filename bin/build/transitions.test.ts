import { describe, expect, test } from "bun:test"
import { transition } from "./transitions"

describe("transition — plan", () => {
  test("done → plan-review", () => {
    expect(transition({ phase: "plan", verdict: { kind: "done" } })).toEqual({
      phase: "plan-review",
      status: "running",
    })
  })
  test("escalate → blocked at plan", () => {
    expect(
      transition({ phase: "plan", verdict: { kind: "escalate", reason: "x" } }),
    ).toEqual({ phase: "plan", status: "blocked" })
  })
})

describe("transition — plan-review", () => {
  test("approved → build", () => {
    expect(
      transition({ phase: "plan-review", verdict: { kind: "approved" } }),
    ).toEqual({ phase: "build", status: "running" })
  })
  test("needs_revision → plan (unbounded loop)", () => {
    expect(
      transition({ phase: "plan-review", verdict: { kind: "needs_revision" } }),
    ).toEqual({ phase: "plan", status: "running" })
  })
  test("escalate → blocked", () => {
    expect(
      transition({
        phase: "plan-review",
        verdict: { kind: "escalate", reason: "x" },
      }),
    ).toEqual({ phase: "plan-review", status: "blocked" })
  })
})

describe("transition — build", () => {
  test("done → validate", () => {
    expect(transition({ phase: "build", verdict: { kind: "done" } })).toEqual({
      phase: "validate",
      status: "running",
    })
  })
  test("escalate → blocked", () => {
    expect(
      transition({
        phase: "build",
        verdict: { kind: "escalate", reason: "x" },
      }),
    ).toEqual({ phase: "build", status: "blocked" })
  })
})

describe("transition — validate", () => {
  test("pass → review", () => {
    expect(transition({ phase: "validate", pass: true })).toEqual({
      phase: "review",
      status: "running",
    })
  })
  test("fail → build (with failure output)", () => {
    expect(transition({ phase: "validate", pass: false })).toEqual({
      phase: "build",
      status: "running",
    })
  })
})

describe("transition — review", () => {
  test("clean → pr", () => {
    expect(transition({ phase: "review", verdict: { kind: "clean" } })).toEqual(
      { phase: "pr", status: "running" },
    )
  })
  test("blocking → review with round bump", () => {
    expect(
      transition({ phase: "review", verdict: { kind: "blocking" } }),
    ).toEqual({ phase: "review", status: "running", bumpReviewRound: true })
  })
  test("escalate → blocked", () => {
    expect(
      transition({
        phase: "review",
        verdict: { kind: "escalate", reason: "x" },
      }),
    ).toEqual({ phase: "review", status: "blocked" })
  })
})

describe("transition — pr / monitor", () => {
  test("pr done → monitor", () => {
    expect(transition({ phase: "pr", verdict: { kind: "done" } })).toEqual({
      phase: "monitor",
      status: "running",
    })
  })
  test("pr escalate → blocked", () => {
    expect(
      transition({ phase: "pr", verdict: { kind: "escalate", reason: "x" } }),
    ).toEqual({ phase: "pr", status: "blocked" })
  })
  test("monitor done → done/done", () => {
    expect(transition({ phase: "monitor", done: true })).toEqual({
      phase: "done",
      status: "done",
    })
  })
  test("monitor not done → keep polling", () => {
    expect(transition({ phase: "monitor", done: false })).toEqual({
      phase: "monitor",
      status: "running",
    })
  })
})
