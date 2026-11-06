import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketSource } from '../types'
import { FakeTicketSource } from './fake'
import { FileTicketSource } from './file'
import { compatibleTicketSource, projectTicketTree, validateTicketTree } from './tree'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

for (const adapter of ['file', 'fake'] as const) {
  describe(`${adapter} integration tree`, () => {
    async function source(): Promise<TicketSource> {
      if (adapter === 'fake') return new FakeTicketSource()
      const dir = await mkdtemp(join(tmpdir(), 'ticket-tree-'))
      directories.push(dir)
      return new FileTicketSource({ dir })
    }
    test('legacy defaults, nested round trips, clear and metadata revisions', async () => {
      const s = await source()
      const root = await s.create({ title: 'Root node', body: 'spec', kind: 'node' })
      const nested = await s.create({
        title: 'Nested',
        body: 'spec',
        kind: 'node',
        target: root.ref.id,
      })
      const work = await s.create({ title: 'Work', body: 'spec' })
      expect(work.kind).toBe('work')
      expect(work.target).toBeUndefined()
      await s.mutateIfRevision!(work.ref.id, work.revision, {
        kind: 'update',
        patch: { target: nested.ref.id },
      })
      const assigned = (await s.get(work.ref.id))!
      expect(assigned.target).toBe(nested.ref.id)
      expect(assigned.revision).not.toBe(work.revision)
      await expect(
        s.mutateIfRevision!(work.ref.id, work.revision, {
          kind: 'update',
          patch: { title: 'Lost', target: null },
        }),
      ).rejects.toThrow('changed')
      expect((await s.get(work.ref.id))!.title).toBe('Work')
      await s.update(work.ref.id, { target: null })
      expect((await s.get(work.ref.id))!.revision).toBe(work.revision)
      await s.update(work.ref.id, { kind: 'node' })
      expect((await s.get(work.ref.id))!.revision).not.toBe(work.revision)
      await s.update(work.ref.id, { kind: 'work' })
      expect((await s.get(work.ref.id))!.revision).toBe(work.revision)
      const tree = projectTicketTree((await s.listAll!()).tickets, 'main')
      expect(tree.children.map((entry) => entry.ticket.ref.id)).toEqual([root.ref.id, work.ref.id])
      expect(tree.children[0]!.children[0]!.ticket.ref.id).toBe(nested.ref.id)
    })
    test('refuses cycles, missing/work targets and demotion atomically, even for done children', async () => {
      const s = await source()
      const a = await s.create({ title: 'A', body: 'spec', kind: 'node' })
      const b = await s.create({ title: 'B', body: 'spec', kind: 'node', target: a.ref.id })
      const c = await s.create({ title: 'C', body: 'spec', target: b.ref.id })
      await s.transition(c.ref.id, adapter === 'file' ? 'done' : 'Done')
      for (const [target, reason] of [
        [a.ref.id, 'cycle'],
        [b.ref.id, 'cycle'],
        [c.ref.id, 'not a node'],
        ['missing', 'does not exist'],
      ]) {
        await expect(s.update(a.ref.id, { target, title: 'Bad' })).rejects.toThrow(reason)
        expect((await s.get(a.ref.id))!.title).toBe('A')
      }
      await expect(s.update(a.ref.id, { kind: 'work', title: 'Bad' })).rejects.toThrow('targets it')
      await expect(s.update(b.ref.id, { kind: 'work' })).rejects.toThrow('targets it')
      await s.update(c.ref.id, { target: null })
      await s.update(b.ref.id, { kind: 'work' })
      expect((await s.get(b.ref.id))!.kind).toBe('work')
    })
  })
}

test('file external corrupt chains and tree orphans are explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-tree-'))
  directories.push(dir)
  const s = new FileTicketSource({ dir })
  const node = await s.create({ title: 'Node', body: 'spec', kind: 'node' })
  await writeFile(
    join(dir, 'triage', `${node.ref.id}.md`),
    `+++\nid = "${node.ref.id}"\ntitle = "Node"\nkind = "node"\ntarget = "${node.ref.id}"\n+++\nspec`,
  )
  await expect(s.create({ title: 'New', body: 'spec', target: node.ref.id })).rejects.toThrow(
    'cyclic ancestor',
  )
  const tickets = (await s.listAll()).tickets
  expect(() => projectTicketTree(tickets, 'main')).toThrow('cyclic')
  expect(() => projectTicketTree([{ ...tickets[0]!, target: 'absent' }], 'main')).toThrow('orphan')
})

