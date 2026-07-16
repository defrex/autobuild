import { describe, expect, test } from 'bun:test'
import { FakeWorkspaceProvider } from './fake'

const OPTS = { repo: '/repos/origin', baseBranch: 'main', branch: 'ab/fix-login' }

describe('FakeWorkspaceProvider', () => {
  test('provision returns <root>/<branch> with ref === path and journals', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const handle = await provider.provision(OPTS)
    expect(handle).toEqual({
      provider: 'fake',
      ref: '/ws/ab/fix-login',
      path: '/ws/ab/fix-login',
      branch: 'ab/fix-login',
    })
    expect(provider.provisions).toEqual([OPTS])
    expect(provider.isActive(handle.ref)).toBe(true)
  })

  test('provision is idempotent per branch (resume is a re-run — SPEC §15.6-C)', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const first = await provider.provision(OPTS)
    const second = await provider.provision(OPTS)
    expect(second).toEqual(first)
    expect(provider.provisions).toHaveLength(2)
  })

  test('release journals and is idempotent', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const handle = await provider.provision(OPTS)
    await provider.release(handle)
    expect(provider.isActive(handle.ref)).toBe(false)
    // Releasing again (or releasing something never provisioned) is a no-op.
    await provider.release(handle)
    expect(provider.releases).toHaveLength(2)
  })

  test('setFailure makes the named operation throw until cleared', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    provider.setFailure('provision', new Error('disk full'))
    await expect(provider.provision(OPTS)).rejects.toThrow('disk full')
    expect(provider.provisions).toEqual([]) // failed calls are not journaled

    provider.setFailure('provision', null)
    const handle = await provider.provision(OPTS)

    provider.setFailure('release', new Error('locked'))
    await expect(provider.release(handle)).rejects.toThrow('locked')
    expect(provider.releases).toEqual([])
    expect(provider.isActive(handle.ref)).toBe(true)
  })
})
