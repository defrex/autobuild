import { describe, expect, test } from "bun:test"
import {
  decideMonitorAction,
  failingCheckNames,
  monitorPr,
  type PrSnapshot,
  parsePrSnapshot,
} from "./monitor"

const base: PrSnapshot = {
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  failingChecks: [],
  unresolvedThreads: 0,
}

describe("failingCheckNames", () => {
  test("picks up failing conclusions and states", () => {
    const names = failingCheckNames([
      { name: "build", conclusion: "SUCCESS" },
      { name: "test", conclusion: "FAILURE" },
      { context: "ci/legacy", state: "ERROR" },
      { name: "lint", conclusion: "TIMED_OUT" },
    ])
    expect(names).toEqual(["test", "ci/legacy", "lint"])
  })

  test("empty when everything passed", () => {
    expect(
      failingCheckNames([{ name: "build", conclusion: "SUCCESS" }]),
    ).toEqual([])
  })
})

describe("parsePrSnapshot", () => {
  test("merges gh view JSON with the unresolved count", () => {
    const snap = parsePrSnapshot(
      {
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }],
      },
      3,
    )
    expect(snap).toEqual({
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      failingChecks: ["test"],
      unresolvedThreads: 3,
    })
  })

  test("defaults missing fields to UNKNOWN", () => {
    const snap = parsePrSnapshot({}, 0)
    expect(snap.state).toBe("UNKNOWN")
    expect(snap.failingChecks).toEqual([])
  })
})

describe("decideMonitorAction", () => {
  test("merged / closed are terminal", () => {
    expect(decideMonitorAction({ ...base, state: "MERGED" }).kind).toBe("done")
    expect(decideMonitorAction({ ...base, state: "CLOSED" }).kind).toBe("done")
  })

  test("mergeable + clean + no threads is done", () => {
    expect(decideMonitorAction(base)).toEqual({
      kind: "done",
      reason: "mergeable and clean",
    })
  })

  test("behind base takes priority → rebase", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BEHIND",
        failingChecks: ["test"],
        unresolvedThreads: 2,
      }),
    ).toEqual({ kind: "rebase" })
  })

  test("failing CI before review threads", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BLOCKED",
        failingChecks: ["test"],
        unresolvedThreads: 2,
      }),
    ).toEqual({ kind: "fix-ci", failingChecks: ["test"] })
  })

  test("unresolved threads when CI is green", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BLOCKED",
        unresolvedThreads: 1,
      }),
    ).toEqual({ kind: "address-review" })
  })

  test("waits when blocked but nothing actionable (e.g. CI pending)", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNSTABLE",
      }),
    ).toEqual({ kind: "wait" })
  })
})

describe("monitorPr", () => {
  test("acts on blockers then stops when ready", async () => {
    const snapshots: PrSnapshot[] = [
      { ...base, mergeStateStatus: "BEHIND" },
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["test"] },
      { ...base, mergeStateStatus: "UNSTABLE", mergeable: "UNKNOWN" }, // wait
      base, // done
    ]
    const acted: string[] = []
    let sleeps = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async (a) => {
        acted.push(a.kind)
      },
      sleep: async () => {
        sleeps++
      },
      intervalMs: 1,
    })
    expect(result).toEqual({ outcome: "done", reason: "mergeable and clean" })
    expect(acted).toEqual(["rebase", "fix-ci"])
    // slept after each non-terminal pass (3 of them)
    expect(sleeps).toBe(3)
  })

  test("gives up (not done) when the backstop is hit while not mergeable", async () => {
    const result = await monitorPr({
      poll: async () => ({
        ...base,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNSTABLE",
      }),
      act: async () => {},
      sleep: async () => {},
      intervalMs: 1,
      maxPasses: 3,
    })
    expect(result.outcome).toBe("gave-up")
    expect(result.reason).toContain("3 polling passes")
  })

  test("fires the soft-budget warning without stopping", async () => {
    let polls = 0
    let warned = 0
    await monitorPr({
      poll: async () => {
        polls++
        return polls >= 3
          ? base
          : { ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNSTABLE" }
      },
      act: async () => {},
      sleep: async () => {},
      intervalMs: 1,
      softBudgetPasses: 2,
      onSoftBudget: () => {
        warned++
      },
    })
    expect(warned).toBe(1)
  })
})