test('canonical aliases and foreign refs are validated', async () => {
  const s = new FakeTicketSource()
  const a = await s.create({ title: 'A', body: 'spec', kind: 'node' })
  const get = s.get.bind(s)
  s.get = (id) => get(id === 'alias' ? a.ref.id : id)
  await expect(validateTicketTree(s, a.ref.id, { target: 'alias' })).rejects.toThrow('cycle')
  s.get = async () => ({ ...a, ref: { ...a.ref, source: 'foreign' } })
  await expect(validateTicketTree(s, undefined, { target: 'alias' })).rejects.toThrow(
    'different source',
  )
})

test.each([false, true])(
  'legacy plugin compatibility (frozen=%s) preserves receivers and refuses metadata',
  async (frozen) => {
    const fake = new FakeTicketSource()
    const ticket = await fake.create({ title: 'Old', body: 'spec' })
    const legacy: TicketSource = {
      name: fake.name,
      async get() {
        expect(this).toBe(legacy)
        const { kind: _kind, target: _target, ...rest } = ticket
        return rest
      },
      async listReady() {
        expect(this).toBe(legacy)
        return { tickets: [ticket], diagnostics: [] }
      },
      async listPage() {
        expect(this).toBe(legacy)
        return { tickets: [ticket], diagnostics: ['page'], total: 10 }
      },
      async listStates() {
        expect(this).toBe(legacy)
        return [{ name: 'Triage', tickets: 1 }]
      },
      create: fake.create.bind(fake),
      update: fake.update.bind(fake),
      claim: fake.claim.bind(fake),
      comment: fake.comment.bind(fake),
      transition: fake.transition.bind(fake),
      addBlocker: fake.addBlocker.bind(fake),
      removeBlocker: fake.removeBlocker.bind(fake),
      dependencyStates: fake.dependencyStates.bind(fake),
      mutateIfRevision: fake.mutateIfRevision.bind(fake),
    }
    const source = compatibleTicketSource(frozen ? Object.freeze(legacy) : legacy)
    expect(await source.listReady({})).toMatchObject({ tickets: [{ kind: 'work' }] })
    expect(await source.listPage!({}, { limit: 1 })).toMatchObject({
      tickets: [{ kind: 'work' }],
      diagnostics: ['page'],
      total: 10,
    })
    expect(await source.listStates!()).toEqual([{ name: 'Triage', tickets: 1 }])
    expect((await source.get(ticket.ref.id))!.kind).toBe('work')
    for (const patch of [
      { kind: 'work' as const },
      { target: null },
      { title: 'Lost', target: null },
    ]) {
      await expect(source.update(ticket.ref.id, patch)).rejects.toThrow('integrationTree')
      await expect(
        source.mutateIfRevision!(ticket.ref.id, ticket.revision, { kind: 'update', patch }),
      ).rejects.toThrow('integrationTree')
      await expect(source.create({ title: 'Lost', body: 'spec', ...patch })).rejects.toThrow(
        'integrationTree',
      )
    }
    expect(fake.updates).toHaveLength(0)
    await source.update(ticket.ref.id, { title: 'New' })
    expect((await fake.get(ticket.ref.id))!.title).toBe('New')
  },
)

test('tree-capable native page normalization retains node targets and metadata', async () => {
  const fake = new FakeTicketSource()
  const node = await fake.create({ title: 'node', body: 'body', kind: 'node' })
  const source = Object.assign(fake, {
    integrationTree: true as const,
    async listPage() {
      expect(this as unknown).toBe(fake)
      return {
        tickets: [{ ...node, kind: 'node' as const, target: 'AUT-99' }],
        diagnostics: ['kept'],
        total: 5,
      }
    },
  })
  expect(await compatibleTicketSource(source).listPage!({}, { limit: 1 })).toMatchObject({
    tickets: [{ kind: 'node', target: 'AUT-99' }],
    diagnostics: ['kept'],
    total: 5,
  })
})
