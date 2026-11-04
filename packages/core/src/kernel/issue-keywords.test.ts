import { describe, expect, test } from 'bun:test'
import type { IssueLink } from '../ports/types'
import { buildTrailers } from './build-identity'
import type { BuildIssueLink } from './reducer'
import {
  describeIssueLinks,
  emitsIssueKeywords,
  issueKeywordLines,
  issueLinksForForge,
  landingMessage,
  neutralizeClosingReferences,
  withIssueKeywords,
} from './issue-keywords'

const links: IssueLink[] = [
  { issue: 824, intent: 'refs' },
  { issue: 820, intent: 'closes' },
]
const repository = 'defrex/autobuild'

describe('issueKeywordLines', () => {
  test('one canonical line per link, ascending by issue', () => {
    expect(issueKeywordLines(links)).toEqual(['Closes #820', 'Refs #824'])
    expect(issueKeywordLines([])).toEqual([])
  })
})

describe('neutralizeClosingReferences', () => {
  const neutral = (text: string) => neutralizeClosingReferences(text, links, { repository })

  test('rewrites a closing keyword aimed at a refs issue, keeping the reference', () => {
    expect(neutral('This fixes #824 by caching.')).toBe('This refs #824 by caching.')
    expect(neutral('Fixes: #824')).toBe('Refs: #824')
    expect(neutral('CLOSES #824')).toBe('Refs #824')
    expect(neutral('Closed:#824')).toBe('Refs:#824')
    expect(neutral('resolves GH-824')).toBe('refs GH-824')
  })

  test('repository-qualified forms count only for the adapter repository', () => {
    expect(neutral('fixes defrex/autobuild#824')).toBe('refs defrex/autobuild#824')
    expect(neutral('Fixes Defrex/AutoBuild#824')).toBe('Refs Defrex/AutoBuild#824')
    expect(neutral('closes https://github.com/defrex/autobuild/issues/824')).toBe(
      'refs https://github.com/defrex/autobuild/issues/824',
    )
    expect(neutral('fixes other/repo#824')).toBe('fixes other/repo#824')
    expect(neutral('closes https://github.com/other/repo/issues/824')).toBe(
      'closes https://github.com/other/repo/issues/824',
    )
    // Without the repository identity a qualified reference is left alone.
    expect(neutralizeClosingReferences('fixes defrex/autobuild#824', links)).toBe(
      'fixes defrex/autobuild#824',
    )
  })

  test('each keyword–reference pair stands alone', () => {
    expect(neutral('Fixes #1, fixes #824')).toBe('Fixes #1, refs #824')
    // GitHub needs a keyword per issue, so the bare second reference closes nothing.
    expect(neutral('Fixes #1, #824')).toBe('Fixes #1, #824')
  })

  test('leaves non-references, unlinked numbers and closes intent untouched', () => {
    for (const text of [
      'fixes prefix#824',
      'fixes #8240',
      'unfixes #824',
      'fixes #82',
      'Closes #820',
      'mentions #824 only',
    ])
      expect(neutral(text)).toBe(text)
  })

  test('no refs links is the identity', () => {
    const text = 'Fixes #820 and fixes #824'
    expect(neutralizeClosingReferences(text, [{ issue: 820, intent: 'closes' }])).toBe(text)
    expect(neutralizeClosingReferences(text, [])).toBe(text)
  })
})

