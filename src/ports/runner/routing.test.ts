import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from './fake'
import { createRuntimeResolver, RuntimeConfigError, type RuntimeSpec } from './routing'
import type { RuntimeRegistry } from './runtime'

function runner(): ScriptedAgentRunner {
  return new ScriptedAgentRunner({ script: () => defaultTurnResult() })
}

const claude = runner()
const pi = runner()
const gemini = runner()
const registry: RuntimeRegistry = {
  claude: { runner: claude, servesModels: ['claude-'] },
  pi: { runner: pi, servesModels: ['kimi-', 'gpt-'], defaultModel: 'kimi-k3' },
  gemini: { runner: gemini, servesModels: ['gpt-'] },
}

function resolver(
  roles: Record<string, RuntimeSpec> = {},
  fallback = 'claude',
) {
  return createRuntimeResolver(registry, roles, fallback)
}

describe('createRuntimeResolver — raw per-field inheritance', () => {
  test('an absent default uses the wiring fallback and its built-in model', () => {
    const claudeFallback = resolver()
    expect(claudeFallback.resolve('plan')).toMatchObject({
      runner: claude,
      runtime: 'claude',
      extensions: [],
    })
    expect(claudeFallback.resolve('plan').model).toBeUndefined()

    const piFallback = resolver({}, 'pi')
    expect(piFallback.resolve('plan')).toMatchObject({
      runner: pi,
      runtime: 'pi',
      model: 'kimi-k3',
      extensions: [],
    })
  })

  test('an absent phase role inherits the explicit default pair', () => {
    const r = resolver({
      default: { runtime: 'pi', model: 'gpt-5.6-sol', extensions: ['web-access'] },
      plan: { model: 'kimi-k3' },
    })

    expect(r.resolve('implement')).toMatchObject({
      runner: pi,
      runtime: 'pi',
      model: 'gpt-5.6-sol',
      extensions: ['web-access'],
    })
    expect(r.resolve('plan').model).toBe('kimi-k3')
  })

  test('each configured field overrides or inherits independently', () => {
    const r = resolver({
      default: {
        runtime: 'pi',
        model: 'gpt-5.6-sol',
        extensions: ['web-access'],
      },
      plan: { model: 'kimi-k3' },
      'code-review': { runtime: 'gemini' },
      implement: { extensions: ['subagents'] },
    })

    expect(r.resolve('plan')).toMatchObject({
      runtime: 'pi',
      model: 'kimi-k3',
      extensions: ['web-access'],
    })
    expect(r.resolve('code-review')).toMatchObject({
      runtime: 'gemini',
      model: 'gpt-5.6-sol',
      extensions: ['web-access'],
    })
    expect(r.resolve('implement')).toMatchObject({
      runtime: 'pi',
      model: 'gpt-5.6-sol',
      extensions: ['subagents'],
    })
  })

  test('a runtime gets its own default only when no configured model exists anywhere', () => {
    const r = resolver({
      // This resolves to pi×kimi-k3, but kimi-k3 remains implicit rather than
      // becoming a raw model inherited by children.
      default: { runtime: 'pi' },
      plan: { runtime: 'claude' },
      implement: { runtime: 'pi' },
    })

    expect(r.resolve('default')).toMatchObject({ runtime: 'pi', model: 'kimi-k3' })
    expect(r.resolve('plan').runtime).toBe('claude')
    expect(r.resolve('plan').model).toBeUndefined()
    expect(r.resolve('implement').model).toBe('kimi-k3')
  })

  test('extensions replace wholesale, including an explicit empty list', () => {
    const r = resolver({
      default: { runtime: 'pi', extensions: ['subagents', 'web-access'] },
      plan: { extensions: ['web-access'] },
      implement: { extensions: [] },
      'code-review': {},
    })

    expect(r.resolve('plan').extensions).toEqual(['web-access'])
    expect(r.resolve('implement').extensions).toEqual([])
    expect(r.resolve('code-review').extensions).toEqual(['subagents', 'web-access'])
  })
})

describe('createRuntimeResolver — exact compatibility', () => {
  test('an explicit runtime/model pair resolves exactly', () => {
    expect(
      resolver({ 'code-review': { runtime: 'pi', model: 'kimi-k3' } }).resolve(
        'code-review',
      ),
    ).toMatchObject({ runner: pi, runtime: 'pi', model: 'kimi-k3' })
  })

  test('an inherited incompatible model fails instead of being substituted', () => {
    expect(() =>
      resolver({
        default: { runtime: 'pi', model: 'gpt-5.6-sol' },
        'code-review': { runtime: 'claude' },
      }),
    ).toThrow(
      /\[roles\.code-review\] resolves runtime "claude" with model "gpt-5\.6-sol", but "claude" serves only \[claude-\]/,
    )
  })

  test('a model-only role stays on the inherited runtime instead of hunting a supporter', () => {
    // pi serves kimi-k3, but the inherited/fallback runtime is claude. The
    // configured pair is therefore invalid; routing must not jump to pi.
    expect(() => resolver({ plan: { model: 'kimi-k3' } })).toThrow(
      /\[roles\.plan\] resolves runtime "claude" with model "kimi-k3"/,
    )
  })

  test('the default role itself must be compatible', () => {
    expect(() =>
      resolver({ default: { runtime: 'claude', model: 'kimi-k3' } }),
    ).toThrow(
      /\[roles\.default\] resolves runtime "claude" with model "kimi-k3".*serves only \[claude-\]/,
    )
  })

  test('unknown runtimes name the offending role and registered choices', () => {
    expect(() => resolver({ plan: { runtime: 'ghost' } })).toThrow(
      /\[roles\.plan\] resolves to runtime "ghost", which is not registered \(registered runtimes: claude, pi, gemini\)/,
    )
    expect(() => resolver({ default: { runtime: 'ghost' } })).toThrow(
      /\[roles\.default\] resolves to runtime "ghost"/,
    )
  })

  test('all bad roles are aggregated into one eager failure', () => {
    try {
      resolver({
        default: { runtime: 'pi' },
        plan: { runtime: 'ghost' },
        'code-review': { runtime: 'claude', model: 'kimi-k3' },
      })
      throw new Error('expected a RuntimeConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError)
      const e = error as RuntimeConfigError
      expect(e.problems).toHaveLength(2)
      expect(e.message).toContain('[roles.plan]')
      expect(e.message).toContain('[roles.code-review]')
    }
  })

  test('an invalid default does not hide independent child-role problems', () => {
    try {
      resolver({
        default: { runtime: 'claude', model: 'kimi-k3' },
        plan: { runtime: 'ghost', model: 'unknown' },
        'code-review': { runtime: 'pi' },
      })
      throw new Error('expected a RuntimeConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError)
      const e = error as RuntimeConfigError
      expect(e.problems).toHaveLength(2)
      expect(e.message).toContain('[roles.default]')
      expect(e.message).toContain('[roles.plan]')
      // code-review overrides the runtime and validly inherits kimi-k3.
      expect(e.message).not.toContain('[roles.code-review]')
    }
  })

  test('the reserved default entry is validated once, not cached as a phase role', () => {
    try {
      resolver({ default: { runtime: 'claude', model: 'kimi-k3' } })
      throw new Error('expected a RuntimeConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError)
      expect((error as RuntimeConfigError).problems).toHaveLength(1)
    }
  })
})
