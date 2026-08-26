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
  })

  test('registers Pi against the local provider-qualified catalog wildcard', () => {
    const pi = createProductionRuntimes().runtimes.pi
    expect(pi?.runner.name).toBe('pi')
    expect(pi?.servesModels).toEqual(['*/*'])
    expect(pi?.defaultModel).toBe('kimi-coding/k3')

    const future = createRuntimeResolver(createProductionRuntimes().runtimes, {
      default: { runtime: 'pi', model: 'future-provider/new-model' },
    })
    expect(future.resolve('plan').model).toBe('future-provider/new-model')
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
