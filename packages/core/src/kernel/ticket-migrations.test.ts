import { expect, test } from 'bun:test'
import { ticketMigrationsReducer, resolveTicketRef } from './ticket-migrations'
import { validateRepositoryEventWrite, type RepositoryEvent } from '../events/repository'
import { projectRepositoryStateEvents } from '../store/repo-state-events'
const actor = { kind: 'human', user: 'operator' } as const
const fact = (
  identity: string,
  from: string,
  to: string,
  mapping: Record<string, string>,
): RepositoryEvent =>
  ({
    seq: 1,
    ts: new Date().toISOString(),
    repo: 'repo',
    actor,
    type: 'tickets.migration-recorded',
    payload: { identity, from, to, mapping },
  }) as RepositoryEvent

test('chained remaps preserve original refs and incremental replay', () => {
  const events = [
    fact('one', 'linear', 'file', { N: 'NODE', C: 'CHILD' }),
    fact('two', 'file', 'hosted', { NODE: 'AUT-1', CHILD: 'AUT-2' }),
  ]
  const original = { source: 'linear', id: 'N', title: 'Node' }
  const state = ticketMigrationsReducer.reduce(events)
  expect(resolveTicketRef(state, original, 'hosted', 'node')).toEqual({
    ...original,
    source: 'hosted',
    id: 'AUT-1',
  })
  expect(original.source).toBe('linear')
  const prefix = ticketMigrationsReducer.advance(
    ticketMigrationsReducer.initial(),
    events.slice(0, 1),
  )
  expect(
    ticketMigrationsReducer.finish(ticketMigrationsReducer.advance(prefix, events.slice(1))),
  ).toEqual(state)
  expect(resolveTicketRef(state, { source: 'file', id: 'NODE' }, 'file')).toEqual({
    source: 'file',
    id: 'NODE',
  })
})
test('missing routes and uncovered mappings name build and original id', () => {
  for (const events of [[], [fact('one', 'linear', 'file', { OTHER: 'OTHER' })]]) {
    expect(() =>
      resolveTicketRef(
        ticketMigrationsReducer.reduce(events),
        { source: 'linear', id: 'N' },
        'file',
        'node',
      ),
    ).toThrow('build node ticket linear:N')
    expect(() =>
      resolveTicketRef(
        ticketMigrationsReducer.reduce(events),
        { source: 'linear', id: 'N' },
        'file',
        'node',
      ),
    ).toThrow('ab ticket migration record')
  }
})
test('duplicates are idempotent; conflicting identities, mappings and cycles fail closed', () => {
  const first = fact('one', 'linear', 'file', { N: 'NODE' })
  expect(ticketMigrationsReducer.reduce([first, first]).migrations).toHaveLength(1)
  for (const next of [
    fact('one', 'linear', 'file', { N: 'OTHER' }),
    fact('two', 'linear', 'hosted', { N: 'AUT-1' }),
    fact('two', 'file', 'linear', { NODE: 'N' }),
  ])
    expect(() => ticketMigrationsReducer.reduce([first, next])).toThrow()
})
test('schema rejects malformed sources, empty IDs and duplicate destination IDs', () => {
  for (const payload of [
    { identity: 'x', from: 'linear:repo', to: 'file', mapping: {} },
    { identity: 'x', from: 'linear', to: 'file', mapping: { '': 'N' } },
    { identity: 'x', from: 'linear', to: 'file', mapping: { A: 'N', B: 'N' } },
  ])
    expect(() =>
      validateRepositoryEventWrite({ actor, type: 'tickets.migration-recorded', payload }),
    ).toThrow()
  expect(() =>
    validateRepositoryEventWrite({
      actor,
      type: 'tickets.migration-recorded',
      payload: { identity: 'x', from: 'linear', to: 'file', mapping: {} },
    }),
  ).not.toThrow()
})
test('migration facts survive later dispatcher runs', () => {
  const migration = fact('one', 'linear', 'file', { N: 'N' })
  const run = {
    ...migration,
    seq: 2,
    type: 'dispatcher.run-started',
    payload: {},
  } as unknown as RepositoryEvent
  expect(projectRepositoryStateEvents([migration, run])).toContain(migration)
})

test('database and hosted preserve their existing adapter compatibility through a recorded move', () => {
  const state = ticketMigrationsReducer.reduce([
    fact('hosted-cutover', 'linear', 'hosted', { OLD: 'AUT-1' }),
  ])
  expect(resolveTicketRef(state, { source: 'linear', id: 'OLD' }, 'database')).toEqual({
    source: 'database',
    id: 'AUT-1',
  })
  expect(resolveTicketRef(state, { source: 'database', id: 'AUT-1' }, 'hosted')).toEqual({
    source: 'hosted',
    id: 'AUT-1',
  })
  expect(resolveTicketRef(state, { source: 'hosted', id: 'AUT-1' }, 'database')).toEqual({
    source: 'database',
    id: 'AUT-1',
  })
})
