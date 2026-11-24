import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abOperatorDispatcher } from './operator-preference'
import { runCli } from './main'

test('local preference read/write validates atomically, preserves overrides and refuses phase authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-operator-'))
  const committed = '[tickets]\nsource = "file"\nreadyState = "ready"\n'
  const file = join(root, '.autobuild/local.toml')
  const output: string[] = []
  const run = (value?: string, env = {}) =>
    abOperatorDispatcher({
      targetRepo: root,
      value,
      env,
      json: true,
      stdout: (line) => output.push(line),
    })
  try {
    await Bun.write(join(root, 'autobuild.toml'), committed)
    await run()
    expect(JSON.parse(output.pop()!)).toEqual({ dispatcher: null, file })
    expect(await Bun.file(file).exists()).toBe(false)
    const errors: string[] = []
    const deps = {
      workspacePath: root,
      processEnv: {},
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
      openStore: () => {
        throw new Error('must not open store')
      },
    }
    expect(await runCli(['operator', 'dispatcher', '--json'], deps)).toBe(0)
    expect(JSON.parse(output.pop()!).dispatcher).toBeNull()
    for (const args of [
      [],
      ['other'],
      ['dispatcher', 'human', 'extra'],
      ['dispatcher', '--unknown'],
    ])
      expect(await runCli(['operator', ...args], deps)).toBe(1)
    expect(errors.length).toBe(4)
    await run('human')
    expect(JSON.parse(output.pop()!).dispatcher).toBe('human')
    await Bun.write(
      file,
      `${await Bun.file(file).text()}\n[hooks.notify]\ncommand = "echo hello"\n`,
    )
    await run('agent')
    expect(JSON.parse(output.pop()!).dispatcher).toBe('agent')
    expect(await Bun.file(file).text()).toContain('echo hello')
    const saved = await Bun.file(file).text()
    for (const env of [{ AB_BUILD: 'b' }, { AB_HARVEST: 'h' }, { AB_SESSION: 's' }])
      await expect(run('human', env)).rejects.toThrow('outside a build or harvest')
    await expect(run('other')).rejects.toThrow('usage:')
    expect(await Bun.file(file).text()).toBe(saved)
    for (const invalid of ['[operator', '[operator]\ndispatcher = "invalid"', 'store = "bad"']) {
      await Bun.write(file, invalid)
      await expect(run('human')).rejects.toThrow()
      expect(await Bun.file(file).text()).toBe(invalid)
    }
    expect(await Bun.file(join(root, 'autobuild.toml')).text()).toBe(committed)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
