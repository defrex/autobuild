import { describe, expect, test } from 'bun:test'
import type { AgentRunner } from '../types'
import { ScriptedAgentRunner, defaultTurnResult } from './fake'
import { resolveRole } from './routing'

function runner(): AgentRunner {
  return new ScriptedAgentRunner({ script: () => defaultTurnResult() })
}

const claude = runner()
const pi = runner()
const registry = { claude, pi }

describe('resolveRole', () => {
  test('explicit role resolves its runner and model', () => {
    const roles = { 'code-review': { runner: 'pi', model: 'gpt-5' } }
    const resolved = resolveRole('code-review', roles, registry, 'claude')
    expect(resolved.runner).toBe(pi)
    expect(resolved.model).toBe('gpt-5')
  })

  test('role without a model resolves with model undefined', () => {
    const roles = { plan: { runner: 'claude' } }
    const resolved = resolveRole('plan', roles, registry, 'claude')
    expect(resolved.runner).toBe(claude)
    expect(resolved.model).toBeUndefined()
  })

  test('unknown role falls back to registry[fallback] with no model', () => {
    const roles = { plan: { runner: 'pi', model: 'gpt-5' } }
    const resolved = resolveRole('finalize', roles, registry, 'claude')
    expect(resolved.runner).toBe(claude)
    expect(resolved.model).toBeUndefined()
  })

  test('role naming an unregistered runner throws, listing registered runners', () => {
    const roles = { plan: { runner: 'gemini' } }
    expect(() => resolveRole('plan', roles, registry, 'claude')).toThrow(
      'role "plan" routes to runner "gemini", which is not registered (registered runners: claude, pi)',
    )
  })

  test('unknown role with an unregistered fallback throws', () => {
    expect(() => resolveRole('plan', {}, registry, 'codex')).toThrow(
      'role "plan" routes to runner "codex", which is not registered (registered runners: claude, pi)',
    )
  })

  test('empty registry error says none registered', () => {
    expect(() => resolveRole('plan', {}, {}, 'claude')).toThrow(
      '(registered runners: none)',
    )
  })
})
