import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { createRuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistration, RuntimeRegistry } from '../ports/runner/runtime'
import { createPluginRegistry } from './registry'
import { materializePluginRuntimes } from './runtimes'

function runner(name = 'adapter'): ScriptedAgentRunner {
  const value = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
  Object.defineProperty(value, 'name', { value: name })
  return value
}

function registration(
  name: string,
  over: Partial<RuntimeRegistration> = {},
): RuntimeRegistration {
  return {
    runner: runner(name),
    servesModels: [`${name}/`],
    ...over,
  }
}

const builtins = (): RuntimeRegistry => ({
  builtin: registration('builtin'),
})

describe('materializePluginRuntimes', () => {
  test('constructs factories in registration order with stable context into a fresh registry', async () => {
    const plugins = createPluginRegistry()
    const calls: Array<{ name: string; context: unknown }> = []
    const env = { TOKEN: 'secret', OMIT: undefined }
    plugins.register({
      name: 'first-plugin',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        alpha: async (context) => {
          calls.push({ name: 'alpha', context })
          return registration('alpha-adapter')
        },
        beta: (context) => {
          calls.push({ name: 'beta', context })
          return registration('beta-adapter')
        },
      },
    })
    plugins.register({
      name: 'second-plugin',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        gamma: (context) => {
          calls.push({ name: 'gamma', context })
          return registration('gamma-adapter')
        },
      },
    })
    const base = builtins()

    const merged = await materializePluginRuntimes(base, plugins, {
      repoRoot: '/repo',
      env,
    })

    expect(Object.keys(merged)).toEqual(['builtin', 'alpha', 'beta', 'gamma'])
    expect(Object.keys(base)).toEqual(['builtin'])
    expect(merged).not.toBe(base)
    expect(calls.map((call) => call.name)).toEqual(['alpha', 'beta', 'gamma'])
    for (const call of calls) {
      expect(call.context).toEqual({ config: {}, env, repoRoot: '/repo' })
    }
    expect(calls[0]!.context).toBe(calls[1]!.context)
    expect(Object.isFrozen((calls[0]!.context as { config: object }).config)).toBe(true)
  })

  test('plugin defaults and served families use the existing eager resolver semantics', async () => {
    const plugins = createPluginRegistry()
    plugins.register({
      name: 'runtime-pack',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        custom: () => registration('different-adapter-name', {
          servesModels: ['custom-family/'],
          defaultModel: 'custom-family/default',
        }),
      },
    })
    const merged = await materializePluginRuntimes(builtins(), plugins, {
      repoRoot: '/repo',
      env: {},
    })

    const selected = createRuntimeResolver(
      merged,
      { default: { runtime: 'custom' } },
      'builtin',
    ).resolve('plan')
    expect(selected.runtime).toBe('custom')
    expect(selected.model).toBe('custom-family/default')
    expect(selected.runner.name).toBe('different-adapter-name')

    expect(() =>
      createRuntimeResolver(
        merged,
        { default: { runtime: 'custom', model: 'other/model' } },
        'builtin',
      ),
    ).toThrow(/runtime "custom".*model "other\/model".*custom-family\//s)

    expect(() =>
      createRuntimeResolver(
        merged,
        { default: { runtime: 'missing' } },
        'builtin',
      ),
    ).toThrow(/registered runtimes: builtin, custom/)
  })

  test('preserves an optional callable one-shot capability', async () => {
    const plugins = createPluginRegistry()
    const complete = async () => ({ text: 'plugin result' })
    plugins.register({
      name: 'runtime-pack',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        custom: () => registration('custom', { oneShot: { complete } }),
        sessionOnly: () => registration('session-only'),
      },
    })

    const merged = await materializePluginRuntimes({}, plugins, {
      repoRoot: '/repo',
      env: {},
    })
    expect(merged.custom!.oneShot?.complete).toBe(complete)
    expect(merged.sessionOnly!.oneShot).toBeUndefined()
  })

  test('wraps factory failures with runtime and plugin ownership', async () => {
    const plugins = createPluginRegistry()
    plugins.register({
      name: 'broken-pack',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        broken: () => {
          throw new Error('missing executable')
        },
      },
    })
    const base = builtins()

    await expect(
      materializePluginRuntimes(base, plugins, { repoRoot: '/repo', env: {} }),
    ).rejects.toThrow(
      'agent runtime "broken" factory from plugin "broken-pack" failed: missing executable',
    )
    expect(Object.keys(base)).toEqual(['builtin'])
  })

  test.each([
    ['non-object', null, 'must be an object'],
    ['missing runner', { servesModels: [] }, 'runner must be'],
    [
      'partial runner',
      { runner: { name: 'x', start() {}, continue() {} }, servesModels: [] },
      'runner.end must be a function',
    ],
    [
      'bad families',
      { runner: runner('x'), servesModels: [''] },
      'servesModels must be an array of nonblank strings',
    ],
    [
      'bad default',
      { runner: runner('x'), servesModels: ['x/'], defaultModel: 'other/model' },
      'defaultModel "other/model" is not served',
    ],
    [
      'bad one-shot',
      { runner: runner('x'), servesModels: [], oneShot: {} },
      'oneShot.complete must be a function',
    ],
  ])('rejects malformed registration: %s', async (_label, value, message) => {
    const plugins = createPluginRegistry()
    plugins.register({
      name: 'malformed-pack',
      apiVersion: '^1.0.0',
      agentRuntimes: { malformed: () => value as RuntimeRegistration },
    })

    await expect(
      materializePluginRuntimes(builtins(), plugins, {
        repoRoot: '/repo',
        env: {},
      }),
    ).rejects.toThrow(
      new RegExp(`agent runtime "malformed" from plugin "malformed-pack".*${message}`, 's'),
    )
  })

  test('rejects unexpected collisions before invoking any factory', async () => {
    const plugins = createPluginRegistry()
    let calls = 0
    plugins.register({
      name: 'custom-pack',
      apiVersion: '^1.0.0',
      agentRuntimes: {
        custom: () => {
          calls += 1
          return registration('custom')
        },
      },
    })

    await expect(
      materializePluginRuntimes(
        { custom: registration('existing') },
        plugins,
        { repoRoot: '/repo', env: {} },
      ),
    ).rejects.toThrow(
      'agent runtime "custom" from plugin "custom-pack" collides with an existing runtime registration',
    )
    expect(calls).toBe(0)
  })
})
