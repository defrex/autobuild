import { describe, expect, test } from 'bun:test'
import type { Ticket } from 'autobuild/plugin-sdk'
import {
  bodyFromEditor,
  draftFromTicket,
  groupTickets,
  reconcileTicketDetail,
  ticketFilterQuery,
  ticketUpdatePatch,
} from './ticket-view-model'

const ticket: Ticket = {
  ref: { source: 'linear', id: 'AUT-1', title: 'One' },
  title: 'One',
  body: 'first\r\nsecond  \nno-final-newline',
  state: 'Ready',
  labels: ['a', 'b'],
}

describe('ticket view model', () => {
  test('omits unchanged bodies and preserves exact edited bytes', () => {
    const draft = draftFromTicket(ticket)
    expect(draft.body).toBe('first\nsecond  \nno-final-newline')
    expect(ticketUpdatePatch(ticket, draft)).toBeNull()
    draft.body = 'first\r\nchanged \n\n'
    expect(ticketUpdatePatch(ticket, draft)).toEqual({ body: 'first\r\nchanged \n\n' })
  })

  test('restores textarea-normalized CRLF and mixed separators around edits', () => {
    expect(bodyFromEditor('one\r\ntwo\r\nthree', 'one\nTWO\nthree')).toBe('one\r\nTWO\r\nthree')
    expect(bodyFromEditor('one\r\ntwo\nthree\rfour', 'ONE\ntwo\nthree\nfour')).toBe(
      'ONE\r\ntwo\nthree\rfour',
    )
  })

  test('replaces and clears labels', () => {
    expect(ticketUpdatePatch(ticket, { ...draftFromTicket(ticket), labels: [] })).toEqual({
      labels: [],
    })
    expect(ticketUpdatePatch(ticket, { ...draftFromTicket(ticket), labels: ['b', 'a'] })).toEqual({
      labels: ['b', 'a'],
    })
  })

  test('encodes conjunctive filters and groups states', () => {
    expect(ticketFilterQuery({ state: 'In Progress', labels: ['web', 'ready'] })).toBe(
      'state=In+Progress&label=web&label=ready',
    )
    expect(
      groupTickets([ticket, { ...ticket, ref: { ...ticket.ref, id: 'AUT-2' }, state: 'Done' }]).map(
        (group) => group.state,
      ),
    ).toEqual(['Ready', 'Done'])
  })

  test('keeps a dirty detail across polling', () => {
    const current = { ticket, blockers: [], build: null }
    const incoming = { ...current, ticket: { ...ticket, body: 'remote' } }
    expect(reconcileTicketDetail(current, incoming, true)).toBe(current)
    expect(reconcileTicketDetail(current, incoming, false)).toBe(incoming)
  })
})
