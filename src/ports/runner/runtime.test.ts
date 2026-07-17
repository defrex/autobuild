import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from './fake'
import { serves, type RuntimeRegistration } from './runtime'

function reg(servesModels: string[]): RuntimeRegistration {
  return {
    runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
    servesModels,
  }
}

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
})
