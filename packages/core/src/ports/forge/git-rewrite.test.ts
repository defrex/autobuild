import { describe, expect, test } from 'bun:test'
import { gitRewrite, parseRemoteHead, publishBranch } from './git-rewrite'
import { ArchiveConflictError, ForgeFailure, isForgeFailure } from '../forge-failure'
import { ForgeRequestDeferred } from '../forge-request-context'

test('transport uses exact leases and refuses namespace policy errors before replacement', async () => {
  const commands: string[][] = []
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  const capability = gitRewrite(async (cmd) => {
    commands.push(cmd)
    return cmd[1] === 'push'
      ? { exitCode: 1, stdout: '', stderr: 'remote: namespace denied' }
      : { exitCode: 0, stdout: '', stderr: '' }
  }, false)
  await expect(capability.archive({ workspacePath: '/fixture', sha, ref })).rejects.toThrow(
    `archive publication rejected for ${ref}`,
  )
  expect(commands.find((cmd) => cmd[1] === 'push')).toEqual([
    'git',
    'push',
    `--force-with-lease=${ref}:`,
    'origin',
    `${sha}:${ref}`,
  ])
  expect(commands.some((cmd) => cmd.some((arg) => arg.startsWith('refs/heads/')))).toBe(false)
})

describe('refused archive push falls back to the supplied ref creation', () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  const refusal = 'remote: pushes of anything other than a branch are not allowed'
  function harness(options: {
    push?: { exitCode: number; stderr: string }
    readback?: () => string | null
    before?: string | null
    fallback?: (ref: string, sha: string) => Promise<void>
  }) {
    const commands: string[][] = []
    const calls: [string, string][] = []
    let published = false
    const capability = gitRewrite(
      async (cmd) => {
        commands.push(cmd)
        if (cmd[1] === 'push')
          return { stdout: '', ...(options.push ?? { exitCode: 1, stderr: refusal }) }
        if (cmd[1] === 'ls-remote') {
          const pushed = commands.some((c) => c[1] === 'push')
          const actual = pushed
            ? options.readback
              ? options.readback()
              : published
                ? sha
                : null
            : (options.before ?? null)
          return { exitCode: 0, stdout: actual ? `${actual}\t${ref}\n` : '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      false,
      async () => {
        throw new Error('missing-object creation must not run for a local commit')
      },
      async (r, s) => {
        calls.push([r, s])
        if (options.fallback) return options.fallback(r, s)
        published = true
      },
    )
    return {
      run: () => capability.archive({ workspacePath: '/ws', sha, ref }),
      commands,
      calls,
    }
  }

  test('refused push then REST success publishes the identical ref', async () => {
    const h = harness({})
    await h.run()
    expect(h.calls).toEqual([[ref, sha]])
    const written = [...h.commands.flat(), ...h.calls.flat()]
    expect(written.some((arg) => /refs\/(?:heads|tags)\//.test(arg))).toBe(false)
  })

  test('refused push then REST failure names both refusals', async () => {
    const h = harness({
      fallback: async () => {
        throw new Error('policy')
      },
    })
    const failure = await h.run().then(
      () => undefined,
      (error: unknown) => error,
    )
    const message = (failure as Error).message
    for (const part of [
      `archive publication rejected for ${ref} at ${sha}: git push refused (`,
      refusal,
      'GitHub REST ref creation failed (policy)',
      '(archive refs are optional; Autobuild falls back to a BuildStore copy)',
    ])
      expect(message).toContain(part)
  })

  test('refused push then unconfirmed readback is rejected', async () => {
    const h = harness({ fallback: async () => {} })
    const failure = (await h.run().then(
      () => undefined,
      (error: unknown) => error,
    )) as Error
    expect(failure.message).toContain('git push refused')
    expect(failure.message).toContain('did not confirm publication')
  })

  test('refused push then a different readback SHA is an immutable archive', async () => {
    const other = 'b'.repeat(40)
    const h = harness({ readback: () => other })
    await expect(h.run()).rejects.toThrow(
      `immutable archive ${ref} names ${other}, expected ${sha}`,
    )
    await expect(h.run()).rejects.toBeInstanceOf(ArchiveConflictError)
  })

  test('pre-existing different archive runs neither transport', async () => {
    const other = 'b'.repeat(40)
    const h = harness({ before: other })
    await expect(h.run()).rejects.toThrow(`immutable archive ${ref} names ${other}`)
    await expect(h.run()).rejects.toBeInstanceOf(ArchiveConflictError)
    expect(h.commands.some((c) => c[1] === 'push')).toBe(false)
    expect(h.calls).toEqual([])
  })

  test('transient push failure stays transient and never falls back', async () => {
    const h = harness({ push: { exitCode: 128, stderr: 'fatal: HTTP 503 Service Unavailable' } })
    const failure = await h.run().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(isForgeFailure(failure)).toBe(true)
    expect(h.calls).toEqual([])
  })

  test('transient REST failure after a refusal keeps its class', async () => {
    for (const failure of [
      new ForgeFailure('unavailable', { kind: 'transient', retry: 'retryable' }),
      new ForgeRequestDeferred('deferred'),
    ]) {
      const h = harness({
        fallback: async () => {
          throw failure
        },
      })
      await expect(h.run()).rejects.toBe(failure)
    }
  })

  test('successful push never calls the fallback', async () => {
    let pushed = false
    const h = harness({
      push: { exitCode: 0, stderr: '' },
      readback: () => {
        pushed = true
        return sha
      },
    })
    await h.run()
    expect(pushed).toBe(true)
    expect(h.calls).toEqual([])
  })
})

for (const diagnostic of [
  'fatal: unable to access: The requested URL returned error: 503',
  'fatal: HTTP 502 Bad Gateway',
  'Recv failure: Connection reset by peer',
  'fatal: Operation timed out after 30000 milliseconds',
  '! [rejected] ab/probe -> ab/probe (stale info)',
  'fatal: Authentication failed',
  'fatal: Permission denied',
]) {
  test(`network rewrite diagnostic: ${diagnostic}`, async () => {
    const { isForgeFailure } = await import('../forge-failure')
    const capability = gitRewrite(
      async () => ({ exitCode: 128, stdout: '', stderr: diagnostic }),
      false,
    )
    let failure: unknown
    try {
      await capability.snapshot({
        workspacePath: '/repo',
        branch: 'ab/probe',
        destinationRef: 'refs/autobuild/reconcile/probe/head',
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(isForgeFailure(failure)).toBe(!/rejected|Authentication|Permission/.test(diagnostic))
  })
}

for (const after of [null, 'a'.repeat(40), 'b'.repeat(40)]) {
  test(`uncertain remote archive requires exact readback: ${after}`, async () => {
    const { ForgeFailure } = await import('../forge-failure')
    const { ForgeRequestDeferred } = await import('../forge-request-context')
    for (const failure of [
      new ForgeFailure('rate limited', { kind: 'rate-limited', resetAt: '2026-10-29T12:00:00Z' }),
      new ForgeFailure('unavailable', { kind: 'transient', retry: 'retryable' }),
      new ForgeRequestDeferred('deferred'),
    ]) {
      const sha = 'a'.repeat(40)
      const ref = `refs/autobuild/archive/probe/${sha}`
      let attempted = false
      let fetched = false
      const capability = gitRewrite(
        async (cmd) => {
          if (cmd[1] === 'fetch') fetched = true
          return {
            exitCode: cmd[1] === 'cat-file' && !fetched ? 1 : 0,
            stderr: '',
            stdout: cmd[1] === 'ls-remote' && attempted && after ? `${after}\t${ref}\n` : '',
          }
        },
        false,
        async () => {
          attempted = true
          throw failure
        },
      )
      const result = capability.archive({ workspacePath: '/ws', sha, ref })
      if (after === sha) await result
      // A different archive SHA is immutable, whatever the write transport reported.
      else if (after)
        await expect(result).rejects.toThrow(`immutable archive ${ref} names ${after}`)
      else await expect(result).rejects.toBe(failure)
      expect(fetched).toBe(after === sha)
    }
  })
}

test('preexisting remote archive is immutable and fetched by name when missing locally', async () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  for (const actual of [sha, 'b'.repeat(40)]) {
    const commands: string[][] = []
    const capability = gitRewrite(
      async (cmd) => {
        commands.push(cmd)
        return {
          exitCode: cmd[1] === 'cat-file' && !commands.some((c) => c[1] === 'fetch') ? 1 : 0,
          stdout: cmd[1] === 'ls-remote' ? `${actual}\t${ref}\n` : '',
          stderr: '',
        }
      },
      false,
      async () => {
        throw new Error('must not create')
      },
    )
    const result = capability.archive({ workspacePath: '/ws', sha, ref })
    if (actual !== sha) await expect(result).rejects.toThrow('immutable archive')
    else await result
    expect(commands.some((c) => c[1] === 'fetch')).toBe(actual === sha)
    expect(commands.some((c) => c[1] === 'push')).toBe(false)
  }
})

test('archive materialization must verify the local commit', async () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  const capability = gitRewrite(
    async (cmd) => ({
      exitCode: cmd[1] === 'cat-file' ? 1 : 0,
      stdout: cmd[1] === 'ls-remote' ? `${sha}\t${ref}\n` : '',
      stderr: 'missing commit',
    }),
    false,
  )
  await expect(capability.archive({ workspacePath: '/ws', sha, ref })).rejects.toThrow(
    'missing commit',
  )
})

test('missing local object without provider creation fails with SHA and ref context', async () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  const capability = gitRewrite(async (cmd) => {
    expect(cmd[1]).not.toBe('push')
    return { exitCode: cmd[1] === 'cat-file' ? 1 : 0, stdout: '', stderr: '' }
  }, false)
  await expect(capability.archive({ workspacePath: '/ws', sha, ref })).rejects.toThrow(
    `archive publication rejected for ${ref} at ${sha}`,
  )
})

test('authoritative read errors and malformed advertisements cannot acknowledge publication', async () => {
  for (const output of [
    `${'a'.repeat(40)}\trefs/heads/other`,
    'x\trefs/heads/ab/example',
    `${'a'.repeat(40)}\trefs/heads/ab/example\n${'b'.repeat(40)}\trefs/heads/ab/example`,
  ])
    expect(() => parseRemoteHead(output, 'refs/heads/ab/example')).toThrow()
  expect(parseRemoteHead('', 'refs/heads/ab/example')).toBeNull()
  await expect(
    publishBranch(
      async () => ({ exitCode: 1, stdout: '', stderr: 'offline' }),
      '/ws',
      'ab/example',
      'a'.repeat(40),
    ),
  ).rejects.toThrow('cannot read')
})
