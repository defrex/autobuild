import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  captureEnvironment,
  compareFrameSets,
  resolveBaseline,
  runCaptureCommand,
} from './capture-parity'

describe('compareFrameSets', () => {
  const base = new Map([
    ['terminal/a.png', '1'],
    ['web/b.png', '2'],
  ])

  test('identical sets are clean', () => {
    expect(compareFrameSets(base, new Map(base))).toEqual({
      missing: [],
      extra: [],
      differing: [],
      compared: 2,
    })
  })

  test('reports a differing, a missing, and an extra frame', () => {
    const head = new Map([
      ['terminal/a.png', 'changed'],
      ['web/c.png', '3'],
    ])
    expect(compareFrameSets(base, head)).toEqual({
      missing: ['web/b.png'],
      extra: ['web/c.png'],
      differing: ['terminal/a.png'],
      compared: 1,
    })
  })
})

test('capture subprocesses produce identical fixture commit provenance despite different ambient Git dates', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'ab-capture-git-dates-'))
  async function commit(name: string, ambientDate: string): Promise<string> {
    const cwd = join(root, name)
    await mkdir(cwd)
    const env = captureEnvironment({
      ...process.env,
      GIT_AUTHOR_DATE: ambientDate,
      GIT_COMMITTER_DATE: ambientDate,
    })
    async function git(args: string[]) {
      const child = Bun.spawn(
        [
          'git',
          '-c',
          'user.name=capture',
          '-c',
          'user.email=capture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(err)
      return out.trim()
    }
    await git(['init', '-q', '-b', 'main'])
    await writeFile(
      join(cwd, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "ready"\n',
    )
    await git(['add', 'autobuild.toml'])
    await git(['commit', '-q', '-m', 'initial'])
    return git(['show', '-s', '--format=%H %aI %cI', 'HEAD'])
  }
  try {
    const base = await commit('base', '2020-01-01T00:00:00Z')
    const head = await commit('head', '2030-01-01T00:00:00Z')
    expect(head).toBe(base)
    const [, authorDate, committerDate] = base.split(' ')
    expect(new Date(authorDate!).toISOString()).toBe('2026-07-15T12:00:00.000Z')
    expect(new Date(committerDate!).toISOString()).toBe('2026-07-15T12:00:00.000Z')
    expect(
      captureEnvironment({ PATH: '/capture-bin', CHROMIUM_BIN: '/capture-chromium' }),
    ).toMatchObject({ PATH: '/capture-bin', CHROMIUM_BIN: '/capture-chromium' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capture commands create reproducible real Git provenance for independent trees', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'capture-provenance-'))
  try {
    const commits: string[] = []
    for (const name of ['base', 'head']) {
      const cwd = join(scratch, name)
      await runCaptureCommand(scratch, ['git', 'init', '-q', '-b', 'main', cwd])
      await writeFile(join(cwd, 'autobuild.toml'), 'capacity = 2\n')
      await runCaptureCommand(cwd, ['git', 'add', 'autobuild.toml'])
      await runCaptureCommand(cwd, [
        'git',
        '-c',
        'user.name=capture',
        '-c',
        'user.email=capture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'fixture',
      ])
      const child = Bun.spawn(['git', 'show', '-s', '--format=%H %aI %cI'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = (await new Response(child.stdout).text()).trim()
      expect(await child.exited).toBe(0)
      expect(
        output
          .split(' ')
          .slice(1)
          .map((value) => Date.parse(value)),
      ).toEqual([Date.parse('2026-07-15T12:00:00Z'), Date.parse('2026-07-15T12:00:00Z')])
      commits.push(output.split(' ')[0]!)
    }
    expect(commits[0]).toBe(commits[1])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('capture drains stdout and stderr while waiting for completion', async () => {
  await runCaptureCommand(tmpdir(), [
    'bun',
    '-e',
    "process.stdout.write('x'.repeat(4 * 1024 * 1024)); process.stderr.write('y'.repeat(4 * 1024 * 1024))",
  ])
}, 10_000)

test('capture infrastructure diagnostics distinguish signals and ordinary exits', async () => {
  const signalCommand = ['bun', '-e', "process.kill(process.pid, 'SIGTERM')"]
  await expect(runCaptureCommand(tmpdir(), signalCommand)).rejects.toThrow('signal SIGTERM')
  try {
    await runCaptureCommand(tmpdir(), ['bun', '-e', 'process.exit(7)'])
    throw new Error('expected capture failure')
  } catch (error) {
    expect(String(error)).toContain('capture infrastructure failure')
    expect(String(error)).toContain('bun -e process.exit(7)')
    expect(String(error)).toContain(tmpdir())
    expect(String(error)).toContain('exit 7, signal none, source unknown')
    expect(String(error)).not.toContain('capture parity FAILED')
  }
})

test('recorded baseline resolves without default branch refs and invalid inputs fail before capture', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'capture-baseline-'))
  async function git(args: string[]) {
    const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(err)
    return out.trim()
  }
  async function commit(message: string) {
    await git([
      '-c',
      'user.name=capture',
      '-c',
      'user.email=capture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      message,
    ])
  }
  try {
    await git(['init', '-q', '-b', 'build'])
    await commit('base')
    const base = await git(['rev-parse', 'HEAD'])
    await commit('head')
    expect(await resolveBaseline(['--base', base], cwd)).toEqual({ baseRef: base, baseSha: base })
    await expect(resolveBaseline([], cwd)).rejects.toThrow('No default baseline')
    await expect(resolveBaseline(['--base'], cwd)).rejects.toThrow('--base requires a value')
    await expect(resolveBaseline(['--base', '--other'], cwd)).rejects.toThrow(
      '--base requires a value',
    )
    await expect(resolveBaseline(['--base', 'not-a-commit'], cwd)).rejects.toThrow('rev-parse')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
