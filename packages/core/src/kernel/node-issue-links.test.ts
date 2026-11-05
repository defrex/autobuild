import { describe, expect, test } from 'bun:test'
import type { IssueLink } from '../ports/types'
import {
  contributedIssueLinks,
  mergeNodeIssueLinks,
  nodeIssueLinksForForge,
  nodeIssueLinksPublished,
  nodeIssueLinksSyncPending,
  type NodeIssueLink,
  type NodeIssueLinkState,
} from './node-issue-links'

const closes = (issue: number): NodeIssueLink => ({ issue, intent: 'closes' })
const refs = (issue: number): NodeIssueLink => ({ issue, intent: 'refs' })
const downgraded = (issue: number): NodeIssueLink => ({
  issue,
  intent: 'refs',
  downgraded: true,
})

describe('mergeNodeIssueLinks', () => {
  test('a downgrade wins, then any closes, else refs', () => {
    expect(mergeNodeIssueLinks([closes(1)], [closes(1)])).toEqual([closes(1)])
    expect(mergeNodeIssueLinks([closes(1)], [refs(1)])).toEqual([closes(1)])
    expect(mergeNodeIssueLinks([refs(1)], [refs(1)])).toEqual([refs(1)])
    expect(mergeNodeIssueLinks([closes(1)], [downgraded(1)])).toEqual([downgraded(1)])
    expect(mergeNodeIssueLinks([downgraded(1)], [closes(1)])).toEqual([downgraded(1)])
  })

  test('is order independent, idempotent and sorted', () => {
    const contributions = [
      [closes(9), refs(3)],
      [downgraded(3), closes(5)],
      [refs(5), closes(1)],
    ]
    const expected = [closes(1), downgraded(3), closes(5), closes(9)]
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    for (const order of permutations) {
      const union = order.reduce<NodeIssueLink[]>(
        (acc, index) => mergeNodeIssueLinks(acc, contributions[index]!),
        [],
      )
      expect(union).toEqual(expected)
      expect(mergeNodeIssueLinks(union, union)).toEqual(expected)
    }
  })
})

describe('contributedIssueLinks', () => {
  test('a leaf contributes its effective links with downgrade provenance', () => {
    expect(
      contributedIssueLinks({
        kind: 'work',
        issueLinks: [
          { issue: 824, intent: 'refs', downgrade: { reason: 'half', seq: 3 } },
          { issue: 820, intent: 'closes' },
        ],
      }),
    ).toEqual([closes(820), downgraded(824)])
  })

  test('a node contributes its own effective links merged with its union', () => {
    expect(
      contributedIssueLinks({
        kind: 'node',
        issueLinks: [{ issue: 1, intent: 'closes' }],
        nodeIssueLinks: { links: [closes(820), downgraded(824)] },
      }),
    ).toEqual([closes(1), closes(820), downgraded(824)])
    expect(contributedIssueLinks({ kind: 'node', issueLinks: [] })).toEqual([])
  })

  test("a node's own links merge under the union rules, keeping its downgrade provenance", () => {
    // Own closes, child downgrade: the downgrade wins.
    expect(
      contributedIssueLinks({
        kind: 'node',
        issueLinks: [{ issue: 824, intent: 'closes' }],
        nodeIssueLinks: { links: [downgraded(824)] },
      }),
    ).toEqual([downgraded(824)])
    // Own refs, child closes: closes.
    expect(
      contributedIssueLinks({
        kind: 'node',
        issueLinks: [{ issue: 820, intent: 'refs' }],
        nodeIssueLinks: { links: [closes(820)] },
      }),
    ).toEqual([closes(820)])
    // Own downgrade, child closes: the own downgrade wins.
    expect(
      contributedIssueLinks({
        kind: 'node',
        issueLinks: [{ issue: 820, intent: 'refs', downgrade: { reason: 'half', seq: 2 } }],
        nodeIssueLinks: { links: [closes(820)] },
      }),
    ).toEqual([downgraded(820)])
    // Own links alone.
    expect(
      contributedIssueLinks({ kind: 'node', issueLinks: [{ issue: 830, intent: 'closes' }] }),
    ).toEqual([closes(830)])
  })
})

