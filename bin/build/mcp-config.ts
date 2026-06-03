/**
 * Scoped MCP config for the e2e step.
 *
 * The e2e builder only needs the `next-devtools` browser MCP. Rather than
 * inheriting the whole project `.mcp.json` (which boots convex with
 * `--cautiously-allow-production-pii`, sentry, linear, etc.), we extract just
 * the `next-devtools` server into a minimal config and run the builder with
 * `--mcp-config <scoped> --strict-mcp-config` so nothing else starts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type McpConfig = { mcpServers?: Record<string, unknown> }

/**
 * Extract a single named server into a minimal scoped config, or `null` if the
 * server isn't present. (pure)
 */
export function scopeMcpServer(
  config: McpConfig,
  name: string,
): McpConfig | null {
  const server = config.mcpServers?.[name]
  if (!server) return null
  return { mcpServers: { [name]: server } }
}

/**
 * Write a scoped config containing only the project's `next-devtools` server
 * (read from `<repoRoot>/.mcp.json`) to `outPath`. Returns the path, or `null`
 * if there's no `.mcp.json` or no `next-devtools` entry to scope.
 */
export function writeScopedNextDevtoolsConfig(
  repoRoot: string,
  outPath: string,
): string | null {
  const mcpPath = join(repoRoot, ".mcp.json")
  if (!existsSync(mcpPath)) return null
  const scoped = scopeMcpServer(
    JSON.parse(readFileSync(mcpPath, "utf-8")) as McpConfig,
    "next-devtools",
  )
  if (!scoped) return null
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(scoped, null, 2)}\n`)
  return outPath
}
