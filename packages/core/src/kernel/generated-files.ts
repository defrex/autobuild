import { compilePathSelectors } from '../config/path-selectors'
import type { GeneratedEntry } from '../config/schema'

/** One declared command and the conflicted files it owns. */
export interface GeneratedGroup {
  command: string
  files: string[]
}

export interface GeneratedClassification {
  /** Declaration order; one command runs once per group. */
  groups: GeneratedGroup[]
  /** Conflicted paths no declaration owns. */
  other: string[]
}

/**
 * Sort conflicted paths into the `[[generated]]` entries that own them. The
 * first matching entry, in declaration order, owns a file, so overlapping
 * globs are legal and deterministic.
 */
export function classifyGenerated(
  files: readonly string[],
  declarations: readonly GeneratedEntry[],
): GeneratedClassification {
  const matchers = declarations.map((entry) => compilePathSelectors(entry.paths))
  const owned = declarations.map((): string[] => [])
  const other: string[] = []
  for (const file of files) {
    const owner = matchers.findIndex((matches) => matches(file))
    if (owner === -1) other.push(file)
    else owned[owner]!.push(file)
  }
  const groups = declarations.flatMap((entry, index) =>
    owned[index]!.length === 0 ? [] : [{ command: entry.command, files: owned[index]! }],
  )
  return { groups, other }
}

/** Every declared selector, for guarding and cleaning regeneration output. */
export function generatedSelectors(declarations: readonly GeneratedEntry[]): string[] {
  return [...new Set(declarations.flatMap((entry) => entry.paths))]
}
