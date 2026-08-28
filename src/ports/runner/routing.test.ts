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
  claude: {
    runner: claude,
    servesModels: ['claude-'],
    ownedArgs: ['--model', '-m'],
    promptBoundary: '--',
  },
  pi: { runner: pi, servesModels: ['kimi-', 'gpt-'], defaultModel: 'kimi-k3' },
  gemini: { runner: gemini, servesModels: ['gpt-'] },
}

function resolver(roles: Record<string, RuntimeSpec> = {}) {
  const configured = Object.hasOwn(roles, 'default')
    ? roles
    : { default: { runtime: 'claude' }, ...roles }
  return createRuntimeResolver(registry, configured)
}

function runtimeConfigError(create: () => unknown): RuntimeConfigError {
  try {
    create()
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigError)
    return error as RuntimeConfigError
  }
  throw new Error('expected a RuntimeConfigError')
}

describe('createRuntimeResolver — raw per-field inheritance', () => {
  test('an absent default is rejected with a copyable fix and available runtimes', () => {
    expect(() => createRuntimeResolver(registry, {})).toThrow(
      /\[roles\.default\].*missing required runtime.*\[roles\.default\].*runtime = "<runtime>".*Available runtimes: claude, pi, gemini/s,
    )
  })

  test('an absent phase role inherits the explicit default pair', () => {
    const r = resolver({
      default: { runtime: 'pi', model: 'gpt-5.6-sol', args: ['web-access'] },
      plan: { model: 'kimi-k3' },
    })

    expect(r.resolve('implement')).toMatchObject({
      runner: pi,
      runtime: 'pi',
      model: 'gpt-5.6-sol',
      args: ['web-access'],
    })
    expect(r.resolve('plan').model).toBe('kimi-k3')
  })

  test('each configured field overrides or inherits independently', () => {
    const r = resolver({
      default: {
        runtime: 'pi',
        model: 'gpt-5.6-sol',
        args: ['web-access'],
      },
      plan: { model: 'kimi-k3' },
      'code-review': { runtime: 'gemini' },
      implement: { args: ['subagents'] },
    })

    expect(r.resolve('plan')).toMatchObject({
      runtime: 'pi',
      model: 'kimi-k3',
      args: ['web-access'],
    })
    expect(r.resolve('code-review')).toMatchObject({
      runtime: 'gemini',
      model: 'gpt-5.6-sol',
      args: ['web-access'],
    })
    expect(r.resolve('implement')).toMatchObject({
      runtime: 'pi',
      model: 'gpt-5.6-sol',
      args: ['subagents'],
    })
  })

  test('session budgets fall back to policy, inherit default, and override per role', () => {
    const policyOnly = createRuntimeResolver(registry, { default: { runtime: 'pi' } }, 90)
    expect(policyOnly.resolve('plan').sessionBudgetSeconds).toBe(90)

    const roles = createRuntimeResolver(
      registry,
      {
        default: { runtime: 'pi', sessionBudgetSeconds: 120 },
        plan: {},
        implement: { sessionBudgetSeconds: 240 },
      },
      90,
    )
    expect(roles.resolve('plan').sessionBudgetSeconds).toBe(120)
    expect(roles.resolve('implement').sessionBudgetSeconds).toBe(240)
    expect(roles.resolve('implement').alternates).toEqual([])
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

  test('args replace wholesale, including an explicit empty list', () => {
    const r = resolver({
      default: { runtime: 'pi', args: ['subagents', 'web-access'] },
      plan: { args: ['web-access'] },
      implement: { args: [] },
      'code-review': {},
    })

    expect(r.resolve('plan').args).toEqual(['web-access'])
    expect(r.resolve('implement').args).toEqual([])
    expect(r.resolve('code-review').args).toEqual(['subagents', 'web-access'])
  })
})

describe('createRuntimeResolver — ordered alternates', () => {
  test('inherits the default list and overlays each entry on the concrete primary', () => {
    const r = resolver({
      default: {
        runtime: 'pi',
        model: 'gpt-5.6-sol',
        args: ['web-access'],
        alternates: [{ runtime: 'gemini', args: [] }],
      },
      plan: { model: 'gpt-plan', args: ['subagents'] },
    })

    expect(r.resolve('plan').alternates).toEqual([
      expect.objectContaining({
        runner: gemini,
        runtime: 'gemini',
        model: 'gpt-plan',
        args: [],
      }),
    ])
  })

  test('a role list replaces the default wholesale, including explicit []', () => {
    const r = resolver({
      default: { runtime: 'pi', alternates: [{ runtime: 'claude' }] },
      plan: { alternates: [] },
      implement: {
        alternates: [
          { runtime: 'gemini', model: 'gpt-first' },
          { runtime: 'claude', model: 'claude-second' },
        ],
      },
    })
    expect(r.resolve('plan').alternates).toEqual([])
    expect(
      r.resolve('implement').alternates.map(({ runtime, model }) => ({ runtime, model })),
    ).toEqual([
      { runtime: 'gemini', model: 'gpt-first' },
      { runtime: 'claude', model: 'claude-second' },
    ])
  })

  test('all indexed alternate problems join the eager aggregate', () => {
    try {
      resolver({
        default: { runtime: 'pi' },
        plan: {
          alternates: [{ runtime: 'ghost' }, { runtime: 'claude', model: 'kimi-k3' }],
        },
      })
      throw new Error('expected a RuntimeConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError)
      expect((error as RuntimeConfigError).problems).toHaveLength(2)
      expect(String(error)).toContain('[roles.plan].alternates[0]')
      expect(String(error)).toContain('[roles.plan].alternates[1]')
    }
  })
})

describe('createRuntimeResolver — owned argv validation', () => {
  test('rejects exact aliases and --option=value forms while preserving supplemental args', () => {
    const error = runtimeConfigError(() =>
      resolver({
        plan: { args: ['--model=claude-opus', '--permission-mode', 'plan'] },
        implement: { args: ['-mclaude-opus'] },
      }),
    )
    expect(error.problems).toEqual([
      '[roles.plan] argument "--model=claude-opus" conflicts with an option owned by runtime "claude"',
      '[roles.implement] argument "-mclaude-opus" conflicts with an option owned by runtime "claude"',
    ])

    expect(
      resolver({ plan: { args: ['--permission-mode', 'plan'] } }).resolve('plan').args,
    ).toEqual(['--permission-mode', 'plan'])
  })

  test('validates alternate args against the alternate runtime and labels the indexed entry', () => {
    const error = runtimeConfigError(() =>
      resolver({ plan: { alternates: [{ runtime: 'claude', args: ['--model=x'] }] } }),
    )
    expect(error.problems[0]).toContain('[roles.plan].alternates[0]')
    expect(error.problems[0]).toContain('runtime "claude"')
  })

  test('rejects an exact prompt boundary on primary and alternate targets before launch', () => {
    const boundaryRunner = runner()
    const boundaryRegistry: RuntimeRegistry = {
      claude: {
        runner: boundaryRunner,
        servesModels: ['claude-'],
        promptBoundary: '--',
      },
    }
    const error = runtimeConfigError(() =>
      createRuntimeResolver(boundaryRegistry, {
        default: { runtime: 'claude' },
        implement: {
          args: ['--'],
          alternates: [{ args: ['--'] }],
        },
      }),
    )

    expect(error.problems).toEqual([
      '[roles.implement] argument "--" conflicts with the prompt boundary for runtime "claude". Remove it because Autobuild owns and appends this prompt separator.',
      '[roles.implement].alternates[0] argument "--" conflicts with the prompt boundary for runtime "claude". Remove it because Autobuild owns and appends this prompt separator.',
    ])
    expect(boundaryRunner.sessions.size).toBe(0)
  })

  test('prompt-boundary matching is exact, ordered, and capability-scoped', () => {
    const nearMisses = ['--future-option', 'prefix--suffix', '--=value', 'passthrough-value']
    expect(resolver({ plan: { args: nearMisses } }).resolve('plan').args).toEqual(nearMisses)

    const piArgs = ['before', '--', 'after']
    expect(
      resolver({ default: { runtime: 'pi', args: piArgs } }).resolve('implement').args,
    ).toEqual(piArgs)
  })
})

describe('createRuntimeResolver — exact compatibility', () => {
  test('an explicit runtime/model pair resolves exactly', () => {
    expect(
      resolver({ 'code-review': { runtime: 'pi', model: 'kimi-k3' } }).resolve('code-review'),
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
    expect(() => resolver({ default: { runtime: 'claude', model: 'kimi-k3' } })).toThrow(
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

  describe('runtime names inherited from Object.prototype are not registrations', () => {
    const inheritedNames = ['constructor', 'toString', 'valueOf']
    const notRegistered = (label: string, runtime: string) =>
      `${label} resolves to runtime "${runtime}", which is not registered ` +
      '(registered runtimes: claude, pi, gemini)'

    for (const runtime of inheritedNames) {
      test(`rejects "${runtime}" on [roles.default]`, () => {
        const error = runtimeConfigError(() => resolver({ default: { runtime } }))
        expect(error.problems).toEqual([notRegistered('[roles.default]', runtime)])
      })

      test(`rejects "${runtime}" on an overriding role`, () => {
        const error = runtimeConfigError(() => resolver({ plan: { runtime } }))
        expect(error.problems).toEqual([notRegistered('[roles.plan]', runtime)])
      })

      test(`rejects "${runtime}" on every role that inherits it`, () => {
        const error = runtimeConfigError(() =>
          resolver({ default: { runtime }, plan: {}, implement: {} }),
        )
        expect(error.problems).toEqual([
          notRegistered('[roles.default]', runtime),
          notRegistered('[roles.plan]', runtime),
          notRegistered('[roles.implement]', runtime),
        ])
      })
    }
  })

  describe('an own registration may use an Object.prototype name', () => {
    for (const runtime of ['constructor', 'toString', 'valueOf']) {
      test(`resolves a genuine own "${runtime}" registration`, () => {
        const collidingRunner = runner()
        const ownRegistry: RuntimeRegistry = {
          claude: registry.claude!,
          [runtime]: {
            runner: collidingRunner,
            servesModels: [`${runtime}-`],
            defaultModel: `${runtime}-default`,
          },
        }

        const inherited = createRuntimeResolver(ownRegistry, {
          default: { runtime },
        }).resolve(runtime)
        expect(inherited).toMatchObject({
          runner: collidingRunner,
          runtime,
          model: `${runtime}-default`,
        })

        const overridden = createRuntimeResolver(ownRegistry, {
          default: { runtime: 'claude' },
          plan: { runtime, model: `${runtime}-model` },
        }).resolve('plan')
        expect(overridden).toMatchObject({
          runner: collidingRunner,
          runtime,
          model: `${runtime}-model`,
        })

        expect(() =>
          createRuntimeResolver(ownRegistry, {
            default: { runtime, model: 'incompatible' },
          }),
        ).toThrow(
          `[roles.default] resolves runtime "${runtime}" with model "incompatible", but ` +
            `"${runtime}" serves only [${runtime}-]`,
        )
      })
    }
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

/**
 * `resolve(role, ...aliases)` answers ONE question: which declared key applies.
 * The earliest declared candidate wins — that single rule is what lets an agent
 * verify step route by its step name (§9) while its deprecated skill-name key
 * keeps working for configs written before the rule was stated.
 */
describe('createRuntimeResolver — deprecated alias candidates', () => {
  const roles = {
    default: { runtime: 'claude' },
    e2e: { runtime: 'pi', model: 'kimi-k3' },
    'ab-verify-e2e': { runtime: 'gemini', model: 'gpt-5.6-sol' },
  }

  test('an alias resolves when the primary key is undeclared', () => {
    const r = resolver({ default: roles.default, 'ab-verify-e2e': roles['ab-verify-e2e'] })
    expect(r.resolve('e2e', 'ab-verify-e2e')).toMatchObject({
      runtime: 'gemini',
      model: 'gpt-5.6-sol',
    })
  })

  test('the primary key wins when both are declared', () => {
    expect(resolver(roles).resolve('e2e', 'ab-verify-e2e')).toMatchObject({
      runtime: 'pi',
      model: 'kimi-k3',
    })
  })

  test('an alias never shadows an explicitly declared primary', () => {
    const r = resolver({ default: roles.default, e2e: roles.e2e })
    expect(r.resolve('e2e', 'ab-verify-e2e')).toMatchObject({ runtime: 'pi', model: 'kimi-k3' })
    // …and the alias, requested on its own, is simply undeclared.
    expect(r.resolve('ab-verify-e2e').runtime).toBe('claude')
  })

  test('neither declared falls back to [roles.default], exactly as before', () => {
    const r = resolver({ default: { runtime: 'pi', model: 'kimi-k3' } })
    expect(r.resolve('e2e', 'ab-verify-e2e')).toMatchObject({ runtime: 'pi', model: 'kimi-k3' })
  })

  test('the RESERVED primary wins over a later declared alias', () => {
    // The case a naive `resolvedRoles`-only walk gets backwards: `default` is
    // deliberately never cached, so an alias would otherwise outrank an agent
    // verify step literally named `default`.
    const r = resolver({
      default: { runtime: 'pi', model: 'kimi-k3' },
      x: { runtime: 'gemini', model: 'gpt-5.6-sol' },
    })
    expect(r.resolve('default', 'x')).toMatchObject({ runtime: 'pi', model: 'kimi-k3' })
  })

  test('candidate order is truthful past `default` — it terminates the walk', () => {
    const r = resolver({
      default: { runtime: 'pi', model: 'kimi-k3' },
      b: { runtime: 'gemini', model: 'gpt-5.6-sol' },
    })
    // `a` is undeclared, `default` matches at its position, `b` is never consulted.
    expect(r.resolve('a', 'default', 'b')).toMatchObject({ runtime: 'pi', model: 'kimi-k3' })
  })

  // Verify step names are an open set, so `constructor`, `toString`, and
  // friends are legal step names — and a cache with a normal prototype answers
  // them with an inherited FUNCTION, which reads as "declared".
  describe('a prototype-colliding key is only ever declared on purpose', () => {
    for (const colliding of ['constructor', 'toString', 'valueOf', '__proto__']) {
      test(`an undeclared "${colliding}" primary still consults the declared alias`, () => {
        const r = resolver({
          default: { runtime: 'claude' },
          [`ab-verify-${colliding}`]: { runtime: 'pi', model: 'kimi-k3' },
        })
        expect(r.resolve(colliding, `ab-verify-${colliding}`)).toMatchObject({
          runner: pi,
          runtime: 'pi',
          model: 'kimi-k3',
        })
      })

      test(`an undeclared "${colliding}" with no alias falls back to the default`, () => {
        const r = resolver({ default: { runtime: 'pi', model: 'kimi-k3' } })
        expect(r.resolve(colliding)).toMatchObject({ runner: pi, runtime: 'pi' })
      })
    }

    test('…and a DECLARED prototype-colliding key still wins over its alias', () => {
      const r = resolver({
        default: { runtime: 'claude' },
        constructor: { runtime: 'pi', model: 'kimi-k3' },
        'ab-verify-constructor': { runtime: 'gemini', model: 'gpt-5.6-sol' },
      })
      expect(r.resolve('constructor', 'ab-verify-constructor')).toMatchObject({
        runtime: 'pi',
        model: 'kimi-k3',
      })
    })

    test('every resolution is a runtime, never an inherited function', () => {
      const r = resolver({ default: { runtime: 'claude' } })
      for (const key of ['constructor', 'toString', 'hasOwnProperty', 'isPrototypeOf']) {
        const resolved = r.resolve(key)
        // The failure this guards: destructuring `Object.prototype.constructor`
        // in executeSession yields undefined runner/runtime and kills the
        // session instead of routing it.
        expect(typeof resolved).toBe('object')
        expect(resolved.runner).toBeDefined()
        expect(resolved.runtime).toBe('claude')
      }
    })
  })

  test('the eager error is untouched: a role nothing requests is still validated', () => {
    // The new warning path reports declared-but-unrequested keys; it must never
    // soften the eager runtime/model failure that already covers them.
    expect(() => resolver({ ghost: { runtime: 'nonesuch' } })).toThrow(
      /\[roles\.ghost\] resolves to runtime "nonesuch", which is not registered/,
    )
  })
})
