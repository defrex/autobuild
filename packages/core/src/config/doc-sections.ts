/**
 * Shared doc-parsing helpers for the configuration-reference drift guards
 * (AUT-505). Pure functions with no module-level doc state, so both core's
 * `configuration-doc.test.ts` and the plugin packages' doc-coverage tests can
 * import one copy — via the `@defrex/autobuild/testing` barrel out of tree.
 */
import { expect } from 'bun:test'

export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact heading contents, up to the next heading at the same or higher level. */
export function headingSection(
  markdown: string,
  level: number,
  heading: string,
): string | undefined {
  const marker = `${'#'.repeat(level)} ${heading}`
  const lines = markdown.split('\n')
  const boundary = new RegExp(`^#{1,${level}} `)
  let fenced = false
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!fenced && line === marker) {
      start = index
      break
    }
  }
  if (start === -1) return undefined

  fenced = false
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.startsWith('```')) {
      fenced = !fenced
    } else if (!fenced && boundary.test(line)) {
      break
    }
    end += 1
  }
  return lines.slice(start + 1, end).join('\n')
}

export function expectRows(
  location: string,
  section: string | undefined,
  fields: readonly string[],
): void {
  expect(section, `${location} section is missing`).toBeDefined()
  const missing = fields.filter(
    (field) => !new RegExp(`^\\| \`${escapeRegex(field)}\` \\|`, 'm').test(section ?? ''),
  )
  expect(
    missing,
    `${location} is missing structural field rows for: ${missing.join(', ')}`,
  ).toEqual([])
}
