import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ticketsSchema } from '../../config/schema'
import { FileTicketSource } from './file'
import { moveTicketToRole } from './operations'

const roles = ticketsSchema.parse({
  source: 'file',
  readyState: 'ready',
  triageState: 'triage',
  backlogState: 'Icebox',
  rejectedState: 'rejected',
})
const bare = ticketsSchema.parse({ source: 'file', readyState: 'ready', triageState: 'triage' })

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
    expect((await moveTicketToRole(source, fileRoles, ticket.ref.id, 'ready')).state).toBe('ready')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
