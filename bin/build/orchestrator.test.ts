import { describe, expect, test } from "bun:test"
import { chooseReviewVerdict, decideStartup } from "./orchestrator"
import { initState } from "./state"

const now = "2026-05-28T00:00:00Z"

describe("chooseReviewVerdict", () => {
  test("prefers the round-file verdict over the chat-message verdict", () => {
    // The round file's bare sentinel is authoritative; even if the message
    // parsed to something else, the file wins.
    expect(
      chooseReviewVerdict({ kind: "blocking" }, { kind: "clean" }, 4),
    ).toEqual({ kind: "blocking" })
  })

  test("falls back to the message verdict when the file has none", () => {
    expect(chooseReviewVerdict(null, { kind: "clean" }, 2)).toEqual({
      kind: "clean",
    })
  })

  test("escalates only when neither source yields a verdict", () => {
    expect(chooseReviewVerdict(null, null, 4)).toEqual({
      kind: "escalate",
      reason: "code-review round 4 produced no CLEAN/BLOCKING/ESCALATE verdict",
    })
  })
})

describe("decideStartup", () => {
  test("no state + no design → halt (run /spec first)", () => {
    const d = decideStartup(
      { designExists: false, state: null, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("/spec")
  })

  test("no state + design → start fresh at plan", () => {
    const d = decideStartup(
      { designExists: true, state: null, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") {
      expect(d.state.phase).toBe("plan")
      expect(d.state.status).toBe("running")
    }
  })

  test("existing state + NEEDS-INPUT present → halt", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "build" as const,
      status: "blocked" as const,
    }
    const d = decideStartup(
      { designExists: true, state, needsInputExists: true },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("NEEDS-INPUT.md")
  })

  test("blocked but NEEDS-INPUT deleted → resume running from same phase", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "review" as const,
      status: "blocked" as const,
      reviewRound: 2,
    }
    const d = decideStartup(
      { designExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") {
      expect(d.state.phase).toBe("review")
      expect(d.state.status).toBe("running")
      expect(d.state.reviewRound).toBe(2)
    }
  })

  test("already done → halt", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "done" as const,
      status: "done" as const,
    }
    const d = decideStartup(
      { designExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("already done")
  })
})
