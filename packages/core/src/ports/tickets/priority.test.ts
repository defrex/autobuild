import { describe, expect, test } from 'bun:test'
import type { Ticket, TicketSource, TicketUpdate } from '../types'
import { FakeTicketSource } from './fake'
import {
  parsePriorityFlag,
  refuseUnsupportedPriority,
  ticketPriority,
  TicketPriorityUnsupported,
  urgentFirst,
  withoutUnsupportedPriority,
} from './priority'
import { ticketRevision } from './revision'
import { compatibleTicketSource, normalizeSourceTicket, normalizeTicket } from './tree'
import { validateTicketUpdate } from './update'

const supported = { name: 'file', priority: true }
const unsupported = { name: 'hosted' }

describe('ticket priority', () => {
  test('urgentFirst is a stable partition that leaves its input alone', () => {
    const input = [
      { id: 'n1' },
      { id: 'u1', priority: 'urgent' as const },
      { id: 'n2', priority: 'normal' as const },
      { id: 'u2', priority: 'urgent' as const },
    ]
    const before = [...input]
    expect(urgentFirst(input).map((t) => t.id)).toEqual(['u1', 'u2', 'n1', 'n2'])
    expect(input).toEqual(before)
    const normal = [{ id: 'a' }, { id: 'b' }]
    expect(urgentFirst(normal)).toEqual(normal)
    expect(urgentFirst(normal)).not.toBe(normal)
    const urgent = [
      { id: 'a', priority: 'urgent' as const },
      { id: 'b', priority: 'urgent' as const },
    ]
    expect(urgentFirst(urgent)).toEqual(urgent)
  })

  test('refusal fires only for urgent on a source without the capability', () => {
    expect(() => refuseUnsupportedPriority(unsupported, { priority: 'urgent' })).toThrow(
      TicketPriorityUnsupported,
    )
    expect(() => refuseUnsupportedPriority(unsupported, { priority: 'urgent' })).toThrow(
      'hosted ticket source cannot store ticket priority; nothing was written',
    )
    refuseUnsupportedPriority(unsupported, { priority: 'normal' })
    refuseUnsupportedPriority(unsupported, {})
    refuseUnsupportedPriority(supported, { priority: 'urgent' })
  })

  test('the strip helper removes priority only for an unsupported source', () => {
    expect(withoutUnsupportedPriority(unsupported, { title: 'T', priority: 'normal' })).toEqual({
      title: 'T',
    })
    expect(withoutUnsupportedPriority(supported, { priority: 'normal' })).toEqual({
      priority: 'normal',
    })
    expect(() => withoutUnsupportedPriority(unsupported, { priority: 'urgent' })).toThrow(
      TicketPriorityUnsupported,
    )
  })

  test('the flag parser accepts both classes and names them otherwise', () => {
    expect(parsePriorityFlag('urgent')).toBe('urgent')
    expect(parsePriorityFlag('normal')).toBe('normal')
    expect(() => parsePriorityFlag('high')).toThrow('--priority: expected urgent or normal')
  })

  test('ticketPriority defaults to normal', () => {
    expect(ticketPriority({})).toBe('normal')
    expect(ticketPriority({ priority: 'urgent' })).toBe('urgent')
  })

  test('updates validate priority', () => {
    expect(validateTicketUpdate({ priority: 'urgent' })).toEqual({ priority: 'urgent' })
    expect(() => validateTicketUpdate({ priority: 'high' as never })).toThrow(
      /invalid ticket update — priority/,
    )
  })

  test('revisions change only for urgent', () => {
    const base = { title: 'T', body: 'B', labels: [], state: 'Ready' }
    const plain = ticketRevision(base)
    expect(ticketRevision({ ...base, priority: 'normal' })).toBe(plain)
    expect(ticketRevision({ ...base, priority: 'urgent' })).not.toBe(plain)
  })
})

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ref: { source: 'stub', id: 't1', title: 'T' },
    revision: 'r1',
    title: 'T',
    body: 'B',
    state: 'Ready',
    resolved: false,
    labels: [],
    ...overrides,
  }
}

describe('priority normalization', () => {
  test('normal is never emitted and an unsupported source reads normal', () => {
    expect('priority' in normalizeTicket(ticket({ priority: 'normal' }))).toBe(false)
    expect(normalizeTicket(ticket({ priority: 'urgent' })).priority).toBe('urgent')
    const source = { name: 'stub' } as TicketSource
    expect('priority' in normalizeSourceTicket(source, ticket({ priority: 'urgent' }))).toBe(false)
  })

  test('the compat wrapper skips a normal-only write on an unsupported source', async () => {
    const updates: TicketUpdate[] = []
    const mutations: unknown[] = []
    const stub = {
      name: 'stub',
      listReady: async () => ({ tickets: [], diagnostics: [] }),
      get: async () => ticket(),
      claim: async () => true,
      comment: async () => {},
      transition: async () => {},
      create: async () => ticket(),
      update: async (_id: string, patch: TicketUpdate) => {
        updates.push(patch)
      },
      addBlocker: async () => {},
      removeBlocker: async () => {},
      dependencyStates: async () => [],
      mutateIfRevision: async (...args: unknown[]) => {
        mutations.push(args)
      },
    } satisfies TicketSource
    const source = compatibleTicketSource(stub)
    await source.update('t1', { priority: 'normal' })
    await source.update('t1', { title: 'New', priority: 'normal' })
    expect(updates).toEqual([{ title: 'New' }])
    await expect(source.update('t1', { priority: 'urgent' })).rejects.toBeInstanceOf(
      TicketPriorityUnsupported,
    )
    await expect(source.update('t1', { priority: 'high' as never })).rejects.toThrow(
      /invalid ticket update/,
    )
    await source.mutateIfRevision!('t1', 'r1', { kind: 'update', patch: { priority: 'normal' } })
    await expect(
      source.mutateIfRevision!('t1', 'stale', { kind: 'update', patch: { priority: 'normal' } }),
    ).rejects.toThrow('changed: expected revision stale')
    expect(mutations).toEqual([])
    expect(updates).toHaveLength(1)
  })

  test('the fake round-trips urgent and clears it with normal', async () => {
    const fake = new FakeTicketSource([ticket({ ref: { source: 'fake', id: 'a', title: 'T' } })])
    const before = (await fake.get('a'))!.revision
    await fake.update('a', { priority: 'urgent' })
    const urgent = (await fake.get('a'))!
    expect(urgent.priority).toBe('urgent')
    expect(urgent.revision).not.toBe(before)
    await fake.update('a', { priority: 'normal' })
    const normal = (await fake.get('a'))!
    expect('priority' in normal).toBe(false)
    expect(normal.revision).toBe(before)
  })
})
