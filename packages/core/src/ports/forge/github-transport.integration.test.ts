import { describe, expect, test } from 'bun:test'
import { githubTokenFromGhCli, type GitHubCliExec } from './github-transport'

describe('resolveGitHubToken', () => {
  test('abandons a probe that outlives its deadline and aborts it through the seam', async () => {
    let aborted = false
    const started = Date.now()
    const wedged: GitHubCliExec = (_cmd, opts) =>
      new Promise(() => {
        // Never settles — a locked keyring, or a wrapper that forked the real
        // gh and left the pipes open past the kill.
        opts.signal.addEventListener('abort', () => {
          aborted = true
        })
      })
    const result = await githubTokenFromGhCli(wedged, 50)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(aborted).toBe(true)
    expect(result).toEqual({
      token: undefined,
      reason: '`gh auth token --hostname github.com` did not answer within 50 ms',
    })
  })
})
