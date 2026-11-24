import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bunExec } from './github'
import { gitRewrite } from './git-rewrite'
import type { Exec } from '../workspace/git-worktree'

const mkdtemp = ownTempDirectories(afterEach)

for (const local of [true, false]) {
  test(`${local ? 'local-git' : 'GitHub transport'} archives and guards real rewrites on leaf and node branches`, async () => {
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
      const branches = ['ab/probe', 'ab-node/probe']
      for (const branch of branches) await git(['branch', branch])
      const remote = join(root, 'remote.git')
      if (!local) {
        await git(['init', '--bare', '-q', remote])
        await git(['remote', 'add', 'origin', remote])
        await git(['push', '-q', 'origin', ...branches])
      }
      await git(['checkout', '--detach', '-q'])
      await writeFile(join(cwd, 'file'), 'new\n')
      await git(['commit', '-qam', 'new'])
      const sha = await git(['rev-parse', 'HEAD'])
      const capability = gitRewrite(bunExec, local)
      for (const branch of branches) {
        expect(
          await capability.snapshot({
            workspacePath: cwd,
            branch,
            destinationRef: `refs/autobuild/reconcile/${branch}/head`,
          }),
        ).toBe(old)
        const ref = `refs/autobuild/archive/${branch.replace('/', '-')}/${old}`
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
          await git(['checkout', '--detach', '-q', sha])
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
        const fresh = join(root, branch.replace('/', '-'))
        await git(['init', '-q', fresh], root)
        await git(['fetch', '--no-tags', local ? cwd : remote, ref], fresh)
        expect(await git(['show', 'FETCH_HEAD:file'], fresh)).toBe('old')
        const refs = await git(
          ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'],
          local ? cwd : remote,
        )
        expect(refs).not.toContain('archive')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

/** Remote O <- A <- A2 on main's line, with A and A2 held only under
 * unadvertised staging refs, plus unrelated X on ab/other. */
async function archiveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-archive-ancestry-'))
  const remote = join(root, 'origin.git')
  const seed = join(root, 'seed')
  async function git(args: string[], cwd = seed) {
    const result = await bunExec(['git', ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  async function status(args: string[], cwd: string) {
    return (await bunExec(['git', ...args], { cwd })).exitCode
  }
  await git(['init', '--bare', '-q', '-b', 'main', remote], root)
  await git(['init', '-q', '-b', 'main', seed], root)
  await git(['config', 'user.name', 'Contract'])
  await git(['config', 'user.email', 'contract@test.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['remote', 'add', 'origin', remote])
  await writeFile(join(seed, 'file'), 'o\n')
  await git(['add', '.'])
  await git(['commit', '-qm', 'O'])
  const o = await git(['rev-parse', 'HEAD'])
  await git(['push', '-q', 'origin', 'main', `${o}:refs/heads/ab/probe`])
  await git(['commit', '--allow-empty', '-qm', 'A'])
  const a = await git(['rev-parse', 'HEAD'])
  await git(['commit', '--allow-empty', '-qm', 'A2'])
  const a2 = await git(['rev-parse', 'HEAD'])
  await git(['push', '-q', 'origin', `${a}:refs/seed/a`, `${a2}:refs/seed/a2`])
  await git(['checkout', '-q', '--orphan', 'ab/other'])
  await git(['commit', '--allow-empty', '-qm', 'X'])
  const x = await git(['rev-parse', 'HEAD'])
  await git(['push', '-q', 'origin', 'ab/other'])
  let clones = 0
  async function clone(...flags: string[]) {
    const cwd = join(root, `work-${clones++}`)
    await git(['clone', '-q', ...flags, `file://${remote}`, cwd], root)
    expect(await status(['cat-file', '-e', `${a}^{commit}`], cwd)).not.toBe(0)
    return cwd
  }
  const shallowPath = async (cwd: string) =>
    resolve(cwd, await git(['rev-parse', '--git-path', 'shallow'], cwd))
  const createArchive = async (ref: string, sha: string) => {
    await git(['update-ref', ref, sha, '0'.repeat(40)], remote)
  }
  return {
    remote,
    o,
    a,
    a2,
    x,
    git,
    status,
    clone,
    shallowPath,
    createArchive,
    ref: (sha: string) => `refs/autobuild/archive/probe/${sha}`,
  }
}

const shallowFlag = /^--(depth|deepen|unshallow|shallow-)/

test('remote archive recovery preserves ancestry across repeated and descendant recovery', async () => {
  const f = await archiveFixture()
  const cwd = await f.clone('--single-branch', '--branch', 'main')
  expect(await f.status(['cat-file', '-e', `${f.x}^{commit}`], cwd)).not.toBe(0)
  const commands: string[][] = []
  const exec: Exec = async (cmd, opts) => {
    commands.push(cmd)
    return bunExec(cmd, opts)
  }
  const capability = gitRewrite(exec, false, f.createArchive)
  await capability.archive({ workspacePath: cwd, ref: f.ref(f.a), sha: f.a })
  expect(commands.filter((cmd) => cmd[1] === 'fetch')).toEqual([
    ['git', 'fetch', '--refmap=', '--no-tags', '--no-write-fetch-head', 'origin', f.ref(f.a)],
  ])
  expect(commands.some((cmd) => cmd.some((arg) => shallowFlag.test(arg) || arg === '--all'))).toBe(
    false,
  )
  expect(await f.status(['cat-file', '-e', `${f.x}^{commit}`], cwd)).not.toBe(0)
  expect(await f.git(['cat-file', '-t', f.a], cwd)).toBe('commit')
  expect(await f.status(['merge-base', '--is-ancestor', f.o, f.a], cwd)).toBe(0)
  expect(await f.git(['rev-parse', '--is-shallow-repository'], cwd)).toBe('false')
  expect(
    await access(await f.shallowPath(cwd)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(await f.git(['rev-parse', f.ref(f.a)], f.remote)).toBe(f.a)
  const probe = { workspacePath: cwd, branch: 'ab/probe' }
  const fastForward = capability.fastForward!
  expect(await fastForward({ ...probe, expected: f.o, sha: f.a })).toEqual({
    kind: 'published',
  })

  await capability.archive({ workspacePath: cwd, ref: f.ref(f.a), sha: f.a })
  await capability.archive({ workspacePath: cwd, ref: f.ref(f.a2), sha: f.a2 })
  expect(await f.status(['merge-base', '--is-ancestor', f.o, f.a2], cwd)).toBe(0)
  expect(await f.status(['merge-base', '--is-ancestor', f.a, f.a2], cwd)).toBe(0)
  expect(await f.git(['rev-parse', '--is-shallow-repository'], cwd)).toBe('false')
  expect(await fastForward({ ...probe, expected: f.a, sha: f.a2 })).toEqual({
    kind: 'published',
  })
  expect(await f.git(['rev-parse', 'refs/heads/ab/probe'], f.remote)).toBe(f.a2)
})

test('remote archive recovery keeps an already-shallow boundary unchanged', async () => {
  const f = await archiveFixture()
  const cwd = await f.clone('--depth=1', '--branch', 'main')
  const shallow = await readFile(await f.shallowPath(cwd), 'utf8')
  expect(shallow.trim()).toBe(f.o)
  await gitRewrite(bunExec, false, f.createArchive).archive({
    workspacePath: cwd,
    ref: f.ref(f.a),
    sha: f.a,
  })
  expect(await readFile(await f.shallowPath(cwd), 'utf8')).toBe(shallow)
  expect(await f.git(['cat-file', '-t', f.a], cwd)).toBe('commit')
  expect(await f.status(['merge-base', '--is-ancestor', f.o, f.a], cwd)).toBe(0)
})

for (const shallow of [false, true]) {
  test(`failed archive recovery preserves repository state (shallow=${shallow})`, async () => {
    const f = await archiveFixture()
    const cwd = await f.clone(...(shallow ? ['--depth=1', '--branch', 'main'] : []))
    const ref = f.ref(f.a)
    const exec: Exec = async (cmd, opts) => {
      // The archive vanishes between readback and the real fetch.
      if (cmd[1] === 'fetch') await f.git(['update-ref', '-d', ref], f.remote)
      return bunExec(cmd, opts)
    }
    const exists = (path: string) =>
      access(path).then(
        () => true,
        () => false,
      )
    async function snapshot() {
      return {
        refs: await f.git(['for-each-ref'], cwd),
        head: await f.git(['rev-parse', 'HEAD'], cwd),
        status: await f.git(['status', '--porcelain'], cwd),
        shallow: await f.git(['rev-parse', '--is-shallow-repository'], cwd),
        boundary: (await exists(await f.shallowPath(cwd)))
          ? await readFile(await f.shallowPath(cwd), 'utf8')
          : null,
        fetchHead: await exists(
          resolve(cwd, await f.git(['rev-parse', '--git-path', 'FETCH_HEAD'], cwd)),
        ),
      }
    }
    const before = await snapshot()
    await expect(
      gitRewrite(exec, false, f.createArchive).archive({ workspacePath: cwd, ref, sha: f.a }),
    ).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
    expect(await f.status(['cat-file', '-e', `${f.a}^{commit}`], cwd)).not.toBe(0)
  })
}
