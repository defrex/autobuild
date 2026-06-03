import { describe, expect, test } from "bun:test"
import {
  parseBuilderVerdict,
  parseCodeReviewVerdict,
  parsePlanReviewVerdict,
} from "./verdicts"

describe("parseBuilderVerdict", () => {
  test("recognises the done sentinel on its own line", () => {
    expect(parseBuilderVerdict("did stuff\nPLAN_DONE", "PLAN_DONE")).toEqual({
      kind: "done",
    })
    expect(parseBuilderVerdict("built it\nBUILD_DONE", "BUILD_DONE")).toEqual({
      kind: "done",
    })
  })

  test("requires the matching done token", () => {
    expect(parseBuilderVerdict("BUILD_DONE", "PLAN_DONE")).toBeNull()
  })

  test("parses ESCALATE with a reason", () => {
    expect(
      parseBuilderVerdict(
        "tried\nESCALATE: plan contradicts design",
        "PLAN_DONE",
      ),
    ).toEqual({ kind: "escalate", reason: "plan contradicts design" })
  })

  test("ESCALATE without a reason falls back to a placeholder", () => {
    expect(parseBuilderVerdict("ESCALATE", "BUILD_DONE")).toEqual({
      kind: "escalate",
      reason: "no reason given",
    })
  })

  test("returns null when no sentinel is present", () => {
    expect(parseBuilderVerdict("just some prose", "PLAN_DONE")).toBeNull()
  })

  test("last sentinel wins", () => {
    const out = "ESCALATE: early doubt\nresolved it\nPLAN_DONE"
    expect(parseBuilderVerdict(out, "PLAN_DONE")).toEqual({ kind: "done" })
  })

  test("ignores sentinel tokens embedded in prose", () => {
    expect(
      parseBuilderVerdict("I will emit PLAN_DONE when finished.", "PLAN_DONE"),
    ).toBeNull()
  })

  test("tolerates trailing whitespace and blank lines", () => {
    expect(parseBuilderVerdict("PLAN_DONE  \n\n", "PLAN_DONE")).toEqual({
      kind: "done",
    })
  })
})

describe("parsePlanReviewVerdict", () => {
  test("APPROVED / NEEDS_REVISION", () => {
    expect(parsePlanReviewVerdict("looks good\nAPPROVED")).toEqual({
      kind: "approved",
    })
    expect(parsePlanReviewVerdict("missing X\nNEEDS_REVISION")).toEqual({
      kind: "needs_revision",
    })
  })

  test("ESCALATE carries the reason", () => {
    expect(parsePlanReviewVerdict("ESCALATE: needs product call")).toEqual({
      kind: "escalate",
      reason: "needs product call",
    })
  })

  test("recognises a bold Verdict label with a backtick-wrapped token", () => {
    expect(
      parsePlanReviewVerdict("looks good\n**Verdict:** `APPROVED`"),
    ).toEqual({ kind: "approved" })
  })

  test("null when absent", () => {
    expect(parsePlanReviewVerdict("no verdict here")).toBeNull()
  })
})

describe("parseCodeReviewVerdict", () => {
  test("CLEAN / BLOCKING", () => {
    expect(parseCodeReviewVerdict("nothing left\nCLEAN")).toEqual({
      kind: "clean",
    })
    expect(parseCodeReviewVerdict("[blocking] foo\nBLOCKING")).toEqual({
      kind: "blocking",
    })
  })

  test("ESCALATE carries the reason", () => {
    expect(parseCodeReviewVerdict("ESCALATE: repeated thrash")).toEqual({
      kind: "escalate",
      reason: "repeated thrash",
    })
  })

  test("null when absent", () => {
    expect(parseCodeReviewVerdict("findings but no verdict")).toBeNull()
  })

  test("recognises a backtick-wrapped sentinel after a Verdict: label", () => {
    // Reviewers (codex) phrase their summary as "Verdict: `BLOCKING`" — a
    // backtick-wrapped token with a label prefix, not a bare sentinel line.
    expect(
      parseCodeReviewVerdict("findings...\n\nVerdict: `BLOCKING`"),
    ).toEqual({ kind: "blocking" })
    expect(parseCodeReviewVerdict("all good\nVerdict: `CLEAN`")).toEqual({
      kind: "clean",
    })
  })

  test("recognises a bare backtick-wrapped sentinel line", () => {
    expect(parseCodeReviewVerdict("done\n`BLOCKING`")).toEqual({
      kind: "blocking",
    })
  })

  test("does not match a backticked token mid-sentence", () => {
    expect(
      parseCodeReviewVerdict("this is not `BLOCKING` in my view"),
    ).toBeNull()
  })
})
