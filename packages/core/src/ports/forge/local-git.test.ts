import { expect, test } from 'bun:test'
import { LocalGitForge } from './local-git'
import type { Forge } from '../types'

test('local-git does not declare issue-closing support, so builds emit no keywords', () => {
  const forge: Forge = new LocalGitForge()
  expect(forge.closesIssues).toBeUndefined()
  expect(forge.updatePrIssueLinks).toBeUndefined()
})

test('remote branch existence requires the served repository root', async () => {
  await expect(new LocalGitForge().remoteBranchExists('ab/any')).rejects.toThrow(
    'no repository root',
  )
})
