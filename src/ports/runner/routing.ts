/**
 * Role → runner/model routing (SPEC §9, §16.1 [roles]) — v1's harnessMap,
 * generalized. Mixing models across roles is intentional: a different
 * reviewer catches more. `roles` comes from autobuild.toml; `registry` maps
 * runner names to constructed adapters.
 */
import type { AgentRunner } from '../types'

export function resolveRole(
  role: string,
  roles: Record<string, { runner: string; model?: string }>,
  registry: Record<string, AgentRunner>,
  fallback: string,
): { runner: AgentRunner; model?: string } {
  const entry = roles[role]
  const runnerName = entry?.runner ?? fallback
  const runner = registry[runnerName]
  if (!runner) {
    throw new Error(
      `role "${role}" routes to runner "${runnerName}", which is not registered ` +
        `(registered runners: ${Object.keys(registry).join(', ') || 'none'})`,
    )
  }
  return {
    runner,
    ...(entry?.model !== undefined ? { model: entry.model } : {}),
  }
}
