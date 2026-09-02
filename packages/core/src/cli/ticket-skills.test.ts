import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const spec = await readFile(join(DIST_ROOT, 'skills', 'spec', 'SKILL.md'), 'utf8')
const tickets = await readFile(join(DIST_ROOT, 'skills', 'tickets', 'SKILL.md'), 'utf8')
const ticketGuides = [tickets] as const
const body = (source: string) => source.replace(/^---\n[\s\S]*?\n---\n/, '')

describe('ticket grooming skill guidance', () => {
  test('spec syncs an accepted body and dependencies through exact CLI forms', () => {
    expect(spec).toContain('ab ticket update <ticket> --body spec.md')
    expect(spec).toContain('ab ticket block <ticket> <blocker-id>')
    expect(spec).toContain('ab ticket unblock <ticket> <blocker-id>')
    expect(spec).toContain('Omitted metadata is preserved')
    expect(spec).not.toContain("Changing* an existing ticket's dependencies is not available")
  })

  test('spec builds dependency chains from JSON ids instead of prose', () => {
    expect(spec).toContain('ab ticket create "A" --body a.md --json')
    expect(spec).toContain("jq -r '.ref.id' a-ticket.json")
    expect(spec).toContain('ab ticket create "B" --body b.md --blocked-by "$a_id" --json')
    expect(spec).toContain("jq -r '.ref.id' b-ticket.json")
    expect(spec).toContain('ab ticket create "C" --body c.md --blocked-by "$b_id" --json')
    expect(spec).toContain('Never parse an id from the human-readable confirmation line')
    expect(spec).toContain(
      'adding a blocker\nafter a ticket has already been claimed does not stop its active build',
    )
  })

  test('canonical spec guidance matches live and pristine installed copies', async () => {
    for (const path of [
      join(DIST_ROOT, '.agents', 'skills', 'ab-spec', 'SKILL.md'),
      join(DIST_ROOT, '.agents', 'skills', '.ab-pristine', 'ab-spec', 'SKILL.md'),
    ]) {
      expect(body(await readFile(path, 'utf8'))).toBe(body(spec))
    }
  })

  test('spec honors stated create placement without asking or inferring it', () => {
    expect(spec).toContain('ab ticket create "…" --body spec.md --state "<state>"')
    expect(spec).toContain('Do not ask a placement question solely to obtain a state')
    expect(spec).toContain('do not infer one\nfrom the ticket')
    expect(spec).toContain('If grooming named no destination, omit `--state`')
    expect(spec).toContain("uses `[tickets].createState`, or the ticket source's own default")
    expect(spec).toContain('explicitly named destination equals `[tickets].readyState`')
    expect(spec).toContain('may be claimed by the next\ndispatch')
    for (const gate of ['label', 'dependency', 'intake', 'capacity', 'readiness']) {
      expect(spec).toContain(gate)
    }
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
})
