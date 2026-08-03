import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecResult } from '../ports/workspace/git-worktree'
import { runCli } from './main'
import { availableRelease, selfUpdate, type SelfUpdateCommand } from './self-update'
import {
  cleanupUpgradeCommitContext,
  createUpgradeCommitContext,
  loadUpgradeCommitContext,
  UPGRADE_COMMIT_CONTEXT_ENV,
} from './upgrade-commit'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function installFixture(scope: 'local' | 'global' = 'local'): Promise<{
  owner: string
  dist: string
  globalBin: string
}> {
  root = await mkdtemp(join(tmpdir(), 'ab-self-update-'))
  const owner = join(root, 'owner')
  const dist = join(owner, 'node_modules', 'autobuild')
  const globalBin = join(root, 'global-bin')
  await mkdir(join(dist, 'bin'), { recursive: true })
  await mkdir(join(dist, 'skills'))
  await mkdir(globalBin)
  await writeFile(
    join(dist, 'package.json'),
    JSON.stringify({ name: 'autobuild', version: '2.0.0', bin: { ab: 'bin/ab.ts' } }),
  )
  await writeFile(join(dist, 'bin', 'ab.ts'), '')
  await writeFile(join(dist, '.bun-tag'), 'a-fork-autobuild-a1b2c3d')
  await writeFile(
    join(owner, 'package.json'),
    JSON.stringify({ dependencies: { autobuild: 'github:a-fork/autobuild#v2.0.0' } }),
  )
  await writeFile(
    join(owner, 'bun.lock'),
    `{
      "workspaces": { "": { "dependencies": { "autobuild": "github:a-fork/autobuild#v2.0.0", }, }, },
      "packages": { "autobuild": ["autobuild@github:a-fork/autobuild#a1b2c3d", {}, "a-fork-autobuild-a1b2c3d"], },
    }`,
  )
  if (scope === 'global') await symlink(join(dist, 'bin', 'ab.ts'), join(globalBin, 'ab'))
  return { owner, dist, globalBin }
}

function result(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode }
}

function scripted(
  replies: ExecResult[],
  calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }>,
): SelfUpdateCommand {
  return async (command, options) => {
    calls.push({ command, options })
    return replies.shift() ?? result('', 'unexpected command', 99)
  }
}

describe('silent available-release probe', () => {
  test('returns only a newer exact release and never reaches installation commands', async () => {
    const fixture = await installFixture()
    for (const [tag, expected] of [
      ['v2.1.0', '2.1.0'],
      ['v2.0.0', undefined],
      ['v1.9.0', undefined],
    ] as const) {
      const calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
      expect(
        await availableRelease({
          distRoot: fixture.dist,
          command: scripted(
            [result(`${fixture.globalBin}\n`), result(`{"tag_name":"${tag}"}`)],
            calls,
          ),
        }),
      ).toBe(expected)
      expect(calls.map((call) => call.command)).toEqual([
        ['bun', 'pm', 'bin', '-g'],
        ['gh', 'api', 'repos/a-fork/autobuild/releases/latest'],
      ])
    }
  })

  test('unsupported installations and every command/response failure are silent absence', async () => {
    const fixture = await installFixture()
    await mkdir(join(fixture.dist, '.git'))
    let calls = 0
    expect(
      await availableRelease({
        distRoot: fixture.dist,
        command: async () => {
          calls += 1
          return result()
        },
      }),
    ).toBeUndefined()
    expect(calls).toBe(0)
    await rm(join(fixture.dist, '.git'), { recursive: true })

    for (const replies of [
      [result('', 'missing bun', 127)],
      [result(`${fixture.globalBin}\n`), result('', 'offline', 1)],
      [result(`${fixture.globalBin}\n`), result('not json')],
      [result(`${fixture.globalBin}\n`), result('{"tag_name":"latest"}')],
    ]) {
      expect(
        await availableRelease({
          distRoot: fixture.dist,
          command: scripted(replies, []),
        }),
      ).toBeUndefined()
    }
  })

  test('an unclassifiable distribution stops before release lookup', async () => {
    const fixture = await installFixture()
    await writeFile(
      join(fixture.owner, 'package.json'),
      JSON.stringify({ dependencies: { autobuild: 'file:../autobuild' } }),
    )
    const calls: string[][] = []
    expect(
      await availableRelease({
        distRoot: fixture.dist,
        command: async (command) => {
          calls.push(command)
          return result(`${fixture.globalBin}\n`)
        },
      }),
    ).toBeUndefined()
    expect(calls).toEqual([['bun', 'pm', 'bin', '-g']])
  })

  test('passes cancellation to helper commands and collapses abort to absence', async () => {
    const fixture = await installFixture()
    const abort = new AbortController()
    let observed: AbortSignal | undefined
    const pending = availableRelease({
      distRoot: fixture.dist,
      signal: abort.signal,
      command: async (_command, options) => {
        observed = options.signal
        return await new Promise<ExecResult>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(result('', 'aborted', 1)), {
            once: true,
          })
        })
      },
    })
    while (observed === undefined) await new Promise((resolve) => setTimeout(resolve, 1))
    abort.abort()
    expect(await pending).toBeUndefined()
    expect(observed).toBe(abort.signal)
  })
})

