import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Exec } from '../workspace/git-worktree'
import { bunExec } from './github'
import { gitRewrite, parseRemoteHead, publishBranch } from './git-rewrite'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-publication-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const cwd = join(root, 'repo')
  const git = async (args: string[], path = cwd) => {
    const r = await bunExec(['git', ...args], { cwd: path })
    if (r.exitCode !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  await git(['init', '--bare', remote], root)
  await git(['init', '-b', 'main', cwd], root)
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.com'])
  await writeFile(join(cwd, 'file'), 'base')
  await git(['add', 'file'])
  await git(['commit', '-qm', 'base'])
  const base = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '-b', 'ab-node/example'])
  await git(['commit', '--allow-empty', '-qm', 'intended'])
  const sha = await git(['rev-parse', 'HEAD'])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', 'origin', `${sha}:refs/heads/ab-node/example`])
  await git(['checkout', '--detach', base])
  return { root, cwd, remote, git, base, sha }
}

for (const missing of [false, true])
  test(`remote confirmation repairs ${missing ? 'absent' : 'recreated'} node cache without a second push`, async () => {
    const f = await fixture()
    if (missing) await f.git(['update-ref', '-d', 'refs/heads/ab-node/example'])
    else await f.git(['update-ref', 'refs/heads/ab-node/example', f.base])
    let pushes = 0
    const exec: Exec = async (cmd, opts) => {
      if (cmd[1] === 'push') pushes++
      return bunExec(cmd, opts)
    }
    expect(
      await gitRewrite(exec, false).replace({
        workspacePath: f.cwd,
        branch: 'ab-node/example',
        expected: f.base,
        sha: f.sha,
      }),
    ).toEqual({ kind: 'published' })
    expect(await f.git(['rev-parse', 'refs/heads/ab-node/example'])).toBe(f.sha)
    expect(await f.git(['rev-parse', 'HEAD'])).toBe(f.base)
    expect(pushes).toBe(0)
  })

test('confirmation fetches missing objects into a separate cache without changing its files', async () => {
  const f = await fixture()
  const cache = join(f.root, 'cache')
  await f.git(['clone', '--no-checkout', f.remote, cache], f.root)
  await f.git(['checkout', '--detach', f.base], cache)
  await f.git(['update-ref', 'refs/heads/ab-node/example', f.base], cache)
  // Advance after cloning, so the cache lacks the new object.
  await f.git(['checkout', '--detach', f.sha])
  await f.git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-qm',
    'next',
  ])
  const sha = await f.git(['rev-parse', 'HEAD'])
  await f.git(['push', 'origin', `${sha}:refs/heads/ab-node/example`])
  await writeFile(join(cache, 'file'), 'uncommitted')
  expect(
    await gitRewrite(bunExec, false).replace({
      workspacePath: cache,
      branch: 'ab-node/example',
      expected: f.sha,
      sha,
    }),
  ).toEqual({ kind: 'published' })
  expect(await f.git(['rev-parse', 'refs/heads/ab-node/example'], cache)).toBe(sha)
  expect(await Bun.file(join(cache, 'file')).text()).toBe('uncommitted')
  expect(await f.git(['rev-parse', 'HEAD'], cache)).toBe(f.base)
})

test('uncertain push is adopted only by exact readback; descendant candidate is contention', async () => {
  const f = await fixture()
  await f.git(['push', '--force', 'origin', `${f.base}:refs/heads/ab-node/example`])
  const exec: Exec = async (cmd, opts) => {
    const result = await bunExec(cmd, opts)
    return cmd[1] === 'push' ? { ...result, exitCode: 1, stderr: 'lost acknowledgement' } : result
  }
  const input = { workspacePath: f.cwd, branch: 'ab-node/example', expected: f.base, sha: f.sha }
  expect(await gitRewrite(exec, false).replace(input)).toEqual({ kind: 'published' })
  await f.git(['checkout', '--detach', f.sha])
  await f.git(['commit', '--allow-empty', '-qm', 'third-party'])
  const third = await f.git(['rev-parse', 'HEAD'])
  await f.git(['push', 'origin', `${third}:refs/heads/ab-node/example`])
  expect(await gitRewrite(bunExec, false).replace(input)).toEqual({
    kind: 'lease-mismatch',
    actual: third,
  })
})

test('ordinary publication confirms a failed push effect and retries without another push', async () => {
  const f = await fixture()
  await f.git(['checkout', '-b', 'ab/example', f.sha])
  let pushes = 0
  const exec: Exec = async (cmd, opts) => {
    const result = await bunExec(cmd, opts)
    if (cmd[1] === 'push') {
      pushes++
      return { ...result, exitCode: 1 }
    }
    return result
  }
  await publishBranch(exec, f.cwd, 'ab/example', f.sha)
  await publishBranch(exec, f.cwd, 'ab/example', f.sha)
  expect(pushes).toBe(1)
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
