import { describe, expect, test } from 'bun:test'
import {
  encodeCreationMarker,
  type IssueStateResult,
  issueLinksOf,
  issueState,
  NOT_PLANNED_STATE,
  parseIssueId,
  parseLinkLabel,
  reopenVerdict,
  representableState,
  splitCreationMarker,
  ticketLabelsOf,
  writeForState,
} from './github-issues'
import type { TicketLifecycle } from './lifecycle'

const LIFECYCLE: TicketLifecycle = {
  triage: 'triage',
  ready: 'ready',
  doing: 'doing',
  done: 'done',
  create: 'triage',
  proposal: 'triage',
}
const WITH_ROLES: TicketLifecycle = { ...LIFECYCLE, backlog: 'backlog', rejected: 'rejected' }

const issue = (
  state: 'open' | 'closed',
  labels: string[],
  state_reason: string | null = state === 'closed' ? 'completed' : null,
) => ({ state, state_reason, labels: labels.map((name) => ({ name })) })

describe('issueState', () => {
  const cases: Array<[string, ReturnType<typeof issue>, TicketLifecycle, IssueStateResult]> = [
    ['open, no state label', issue('open', ['bug']), LIFECYCLE, { state: 'triage' }],
    ['open, one label', issue('open', ['autobuild:ready', 'bug']), LIFECYCLE, { state: 'ready' }],
    ['label case', issue('open', ['AutoBuild:Ready']), LIFECYCLE, { state: 'ready' }],
    ['custom state', issue('open', ['autobuild:icebox']), LIFECYCLE, { state: 'icebox' }],
    ['backlog', issue('open', ['autobuild:backlog']), WITH_ROLES, { state: 'backlog' }],
    [
      'two labels',
      issue('open', ['autobuild:ready', 'autobuild:doing']),
      LIFECYCLE,
      { malformed: ['autobuild:ready', 'autobuild:doing'] },
    ],
    ['completed', issue('closed', ['autobuild:doing']), LIFECYCLE, { state: 'done' }],
    ['legacy null reason', issue('closed', [], null), LIFECYCLE, { state: 'done' }],
    [
      'not planned, no role',
      issue('closed', [], 'not_planned'),
      LIFECYCLE,
      { state: NOT_PLANNED_STATE },
    ],
    ['not planned, role', issue('closed', [], 'not_planned'), WITH_ROLES, { state: 'rejected' }],
    [
      'duplicate, no role',
      issue('closed', [], 'duplicate'),
      LIFECYCLE,
      { state: NOT_PLANNED_STATE },
    ],
    ['duplicate, role', issue('closed', [], 'duplicate'), WITH_ROLES, { state: 'rejected' }],
  ]
  test.each(cases)('%s', (_name, input, lifecycle, expected) => {
    expect(issueState(input, lifecycle)).toEqual(expected)
  })
})

describe('writeForState', () => {
  const current = ['bug', 'autobuild:ready', 'autobuild-link:refs #9']
  test('done and rejected close with their reason and strip state labels', () => {
    expect(writeForState('done', WITH_ROLES, current)).toEqual({
      state: 'closed',
      state_reason: 'completed',
      labels: ['bug', 'autobuild-link:refs #9'],
    })
    expect(writeForState('Rejected', WITH_ROLES, current)).toEqual({
      state: 'closed',
      state_reason: 'not_planned',
      labels: ['bug', 'autobuild-link:refs #9'],
    })
  })
  test('triage is label-less and other states hold exactly their label', () => {
    expect(writeForState('triage', LIFECYCLE, current)).toEqual({
      state: 'open',
      labels: ['bug', 'autobuild-link:refs #9'],
    })
    expect(writeForState('backlog', WITH_ROLES, current)).toEqual({
      state: 'open',
      labels: ['bug', 'autobuild-link:refs #9', 'autobuild:backlog'],
    })
  })
  test('not-planned cannot be moved into', () => {
    expect(() => writeForState(NOT_PLANNED_STATE, LIFECYCLE, [])).toThrow('cannot be moved into')
  })
})

