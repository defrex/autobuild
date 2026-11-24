import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { hostStateHome, resolveRepoStatePaths } from './repo-state'

const key = (name: string, localStateRoot: string) =>
  `${name}-${createHash('sha256').update(localStateRoot).digest('hex').slice(0, 12)}`

describe('resolveRepoStatePaths', () => {
  const repo = '/code/example'
  const stateHome = '/state'

  test('defaults every local path beneath the repository state root', () => {
    expect(resolveRepoStatePaths({ repo, stateHome })).toEqual({
      repo,
      checkout: repo,
      defaultLocalRoot: '/code/example/.autobuild',
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
      isolatedWorktreeRoot: `/state/autobuild/worktrees/${key('example', '/code/example/.autobuild')}`,
    })
  })

  test('normalizes relative and absolute local overrides and moves the state worktrees', () => {
    expect(resolveRepoStatePaths({ repo, stateHome, storeRef: 'state/../state' })).toMatchObject({
      storeRef: '/code/example/state',
      worktreeRoot: '/code/example/state/worktrees',
    })
    expect(resolveRepoStatePaths({ repo, stateHome, storeRef: '/var/lib/ab' })).toMatchObject({
      storeRef: '/var/lib/ab',
      worktreeRoot: '/var/lib/ab/worktrees',
    })
  })

  test('preserves remote URLs and keeps their state worktrees repository-local', () => {
    expect(
      resolveRepoStatePaths({ repo, stateHome, storeRef: 'https://store.example/api' }),
    ).toMatchObject({
      storeRef: 'https://store.example/api',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('isolated roots differ per state tree and per checkout with one basename', () => {
    const roots = [
      resolveRepoStatePaths({ repo, stateHome }),
      resolveRepoStatePaths({ repo, stateHome, storeRef: '/var/lib/ab' }),
      resolveRepoStatePaths({ repo: '/other/example', stateHome }),
    ].map((state) => state.isolatedWorktreeRoot)
    expect(new Set(roots).size).toBe(3)
    expect(roots[1]).toBe(`/state/autobuild/worktrees/${key('example', '/var/lib/ab')}`)
    expect(resolveRepoStatePaths({ repo: '/code/.my repo!', stateHome }).isolatedWorktreeRoot).toBe(
      `/state/autobuild/worktrees/${key('my-repo-', '/code/.my repo!/.autobuild')}`,
    )
  })

  test('uses nonblank flag over environment over default', () => {
    expect(
      resolveRepoStatePaths({ repo, stateHome, storeRef: 'flag', envStore: 'environment' })
        .storeRef,
    ).toBe('/code/example/flag')
    expect(resolveRepoStatePaths({ repo, stateHome, envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(
      resolveRepoStatePaths({ repo, stateHome, storeRef: '', envStore: 'environment' }).storeRef,
    ).toBe('/code/example/environment')
    expect(resolveRepoStatePaths({ repo, stateHome, storeRef: '  ', envStore: '' })).toMatchObject({
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })
})

test('hostStateHome takes an absolute XDG_STATE_HOME, else ~/.local/state', () => {
  expect(hostStateHome({ XDG_STATE_HOME: '/xdg/state' }, '/home/u')).toBe('/xdg/state')
  expect(hostStateHome({ XDG_STATE_HOME: '  ' }, '/home/u')).toBe('/home/u/.local/state')
  expect(hostStateHome({ XDG_STATE_HOME: 'relative/state' }, '/home/u')).toBe(
    '/home/u/.local/state',
  )
  expect(hostStateHome({}, '/home/u')).toBe('/home/u/.local/state')
})
