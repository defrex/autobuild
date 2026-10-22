import { expect, test } from 'bun:test'
import { GitHubForge } from './github'

test('async work retaining a closed tick context resumes with ordinary fresh reads', async () => {
  let calls = 0
  const forge = new GitHubForge({
    repository: 'acme/repo',
    transport: async () => ({
      status: 200,
      headers: {},
      json: { commit: { sha: String(++calls) } },
    }),
  })
  let release!: () => void
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  let background!: Promise<void>
  await forge.withReadScope(async () => {
    expect(await forge.remoteBranchSha('main')).toBe('1')
    background = (async () => {
      await resumed
      expect(await forge.remoteBranchSha('main')).toBe('2')
      expect(await forge.remoteBranchSha('main')).toBe('3')
    })()
  })
  release()
  await background
  expect(calls).toBe(3)
})
