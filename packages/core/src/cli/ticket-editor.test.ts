import { describe, expect, test } from 'bun:test'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FakeTicketSource } from '../ports/tickets/fake'
import { tmpdir } from 'node:os'
import { editTicket, runTicketEditor } from './ticket-editor'

async function fixture() {
  const source = new FakeTicketSource()
  const ticket = await source.create({ title: 'Original', body: '# Body\n', labels: ['one'] })
  return { source, ticket, id: ticket.ref.id }
}

describe('ticket editor', () => {
  test('VISUAL command with arguments wins and only changed editable fields are saved', async () => {
    const { source, id } = await fixture()
    await editTicket(
      source,
      id,
      { VISUAL: 'editor --wait', EDITOR: 'other' },
      () => {},
      async (command, path) => {
        expect(command).toBe('editor --wait')
        await writeFile(
          path,
          (await readFile(path, 'utf8'))
            .replace('Original', 'Edited')
            .replace(/^labels = .+$/m, 'labels = []'),
        )
        return 0
      },
    )
    expect((await source.get(id))?.title).toBe('Edited')
    expect((await source.get(id))?.labels).toEqual([])
    expect((await source.get(id))?.body).toBe('# Body\n')
    expect(source.updates).toHaveLength(1)
    expect(source.updates[0]?.patch.body).toBeUndefined()
  })

  test.each(['unchanged', 'formatting'])('%s buffer writes nothing', async (kind) => {
    const { source, id } = await fixture()
    await editTicket(
      source,
      id,
      { EDITOR: 'editor' },
      () => {},
      async (_, path) => {
        if (kind === 'formatting')
          await writeFile(path, (await readFile(path, 'utf8')).replace('title = ', 'title  = '))
        return 0
      },
    )
    expect(source.updates).toHaveLength(0)
  })

  test.each([
    'conflict',
    'syntax',
    'reference',
    'unknown',
    'blank',
    'body',
    'id',
    'blockers',
    'creationKey',
    'editor',
  ])('%s preserves the buffer', async (kind) => {
    const { source, id } = await fixture()
    let saved = ''
    try {
      await expect(
        editTicket(
          source,
          id,
          { EDITOR: 'editor' },
          () => {},
          async (_, path) => {
            saved = path
            let raw = (await readFile(path, 'utf8')).replace('Original', 'Typed text')
            if (kind === 'conflict') await source.update(id, { body: 'Other writer' })
            if (kind === 'syntax') raw = 'invalid TOML buffer'
            if (kind === 'reference') raw = raw.replace('# revision = ', '# changed = ')
            if (kind === 'unknown') raw = raw.replace('title = ', 'unknown = ')
            if (kind === 'blank') raw = raw.replace('Typed text', '')
            if (kind === 'body') raw = raw.replace('# Body\n', '')
            if (kind === 'id') raw = raw.replace(`id = "${id}"`, 'id = "other"')
            if (kind === 'blockers')
              raw = raw.replace('title = ', 'blockedBy = ["other"]\ntitle = ')
            if (kind === 'creationKey')
              raw = raw.replace('title = ', 'idempotencyKey = "other"\ntitle = ')
            await writeFile(path, raw)
            return kind === 'editor' ? 1 : 0
          },
        ),
      ).rejects.toThrow('edited text kept at /')
      expect(await readFile(saved, 'utf8')).toBeTruthy()
      expect((await source.get(id))?.title).toBe('Original')
    } finally {
      if (saved) await rm(dirname(saved), { recursive: true, force: true })
    }
  })

  test('missing editor and unsupported sources refuse before opening', async () => {
    const { source, id } = await fixture()
    await expect(editTicket(source, id, {}, () => {})).rejects.toThrow('VISUAL or EDITOR')
    Object.defineProperty(source, 'mutateIfRevision', { value: undefined })
    await expect(editTicket(source, id, { EDITOR: 'editor' }, () => {})).rejects.toThrow(
      'does not support',
    )
  })
})

test('editor commands safely quote generated paths with spaces and apostrophes', async () => {
  const dir = await mkdtemp(join(tmpdir(), "ab-editor's space-"))
  try {
    const path = join(dir, 'ticket.md')
    await writeFile(path, 'buffer')
    expect(await runTicketEditor('test -f', path)).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
