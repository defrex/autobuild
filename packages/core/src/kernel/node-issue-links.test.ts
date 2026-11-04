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

  test("a node contributes its union, never its ticket's own links", () => {
    expect(
      contributedIssueLinks({
        kind: 'node',
        issueLinks: [{ issue: 1, intent: 'closes' }],
        nodeIssueLinks: { links: [closes(820), downgraded(824)] },
      }),
    ).toEqual([closes(820), downgraded(824)])
    expect(contributedIssueLinks({ kind: 'node', issueLinks: [] })).toEqual([])
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

  test('applies only to a root node on a capable forge with a nonempty union', () => {
    expect(nodeIssueLinksForForge(root, forge)).toEqual(projected)
    expect(nodeIssueLinksForForge({ ...root, target: { build: 'parent' } }, forge)).toBeUndefined()
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
