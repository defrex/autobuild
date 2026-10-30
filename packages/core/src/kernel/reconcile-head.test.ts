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

test.each(['reconcile', 'restack'] as const)(
  'retirement removes only the %s candidate requirement, including incremental restart',
  async (operation) => {
    const { buildReadFactsReducer } = await import('./read-facts')
    const { leafRestackReducer } = await import('./leaf-restack-state')
    const sha = '9'.repeat(40)
    const base = 'a'.repeat(40)
    const transaction = {
      id: 'old',
      attempt: 1,
      branch: 'ab/build',
      oldHead: base,
      oldBase: base,
      targetBase: base,
      changeSha: base,
      workspaceHead: base,
      localBranchHead: base,
      trigger: 'verify-entry',
      cycle: 1,
      observation: 1,
      message: 'retained message',
    }
    const events = buildLog([
      [`${operation}.prepared`, transaction],
      [`${operation}.replayed`, { id: transaction.id, conflicted: false }],
      [
        `${operation}.publish-intended`,
        {
          ...transaction,
          headSha: sha,
          conflicted: false,
          artifact: { kind: 'reconcile-notes', rev: 0 },
        },
      ],
      [
        'publication.candidate-retired',
        { operation, id: 'old', replacementId: 'replacement', sha, request: 1 },
      ],
    ])
    let acc = buildReadFactsReducer.advance(buildReadFactsReducer.initial(), events.slice(0, 2))
    acc = buildReadFactsReducer.advance(structuredClone(acc), events.slice(2))
    expect(buildReadFactsReducer.finish(acc).gitTips).not.toContain(sha)
    expect(referencedGitTips(events)).not.toContain(sha)
    const proven = buildLog([
      [
        'implement.completed',
        { round: 1, artifact: { kind: 'implement-notes', rev: 0 }, commits: { base, head: sha } },
      ],
    ])
    expect(referencedGitTips([...events, ...proven])).toContain(sha)
    expect(
      buildReadFactsReducer.finish(buildReadFactsReducer.advance(acc, proven)).gitTips,
    ).toContain(sha)
    if (operation === 'restack') {
      const selection = leafRestackReducer.reduce([...events, events[2]!])
      expect(selection.active?.id).toBe('replacement')
      expect(selection.active?.targetBase).toBe(base)
      expect(selection.active?.message).toBe('retained message')
      expect(selection.intent).toBeUndefined()
      expect(selection.replay).toBeUndefined()
    }
  },
)
