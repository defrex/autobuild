import { resolve } from 'node:path'
import { resolveMainRepo } from './repo-state'
import { describe, expect, test } from 'bun:test'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  buildInRepository,
  normalizeGitRemoteUrl,
  resolveRepoOrigin,
  resolveRepoStatePaths,
  streamInRepository,
} from './repo-state'

describe('resolveRepoStatePaths', () => {
  const repo = '/code/example'

  test('defaults every local path beneath the repository state root', () => {
    expect(resolveRepoStatePaths({ repo })).toEqual({
      repo,
      checkout: repo,
      defaultLocalRoot: '/code/example/.autobuild',
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('normalizes relative and absolute local overrides and moves worktrees', () => {
    expect(resolveRepoStatePaths({ repo, storeRef: 'state/../state' })).toMatchObject({
      storeRef: '/code/example/state',
      worktreeRoot: '/code/example/state/worktrees',
    })
    expect(resolveRepoStatePaths({ repo, storeRef: '/var/lib/ab' })).toMatchObject({
      storeRef: '/var/lib/ab',
      worktreeRoot: '/var/lib/ab/worktrees',
    })
  })

  test('preserves remote URLs and keeps their worktrees repository-local', () => {
    expect(resolveRepoStatePaths({ repo, storeRef: 'https://store.example/api' })).toMatchObject({
      storeRef: 'https://store.example/api',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('uses nonblank flag over environment over default', () => {
    expect(
      resolveRepoStatePaths({ repo, storeRef: 'flag', envStore: 'environment' }).storeRef,
    ).toBe('/code/example/flag')
    expect(resolveRepoStatePaths({ repo, envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(resolveRepoStatePaths({ repo, storeRef: '', envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(resolveRepoStatePaths({ repo, storeRef: '  ', envStore: '' })).toMatchObject({
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })
})

describe('normalizeGitRemoteUrl', () => {
  test('reduces spelling variants of one origin to a single form', () => {
    expect(normalizeGitRemoteUrl('https://github.com/acme/app.git')).toBe(
      'https://github.com/acme/app',
    )
    expect(normalizeGitRemoteUrl('https://github.com/acme/app')).toBe('https://github.com/acme/app')
    expect(normalizeGitRemoteUrl('https://github.com/acme/app/')).toBe(
      'https://github.com/acme/app',
    )
    expect(normalizeGitRemoteUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app')
    expect(normalizeGitRemoteUrl('github.com:acme/app.git')).toBe('https://github.com/acme/app')
    expect(normalizeGitRemoteUrl('HTTPS://GitHub.COM/acme/app')).toBe('https://github.com/acme/app')
    // ssh and git spellings collapse to the https form, matching the scp-like
    // branch, so an ssh-origin host checkout and a guest's pinned https origin
    // compare equal.
    expect(normalizeGitRemoteUrl('ssh://git@github.com/acme/app.git')).toBe(
      'https://github.com/acme/app',
    )
    expect(normalizeGitRemoteUrl('ssh://github.com/acme/app')).toBe('https://github.com/acme/app')
    expect(normalizeGitRemoteUrl('git://github.com/acme/app.git')).toBe(
      'https://github.com/acme/app',
    )
    expect(normalizeGitRemoteUrl('git+ssh://git@github.com/acme/app')).toBe(
      'https://github.com/acme/app',
    )
    expect(normalizeGitRemoteUrl('SSH://GitHub.COM/acme/app.git')).toBe(
      'https://github.com/acme/app',
    )
  })

  test('passes unparseable and local-path remotes through trimmed', () => {
    expect(normalizeGitRemoteUrl('/srv/git/acme/app')).toBe('/srv/git/acme/app')
    expect(normalizeGitRemoteUrl('  /srv/git/acme/app\n')).toBe('/srv/git/acme/app')
    expect(normalizeGitRemoteUrl('C:\\code\\app')).toBe('C:\\code\\app')
    expect(normalizeGitRemoteUrl('not a url')).toBe('not a url')
  })
})

describe('resolveRepoOrigin', () => {
  test('normalizes the origin remote URL', async () => {
    const exec: Exec = async (cmd) => {
      expect(cmd).toEqual(['git', 'remote', 'get-url', 'origin'])
      return { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
    }
    expect(await resolveRepoOrigin('/checkout', exec)).toBe('https://github.com/acme/app')
  })

  test('is undefined with no origin remote and on git failure', async () => {
    const noRemote: Exec = async () => ({
      stdout: '',
      stderr: "error: No such remote 'origin'\n",
      exitCode: 2,
    })
    expect(await resolveRepoOrigin('/checkout', noRemote)).toBeUndefined()
    const thrown: Exec = async () => {
      throw new Error('git unavailable')
    }
    expect(await resolveRepoOrigin('/checkout', thrown)).toBeUndefined()
    const blank: Exec = async () => ({ stdout: '\n', stderr: '', exitCode: 0 })
    expect(await resolveRepoOrigin('/checkout', blank)).toBeUndefined()
  })
})

describe('buildInRepository', () => {
  const ORIGIN = 'https://github.com/acme/app'
  const failingExec: Exec = async () => {
    throw new Error('git must not be consulted for a path match')
  }

  test('path equality is decided without consulting git', async () => {
    expect(
      await buildInRepository(
        { slug: 'b', repo: '/repo', createdAt: '', updatedAt: '' },
        '/repo',
        failingExec,
      ),
    ).toBe(true)
  })

  test('a path mismatch is forgiven by origin equality (the differently located checkout)', async () => {
    const exec: Exec = async (cmd) => {
      expect(cmd).toEqual(['git', 'remote', 'get-url', 'origin'])
      return { stdout: 'git@github.com:acme/app\n', stderr: '', exitCode: 0 }
    }
    expect(
      await buildInRepository(
        { slug: 'b', repo: '/host/checkout', repoOrigin: ORIGIN, createdAt: '', updatedAt: '' },
        '/guest/checkout',
        exec,
      ),
    ).toBe(true)
  })

  test('an ssh-spelled checkout matches an https-spelled record (cross-protocol)', async () => {
    const sshRemote: Exec = async () => ({
      stdout: 'ssh://git@github.com/acme/app.git\n',
      stderr: '',
      exitCode: 0,
    })
    expect(
      await buildInRepository(
        { slug: 'b', repo: '/host/checkout', repoOrigin: ORIGIN, createdAt: '', updatedAt: '' },
        '/guest/checkout',
        sshRemote,
      ),
    ).toBe(true)
    // And the mirror image: the record's origin was normalized from an ssh://
    // remote while the current checkout pins the https spelling.
    const httpsRemote: Exec = async () => ({
      stdout: 'https://github.com/acme/app.git\n',
      stderr: '',
      exitCode: 0,
    })
    expect(
      await buildInRepository(
        {
          slug: 'b',
          repo: '/host/checkout',
          repoOrigin: 'ssh://git@github.com/acme/app',
          createdAt: '',
          updatedAt: '',
        },
        '/guest/checkout',
        httpsRemote,
      ),
    ).toBe(true)
  })

  test('a record without a recorded origin, or with a different origin, is foreign', async () => {
    const otherOrigin: Exec = async () => ({
      stdout: 'https://github.com/other/app.git\n',
      stderr: '',
      exitCode: 0,
    })
    expect(
      await buildInRepository(
        { slug: 'b', repo: '/host/checkout', createdAt: '', updatedAt: '' },
        '/guest/checkout',
        otherOrigin,
      ),
    ).toBe(false)
    expect(
      await buildInRepository(
        { slug: 'b', repo: '/host/checkout', repoOrigin: ORIGIN, createdAt: '', updatedAt: '' },
        '/guest/checkout',
        otherOrigin,
      ),
    ).toBe(false)
  })
})

describe('streamInRepository', () => {
  const ORIGIN = 'https://github.com/acme/app'

  test('an already-normalized scope matches the same identity', () => {
    expect(streamInRepository(ORIGIN, ORIGIN)).toBe(true)
  })

  test('an scp-like ssh-spelled scope matches the https identity (writer-vintage normalization)', () => {
    expect(streamInRepository('git@github.com:acme/app.git', ORIGIN)).toBe(true)
  })

  test('a foreign origin is rejected', () => {
    expect(streamInRepository('https://github.com/other/app', ORIGIN)).toBe(false)
  })

  test('a legacy physical-path scope stays rejected against an origin identity (the pinned AUT-314 divergence)', () => {
    // StreamScope carries no `repoOrigin`, so a legacy physical-path scope has
    // no recorded origin to compare — buildInRepository's forgiveness arm has
    // no stream analog, and this deliberate divergence is documented on the
    // helper rather than fixed here.
    expect(streamInRepository('/host/checkout', ORIGIN)).toBe(false)
  })

  test('a path identity still matches a path scope (origin-less fixture)', () => {
    expect(streamInRepository('/repo', '/repo')).toBe(true)
  })
})

describe('resolveMainRepo', () => {
  test('uses the top level when the Git and common directories are equal', async () => {
    const exec: Exec = async (cmd, opts) => {
      expect(cmd).toEqual([
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ])
      expect(opts.cwd).toBe('/worktree')
      return {
        stdout: '/main/repo/.git\n/main/repo/.git\n/main/repo\n',
        stderr: '',
        exitCode: 0,
      }
    }
    expect(await resolveMainRepo('/worktree', exec)).toBe('/main/repo')
  })

  test('falls back to the resolved target when Git is unavailable', async () => {
    const exec: Exec = async () => {
      throw new Error('git unavailable')
    }
    expect(await resolveMainRepo('./plain-directory', exec)).toBe(resolve('./plain-directory'))
  })
})
