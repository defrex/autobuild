import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from './fake'
import { createRuntimeResolver, RuntimeConfigError, type RuntimeSpec } from './routing'
import type { RuntimeRegistry } from './runtime'

function runner(): ScriptedAgentRunner {
  return new ScriptedAgentRunner({ script: () => defaultTurnResult() })
}

// A registry with three runtimes: claude (Claude models, no default model —
// its SDK default), pi (Kimi + GPT, default kimi-k3), and gemini (a second
// GPT-serving runtime, to force model-only ambiguity).
const claude = runner()
const pi = runner()
const gemini = runner()
const registry: RuntimeRegistry = {
  claude: { runner: claude, servesModels: ['claude-'] },
  pi: { runner: pi, servesModels: ['kimi-', 'gpt-'], defaultModel: 'kimi-k3' },
  gemini: { runner: gemini, servesModels: ['gpt-'] },
}

/** Build a resolver over `registry` and resolve one role's spec. */
function resolveRole(
  role: string,
  spec: RuntimeSpec,
  agent: RuntimeSpec | undefined = undefined,
  fallback = 'claude',
): { runner: unknown; runtime: string; model?: string } {
  const resolver = createRuntimeResolver(registry, agent, fallback, { [role]: spec })
  return resolver.resolve(role)
}

describe('resolveSpec — role overrides, most-specific-first', () => {
  test('runtime + model → exactly that pair', () => {
    const r = resolveRole('code-review', { runtime: 'pi', model: 'kimi-k3' })
    expect(r.runtime).toBe('pi')
    expect(r.runner).toBe(pi)
    expect(r.model).toBe('kimi-k3')
  })

  test('runtime only → that runtime with its own default model', () => {
    const r = resolveRole('plan', { runtime: 'pi' })
    expect(r.runtime).toBe('pi')
    expect(r.model).toBe('kimi-k3')
  })

  test('runtime only with no declared default model → model undefined', () => {
    const r = resolveRole('plan', { runtime: 'claude' })
    expect(r.runtime).toBe('claude')
    expect(r.model).toBeUndefined()
  })

  test('model only → the default runtime wins when it qualifies, even if others also do', () => {
    // gpt-* is served by both pi and gemini; with default = pi, pi wins.
    const r = resolveRole('plan', { model: 'gpt-5.6-sol' }, { runtime: 'pi' })
    expect(r.runtime).toBe('pi')
    expect(r.model).toBe('gpt-5.6-sol')
  })

  test('model only → the single supporter when the default does not qualify', () => {
    // default = claude (serves only claude-); kimi-* has exactly one supporter, pi.
    const r = resolveRole('plan', { model: 'kimi-k3' })
    expect(r.runtime).toBe('pi')
    expect(r.model).toBe('kimi-k3')
  })

  test('neither → the default pair', () => {
    const r = resolveRole('finalize', {}, { runtime: 'pi', model: 'kimi-k3' })
    expect(r.runtime).toBe('pi')
    expect(r.model).toBe('kimi-k3')
  })
})

describe('resolveSpec — loud errors', () => {
  test('runtime + model the runtime cannot serve', () => {
    expect(() =>
      createRuntimeResolver(registry, undefined, 'claude', {
        'code-review': { runtime: 'claude', model: 'kimi-k3' },
      }),
    ).toThrow(/pins runtime "claude" with model "kimi-k3", but "claude" serves only \[claude-\]/)
  })

  test('a role naming an unregistered runtime', () => {
    expect(() =>
      createRuntimeResolver(registry, undefined, 'claude', {
        plan: { runtime: 'ghost' },
      }),
    ).toThrow(/\[roles\].plan names runtime "ghost", which is not registered/)
  })

  test('model only with zero supporters', () => {
    expect(() =>
      createRuntimeResolver(registry, undefined, 'claude', {
        plan: { model: 'llama-3' },
      }),
    ).toThrow(/requests model "llama-3", but no registered runtime serves it/)
  })

  test('model only with multiple non-default supporters names the ambiguity', () => {
    // default = claude; gpt-* is served by pi AND gemini, neither the default.
    expect(() =>
      createRuntimeResolver(registry, undefined, 'claude', {
        plan: { model: 'gpt-5.6-sol' },
      }),
    ).toThrow(/served by multiple runtimes \(pi, gemini\) and none is the default/)
  })

  test('an unregistered runtime in the [agent] default fails', () => {
    expect(() =>
      createRuntimeResolver(registry, { runtime: 'ghost' }, 'claude', {}),
    ).toThrow(/\[agent\] default names runtime "ghost", which is not registered/)
  })

  test('aggregates every problem into one error naming both bad roles', () => {
    try {
      createRuntimeResolver(registry, undefined, 'claude', {
        plan: { runtime: 'ghost' },
        'code-review': { runtime: 'claude', model: 'kimi-k3' },
      })
      throw new Error('expected a RuntimeConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError)
      const e = error as RuntimeConfigError
      expect(e.problems).toHaveLength(2)
      expect(e.message).toContain('[roles].plan')
      expect(e.message).toContain('[roles].code-review')
    }
  })
})

describe('default pair', () => {
  test('[agent] absent ⇒ the fallback runtime with its own default model', () => {
    // fallback = pi (defaultModel kimi-k3).
    const resolver = createRuntimeResolver(registry, undefined, 'pi', {})
    const r = resolver.resolve('anything')
    expect(r.runtime).toBe('pi')
    expect(r.model).toBe('kimi-k3')
  })

  test('[agent] absent with a fallback that has no default model ⇒ no model (today’s behavior)', () => {
    const resolver = createRuntimeResolver(registry, undefined, 'claude', {})
    const r = resolver.resolve('anything')
    expect(r.runtime).toBe('claude')
    expect(r.model).toBeUndefined()
  })

  test('a role absent from config resolves to the default pair', () => {
    const resolver = createRuntimeResolver(registry, { runtime: 'pi' }, 'claude', {
      plan: { runtime: 'claude' },
    })
    // 'implement' was never declared → default pair (pi).
    expect(resolver.resolve('implement').runtime).toBe('pi')
    expect(resolver.resolve('plan').runtime).toBe('claude')
  })

  test('roles resolve model-only against the default pair’s runtime, not the fallback', () => {
    // default pair = pi; a role model-only for gpt-* prefers pi (the default),
    // resolving the pi/gemini ambiguity that the fallback (claude) would not.
    const resolver = createRuntimeResolver(registry, { runtime: 'pi' }, 'claude', {
      plan: { model: 'gpt-5.6-sol' },
    })
    expect(resolver.resolve('plan').runtime).toBe('pi')
  })
})
