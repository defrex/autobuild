/** The deterministic, mechanically checkable core of docs/spec-standard.md. */
export interface SpecConformance {
  conforms: boolean
  missing: string[]
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/
const HEADING = /^(#{1,6})\s*(.+?)\s*$/

function sectionUnder(lines: string[], name: string): string[] | null {
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(HEADING)
    if (match?.[2]?.toLowerCase().startsWith(name)) {
      start = i + 1
      level = match[1]?.length ?? 0
      break
    }
  }
  if (start === -1) return null
  const section: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) break
    const heading = line.match(HEADING)
    if (heading !== null && (heading[1]?.length ?? 0) <= level) break
    section.push(line)
  }
  return section
}

export function specConformance(body: string): SpecConformance {
  const missing: string[] = []
  if (body.trim().length === 0) missing.push('a nonempty spec body')
  const lines = body.split('\n')
  const criteria = sectionUnder(lines, 'acceptance criteria')
  if (criteria === null) {
    missing.push("an '## Acceptance criteria' heading")
  } else if (!criteria.some((line) => LIST_ITEM.test(line))) {
    missing.push("at least one list item under '## Acceptance criteria'")
  }
  if (sectionUnder(lines, 'out of scope') === null) {
    missing.push("an '## Out of scope' heading")
  }
  return { conforms: missing.length === 0, missing }
}
