import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manualClock } from '../../testing/fixed'
import { FileTicketSource } from './file'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ab-file-tickets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function source(opts: Partial<ConstructorParameters<typeof FileTicketSource>[0]> = {}) {
  return new FileTicketSource({
    dir,
    clock: manualClock('2026-07-15T12:00:00.000Z'),
    ...opts,
  })
}

const SPEC_BODY = [
  '# Rate-limit auth endpoints',
  '',
  '## What',
  'Add a token bucket to /auth/*.',
  '',
  '## Acceptance criteria',
  '- 429 after N attempts',
  '',
].join('\n')

async function seedTicket(
  id: string,
  over: { state?: string; labels?: string[]; body?: string; claimedBy?: string } = {},
): Promise<string> {
  const labels = (over.labels ?? []).map((l) => JSON.stringify(l)).join(', ')
  const lines = [
    '+++',
    `id = ${JSON.stringify(id)}`,
    `title = "Ticket ${id}"`,
    `state = ${JSON.stringify(over.state ?? 'Ready')}`,
    `labels = [ ${labels} ]`,
  ]
  if (over.claimedBy !== undefined) lines.push(`claimedBy = ${JSON.stringify(over.claimedBy)}`)
  lines.push('+++')
  const content = `${lines.join('\n')}\n${over.body ?? SPEC_BODY}`
  await writeFile(join(dir, `${id}.md`), content)
  return content
}