describe('withIssueKeywords', () => {
  test('empty links return the input byte for byte', () => {
    for (const text of ['', 'Body', 'Body\n', 'Fixes #824\r\n\r\nCo-authored-by: A'])
      expect(withIssueKeywords(text, [])).toBe(text)
  })

  test('appends the canonical paragraph whatever the text says', () => {
    expect(withIssueKeywords('Summary of the work.\n', links, { trailers: false })).toBe(
      'Summary of the work.\n\nCloses #820\nRefs #824\n',
    )
    expect(withIssueKeywords('', links, { trailers: false })).toBe('Closes #820\nRefs #824')
  })

  test('drops whole lines restating linked issues and neutralizes inline prose', () => {
    const body = 'This fixes #824 by caching.\n\nFixes: #820\nRefs #824\nCloses #1\n\n'
    expect(withIssueKeywords(body, links, { repository, trailers: false })).toBe(
      'This refs #824 by caching.\n\nCloses #1\n\nCloses #820\nRefs #824\n',
    )
  })

  test('is idempotent', () => {
    for (const text of [
      'Body fixes #824\n',
      'Title\n\nBody\n\nCo-authored-by: A <a@example.test>\n',
      'Fixes: #824',
      '',
    ]) {
      const once = withIssueKeywords(text, links, { repository })
      expect(withIssueKeywords(once, links, { repository })).toBe(once)
    }
  })

  test('the paragraph goes before a terminal trailer block, never inside it', () => {
    const message = 'Body\n\nCo-authored-by: A <a@example.test>\n'
    expect(withIssueKeywords(message, links)).toBe(
      'Body\n\nCloses #820\nRefs #824\n\nCo-authored-by: A <a@example.test>\n',
    )
    // A keyword written as a trailer is still recognized and deduplicated.
    expect(withIssueKeywords('Body\n\nFixes: #824\n', links)).toBe(
      'Body\n\nCloses #820\nRefs #824\n',
    )
  })
})

describe('landingMessage', () => {
  test('keyword paragraph, then the trailer block carrying the build identity', () => {
    const composed = landingMessage('Body\n\nCo-authored-by: A <a@example.test>\n', 'slug', links)
    expect(composed).toBe(
      'Body\n\nCloses #820\nRefs #824\n\nCo-authored-by: A <a@example.test>\nAutobuild-Build: slug\n',
    )
    expect(buildTrailers(composed)).toEqual(['slug'])
    const bare = landingMessage('Body fixes #824', 'slug', links)
    expect(bare).toBe('Body refs #824\n\nCloses #820\nRefs #824\n\nAutobuild-Build: slug\n')
    expect(buildTrailers(bare)).toEqual(['slug'])
    expect(landingMessage(bare, 'slug', links)).toBe(bare)
  })

  test('no links is exactly the build trailer', () => {
    expect(landingMessage('Body fixes #824\n', 'slug', [])).toBe(
      'Body fixes #824\n\nAutobuild-Build: slug\n',
    )
  })
})

describe('emitsIssueKeywords', () => {
  const capable = { closesIssues: true }
  const leaf = { issueLinks: links }
  test('only a linked leaf aimed at the base through a capable forge', () => {
    expect(emitsIssueKeywords(leaf, capable)).toBe(true)
    expect(emitsIssueKeywords({ ...leaf, kind: 'work' }, capable)).toBe(true)
    expect(emitsIssueKeywords({ ...leaf, kind: 'node' }, capable)).toBe(false)
    expect(emitsIssueKeywords({ ...leaf, target: { build: 'node' } }, capable)).toBe(false)
    expect(emitsIssueKeywords(leaf, {})).toBe(false)
    expect(emitsIssueKeywords({ issueLinks: [] }, capable)).toBe(false)
  })

  test('the forge receives only issue and intent', () => {
    const downgraded: BuildIssueLink[] = [
      { issue: 1, intent: 'refs', downgrade: { reason: 'r', seq: 4 } },
    ]
    expect(issueLinksForForge({ issueLinks: downgraded }, capable)).toEqual({
      issueLinks: [{ issue: 1, intent: 'refs' }],
    })
    expect(issueLinksForForge(leaf, {})).toEqual({})
  })
})

test('describeIssueLinks shows downgrade provenance', () => {
  expect(
    describeIssueLinks([
      { issue: 820, intent: 'closes' },
      { issue: 824, intent: 'refs', downgrade: { reason: 'API half only' } },
    ]),
  ).toBe('closes #820, refs #824 (downgraded from closes: API half only)')
})
