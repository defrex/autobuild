/**
 * The turn approval list (AUT-342): which registry tool calls suspend a turn
 * until the operator answers. Configured as `[orchestrator].approvals` — a
 * list of registry tool names, optionally qualified by the accepted value of
 * the tool's discriminator field (`tool:qualifier`).
 *
 * Semantics:
 * - A bare entry (`builds.control`) suspends every call to that tool.
 * - A qualified entry (`tickets.move:ready`) suspends only calls whose
 *   discriminator equals the qualifier; other values of the same tool run
 *   without pause.
 * - An entry naming an absent or unknown tool is inert by design, never an
 *   error — the default list is stable while the registry grows.
 * - A qualified entry for a tool without a declared discriminator never
 *   matches (there is nothing to compare).
 *
 * Nothing here encodes this repository's specifics.
 */
import type { ToolApprovalStatus } from 'ai'

/** A per-tool approval configuration value: a static status or a function
 * deciding from the call's input. (The SDK's per-tool map accepts both.) */
export type ApprovalDecision = ToolApprovalStatus | ((input: unknown) => ToolApprovalStatus)

/** The registry tools' discriminator fields, for qualified entries. A tool
 * absent from this map has no discriminator; only bare entries match it. */
const DISCRIMINATOR_FIELDS: Record<string, string> = {
  'builds.control': 'action',
  'builds.answer': 'resolution',
  'tickets.move': 'state',
}

export interface ParsedApprovalEntry {
  tool: string
  qualifier?: string
}

/** Parse one configured entry into its tool and optional qualifier. The
 * config schema already enforces the entry shape syntactically. */
export function parseApprovalEntry(entry: string): ParsedApprovalEntry {
  const separator = entry.indexOf(':')
  if (separator === -1) return { tool: entry }
  return { tool: entry.slice(0, separator), qualifier: entry.slice(separator + 1) }
}

/** Parse the whole configured list. Duplicate entries collapse harmlessly:
 * the resulting matcher is a predicate, not a table. */
export function parseApprovalEntries(entries: readonly string[]): ParsedApprovalEntry[] {
  return entries.map(parseApprovalEntry)
}

/**
 * The AI SDK `toolApproval` per-tool configuration for the parsed list: a
 * bare entry maps the whole tool to `user-approval`; a qualified entry maps
 * to a function that returns `user-approval` when the discriminator equals
 * one of the tool's configured qualifiers, else `not-applicable`. Tools with
 * no matching entry get no key at all — the SDK treats an absent key as
 * not-applicable.
 */
export function approvalConfiguration(
  entries: readonly ParsedApprovalEntry[],
): Record<string, ApprovalDecision> {
  const bare = new Set<string>()
  const qualified = new Map<string, Set<string>>()
  for (const entry of entries) {
    if (entry.qualifier === undefined) {
      bare.add(entry.tool)
      continue
    }
    if (bare.has(entry.tool)) continue
    const set = qualified.get(entry.tool) ?? new Set<string>()
    set.add(entry.qualifier)
    qualified.set(entry.tool, set)
  }
  const configuration: Record<string, ApprovalDecision> = {}
  for (const tool of bare) configuration[tool] = 'user-approval'
  for (const [tool, qualifiers] of qualified) {
    if (bare.has(tool)) continue
    const field = DISCRIMINATOR_FIELDS[tool]
    configuration[tool] = (input: unknown) => {
      // A qualified entry for a tool without a declared discriminator never
      // matches — there is nothing to compare.
      if (field === undefined) return 'not-applicable'
      const discriminator =
        typeof input === 'object' && input !== null
          ? (input as Record<string, unknown>)[field]
          : undefined
      return typeof discriminator === 'string' && qualifiers.has(discriminator)
        ? 'user-approval'
        : 'not-applicable'
    }
  }
  return configuration
}

/** Whether a specific call would be suspended — the mirror of
 * `approvalConfiguration` for tests and for the runner's own diagnostics. */
export function callNeedsApproval(
  entries: readonly ParsedApprovalEntry[],
  tool: string,
  input: unknown,
): boolean {
  for (const entry of entries) {
    if (entry.tool !== tool) continue
    if (entry.qualifier === undefined) return true
    const field = DISCRIMINATOR_FIELDS[tool]
    if (field === undefined) continue
    const discriminator =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)[field]
        : undefined
    if (discriminator === entry.qualifier) return true
  }
  return false
}
