import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import type {
  OneShotCompletion,
  OneShotCompletionInput,
} from '../ports/runner/one-shot'
import type { ProductionRuntimes } from '../ports/runner/production'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import {
  createUpgradeAgentResolver,
  UPGRADE_CONFLICT_DECLINE,
} from './upgrade-agent'

const INPUT = {
  skill: 'ab-plan',
  base: '---\nname: ab-plan\n---\nbase bytes\n',
  local: '---\nname: ab-plan\n---\nlocal bytes\n',
  incoming: '---\nname: ab-plan\n---\nincoming bytes\n',
}

function runner(): ScriptedAgentRunner {
  return new ScriptedAgentRunner({ script: () => defaultTurnResult() })
}

function config(roles: string) {
  return parseConfig(
    `[tickets]\nsource = "file"\nreadyState = "ready"\n\n${roles}`,
    'fixture.toml',
  )
}

function registration(
  oneShot: OneShotCompletion | undefined,
  servesModels: string[],
  defaultModel?: string,
) {
  return {
    runner: runner(),
    ...(oneShot !== undefined ? { oneShot } : {}),
    servesModels,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  }
}

describe('createUpgradeAgentResolver', () => {
  test('loads lazily and propagates exact versions, local bias, cwd, env, and inherited role model', async () => {
    const calls: OneShotCompletionInput[] = []
    let loads = 0
    let runtimeConstructions = 0
    const oneShot: OneShotCompletion = {
      complete: async (input) => {
        calls.push(input)
        return { text: 'resolved skill bytes\n' }
      },
    }
    const load = async (path: string) => {
      loads += 1
      expect(path).toBe(join('/target/repo', 'autobuild.toml'))
      return config(
        '[roles.default]\n' +
          'runtime = "alpha"\n' +
          'model = "alpha-default"\n\n' +
          '[roles.upgrade]\n' +
          'model = "alpha-upgrade"\n',
      )
    }
    const runtimeFactory = (): ProductionRuntimes => {
      runtimeConstructions += 1
      return {
        runtimes: {
          alpha: registration(oneShot, ['alpha-']),
        },
        defaultRuntime: 'alpha',
      }
    }

    const resolve = createUpgradeAgentResolver({
      targetRepo: '/target/repo',
      env: { API_TOKEN: 'secret', OMIT_ME: undefined },
      load,
      runtimeFactory,
    })

    expect(loads).toBe(0)
    expect(runtimeConstructions).toBe(0)
    expect(await resolve(INPUT)).toBe('resolved skill bytes\n')
    expect(loads).toBe(1)
    expect(runtimeConstructions).toBe(1)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.cwd).toBe('/target/repo')
    expect(call.env).toEqual({ API_TOKEN: 'secret' })
    expect(call.model).toBe('alpha-upgrade')
    expect(call.signal).toBeUndefined()
    expect(call.prompt).toContain('Standing bias: preserve the local customization')
    expect(call.prompt).toContain('incorporate every incoming change that does not collide')
    expect(call.prompt).toContain(`<pristine-base>\n${INPUT.base}\n</pristine-base>`)
    expect(call.prompt).toContain(`<local-customization>\n${INPUT.local}\n</local-customization>`)
    expect(call.prompt).toContain(`<incoming-default>\n${INPUT.incoming}\n</incoming-default>`)
    expect(call.prompt).toContain(UPGRADE_CONFLICT_DECLINE)
  })

  test('an explicit upgrade runtime/model override selects that one-shot capability', async () => {
    const selected: string[] = []
    const makeOneShot = (name: string): OneShotCompletion => ({
      complete: async () => {
        selected.push(name)
        return { text: `${name} result` }
      },
    })
    const resolve = createUpgradeAgentResolver({
      targetRepo: '/repo',
      env: {},
      load: async () =>
        config(
          '[roles.default]\n' +
            'runtime = "alpha"\n\n' +
            '[roles.upgrade]\n' +
            'runtime = "beta"\n' +
            'model = "beta-upgrade"\n',
        ),
      runtimeFactory: () => ({
        runtimes: {
          alpha: registration(makeOneShot('alpha'), ['alpha-'], 'alpha-default'),
          beta: registration(makeOneShot('beta'), ['beta-'], 'beta-default'),
        },
        defaultRuntime: 'alpha',
      }),
    })

    expect(await resolve(INPUT)).toBe('beta result')
    expect(selected).toEqual(['beta'])
  })

  test('only the reserved decline token maps to null', async () => {
    const outputs = [
      `  ${UPGRADE_CONFLICT_DECLINE}\n`,
      `${UPGRADE_CONFLICT_DECLINE} with prose`,
    ]
    const resolve = createUpgradeAgentResolver({
      targetRepo: '/repo',
      env: {},
      load: async () => config('[roles.default]\nruntime = "alpha"\n'),
      runtimeFactory: () => ({
        runtimes: {
          alpha: registration(
            {
              complete: async () => ({ text: outputs.shift()! }),
            },
            ['alpha-'],
          ),
        },
        defaultRuntime: 'alpha',
      }),
    })

    expect(await resolve(INPUT)).toBeNull()
    expect(await resolve(INPUT)).toBe(`${UPGRADE_CONFLICT_DECLINE} with prose`)
  })

  test('missing one-shot capability and completion failures surface to the upgrade engine', async () => {
    const withoutCapability = createUpgradeAgentResolver({
      targetRepo: '/repo',
      env: {},
      load: async () => config('[roles.default]\nruntime = "alpha"\n'),
      runtimeFactory: () => ({
        runtimes: {
          alpha: registration(undefined, ['alpha-']),
        },
        defaultRuntime: 'alpha',
      }),
    })
    await expect(withoutCapability(INPUT)).rejects.toThrow(
      /runtime "alpha".*does not provide tool-free one-shot completion/,
    )

    const failedCompletion = createUpgradeAgentResolver({
      targetRepo: '/repo',
      env: {},
      load: async () => config('[roles.default]\nruntime = "alpha"\n'),
      runtimeFactory: () => ({
        runtimes: {
          alpha: registration(
            {
              complete: async () => {
                throw new Error('provider auth failed')
              },
            },
            ['alpha-'],
          ),
        },
        defaultRuntime: 'alpha',
      }),
    })
    await expect(failedCompletion(INPUT)).rejects.toThrow('provider auth failed')
  })
})