describe('FileTicketSource', () => {
  test('full CRUD round-trip: create → get → listReady → claim → transition → comment', async () => {
    const tickets = source({ claimant: 'dispatcher-a', createState: 'Ready' })

    const created = await tickets.create({
      title: 'Rate-limit auth',
      body: SPEC_BODY,
      labels: ['autobuild'],
    })
    expect(created.ref).toEqual({ source: 'file', id: 'file-1', title: 'Rate-limit auth' })
    expect(created.state).toBe('Ready')

    const got = await tickets.get('file-1')
    expect(got).toEqual(created)

    expect(
      (await tickets.listReady({ labels: ['autobuild'], state: 'Ready' })).map(
        (t) => t.ref.id,
      ),
    ).toEqual(['file-1'])

    expect(await tickets.claim('file-1')).toBe(true)

    await tickets.transition('file-1', 'In Progress')
    expect((await tickets.get('file-1'))?.state).toBe('In Progress')

    await tickets.comment('file-1', 'Build started.')
    const after = await tickets.get('file-1')
    expect(after?.body).toContain('## Comment (2026-07-15T12:00:00.000Z)')
    expect(after?.body).toContain('Build started.')
  })

  test('the spec in the body survives a comment append byte-exactly (§6.3, §13)', async () => {
    await seedTicket('file-1', { body: SPEC_BODY })
    const tickets = source()

    const before = await readFile(join(dir, 'file-1.md'), 'utf8')
    await tickets.comment('file-1', 'Spec imported as rev 0.')
    const after = await readFile(join(dir, 'file-1.md'), 'utf8')

    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(
      '\n## Comment (2026-07-15T12:00:00.000Z)\n\nSpec imported as rev 0.\n',
    )
    expect((await tickets.get('file-1'))?.body).toBe(
      `${SPEC_BODY}\n## Comment (2026-07-15T12:00:00.000Z)\n\nSpec imported as rev 0.\n`,
    )
  })

  test('two comments stack below the spec, each stamped by the injected clock', async () => {
    await seedTicket('file-1')
    const clock = manualClock('2026-07-15T12:00:00.000Z')
    const tickets = source({ clock })

    await tickets.comment('file-1', 'first')
    clock.advance(60_000)
    await tickets.comment('file-1', 'second')

    const body = (await tickets.get('file-1'))?.body ?? ''
    const firstAt = body.indexOf('## Comment (2026-07-15T12:00:00.000Z)')
    const secondAt = body.indexOf('## Comment (2026-07-15T12:01:00.000Z)')
    expect(firstAt).toBeGreaterThan(-1)
    expect(secondAt).toBeGreaterThan(firstAt)
    expect(body.startsWith(SPEC_BODY)).toBe(true)
  })

  test('claim writes claimedBy; a second claim returns false', async () => {
    await seedTicket('file-1')
    const tickets = source({ claimant: 'dispatcher-a' })

    expect(await tickets.claim('file-1')).toBe(true)
    const raw = await readFile(join(dir, 'file-1.md'), 'utf8')
    expect(raw).toContain('claimedBy = "dispatcher-a"')

    expect(await tickets.claim('file-1')).toBe(false)
    expect(await source({ claimant: 'dispatcher-b' }).claim('file-1')).toBe(false)
  })

  test('claim preserves the body and returns false for unknown ids', async () => {
    await seedTicket('file-1', { body: SPEC_BODY })
    const tickets = source()

    expect(await tickets.claim('nope')).toBe(false)
    await tickets.claim('file-1')
    expect((await tickets.get('file-1'))?.body).toBe(SPEC_BODY)
  })

  test('transition rewrites state and preserves the body byte-exactly', async () => {
    await seedTicket('file-1', { state: 'Ready', body: SPEC_BODY })
    const tickets = source()

    await tickets.transition('file-1', 'Done')

    const after = await tickets.get('file-1')
    expect(after?.state).toBe('Done')
    expect(after?.body).toBe(SPEC_BODY)
  })

  test('listReady requires every requested label and matches state', async () => {
    await seedTicket('file-1', { state: 'Ready', labels: ['autobuild', 'bug'] })
    await seedTicket('file-2', { state: 'Ready', labels: ['autobuild'] })
    await seedTicket('file-3', { state: 'Triage', labels: ['autobuild', 'bug'] })
    const tickets = source()

    const ready = await tickets.listReady({ labels: ['autobuild', 'bug'], state: 'Ready' })
    expect(ready.map((t) => t.ref.id)).toEqual(['file-1'])
    expect((await tickets.listReady({}))).toHaveLength(3)
  })

  test('listReady on a directory that does not exist yet returns []', async () => {
    const tickets = new FileTicketSource({ dir: join(dir, 'missing') })
    expect(await tickets.listReady({})).toEqual([])
  })

  test('malformed TOML frontmatter throws an error naming the file', async () => {
    const path = join(dir, 'broken.md')
    await writeFile(path, '+++\nid = broken oops\n+++\nbody\n')
    const tickets = source()

    await expect(tickets.get('broken')).rejects.toThrow(path)
    await expect(tickets.listReady({})).rejects.toThrow(path)
  })

  test('missing fences and missing required fields also name the file', async () => {
    const noFence = join(dir, 'no-fence.md')
    await writeFile(noFence, '# just markdown\n')
    await expect(source().get('no-fence')).rejects.toThrow(noFence)

    const missingField = join(dir, 'missing-field.md')
    await writeFile(missingField, '+++\nid = "missing-field"\ntitle = "x"\n+++\nbody\n')
    await expect(source().get('missing-field')).rejects.toThrow(missingField)
  })

  test('a frontmatter id that disagrees with the filename is an error naming the file', async () => {
    const path = join(dir, 'file-1.md')
    await writeFile(path, '+++\nid = "file-9"\ntitle = "x"\nstate = "Ready"\nlabels = [ ]\n+++\nbody\n')
    await expect(source().get('file-1')).rejects.toThrow(path)
  })

  test('create allocates the next free n, skipping existing files', async () => {
    await seedTicket('file-1')
    await seedTicket('file-3')
    const tickets = source()

    const a = await tickets.create({ title: 'A', body: 'a' })
    expect(a.ref.id).toBe('file-2')

    const b = await tickets.create({ title: 'B', body: 'b' })
    expect(b.ref.id).toBe('file-4')
  })

  test('create defaults to Triage (§12) and round-trips labels and body', async () => {
    const tickets = source()
    const created = await tickets.create({
      title: 'Proposal',
      body: 'evidence…',
      labels: ['ingest:sentry'],
    })

    expect(created.state).toBe('Triage')
    const got = await tickets.get(created.ref.id)
    expect(got?.labels).toEqual(['ingest:sentry'])
    expect(got?.body).toBe('evidence…')
  })

  test('ids that escape the ticket directory are rejected', async () => {
    const tickets = source()
    await expect(tickets.get('../escape')).rejects.toThrow('invalid ticket id')
  })
})
