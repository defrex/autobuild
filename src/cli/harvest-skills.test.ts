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
  test('producer distinguishes automatic origins from other hard prerequisites', () => {
    const text = normalize(producer)
    expect(text).toContain('blocks a create on every unresolved, same-source originating ticket')
    expect(text).toContain('do not restate that automatic dependency in `blockedBy`')
    expect(text).toContain('some other ticket as a hard prerequisite')
    expect(text).toContain(
      'Contextual citations, related work, and nonbinding sequencing preferences',
    )
    expect(text).toContain('Never invent an id or turn every ticket mention into a dependency.')
  })

  test('reviewer enforces the shared automatic rule and other blocker metadata', () => {
    const text = normalize(reviewer)
    expect(text).toContain(
      'automatically blocks a create on unresolved, same-source originating tickets',
    )
    expect(text).toContain('must restate that originating dependency in `blockedBy`')
    expect(text).toContain('a prose-only hard prerequisite is not approvable')
    expect(text).toContain('every `blockedBy` id is justified by evidence as a hard start gate')
    expect(text).toContain('must not become blockers, and ticket ids are never invented')
  })
})
