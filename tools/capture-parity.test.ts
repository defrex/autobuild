import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareFrameSets, runCaptureCommand } from './capture-parity'

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