describe('root node emission', () => {
  const forge = { closesIssues: true, updatePrIssueLinks: async () => {} }
  const root: NodeIssueLinkState = {
    kind: 'node',
    issueLinks: [],
    pr: { number: 7 },
    prState: 'open',
    nodeIssueLinks: { links: [closes(820), downgraded(824)] },
  }
  const projected: IssueLink[] = [
    { issue: 820, intent: 'closes' },
    { issue: 824, intent: 'refs' },
  ]

  test('applies only to a node on a capable forge with a nonempty set', () => {
    expect(nodeIssueLinksForForge(root, forge)).toEqual(projected)
    expect(nodeIssueLinksForForge({ ...root, kind: 'work' }, forge)).toBeUndefined()
    expect(
      nodeIssueLinksForForge(root, {
        updatePrIssueLinks: forge.updatePrIssueLinks,
      }),
    ).toBe(undefined)
    expect(nodeIssueLinksForForge(root, { closesIssues: true })).toBeUndefined()
    expect(nodeIssueLinksForForge({ ...root, nodeIssueLinks: { links: [] } }, forge)).toBe(
      undefined,
    )
  })

  test("a root node's set includes its own links, which alone make it nonempty", () => {
    expect(
      nodeIssueLinksForForge(
        {
          ...root,
          issueLinks: [
            { issue: 830, intent: 'closes' },
            { issue: 824, intent: 'closes' },
          ],
        },
        forge,
      ),
    ).toEqual([
      { issue: 820, intent: 'closes' },
      { issue: 824, intent: 'refs' },
      { issue: 830, intent: 'closes' },
    ])
    expect(
      nodeIssueLinksForForge(
        { ...root, issueLinks: [{ issue: 830, intent: 'closes' }], nodeIssueLinks: { links: [] } },
        forge,
      ),
    ).toEqual([{ issue: 830, intent: 'closes' }])
  })

  test("a nested node's PR carries every issue as refs", () => {
    const nested: NodeIssueLinkState = {
      ...root,
      target: { build: 'parent' },
      issueLinks: [{ issue: 830, intent: 'closes' }],
    }
    const refsOnly: IssueLink[] = [
      { issue: 820, intent: 'refs' },
      { issue: 824, intent: 'refs' },
      { issue: 830, intent: 'refs' },
    ]
    expect(nodeIssueLinksForForge(nested, forge)).toEqual(refsOnly)
    expect(nodeIssueLinksForForge(nested, { closesIssues: true })).toBeUndefined()
    expect(nodeIssueLinksSyncPending(nested, forge)).toEqual(refsOnly)
    expect(
      nodeIssueLinksSyncPending(
        {
          ...nested,
          nodeIssueLinks: { ...nested.nodeIssueLinks!, published: { pr: 7, issueLinks: refsOnly } },
        },
        forge,
      ),
    ).toBeUndefined()
  })

  test('an in-flight root whose published lines hold only the union is pending with its own links', () => {
    const inFlight: NodeIssueLinkState = {
      ...root,
      issueLinks: [{ issue: 830, intent: 'closes' }],
      nodeIssueLinks: { ...root.nodeIssueLinks!, published: { pr: 7, issueLinks: projected } },
    }
    expect(nodeIssueLinksSyncPending(inFlight, forge)).toEqual([
      ...projected,
      { issue: 830, intent: 'closes' },
    ])
  })

  test('sync is pending until the open PR confirms the union', () => {
    expect(nodeIssueLinksSyncPending(root, forge)).toEqual(projected)
    const { pr: _pr, ...noPr } = root
    expect(nodeIssueLinksSyncPending(noPr, forge)).toBeUndefined()
    expect(nodeIssueLinksSyncPending({ ...root, prState: 'closed' }, forge)).toBeUndefined()
    const published = (pr: number, issueLinks = projected): NodeIssueLinkState => ({
      ...root,
      nodeIssueLinks: {
        ...root.nodeIssueLinks!,
        published: { pr, issueLinks },
      },
    })
    expect(nodeIssueLinksSyncPending(published(8), forge)).toEqual(projected)
    expect(nodeIssueLinksSyncPending(published(7), forge)).toBeUndefined()
    expect(
      nodeIssueLinksSyncPending(published(7, [{ issue: 820, intent: 'closes' }]), forge),
    ).toEqual(projected)
    expect(nodeIssueLinksPublished(published(7), 7, [...projected].reverse())).toBe(true)
  })
})
