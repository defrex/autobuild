import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

async function skill(path: string): Promise<string> {
  return await readFile(join(ROOT, path, 'SKILL.md'), 'utf8')
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ')
}

const producer = await skill('skills/harvest')
const reviewer = await skill('skills/harvest-review')

describe('harvest skills — blocker judgment', () => {
  test('producer requires metadata for hard prerequisites without broadening references', () => {
    const text = normalize(producer)
    expect(text).toContain('another ticket must complete before this work can start')
    expect(text).toContain("include that hard prerequisite's source-local ticket id in `blockedBy`")
    expect(text).toContain(
      'Contextual citations, related work, and nonbinding sequencing preferences',
    )
    expect(text).toContain('Never invent an id or turn every ticket mention into a dependency.')
  })

  test('reviewer enforces both missing and unjustified blocker metadata', () => {
    const text = normalize(reviewer)
    expect(text).toContain('a prose-only hard prerequisite is not approvable')
    expect(text).toContain('every `blockedBy` id is justified by evidence as a hard start gate')
    expect(text).toContain('must not become blockers, and ticket ids are never invented')
  })
})
