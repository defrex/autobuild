import { describe, expect, test } from 'bun:test'
import type { Exec } from '@defrex/autobuild/git-worktree'
import {
  kernelAtLeast,
  shippedGitExec,
  shippedGitShim,
  type ShippedGitManifest,
} from './shipped-git'

describe('locateShippedGit', () => {
  test('kernel versions compare numerically', () => {
    expect(kernelAtLeast('5.10.240-238.959.amzn2.x86_64', '3.2.0')).toBe(true)
    expect(kernelAtLeast('3.2', '3.2.0')).toBe(true)
    expect(kernelAtLeast('3.10.0', '3.2.0')).toBe(true)
    expect(kernelAtLeast('2.6.32', '3.2.0')).toBe(false)
    expect(kernelAtLeast('unknown', '3.2.0')).toBe(false)
  })
})

describe('shippedGitExec', () => {
  const git = {
    root: '/tmp/abg01234567',
    manifest: {
      git: 'bin/git',
      execPath: 'libexec/git-core',
      lib: 'lib',
      caBundle: 'ssl/ca-bundle.crt',
      templates: 'share/git-core/templates',
    } as ShippedGitManifest,
  }

  function recording() {
    const calls: { cmd: string[]; env?: Record<string, string | undefined> }[] = []
    const base: Exec = async (cmd, opts) => {
      calls.push({ cmd, ...(opts.env ? { env: opts.env } : {}) })
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return { calls, base }
  }

  test('routes git to the shipped tree with its confining environment', async () => {
    const { calls, base } = recording()
    await shippedGitExec(base, git, { PATH: '/usr/bin' })(['git', 'fetch', 'origin'], {
      cwd: '/repo',
      env: { LD_LIBRARY_PATH: '/host/lib', GIT_CONFIG_COUNT: '1' },
    })
    expect(calls[0]!.cmd).toEqual(['/tmp/abg01234567/bin/git', 'fetch', 'origin'])
    expect(calls[0]!.env).toEqual({
      GIT_EXEC_PATH: '/tmp/abg01234567/libexec/git-core',
      LD_LIBRARY_PATH: '/tmp/abg01234567/lib',
      GIT_SSL_CAINFO: '/tmp/abg01234567/ssl/ca-bundle.crt',
      GIT_TEMPLATE_DIR: '/tmp/abg01234567/share/git-core/templates',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_CONFIG_COUNT: '1',
      PATH: '/tmp/abg01234567/bin:/usr/bin',
    })
  })

  test("keeps the caller's CA bundle, protocol and config overrides", async () => {
    const { calls, base } = recording()
    await shippedGitExec(
      base,
      git,
      {},
    )(['git', 'ls-remote'], {
      env: {
        GIT_SSL_CAINFO: '/custom.pem',
        GIT_ALLOW_PROTOCOL: 'https:http',
        GIT_CONFIG_GLOBAL: '/custom.gitconfig',
        GIT_CONFIG_KEY_0: 'credential.helper',
      },
    })
    expect(calls[0]!.env).toMatchObject({
      GIT_SSL_CAINFO: '/custom.pem',
      GIT_ALLOW_PROTOCOL: 'https:http',
      GIT_CONFIG_GLOBAL: '/custom.gitconfig',
      GIT_CONFIG_KEY_0: 'credential.helper',
      PATH: '/tmp/abg01234567/bin',
    })
  })

  test('non-git commands keep their own libraries and find the launcher', async () => {
    const { calls, base } = recording()
    const exec = shippedGitExec(base, git, { PATH: '/usr/bin' })
    await exec(['gh', 'auth', 'token'], {})
    await exec(['sh', '-c', 'git status'], {
      env: { PATH: '/caller/bin', LD_LIBRARY_PATH: '/host/lib', GIT_CONFIG_COUNT: '1' },
    })
    expect(calls).toEqual([
      { cmd: ['gh', 'auth', 'token'], env: { PATH: '/tmp/abg01234567/shim:/usr/bin' } },
      {
        cmd: ['sh', '-c', 'git status'],
        env: {
          PATH: '/tmp/abg01234567/shim:/caller/bin',
          LD_LIBRARY_PATH: '/host/lib',
          GIT_CONFIG_COUNT: '1',
        },
      },
    ])
  })

  test('the launcher confines only Git and keeps caller overrides', () => {
    expect(shippedGitShim(git)).toBe(
      [
        '#!/bin/sh',
        "export GIT_EXEC_PATH='/tmp/abg01234567/libexec/git-core'",
        "export LD_LIBRARY_PATH='/tmp/abg01234567/lib'",
        `[ -n "\${GIT_SSL_CAINFO+set}" ] || GIT_SSL_CAINFO='/tmp/abg01234567/ssl/ca-bundle.crt'; export GIT_SSL_CAINFO`,
        "export GIT_TEMPLATE_DIR='/tmp/abg01234567/share/git-core/templates'",
        `[ -n "\${GIT_CONFIG_NOSYSTEM+set}" ] || GIT_CONFIG_NOSYSTEM='1'; export GIT_CONFIG_NOSYSTEM`,
        `[ -n "\${GIT_CONFIG_GLOBAL+set}" ] || GIT_CONFIG_GLOBAL='/dev/null'; export GIT_CONFIG_GLOBAL`,
        `[ -n "\${GIT_ALLOW_PROTOCOL+set}" ] || GIT_ALLOW_PROTOCOL='https'; export GIT_ALLOW_PROTOCOL`,
        `exec '/tmp/abg01234567/bin/git' "$@"`,
        '',
      ].join('\n'),
    )
  })
})
