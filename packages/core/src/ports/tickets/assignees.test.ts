import { describe, expect, test } from 'bun:test'
import type { TicketsConfig } from '../../config/schema'
import type { Ticket } from '../types'
import {
  creationAssignees,
  parseAssigneesFlag,
  refuseUnsupportedAssignees,
  TicketAssigneesUnsupported,
  ticketAssigneesSchema,
} from './assignees'
import { normalizeTicket } from './tree'

describe('ticket assignees', () => {
  test('a source without the capability refuses any named assignees, including []', () => {
    for (const assignees of [['alice'], []])
      expect(() => refuseUnsupportedAssignees({ name: 'file' }, { assignees })).toThrow(
        new TicketAssigneesUnsupported('file'),
      )
    expect(new TicketAssigneesUnsupported('file').message).toBe(
      'file ticket source cannot store assignees; nothing was written',
    )
    expect(refuseUnsupportedAssignees({ name: 'file' }, {})).toBeUndefined()
    expect(
      refuseUnsupportedAssignees({ name: 'github', assignees: true }, { assignees: ['a'] }),
    ).toBeUndefined()
  })

  test('the schema refuses blank entries and more than ten', () => {
    expect(ticketAssigneesSchema.safeParse(['alice', 'me']).success).toBe(true)
    expect(ticketAssigneesSchema.safeParse(['']).success).toBe(false)
    expect(ticketAssigneesSchema.safeParse([' alice']).success).toBe(false)
    expect(
      ticketAssigneesSchema.safeParse(Array.from({ length: 11 }, (_, i) => `u${i}`)).success,
    ).toBe(false)
  })

  test('the flag splits on commas and an empty value is []', () => {
    expect(parseAssigneesFlag('alice, me')).toEqual(['alice', 'me'])
    expect(parseAssigneesFlag('')).toEqual([])
    expect(() =>
      parseAssigneesFlag(Array.from({ length: 11 }, (_, i) => `u${i}`).join(',')),
    ).toThrow('--assignees: at most 10 assignees')
  })

  test('explicit assignees replace the createAssignee default', () => {
    const configured = { createAssignee: 'me' } as Pick<TicketsConfig, 'createAssignee'>
    expect(creationAssignees(configured)).toEqual(['me'])
    expect(creationAssignees(configured, ['bob'])).toEqual(['bob'])
    expect(creationAssignees(configured, [])).toEqual([])
    expect(creationAssignees({})).toBeUndefined()
    expect(creationAssignees({}, ['bob'])).toEqual(['bob'])
  })

  test('reads from a source without the capability carry no assignees field', () => {
    const ticket = {
      revision: 'r',
      ref: { source: 'file', id: '1' },
      title: 't',
      body: 'b',
      resolved: false,
      labels: [],
      assignees: ['alice'],
    } as Ticket
    expect(normalizeTicket(ticket, true, true, true, false)).not.toHaveProperty('assignees')
    expect(normalizeTicket(ticket).assignees).toEqual(['alice'])
  })
})
