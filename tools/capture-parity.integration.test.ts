import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { resolveBaseline, runCaptureCommand } from './capture-parity'

test('capture commands create reproducible real Git provenance for independent trees', async () => {
  const original = {
    GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
    GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
  }
  const scratch = await mkdtemp(join(tmpdir(), 'capture-provenance-'))
  try {
    const commits: string[] = []
    for (const [name, ambientDate] of [
      ['base', '2020-01-01T00:00:00Z'],
      ['head', '2030-01-01T00:00:00Z'],
    ] as const) {
      process.env.GIT_AUTHOR_DATE = ambientDate
      process.env.GIT_COMMITTER_DATE = ambientDate
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
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
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
