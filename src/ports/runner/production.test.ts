import { describe, expect, test } from 'bun:test'
import { createProductionRuntimes } from './production'
import { createRuntimeResolver } from './routing'

describe('production runtime registry', () => {
  test('registers Codex with resumable and one-shot capabilities and no forced model', () => {
    const production = createProductionRuntimes()
    const codex = production.runtimes.codex
    expect(codex).toBeDefined()
    expect(codex?.runner.name).toBe('codex')
    expect(codex?.oneShot).toBeDefined()
    expect(typeof codex?.oneShot?.complete).toBe('function')
    expect(typeof codex?.initUsable).toBe('function')
    expect(codex?.servesModels).toEqual(['gpt-'])
    expect(codex?.defaultModel).toBeUndefined()
    expect(codex?.ownedArgs).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(codex?.ownedArgs).toContain('--enable')
  })

  test('rejects documented spellings that override shipped adapter invariants', () => {
    const runtimes = createProductionRuntimes().runtimes
    for (const [runtime, arg] of [
      ['claude', '-r'],
      ['claude', '--continue'],
      ['claude', '-c'],
      ['claude', '--fork-session'],
      ['claude', '--from-pr'],
      ['claude', '--teleport'],
      ['claude', '--help'],
      ['claude', '-h'],
      ['claude', '--version'],
      ['claude', '-v'],
      ['codex', '--enable'],
      ['codex', '--help'],
      ['codex', '-h'],
      ['codex', '--version'],
      ['codex', '-V'],
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

  test('registers Pi against the local provider-qualified catalog wildcard', () => {
    const pi = createProductionRuntimes().runtimes.pi
    expect(pi?.runner.name).toBe('pi')
    expect(pi?.servesModels).toEqual(['*/*'])
    expect(pi?.defaultModel).toBe('kimi-coding/k3')
    expect(pi?.ownedArgs).toContain('--no-extensions')
    expect(pi?.ownedArgs).toContain('-ne')
    expect(pi?.ownedArgs).not.toContain('--extension')
    expect(pi?.ownedArgs).not.toContain('-e')

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

  test('rejects every Pi spelling that can override bridge tool and session invariants', () => {
    const runtimes = createProductionRuntimes().runtimes
    const conflicting = [
      '-nt',
      '-ne',
      '-ns',
      '-nc',
      '-np',
      '-na',
      '--tools',
      '-t',
      '--exclude-tools',
      '-xt',
      '--no-builtin-tools',
      '-nbt',
      '--continue',
      '-c',
      '--resume',
      '-r',
      '--session',
      '--session-id',
      '--fork',
      '--approve',
      '-a',
      '--print',
      '-p',
      '--list-models',
      '--export',
      '--help',
      '-h',
      '--version',
      '-v',
    ]

    for (const arg of conflicting) {
      expect(() =>
        createRuntimeResolver(runtimes, {
          default: { runtime: 'pi' },
          plan: { args: [arg, 'conflicting-value'] },
        }),
      ).toThrow(
        `[roles.plan] argument ${JSON.stringify(arg)} conflicts with an option owned by runtime "pi"`,
      )
    }
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
