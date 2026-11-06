import { expect, test } from 'bun:test'
import { ticketsSchema } from '../../config/schema'
import { holdsState, ticketLifecycle } from './lifecycle'

test('hosted normalizes ready and defaults all lifecycle roles without rewriting spelling', () => {
  const tickets = ticketsSchema.parse({ source: 'hosted', teamKey: 'ENG' })
  expect(ticketLifecycle(tickets)).toEqual({
    triage: 'triage',
    ready: 'ready',
    doing: 'doing',
    done: 'done',
    create: 'triage',
    proposal: 'triage',
  })
  expect(
    ticketLifecycle({
      ...tickets,
      triageState: 'Inbox',
      claimedState: 'Active',
      doneState: 'Shipped',
    }),
  ).toEqual({
    triage: 'Inbox',
    ready: 'ready',
    doing: 'Active',
    done: 'Shipped',
    create: 'Inbox',
    proposal: 'Inbox',
  })
  expect(ticketLifecycle(tickets, true)).toEqual({
    triage: 'Backlog',
    ready: 'ready',
    doing: 'Doing',
    done: 'Done',
    create: 'Backlog',
    proposal: 'Backlog',
  })
  expect(() => ticketsSchema.parse({ source: 'file' })).toThrow('readyState')
  expect(() => ticketsSchema.parse({ source: 'linear', teamKey: 'ENG' })).toThrow('readyState')
})

test('ticket URL validation is hosted specific and uses the service URL rules', () => {
  expect(ticketsSchema.parse({ source: 'hosted', url: 'https://SERVICE.test/base/' }).url).toBe(
    'https://service.test/base',
  )
  for (const url of [
    'http://service.test',
    'https://user:pass@service.test',
    'https://service.test/?secret=x',
    'https://service.test/#x',
  ])
    expect(() => ticketsSchema.parse({ source: 'hosted', url })).toThrow('tickets.url')
  expect(() =>
    ticketsSchema.parse({ source: 'file', readyState: 'ready', url: 'https://service.test' }),
  ).toThrow('hosted')
})

test('backlog and rejected are optional roles with no default', () => {
  for (const source of [
    { source: 'file', readyState: 'ready' },
    { source: 'linear', teamKey: 'ENG', readyState: 'Todo' },
    { source: 'hosted', teamKey: 'ENG' },
  ]) {
    const names = ticketLifecycle(ticketsSchema.parse(source))
    expect(names.backlog).toBeUndefined()
    expect(names.rejected).toBeUndefined()
  }
  const names = ticketLifecycle(
    ticketsSchema.parse({
      source: 'linear',
      teamKey: 'ENG',
      readyState: 'Todo',
      triageState: 'Triage',
      backlogState: 'Icebox',
      rejectedState: 'Canceled',
    }),
  )
  expect(names).toMatchObject({ backlog: 'Icebox', rejected: 'Canceled', triage: 'Triage' })
})

test('holdsState matches case-insensitively and never matches an unset role', () => {
  expect(holdsState('Rejected', 'rejected')).toBe(true)
  expect(holdsState(' backlog ', 'Backlog')).toBe(true)
  expect(holdsState('backlog', undefined)).toBe(false)
  expect(holdsState(undefined, 'backlog')).toBe(false)
  expect(holdsState('icebox', 'backlog')).toBe(false)
})

test('backlog and rejected may not share a state with a dispatcher role or each other', () => {
  const refusal = (tickets: Record<string, unknown>) => {
    const parsed = ticketsSchema.safeParse(tickets)
    expect(parsed.success).toBe(false)
    return parsed.error!.issues.map((issue) => issue.message).join('\n')
  }
  const file = { source: 'file', readyState: 'ready' }
  expect(refusal({ ...file, backlogState: 'Ready' })).toContain(
    '[tickets].backlogState "Ready" names the same state as the ready role ([tickets].readyState resolves to "ready"); the backlog and ready roles must name different states',
  )
  // The file source's claimed directory is doing, matched case-insensitively.
  expect(refusal({ ...file, rejectedState: 'Doing' })).toContain(
    'the rejected and claimed roles must name different states',
  )
  expect(refusal({ ...file, rejectedState: 'done' })).toContain('rejected and done roles')
  expect(refusal({ ...file, backlogState: 'triage' })).toContain('backlog and triage roles')
  expect(refusal({ ...file, backlogState: 'proposals', proposalState: 'proposals' })).toContain(
    'backlog and proposal roles',
  )
  expect(refusal({ ...file, backlogState: 'parked', rejectedState: 'Parked' })).toContain(
    'the backlog and rejected roles must name different states',
  )
  // The file source ignores claimedState and doneState overrides: it always
  // claims into doing and completes into Done, so those stay refused.
  const overridden = { ...file, claimedState: 'building', doneState: 'completed' }
  expect(refusal({ ...overridden, rejectedState: 'doing' })).toContain(
    '([tickets].claimedState resolves to "doing"); the rejected and claimed roles',
  )
  expect(refusal({ ...overridden, backlogState: 'done' })).toContain(
    '([tickets].doneState resolves to "Done"); the backlog and done roles',
  )
  expect(refusal({ ...overridden, backlogState: 'completed' })).toContain(
    'the backlog and done roles must name different states',
  )
  // Linear's default triage state is Backlog, so the overlap names both keys.
  expect(
    refusal({ source: 'linear', teamKey: 'ENG', readyState: 'Todo', backlogState: 'Backlog' }),
  ).toContain('([tickets].triageState resolves to "Backlog")')
  expect(
    ticketsSchema.safeParse({ ...file, backlogState: 'backlog', rejectedState: 'rejected' })
      .success,
  ).toBe(true)
  // createState is a human placement, not a dispatcher target, so it may overlap.
  expect(
    ticketsSchema.safeParse({ ...file, backlogState: 'backlog', createState: 'backlog' }).success,
  ).toBe(true)
})

test('github defaults to lowercase lifecycle names, each overridable', () => {
  const tickets = ticketsSchema.parse({ source: 'github' })
  expect(ticketLifecycle(tickets)).toEqual({
    triage: 'triage',
    ready: 'ready',
    doing: 'doing',
    done: 'done',
    create: 'triage',
    proposal: 'triage',
  })
  // The legacy hosted spelling never applies to github.
  expect(ticketLifecycle(tickets, true).triage).toBe('triage')
  expect(
    ticketLifecycle(
      ticketsSchema.parse({
        source: 'github',
        readyState: 'queued',
        claimedState: 'building',
        triageState: 'inbox',
        doneState: 'shipped',
        backlogState: 'backlog',
        rejectedState: 'rejected',
      }),
    ),
  ).toEqual({
    triage: 'inbox',
    ready: 'queued',
    doing: 'building',
    done: 'shipped',
    create: 'inbox',
    proposal: 'inbox',
    backlog: 'backlog',
    rejected: 'rejected',
  })
})
