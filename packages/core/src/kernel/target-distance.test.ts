import { expect, test } from 'bun:test'
import type { Exec } from '../ports/workspace/git-worktree'
import { sampleTargetDistance } from './target-distance'
const exec: Exec = async () => {
  throw new Error('unexpected process execution')
}
const target = { branch: 'main', sha: 'a'.repeat(40), buildBranch: 'ab/work', exec }

test('remote comparison reverses branches and rejects changed destination', async () => {
  const calls: string[][] = []
  const forge = {
    compareBranches: async (...args: string[]) => {
      calls.push(args)
      return { parentSha: 'b'.repeat(40), headSha: target.sha, ahead: 7 }
    },
  }
  expect(await sampleTargetDistance({ ...target, forge })).toEqual({
    branch: 'main',
    sha: target.sha,
    head: 'b'.repeat(40),
    count: 7,
  })
  expect(calls).toEqual([['ab/work', 'main']])
  expect((await sampleTargetDistance({ ...target, sha: 'c'.repeat(40), forge })).count).toBeNull()
  expect((await sampleTargetDistance({ ...target, forge: {} })).count).toBeNull()
})
