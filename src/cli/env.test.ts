/**
 * Ambient auth resolution tests (SPEC §8.1, D8): happy paths, every missing
 * variable, and the AB_PHASE malformations — errors must name the variable
 * and the expected format (D6: errors are agent feedback).
 */
import { describe, expect, test } from 'bun:test'
import { parseAbPhase, resolveCliEnv } from './env'

const FULL_ENV = {
  AB_STORE: '/home/user/.autobuild',
  AB_BUILD: 'auth-rate-limit',
  AB_PHASE: 'implement@2',
  AB_SESSION: 's_9f2',
  AB_TOKEN: 'tok_abc',
}

describe('resolveCliEnv', () => {
  test('resolves the full environment, parsing phase and round', () => {
    expect(resolveCliEnv(FULL_ENV)).toEqual({
      store: '/home/user/.autobuild',
      build: 'auth-rate-limit',
      phase: 'implement',
      round: 2,
      session: 's_9f2',
      token: 'tok_abc',
    })
  })

  test('AB_TOKEN is optional (local store needs none — §8.1)', () => {
    const { AB_TOKEN: _omitted, ...withoutToken } = FULL_ENV
    const resolved = resolveCliEnv(withoutToken)
    expect(resolved.token).toBeUndefined()
    expect(resolved.build).toBe('auth-rate-limit')
  })

  test('round defaults to 1 when AB_PHASE has no @round', () => {
    const resolved = resolveCliEnv({ ...FULL_ENV, AB_PHASE: 'plan' })
    expect(resolved.phase).toBe('plan')
    expect(resolved.round).toBe(1)
  })

  test('verify:e2e@2 parses into a verify phase with round 2', () => {
    const resolved = resolveCliEnv({ ...FULL_ENV, AB_PHASE: 'verify:e2e@2' })
    expect(resolved.phase).toBe('verify:e2e')
    expect(resolved.round).toBe(2)
  })

  test.each(['AB_STORE', 'AB_BUILD', 'AB_PHASE', 'AB_SESSION'] as const)(
    'missing %s errors naming the variable',
    (name) => {
      const env: Record<string, string | undefined> = { ...FULL_ENV }
      delete env[name]
      expect(() => resolveCliEnv(env)).toThrow(new RegExp(`${name} is not set`))
    },
  )

  test('an empty-string variable counts as missing', () => {
    expect(() => resolveCliEnv({ ...FULL_ENV, AB_SESSION: '' })).toThrow(
      /AB_SESSION is not set/,
    )
  })

  test('missing AB_PHASE names the expected format', () => {
    const env: Record<string, string | undefined> = { ...FULL_ENV }
    delete env['AB_PHASE']
    expect(() => resolveCliEnv(env)).toThrow(/'<phase>\[@<round>\]'/)
  })
})

describe('parseAbPhase — malformations (D6: precise, named errors)', () => {
  test('unknown phase names the known phases and the verify:<step> form', () => {
    expect(() => parseAbPhase('deploy')).toThrow(
      /unknown phase "deploy".*plan, plan-review, implement, code-review, finalize, reconcile.*verify:<step>/s,
    )
  })

  test('round 0 is malformed (rounds are 1-based)', () => {
    expect(() => parseAbPhase('implement@0')).toThrow(
      /malformed round "0".*positive integer/s,
    )
  })

  test('non-numeric round is malformed', () => {
    expect(() => parseAbPhase('implement@x')).toThrow(/malformed round "x"/)
  })

  test('trailing @ with no round is malformed', () => {
    expect(() => parseAbPhase('implement@')).toThrow(/malformed round ""/)
  })

  test('a bare "verify:" (no step) is not a phase', () => {
    expect(() => parseAbPhase('verify:')).toThrow(/unknown phase "verify:"/)
  })

  test('doubled @ reports the phase part as unknown, not a silent split', () => {
    expect(() => parseAbPhase('implement@2@3')).toThrow(/unknown phase "implement@2"/)
  })

  test('verify:e2e without a round defaults to round 1', () => {
    expect(parseAbPhase('verify:e2e')).toEqual({ phase: 'verify:e2e', round: 1 })
  })
})
