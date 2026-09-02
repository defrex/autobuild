import { describe, expect, test } from 'bun:test'
import { createProductionRuntimes } from './production'
import { createRuntimeResolver } from './routing'

describe('production runtime registry', () => {
  test('registers exact model, protocol, and prompt-boundary ownership metadata', () => {
    const production = createProductionRuntimes()
    const { claude, codex, pi } = production.runtimes

    expect(claude?.ownedArgs).toEqual(['-p', '--print', '--output-format', '--model'])
    expect(codex?.ownedArgs).toEqual(['--json', '--model', '-m'])
    expect(pi?.ownedArgs).toEqual(['--mode', '--model'])
    expect(claude?.promptBoundary).toBe('--')
    expect(codex?.promptBoundary).toBe('--')
    expect(pi?.promptBoundary).toBeUndefined()

    expect(codex?.runner.name).toBe('codex')
    expect(codex?.oneShot).toBeDefined()
    expect(typeof codex?.oneShot?.complete).toBe('function')
    expect(typeof codex?.initUsable).toBe('function')
    expect(codex?.servesModels).toEqual(['gpt-'])
    expect(codex?.defaultModel).toBeUndefined()
    expect(pi?.runner.name).toBe('pi')
    expect(pi?.servesModels).toEqual(['*/*'])
    expect(pi?.defaultModel).toBe('kimi-coding/k3')
  })

  test('rejects only model and parsed-protocol spellings, including real aliases', () => {
    const runtimes = createProductionRuntimes().runtimes
    for (const [runtime, arg] of [
      ['claude', '-p'],
      ['claude', '--print'],
      ['claude', '--output-format'],
      ['claude', '--model'],
      ['codex', '--json'],
      ['codex', '--model'],
      ['codex', '-m'],
      ['codex', '-mgpt-5.4'],
      ['pi', '--mode'],
      ['pi', '--model'],
    ] as const) {
      expect(() =>
        createRuntimeResolver(runtimes, {
          default: { runtime },
          plan: { args: [arg, 'conflicting-value'] },
        }),
      ).toThrow(
        `[roles.plan] argument ${JSON.stringify(arg)} conflicts with an option owned by runtime "${runtime}"`,
      )
    }
  })

  test('rejects the Autobuild-owned Claude and Codex prompt boundary', () => {
    const runtimes = createProductionRuntimes().runtimes
    for (const runtime of ['claude', 'codex'] as const) {
      expect(() =>
        createRuntimeResolver(runtimes, {
          default: { runtime },
          implement: { args: ['--'] },
        }),
      ).toThrow(
        `[roles.implement] argument "--" conflicts with the prompt boundary for runtime "${runtime}". Remove it because Autobuild owns and appends this prompt separator.`,
      )
    }
  })

  test('passes every other option category through freeform', () => {
    const runtimes = createProductionRuntimes().runtimes
    const cases = [
      [
        'claude',
        [
          '-m',
          '--permission-mode',
          'plan',
          '--resume',
          '--tools',
          '--effort',
          'high',
          'prefix--suffix',
          '--=value',
        ],
      ],
      [
        'codex',
        [
          '--sandbox',
          'workspace-write',
          '--ask-for-approval',
          'never',
          '--enable',
          'web_search',
          '--help',
          '--future-option',
          'prefix--suffix',
          '--=value',
        ],
      ],
      [
        'pi',
        [
          '-m',
          '--session',
          'operator-session',
          '--tools',
          'read',
          '--skill',
          'custom',
          '--thinking',
          'high',
          '--extension',
          './explicit.js',
          '--no-extensions',
          '--help',
          '--',
        ],
      ],
    ] as const

    for (const [runtime, args] of cases) {
      const resolved = createRuntimeResolver(runtimes, {
        default: { runtime },
        plan: { args: [...args] },
      }).resolve('plan')
      expect(resolved.args).toEqual(args)
    }
  })

  test('registers Pi against the local provider-qualified catalog wildcard', () => {
    const future = createRuntimeResolver(createProductionRuntimes().runtimes, {
      default: {
        runtime: 'pi',
        model: 'future-provider/new-model',
        args: ['--extension', './explicit.js'],
      },
    })
    expect(future.resolve('plan').model).toBe('future-provider/new-model')
    expect(future.resolve('plan').args).toEqual(['--extension', './explicit.js'])
  })

  test('validates Codex model families eagerly and delegates an omitted model', () => {
    const production = createProductionRuntimes()
    const omitted = createRuntimeResolver(production.runtimes, {
      default: { runtime: 'codex' },
    })
    expect(omitted.resolve('plan')).toMatchObject({ runtime: 'codex' })
    expect(omitted.resolve('plan').model).toBeUndefined()

    const explicit = createRuntimeResolver(production.runtimes, {
      default: { runtime: 'codex', model: 'gpt-5.4' },
    })
    expect(explicit.resolve('implement').model).toBe('gpt-5.4')

    for (const model of ['openai-codex/gpt-5.4', 'claude-opus-4']) {
      expect(() =>
        createRuntimeResolver(production.runtimes, {
          default: { runtime: 'codex', model },
        }),
      ).toThrow(/runtime "codex".*serves only \[gpt-\]/)
    }
  })
})
