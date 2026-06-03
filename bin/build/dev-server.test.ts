import { describe, expect, test } from "bun:test"
import {
  deriveDevUrl,
  reachable,
  waitUntilReachable,
  withDevServer,
} from "./dev-server"

describe("deriveDevUrl", () => {
  test("uses CONDUCTOR_WORKSPACE_NAME over repo basename", () => {
    expect(
      deriveDevUrl({ CONDUCTOR_WORKSPACE_NAME: "product-meetings" }, "/x/repo"),
    ).toBe("https://product-meetings.dispatch.localhost")
  })

  test("falls back to the repo dir basename", () => {
    expect(deriveDevUrl({}, "/Users/me/code/amplified-geography")).toBe(
      "https://amplified-geography.dispatch.localhost",
    )
  })

  test("CI mode uses plain HTTP on the default portless port", () => {
    expect(deriveDevUrl({ CI: "1" }, "/x/repo")).toBe(
      "http://repo.dispatch.localhost:1355",
    )
  })

  test("PORTLESS_PORT overrides the fallback port", () => {
    expect(deriveDevUrl({ PORTLESS_PORT: "8080" }, "/x/repo")).toBe(
      "http://repo.dispatch.localhost:8080",
    )
  })
})

describe("reachable", () => {
  test("true on any HTTP response", async () => {
    const ok = await reachable("https://x", async () => ({ ok: false }))
    expect(ok).toBe(true)
  })

  test("true on a TLS/certificate error (something is listening)", async () => {
    const ok = await reachable("https://x", async () => {
      throw Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      })
    })
    expect(ok).toBe(true)
  })

  test("false on connection refused", async () => {
    const ok = await reachable("https://x", async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      })
    })
    expect(ok).toBe(false)
  })
})

describe("waitUntilReachable", () => {
  test("resolves true once the server comes up", async () => {
    let calls = 0
    const ok = await waitUntilReachable("https://x", {
      intervalMs: 0,
      reachableImpl: async () => ++calls >= 3,
      sleep: async () => {},
    })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test("returns false after the timeout", async () => {
    let t = 0
    const ok = await waitUntilReachable("https://x", {
      timeoutMs: 10,
      intervalMs: 5,
      reachableImpl: async () => false,
      sleep: async () => {},
      now: () => (t += 5),
    })
    expect(ok).toBe(false)
  })
})

describe("withDevServer", () => {
  test("does not spawn or kill when already reachable", async () => {
    let spawned = false
    const result = await withDevServer({
      devUrl: "https://x",
      repoRoot: "/repo",
      reachableImpl: async () => true,
      spawnDev: () => {
        spawned = true
        return { kill: () => {} } as never
      },
      run: async (url) => `ran:${url}`,
    })
    expect(result).toBe("ran:https://x")
    expect(spawned).toBe(false)
  })

  test("spawns when not reachable and kills only what it started", async () => {
    let spawned = false
    let killed = false
    const result = await withDevServer({
      devUrl: "https://x",
      repoRoot: "/repo",
      reachableImpl: async () => false,
      waitImpl: async () => true,
      spawnDev: () => {
        spawned = true
        return {} as never
      },
      killDev: () => {
        killed = true
      },
      run: async () => "done",
    })
    expect(result).toBe("done")
    expect(spawned).toBe(true)
    expect(killed).toBe(true)
  })

  test("throws and tears down if the spawned server never comes up", async () => {
    let killed = false
    await expect(
      withDevServer({
        devUrl: "https://x",
        repoRoot: "/repo",
        reachableImpl: async () => false,
        waitImpl: async () => false,
        spawnDev: () => ({}) as never,
        killDev: () => {
          killed = true
        },
        run: async () => "should not run",
      }),
    ).rejects.toThrow("never became reachable")
    expect(killed).toBe(true)
  })
})
