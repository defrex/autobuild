import { expect, test } from 'bun:test'
import { buildLog } from './incremental-fixtures'
import { referencedGitTips } from './reconcile-head'

test('unpublished attempt SHAs are excluded while independently published evidence is retained', () => {
  const base = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  const attempted = buildLog([
    ['publication.requested', { operation: 'implement', base, sha: head }],
    ['publication.lost', { request: 1, sha: head }],
    ['workspace.released', {}],
  ])
  expect(referencedGitTips(attempted)).toEqual([])
  const published = buildLog([['implement.completed', { commits: { base, head } }]])
  expect(referencedGitTips([...attempted, ...published])).toEqual([base, head])
})