describe('reopenVerdict', () => {
  const labeled = (name: string) => ({ __typename: 'LabeledEvent', label: { name } })
  const reopened = { __typename: 'ReopenedEvent' }
  test('the newest decisive node wins and other labels are skipped', () => {
    expect(reopenVerdict([reopened, labeled('autobuild:ready')], 'autobuild:ready')).toBe('fresh')
    expect(reopenVerdict([labeled('autobuild:ready'), reopened], 'autobuild:ready')).toBe('stale')
    expect(
      reopenVerdict(
        [labeled('AUTOBUILD:READY'), reopened, labeled('bug'), labeled('autobuild:doing')],
        'autobuild:ready',
      ),
    ).toBe('stale')
    expect(
      reopenVerdict([reopened, labeled('Autobuild:Ready'), labeled('bug')], 'autobuild:ready'),
    ).toBe('fresh')
  })
  test('an empty or non-decisive window is undecidable', () => {
    expect(reopenVerdict([], 'autobuild:ready')).toBe('undecidable')
    expect(reopenVerdict([labeled('bug'), labeled('noise')], 'autobuild:ready')).toBe('undecidable')
  })
})

describe('ids, labels and links', () => {
  test('parseIssueId accepts N and #N only', () => {
    expect(parseIssueId('123')).toBe(123)
    expect(parseIssueId('#123')).toBe(123)
    for (const bad of ['0', '#', 'AUT-1', '12a', crypto.randomUUID(), '-3', '1.5'])
      expect(parseIssueId(bad)).toBeNull()
  })

  test('link labels parse both intents in any case and flag malformed names', () => {
    expect(parseLinkLabel('autobuild-link:closes #824')).toEqual({ issue: 824, intent: 'closes' })
    expect(parseLinkLabel('Autobuild-Link:REFS #820')).toEqual({ issue: 820, intent: 'refs' })
    expect(parseLinkLabel('autobuild-link:oops')).toBe('invalid')
    expect(parseLinkLabel('autobuild-link:refs #0')).toBe('invalid')
    expect(parseLinkLabel('bug')).toBeNull()
  })

  test('the own issue is an implicit closes link and closes wins over refs', () => {
    expect(
      issueLinksOf({
        number: 1001,
        labels: [
          { name: 'autobuild-link:refs #9' },
          { name: 'autobuild-link:closes #9' },
          { name: 'autobuild-link:refs #1001' },
          { name: 'autobuild-link:bad' },
        ],
      }),
    ).toEqual({
      links: [
        { issue: 9, intent: 'closes' },
        { issue: 1001, intent: 'closes' },
      ],
      invalid: ['autobuild-link:bad'],
    })
  })

  test('ticket labels drop state and link labels', () => {
    expect(
      ticketLabelsOf({
        labels: [{ name: 'bug' }, { name: 'autobuild:ready' }, { name: 'autobuild-link:refs #2' }],
      }),
    ).toEqual(['bug'])
  })

  test('representable states follow the hosted state-name rule', () => {
    expect(representableState('icebox')).toBe(true)
    expect(representableState('a'.repeat(40))).toBe(true)
    expect(representableState('a'.repeat(41))).toBe(false)
    expect(representableState('Ready')).toBe(false)
    expect(representableState('ready now')).toBe(false)
  })
})

describe('creation marker', () => {
  test.each(['', 'exact\r\nbody  ', 'ends with newline\n', 'has <!-- comment -->'])(
    'round-trips a byte-exact body %#',
    (body) => {
      const plain = encodeCreationMarker(body, 'key-1')
      expect(splitCreationMarker(plain)).toEqual({ body, marker: { key: 'key-1' } })
      const intent = {
        state: 'done',
        issueLinks: [{ issue: 9, intent: 'refs' as const }],
        blockedBy: ['1002'],
      }
      expect(splitCreationMarker(encodeCreationMarker(body, 'key-1', intent))).toEqual({
        body,
        marker: { key: 'key-1', pending: intent },
      })
    },
  )

  test('a body without a marker is untouched, and only the exact suffix is stripped', () => {
    expect(splitCreationMarker(null)).toEqual({ body: '' })
    const quoted = 'see <!-- autobuild:creation-key key-1 --> above\n'
    expect(splitCreationMarker(quoted)).toEqual({ body: quoted })
  })

  test('creation keys refuse characters that would break the marker', () => {
    expect(() => encodeCreationMarker('b', 'has space')).toThrow('creation key')
    expect(() => encodeCreationMarker('b', 'x-->')).toThrow('creation key')
  })
})
