import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')
const spec = await readFile(join(DIST_ROOT, 'skills', 'spec', 'SKILL.md'), 'utf8')
const tickets = await readFile(
  join(DIST_ROOT, 'skills', 'tickets', 'SKILL.md'),
  'utf8',
)

describe('ticket grooming skill guidance', () => {
  test('spec syncs an accepted body and dependencies through exact CLI forms', () => {
    expect(spec).toContain('ab ticket update <ticket> --body spec.md')
    expect(spec).toContain('ab ticket block <ticket> <blocker-id>')
    expect(spec).toContain('ab ticket unblock <ticket> <blocker-id>')
    expect(spec).toContain('Omitted metadata is preserved')
    expect(spec).not.toContain(
      "Changing* an existing ticket's dependencies is not available",
    )
  })

  test('tickets keeps mv as the state UI but routes editable fields and blockers through ab', () => {
    expect(tickets).toContain('mv .autobuild/tickets/triage/file-3.md')
    expect(tickets).toContain('ab ticket update file-3 --body spec.md')
    expect(tickets).toContain('ab ticket block file-3 file-1')
    expect(tickets).toContain('ab ticket unblock file-3 file-1')
    expect(tickets).toContain('optional `labels` and `blockedBy`')
    expect(tickets).not.toContain('there is no API')
  })
})