describe('distribution self-update orchestration', () => {
  test('latest local update resolves the fork, mutates through Bun, then only hands off', async () => {
    const fixture = await installFixture()
    const calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    const out: string[] = []
    const update = await selfUpdate({
      targetRepo: '/target/repo',
      distRoot: fixture.dist,
      env: { PATH: '/bin' },
      command: scripted(
        [
          result(`${fixture.globalBin}\n`),
          result('{"tag_name":"v2.1.0"}'),
          result('installed'),
          result('ab-plan: adopted\n'),
        ],
        calls,
      ),
      stdout: (line) => out.push(line),
      stderr: () => {},
    })

    expect(update).toEqual({ kind: 'handoff', exitCode: 0 })
    expect(calls.map((call) => call.command)).toEqual([
      ['bun', 'pm', 'bin', '-g'],
      ['gh', 'api', 'repos/a-fork/autobuild/releases/latest'],
      ['bun', 'add', '--cwd', fixture.owner, 'github:a-fork/autobuild#v2.1.0'],
      ['bun', join(fixture.dist, 'bin', 'ab.ts'), 'upgrade', '/target/repo'],
    ])
    expect(calls[3]?.options.env).toMatchObject({ PATH: '/bin', AB_SELF_UPDATE_HANDOFF: '1' })
    expect(out.join('\n')).toContain('package.json')
    expect(out.join('\n')).toContain('bun.lock')
    expect(out).toContain('ab-plan: adopted')
  })

  test('a successful install still hands off if owner metadata becomes unreadable afterward', async () => {
    const fixture = await installFixture()
    const calls: string[][] = []
    const update = await selfUpdate({
      targetRepo: '/repo',
      distRoot: fixture.dist,
      command: async (command) => {
        calls.push(command)
        if (calls.length === 1) return result(`${fixture.globalBin}\n`)
        if (calls.length === 2) return result('{"tag_name":"v2.1.0"}')
        if (calls.length === 3) {
          await Promise.all([
            rm(join(fixture.owner, 'package.json')),
            rm(join(fixture.owner, 'bun.lock')),
          ])
          return result('installed')
        }
        return result('ab-plan: adopted\n')
      },
      stdout: () => {},
      stderr: () => {},
    })

    expect(update).toEqual({ kind: 'handoff', exitCode: 0 })
    expect(calls).toHaveLength(4)
    expect(calls[3]).toEqual(['bun', join(fixture.dist, 'bin', 'ab.ts'), 'upgrade', '/repo'])
  })

  test('local owner paths reach the handoff while global updates contribute no repository files', async () => {
    const local = await installFixture()
    const localFixtureRoot = root!
    await Bun.$`git init -q`.cwd(local.owner)
    await Bun.$`git config user.name 'Upgrade Test'`.cwd(local.owner)
    await Bun.$`git config user.email upgrade@example.test`.cwd(local.owner)
    await Bun.$`git add .`.cwd(local.owner)
    await Bun.$`git commit -qm baseline`.cwd(local.owner)
    const localContext = await createUpgradeCommitContext(local.owner)
    const localCalls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    await selfUpdate({
      targetRepo: local.owner,
      distRoot: local.dist,
      upgradeCommitContextPath: localContext.path,
      command: scripted(
        [result(`${local.globalBin}\n`), result('{"tag_name":"v2.1.0"}'), result(), result()],
        localCalls,
      ),
      stdout: () => {},
      stderr: () => {},
    })
    const loadedLocal = await loadUpgradeCommitContext(localContext.path, local.owner)
    expect(loadedLocal.record.selfUpdatePaths).toEqual(['bun.lock', 'package.json'])
    expect(localCalls[3]?.options.env?.[UPGRADE_COMMIT_CONTEXT_ENV]).toBe(localContext.path)
    await cleanupUpgradeCommitContext(localContext)
    await rm(localFixtureRoot, { recursive: true, force: true })
    root = undefined

    const global = await installFixture('global')
    const target = join(root!, 'target')
    await mkdir(target)
    await Bun.$`git init -q`.cwd(target)
    await Bun.$`git config user.name 'Upgrade Test'`.cwd(target)
    await Bun.$`git config user.email upgrade@example.test`.cwd(target)
    await writeFile(join(target, 'base'), 'base\n')
    await Bun.$`git add . && git commit -qm baseline`.cwd(target)
    const globalContext = await createUpgradeCommitContext(target)
    await selfUpdate({
      targetRepo: target,
      version: '1.9.0',
      distRoot: global.dist,
      upgradeCommitContextPath: globalContext.path,
      command: scripted(
        [result(`${global.globalBin}\n`), result('{"tag_name":"v1.9.0"}'), result(), result()],
        [],
      ),
      stdout: () => {},
      stderr: () => {},
    })
    const loadedGlobal = await loadUpgradeCommitContext(globalContext.path, target)
    expect(loadedGlobal.record.selfUpdatePaths).toEqual([])
    await cleanupUpgradeCommitContext(globalContext)
  })

  test('--no-commit is forwarded explicitly to the replacement binary', async () => {
    const fixture = await installFixture()
    const calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    await selfUpdate({
      targetRepo: '/repo',
      noCommit: true,
      distRoot: fixture.dist,
      command: scripted(
        [result(`${fixture.globalBin}\n`), result('{"tag_name":"v2.1.0"}'), result(), result()],
        calls,
      ),
      stdout: () => {},
      stderr: () => {},
    })
    expect(calls[3]?.command).toEqual([
      'bun',
      join(fixture.dist, 'bin', 'ab.ts'),
      'upgrade',
      '/repo',
      '--no-commit',
    ])
  })

  test('uses global Bun operation and permits an explicit downgrade', async () => {
    const fixture = await installFixture('global')
    const calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    const update = await selfUpdate({
      targetRepo: '/repo',
      version: '1.9.0',
      distRoot: fixture.dist,
      command: scripted(
        [result(`${fixture.globalBin}\n`), result('{"tag_name":"v1.9.0"}'), result(), result()],
        calls,
      ),
      stdout: () => {},
      stderr: () => {},
    })
    expect(update.kind).toBe('handoff')
    expect(calls[1]?.command).toEqual(['gh', 'api', 'repos/a-fork/autobuild/releases/tags/v1.9.0'])
    expect(calls[2]?.command).toEqual(['bun', 'add', '--global', 'github:a-fork/autobuild#v1.9.0'])
  })

  test('does not reinstall the current latest release', async () => {
    const fixture = await installFixture()
    const calls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    const update = await selfUpdate({
      targetRepo: '/repo',
      distRoot: fixture.dist,
      command: scripted([result(`${fixture.globalBin}\n`), result('{"tag_name":"v2.0.0"}')], calls),
      stdout: () => {},
      stderr: () => {},
    })
    expect(update).toEqual({ kind: 'continue' })
    expect(calls).toHaveLength(2)
  })

  test('latest failures warn and continue, while explicit install failures stop before merge', async () => {
    const fixture = await installFixture()
    const latestCalls: Array<{ command: string[]; options: Parameters<SelfUpdateCommand>[1] }> = []
    const warnings: string[] = []
    expect(
      await selfUpdate({
        targetRepo: '/repo',
        distRoot: fixture.dist,
        command: scripted(
          [result(`${fixture.globalBin}\n`), result('', 'offline', 1)],
          latestCalls,
        ),
        stdout: () => {},
        stderr: (line) => warnings.push(line),
      }),
    ).toEqual({ kind: 'continue' })
    expect(warnings.join('\n')).toContain('offline')

    const explicitCalls: Array<{
      command: string[]
      options: Parameters<SelfUpdateCommand>[1]
    }> = []
    expect(
      await selfUpdate({
        targetRepo: '/repo',
        version: '2.1.0',
        distRoot: fixture.dist,
        command: scripted(
          [
            result(`${fixture.globalBin}\n`),
            result('{"tag_name":"v2.1.0"}'),
            result('', 'permission denied', 1),
          ],
          explicitCalls,
        ),
        stdout: () => {},
        stderr: (line) => warnings.push(line),
      }),
    ).toEqual({ kind: 'failed' })
    expect(explicitCalls).toHaveLength(3)
    expect(warnings.join('\n')).toContain('permission denied')
  })

  test('explicit mechanism failures exit nonzero without merging installed skills', async () => {
    const fixture = await installFixture()
    const errors: string[] = []
    const noGlobalTarget = join(root!, 'no-global-target')
    await mkdir(noGlobalTarget)
    expect(
      await runCli(['upgrade', noGlobalTarget, '--version', '2.1.0'], {
        workspacePath: '/repo',
        distributionRoot: fixture.dist,
        selfUpdateCommand: async () => result('', 'global bin unavailable', 1),
        stdout: () => {},
        stderr: (line) => errors.push(line),
      }),
    ).toBe(1)
    expect(errors.at(-1)).toContain('self-update failed:')
    expect(errors.at(-1)).toContain('global bin unavailable')
    expect(existsSync(join(noGlobalTarget, '.agents'))).toBe(false)

    await writeFile(
      join(fixture.owner, 'package.json'),
      JSON.stringify({ dependencies: { autobuild: 'file:../autobuild' } }),
    )
    const unknownTarget = join(root!, 'unknown-target')
    await mkdir(unknownTarget)
    let commands = 0
    expect(
      await runCli(['upgrade', unknownTarget, '--version', '2.1.0'], {
        workspacePath: '/repo',
        distributionRoot: fixture.dist,
        selfUpdateCommand: async () => {
          commands += 1
          return result(`${fixture.globalBin}\n`)
        },
        stdout: () => {},
        stderr: (line) => errors.push(line),
      }),
    ).toBe(1)
    expect(commands).toBe(1)
    expect(errors.at(-1)).toContain('self-update failed:')
    expect(errors.at(-1)).toContain('direct github: dependency')
    expect(existsSync(join(unknownTarget, '.agents'))).toBe(false)
  })

  test('CLI flags gate orchestration and a handoff status ends the parent route', async () => {
    const fixture = await installFixture()
    const target = join(root!, 'target')
    await mkdir(target)
    let updates = 0
    let resolverFactories = 0
    const errors: string[] = []
    const deps = {
      workspacePath: target,
      stdout: () => {},
      stderr: (line: string) => errors.push(line),
      selfUpdate: async (
        options: import('./self-update').SelfUpdateOptions,
      ): Promise<import('./self-update').SelfUpdateResult> => {
        updates += 1
        expect(typeof options.upgradeCommitContextPath).toBe('string')
        expect(existsSync(options.upgradeCommitContextPath!)).toBe(true)
        return { kind: 'handoff', exitCode: 7 }
      },
      upgradeResolverFactory: () => {
        resolverFactories += 1
        return async () => null
      },
    }
    expect(await runCli(['upgrade'], deps)).toBe(7)
    expect(updates).toBe(1)
    expect(resolverFactories).toBe(0)

    expect(await runCli(['upgrade', '--no-self-update', '--version', '2.0.0'], deps)).toBe(1)
    expect(errors.at(-1)).toContain('cannot be combined')
    expect(updates).toBe(1)

    expect(
      await runCli(['upgrade', target, '--no-self-update'], {
        ...deps,
        distributionRoot: fixture.dist,
      }),
    ).toBe(0)
    expect(updates).toBe(1)

    expect(await runCli(['help'], deps)).toBe(0)
    expect(updates).toBe(1)
  })

  test('source checkout refusal performs no command and still permits skill merge', async () => {
    const fixture = await installFixture()
    await mkdir(join(fixture.dist, '.git'))
    let commands = 0
    const warnings: string[] = []
    expect(
      await selfUpdate({
        targetRepo: '/repo',
        distRoot: fixture.dist,
        command: async () => {
          commands += 1
          return result()
        },
        stdout: () => {},
        stderr: (line) => warnings.push(line),
      }),
    ).toEqual({ kind: 'continue' })
    expect(commands).toBe(0)
    expect(warnings.join('\n')).toContain('source checkout')
  })
})
