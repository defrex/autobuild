import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../../config/load'
import { ticketsSchema } from '../../config/schema'
import { FakeTicketSource } from './fake'
import { FileTicketSource } from './file'
import {
  changeBlockers,
  createTicket,
  moveTicketToRole,
  ticketListCriteria,
  updateTicket,
} from './operations'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "Ready"
readyLabels = ["autobuild", "groomed"]
[verify]
steps = []
[finalize]
steps = []
`)

describe('shared ticket operations', () => {
  test('uses ready criteria only when filters are wholly absent', () => {
    expect(ticketListCriteria(config, {})).toEqual({
      state: 'Ready',
      labels: ['autobuild', 'groomed'],
    })
    expect(ticketListCriteria(config, { labels: [] })).toEqual({ labels: [] })
  })

  test('preflights and deduplicates blockers before create', async () => {
    const source = new FakeTicketSource()
    await expect(
      createTicket(source, { title: 'x', body: 'body', blockedBy: ['missing'] }),
    ).rejects.toThrow('missing')
    expect(await source.listReady({})).toMatchObject({ tickets: [] })
    const blocker = await createTicket(source, { title: 'blocker', body: 'body' })
    const created = await createTicket(source, {
      title: 'target',
      body: 'body',
      blockedBy: [blocker.ref.id, blocker.ref.id],
    })
    expect(created.blockedBy).toEqual([blocker.ref.id])
  })

  test('preserves body bytes and blocker retry semantics', async () => {
    const source = new FakeTicketSource()
    const blocker = await createTicket(source, { title: 'blocker', body: 'body' })
    const target = await createTicket(source, { title: 'target', body: 'old' })
    const body = 'a\r\nb  \nno-newline'
    expect((await updateTicket(source, target.ref.id, { body }))?.body).toBe(body)
    await changeBlockers(source, target.ref.id, [blocker.ref.id, blocker.ref.id], 'block')
    expect((await source.get(target.ref.id))?.blockedBy).toEqual([blocker.ref.id])
  })
})

test('guarded blockers are one adapter call and legacy plugins cannot silently drop checks', async () => {
  const source = new FakeTicketSource()
  const target = await source.create({ title: 'Target', body: 'Body' })
  const one = await source.create({ title: 'One', body: 'Body' })
  const two = await source.create({ title: 'Two', body: 'Body' })
  const original = source.mutateIfRevision.bind(source)
  const calls: unknown[] = []
  source.mutateIfRevision = async (...args) => {
    calls.push(args)
    await original(...args)
  }
  await changeBlockers(source, target.ref.id, [one.ref.id, two.ref.id], 'block', target.revision)
  expect(calls).toHaveLength(1)
  expect(source.blockerAdds).toHaveLength(0)
  Object.defineProperty(source, 'mutateIfRevision', { value: undefined })
  const before = await source.get(target.ref.id)
  await expect(
    changeBlockers(source, target.ref.id, [one.ref.id], 'unblock', before!.revision),
  ).rejects.toThrow('does not support')
  await expect(
    updateTicket(source, target.ref.id, { title: 'Lost' }, false, before!.revision),
  ).rejects.toThrow('does not support')
  expect(await source.get(target.ref.id)).toEqual(before)
})

describe('moving by role', () => {
  const roles = ticketsSchema.parse({
    source: 'file',
    readyState: 'ready',
    triageState: 'triage',
    backlogState: 'Icebox',
    rejectedState: 'rejected',
  })
  const bare = ticketsSchema.parse({ source: 'file', readyState: 'ready', triageState: 'triage' })

  test('each role resolves through the configured native names', async () => {
    const source = new FakeTicketSource()
    const ticket = await source.create({ title: 'T', body: 'b' })
    for (const [role, state] of [
      ['backlog', 'Icebox'],
      ['rejected', 'rejected'],
      ['ready', 'ready'],
      ['triage', 'triage'],
    ] as const) {
      expect((await moveTicketToRole(source, roles, ticket.ref.id, role)).state).toBe(state)
    }
  })

  test('an unconfigured role is refused naming its key, never a same-named state', async () => {
    const source = new FakeTicketSource()
    const ticket = await source.create({ title: 'T', body: 'b' })
    await source.transition(ticket.ref.id, 'triage')
    await expect(moveTicketToRole(source, bare, ticket.ref.id, 'backlog')).rejects.toThrow(
      'the backlog role is not configured for this repository; set [tickets].backlogState',
    )
    await expect(moveTicketToRole(source, bare, ticket.ref.id, 'rejected')).rejects.toThrow(
      '[tickets].rejectedState',
    )
    await expect(moveTicketToRole(source, bare, ticket.ref.id, 'doing')).rejects.toThrow(
      'unknown ticket role "doing"',
    )
    expect((await source.get(ticket.ref.id))?.state).toBe('triage')
  })

  test('the file source creates a role state on first use, and a custom backlog is not the role', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-role-move-'))
    try {
      const source = new FileTicketSource({ dir, createState: 'triage', doneState: 'done' })
      const ticket = await source.create({ title: 'T', body: 'b' })
      await source.addState('backlog')
      await expect(moveTicketToRole(source, bare, ticket.ref.id, 'backlog')).rejects.toThrow(
        'backlogState',
      )
      const fileRoles = { ...roles, backlogState: 'icebox' }
      const iced = await moveTicketToRole(source, fileRoles, ticket.ref.id, 'backlog')
      expect(iced.state).toBe('icebox')
      const rejected = await moveTicketToRole(source, fileRoles, ticket.ref.id, 'rejected')
      expect(rejected.state).toBe('rejected')
      expect(await readdir(dir)).toEqual(expect.arrayContaining(['backlog', 'icebox', 'rejected']))
      expect((await source.listStates()).find((s) => s.name === 'rejected')?.about).toBe(
        'Considered and declined; kept for the record',
      )
      expect((await moveTicketToRole(source, fileRoles, ticket.ref.id, 'ready')).state).toBe(
        'ready',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
