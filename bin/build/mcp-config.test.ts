import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scopeMcpServer, writeScopedNextDevtoolsConfig } from "./mcp-config"

describe("scopeMcpServer", () => {
  test("extracts only the named server", () => {
    const config = {
      mcpServers: {
        "next-devtools": {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
        },
        convex: { command: "bunx", args: ["convex", "mcp", "start"] },
      },
    }
    expect(scopeMcpServer(config, "next-devtools")).toEqual({
      mcpServers: {
        "next-devtools": {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
        },
      },
    })
  })

  test("null when the server is absent", () => {
    expect(
      scopeMcpServer({ mcpServers: { convex: {} } }, "next-devtools"),
    ).toBeNull()
    expect(scopeMcpServer({}, "next-devtools")).toBeNull()
  })
})

describe("writeScopedNextDevtoolsConfig", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-mcp-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("writes a scoped config from the project .mcp.json", () => {
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "next-devtools": {
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
          },
          sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
        },
      }),
    )
    const out = join(repo, "build", "feat", ".build", "e2e.mcp.json")
    const path = writeScopedNextDevtoolsConfig(repo, out)
    expect(path).toBe(out)
    const written = JSON.parse(readFileSync(out, "utf-8"))
    expect(Object.keys(written.mcpServers)).toEqual(["next-devtools"])
  })

  test("null when there's no .mcp.json", () => {
    expect(
      writeScopedNextDevtoolsConfig(repo, join(repo, "out.json")),
    ).toBeNull()
  })

  test("null when .mcp.json lacks next-devtools", () => {
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { sentry: {} } }),
    )
    expect(
      writeScopedNextDevtoolsConfig(repo, join(repo, "out.json")),
    ).toBeNull()
  })
})
