import { describe, expect, test } from 'bun:test'
import {
  formatIssueLinks,
  normalizeIssueLinks,
  parseIssueLinkList,
  refuseUnsupportedIssueLinks,
  TicketIssueLinksUnsupported,
} from './issue-links'
import { ticketRevision } from './revision'
import { validateTicketUpdate } from './update'

describe('issue links', () => {
  test('normalization defaults intent to closes and sorts by issue', () => {
    expect(normalizeIssueLinks([{ issue: 820, intent: 'refs' }, { issue: 5 }])).toEqual([
      { issue: 5, intent: 'closes' },
      { issue: 820, intent: 'refs' },
    ])
    expect(normalizeIssueLinks([])).toEqual([])
  })

  test('normalization rejects duplicates and non-positive or fractional issues', () => {
    expect(() => normalizeIssueLinks([{ issue: 3 }, { issue: 3, intent: 'refs' }])).toThrow(
      /duplicate issue #3/,
    )
    for (const issue of [0, -1, 1.5]) expect(() => normalizeIssueLinks([{ issue }])).toThrow()
    expect(() => normalizeIssueLinks([{ issue: 1, intent: 'fixes' as never }])).toThrow(
      /invalid issue links/,
    )
  })

  test('the CLI list accepts N, #N, N:closes and N:refs', () => {
    expect(parseIssueLinkList('824, #820:refs,1:closes')).toEqual([
      { issue: 1, intent: 'closes' },
      { issue: 820, intent: 'refs' },
      { issue: 824, intent: 'closes' },
    ])
    expect(parseIssueLinkList('')).toEqual([])
    expect(() => parseIssueLinkList('x')).toThrow(/--issues: invalid issue link "x"/)
    expect(() => parseIssueLinkList('1:fixes')).toThrow(/--issues: invalid issue link "1:fixes"/)
    expect(() => parseIssueLinkList('2,2:refs')).toThrow(/--issues: .*duplicate issue #2/)
  })

  test('formatting lists intent then issue', () => {
    expect(
      formatIssueLinks([
        { issue: 820, intent: 'refs' },
        { issue: 824, intent: 'closes' },
      ]),
    ).toBe('refs #820, closes #824')
  })

  test('a source without the capability refuses any present set, including empty', () => {
    expect(() => refuseUnsupportedIssueLinks({ name: 'linear' }, {})).not.toThrow()
    const error = (() => {
      try {
        refuseUnsupportedIssueLinks({ name: 'linear' }, { issueLinks: [] })
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(TicketIssueLinksUnsupported)
    expect((error as TicketIssueLinksUnsupported).source).toBe('linear')
    expect((error as Error).message).toContain('linear ticket source cannot store issue links')
    expect(() =>
      refuseUnsupportedIssueLinks({ name: 'file', issueLinks: true }, { issueLinks: [] }),
    ).not.toThrow()
  })

  test('validated updates accept a links-only patch and normalize it', () => {
    expect(validateTicketUpdate({ issueLinks: [{ issue: 9, intent: 'refs' }] })).toEqual({
      issueLinks: [{ issue: 9, intent: 'refs' }],
    })
    expect(validateTicketUpdate({ issueLinks: [] })).toEqual({ issueLinks: [] })
    expect(() =>
      validateTicketUpdate({
        issueLinks: [
          { issue: 1, intent: 'closes' },
          { issue: 1, intent: 'refs' },
        ],
      }),
    ).toThrow(/duplicate issue #1/)
  })

  test('revisions of tickets without links are unchanged; links are covered', () => {
    const ticket = {
      title: 'Fix it',
      body: 'body\n',
      labels: ['b', 'a'],
      state: 'Ready',
      blockedBy: ['x-1'],
    }
    // Computed by the implementation before issue links existed.
    const legacy = '9e3a9b320d690c5fee3187dd83cf3751e0918af634908eee599055ffb4f92c34'
    expect(ticketRevision(ticket)).toBe(legacy)
    expect(ticketRevision({ ...ticket, issueLinks: [] })).toBe(legacy)
    const linked = ticketRevision({ ...ticket, issueLinks: [{ issue: 1, intent: 'closes' }] })
    expect(linked).not.toBe(legacy)
    expect(ticketRevision({ ...ticket, issueLinks: [{ issue: 1, intent: 'refs' }] })).not.toBe(
      linked,
    )
  })
})
