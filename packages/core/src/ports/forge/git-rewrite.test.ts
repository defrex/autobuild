import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bunExec } from './github'
import { gitRewrite } from './git-rewrite'

for (const local of [true, false]) {
  for (const branch of ['ab/probe', 'ab-node/probe']) {
    test(`${local ? 'local-git' : 'GitHub transport'} archives and guards a real rewrite on ${branch}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ab-rewrite-'))
      const cwd = join(root, 'work')
      async function git(args: string[], path = cwd) {
        const result = await bunExec(['git', ...args], { cwd: path })
        if (result.exitCode !== 0) throw new Error(result.stderr)
        return result.stdout.trim()
      }
      try {
        await git(['init', '-q', cwd], root)
        await git(['config', 'user.name', 'Contract'])
        await git(['config', 'user.email', 'contract@test.invalid'])
        await git(['config', 'commit.gpgsign', 'false'])
        await writeFile(join(cwd, 'file'), 'old\n')
        await git(['add', '.'])
        await git(['commit', '-qm', 'old'])
        const old = await git(['rev-parse', 'HEAD'])
        await git(['branch', branch])
        const remote = join(root, 'remote.git')
        if (!local) {
          await git(['init', '--bare', '-q', remote])
          await git(['remote', 'add', 'origin', remote])
          await git(['push', '-q', 'origin', branch])
        }
        await git(['checkout', '--detach', '-q'])
        await writeFile(join(cwd, 'file'), 'new\n')
        await git(['commit', '-qam', 'new'])
        const sha = await git(['rev-parse', 'HEAD'])
        const capability = gitRewrite(bunExec, local)
        expect(
          await capability.snapshot({
            workspacePath: cwd,
            branch,
            destinationRef: 'refs/autobuild/reconcile/probe/head',
          }),
        ).toBe(old)
        const ref = `refs/autobuild/archive/probe/${old}`
        await capability.archive({ workspacePath: cwd, ref, sha: old })
        await capability.archive({ workspacePath: cwd, ref, sha: old })
        await expect(capability.archive({ workspacePath: cwd, ref, sha })).rejects.toThrow(
          'invalid immutable archive',
        )
        const input = { workspacePath: cwd, branch, expected: old, sha }
        expect(await capability.replace(input)).toEqual({ kind: 'published' })
        expect(await capability.replace(input)).toEqual({ kind: 'published' })
        expect(await capability.replace({ ...input, expected: old, sha: old })).toEqual({
          kind: 'lease-mismatch',
          actual: sha,
        })
        if (!local) {
          await git(['checkout', '--detach', '-q'])
          // The remote raced ahead while its local branch stayed at the last
          // published candidate. Keep both guards explicit when synchronizing.
          await writeFile(join(cwd, 'external'), 'external work\n')
          await git(['add', 'external'])
          await git(['commit', '-qm', 'external'])
          const observed = await git(['rev-parse', 'HEAD'])
          await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
          await writeFile(join(cwd, 'next'), 'next\n')
          await git(['add', 'next'])
          await git(['commit', '-qm', 'next'])
          const next = await git(['rev-parse', 'HEAD'])
          expect(
            await capability.replace({
              workspacePath: cwd,
              branch,
              expected: observed,
              localExpected: sha,
              sha: next,
            }),
          ).toEqual({ kind: 'published' })
          expect(await git(['rev-parse', branch])).toBe(next)
        }
        const fresh = join(root, 'fresh')
        await git(['init', '-q', fresh], root)
        await git(['fetch', '--no-tags', local ? cwd : remote, ref], fresh)
        expect(await git(['show', 'FETCH_HEAD:file'], fresh)).toBe('old')
        const refs = await git(
          ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'],
          local ? cwd : remote,
        )
        expect(refs).not.toContain('archive')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

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
