import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')
const spec = await readFile(join(DIST_ROOT, 'skills', 'spec', 'SKILL.md'), 'utf8')
const tickets = await readFile(join(DIST_ROOT, 'skills', 'tickets', 'SKILL.md'), 'utf8')
const installedTickets = await readFile(
  join(DIST_ROOT, '.agents', 'skills', 'ab-tickets', 'SKILL.md'),
  'utf8',
)
const pristineTickets = await readFile(
  join(DIST_ROOT, '.agents', 'skills', '.ab-pristine', 'ab-tickets', 'SKILL.md'),
  'utf8',
)
const ticketGuides = [tickets, installedTickets] as const

describe('ticket grooming skill guidance', () => {
  test('spec syncs an accepted body and dependencies through exact CLI forms', () => {
    expect(spec).toContain('ab ticket update <ticket> --body spec.md')
    expect(spec).toContain('ab ticket block <ticket> <blocker-id>')
    expect(spec).toContain('ab ticket unblock <ticket> <blocker-id>')
    expect(spec).toContain('Omitted metadata is preserved')
    expect(spec).not.toContain("Changing* an existing ticket's dependencies is not available")
  })

  test('tickets keeps file lifecycle transitions local but blocker edits source-agnostic', () => {
    for (const guide of ticketGuides) {
      expect(guide).toContain('mv .autobuild/tickets/triage/file-3.md')
      expect(guide).toContain('ab ticket update file-3 --body spec.md')
      expect(guide).toContain('ab ticket block file-3 file-1')
      expect(guide).toContain('ab ticket unblock file-3 file-1')
      expect(guide).toContain('source-agnostic `ab ticket block`')
      expect(guide).toContain('are file-tracker-only')
      expect(guide).toContain('[tickets] source = "linear"')
      expect(guide).toContain('do not apply that lifecycle')
      expect(guide).toContain('optional `labels` and `blockedBy`')
      expect(guide).not.toContain('there is no API')
    }
  })

  test('tickets distinguishes the ready lifecycle gate from dependency eligibility', () => {
    for (const guide of ticketGuides) {
      expect(guide).toContain("satisfies the local file tracker's")
      expect(guide).toContain('lifecycle-state gate')
      expect(guide).toContain('An unresolved `blockedBy` dependency prevents')
      expect(guide).toContain("ticket's state, labels, and spec otherwise qualify")
      expect(guide).toContain('unclaimed and without a build')
      expect(guide).toContain('once every declared blocker has either reached')
      expect(guide).toContain('completed state (`done/` for the file tracker)')
      expect(guide).toContain('re-evaluates the dependent on a later tick')
      expect(guide).toContain('another move to `ready/`')
      expect(guide).toContain('remaining dispatch gates and available')
      expect(guide).not.toContain('the *entire* act of dispatching it')
      expect(guide).not.toContain('`ready/` alone decides dispatchability')
    }
  })

  test('checked-in live and pristine ticket skills match the canonical install form', () => {
    const expectedInstalled = tickets.replace('\nname: tickets\n', '\nname: ab-tickets\n')
    expect(expectedInstalled).not.toBe(tickets)
    expect(installedTickets).toBe(expectedInstalled)
    expect(pristineTickets).toBe(expectedInstalled)
  })
})
