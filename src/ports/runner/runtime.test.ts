import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from './fake'
import { serves, type RuntimeRegistration, validateRuntimeRegistration } from './runtime'

function reg(servesModels: string[]): RuntimeRegistration {
  return {
    runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
    servesModels,
  }
}

describe('runtime registration validation', () => {
  test('preserves an optional init usability probe', async () => {
    const initUsable = async () => true
    const registration = validateRuntimeRegistration({ ...reg([]), initUsable })
    expect(registration.initUsable).toBe(initUsable)
  })

  test('rejects a malformed init usability probe', () => {
    expect(() => validateRuntimeRegistration({ ...reg([]), initUsable: true })).toThrow(
      'initUsable must be a function when provided',
    )
  })

  test('validates adapter-owned option metadata', () => {
    expect(
      validateRuntimeRegistration({ ...reg([]), ownedArgs: ['--model', '-m'] }).ownedArgs,
    ).toEqual(['--model', '-m'])
    expect(() => validateRuntimeRegistration({ ...reg([]), ownedArgs: ['model'] })).toThrow(
      'ownedArgs must be a unique array',
    )
    expect(() =>
      validateRuntimeRegistration({ ...reg([]), ownedArgs: ['--model', '--model'] }),
    ).toThrow('ownedArgs must be a unique array')
  })

  test('validates prompt-boundary metadata independently of owned options', () => {
    expect(validateRuntimeRegistration({ ...reg([]), promptBoundary: '--' }).promptBoundary).toBe(
      '--',
    )
    for (const promptBoundary of ['', '   ', 42]) {
      expect(() => validateRuntimeRegistration({ ...reg([]), promptBoundary })).toThrow(
        'promptBoundary must be a nonblank string when provided',
      )
    }
  })

  test('accepts only the explicit provider-qualified wildcard syntax', () => {
    expect(validateRuntimeRegistration(reg(['*/*'])).servesModels).toEqual(['*/*'])
    expect(() => validateRuntimeRegistration(reg(['openai/*']))).toThrow(
      'provider-qualified wildcard',
    )
  })
})

describe('serves — prefix-family matching', () => {
  test('matches a model whose id starts with a declared family', () => {
    expect(serves(reg(['kimi-', 'gpt-']), 'kimi-k3')).toBe(true)
    expect(serves(reg(['kimi-', 'gpt-']), 'gpt-5.6-sol')).toBe(true)
    expect(serves(reg(['claude-']), 'claude-opus-4-5')).toBe(true)
  })

  test('rejects a model outside every declared family', () => {
    expect(serves(reg(['kimi-']), 'gpt-5.6-sol')).toBe(false)
    expect(serves(reg(['claude-']), 'kimi-k3')).toBe(false)
  })

  test('an empty family list serves nothing', () => {
    expect(serves(reg([]), 'kimi-k3')).toBe(false)
  })

  test('a bare prefix is a genuine prefix, not an exact id', () => {
    // The family is a prefix: any successor id under it serves without editing.
    expect(serves(reg(['kimi-']), 'kimi-k4-turbo')).toBe(true)
  })

  test('the wildcard accepts arbitrary provider-qualified local-Pi models only', () => {
    expect(serves(reg(['*/*']), 'future-provider/new-model')).toBe(true)
    expect(serves(reg(['*/*']), 'unqualified-model')).toBe(false)
    expect(serves(reg(['*/*']), '/missing-provider')).toBe(false)
  })
})
