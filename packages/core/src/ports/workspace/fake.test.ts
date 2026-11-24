import { describe, expect, test } from 'bun:test'
import { FakeWorkspaceProvider } from './fake'

const OPTS = { repo: '/repos/origin', baseBranch: 'main', branch: 'ab/fix-login' }

describe('FakeWorkspaceProvider (logical mode)', () => {
  test('provision returns <root>/<branch> with ref === path and journals', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const handle = await provider.provision(OPTS)
    expect(handle).toEqual({
      provider: 'fake',
      ref: '/ws/ab/fix-login',
      path: '/ws/ab/fix-login',
      branch: 'ab/fix-login',
      base: { source: 'remote', sha: 'fake-base-sha' },
    })
    expect(provider.provisions).toEqual([OPTS])
    expect(provider.isActive(handle.ref)).toBe(true)
  })

  test('logical provision stays idempotent without touching the filesystem', async () => {
    // The unit IO guard is the filesystem proof: any filesystem call made by
    // logical mode fails this test.
    const provider = new FakeWorkspaceProvider({ root: '/ws-logical', mode: 'logical' })
    const opts = { ...OPTS, repo: '/nonexistent-source' }
    const first = await provider.provision(opts)
    const second = await provider.provision(opts)
    expect(second).toEqual({
      ...first,
      base: { source: 'existing', sha: 'fake-base-sha' },
    })
    expect(provider.provisions).toHaveLength(2)
  })

  test('configured fallback evidence is returned and the branch head survives release', async () => {
    const provider = new FakeWorkspaceProvider({
      root: '/ws',
      mode: 'logical',
      base: {
        source: 'local',
        sha: 'local-sha',
        remoteError: 'origin unavailable',
      },
    })
    const first = await provider.provision(OPTS)
    expect(first.base).toEqual({
      source: 'local',
      sha: 'local-sha',
      remoteError: 'origin unavailable',
    })

    provider.setBranchHead(OPTS.branch, 'implemented-sha')
    await provider.release(first)
    const resumed = await provider.provision(OPTS)
    expect(resumed.base).toEqual({
      source: 'existing',
      sha: 'implemented-sha',
    })
  })

  test('release journals and is idempotent', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const handle = await provider.provision(OPTS)
    await provider.release(handle)
    expect(provider.isActive(handle.ref)).toBe(false)
    // Releasing again (or releasing something never provisioned) is a no-op.
    await provider.release(handle)
    expect(provider.releases).toHaveLength(2)
  })

  test('setFailure makes the named operation throw until cleared', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
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

  test('the build-path publication discriminator is untouched; the sandbox seam exists', () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    // `publication` is the dispatcher's remote-workspace discriminator: it
    // must stay absent on the fake so dispatcher-test builds classify local.
    expect((provider as unknown as { publication?: unknown }).publication).toBeUndefined()
    expect(provider.sandboxPublication).toBeDefined()
  })
})
