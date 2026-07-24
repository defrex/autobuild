/**
 * Ambient auth resolution tests (SPEC §8.1, D8): happy paths, every missing
 * variable, and the AB_PHASE malformations — errors must name the variable
 * and the expected format (D6: errors are agent feedback).
 */
import { describe, expect, test } from 'bun:test'
import {
  MissingAmbientContextError,
  parseAbPhase,
  resolveCliEnv,
  resolveHarvestCliEnv,
} from './env'

const FULL_ENV = {
  AB_STORE: '/home/user/.autobuild',
  AB_BUILD: 'auth-rate-limit',
  AB_PHASE: 'implement@2',
  AB_SESSION: 's_9f2',
  AB_TOKEN: 'tok_abc',
}

const FULL_HARVEST_ENV = {
  AB_STORE: '/home/user/.autobuild',
  AB_REPO: '/home/user/app',
  AB_HARVEST: 'h_123',
  AB_PHASE: 'review@3',
  AB_SESSION: 'hs_9f2',
  AB_TOKEN: 'tok_harvest',
}

function thrownBy(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to throw')
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
    'missing %s raises typed context feedback naming the variable',
    (name) => {
      const env: Record<string, string | undefined> = { ...FULL_ENV }
      delete env[name]
      const error = thrownBy(() => resolveCliEnv(env))
      expect(error).toBeInstanceOf(MissingAmbientContextError)
      expect(error).toMatchObject({ variable: name })
      expect((error as Error).message).toMatch(new RegExp(`${name} is not set`))
    },
  )

  test.each(['AB_STORE', 'AB_BUILD', 'AB_PHASE', 'AB_SESSION'] as const)(
    'empty %s raises the same typed missing-context error',
    (name) => {
      const error = thrownBy(() => resolveCliEnv({ ...FULL_ENV, [name]: '' }))
      expect(error).toBeInstanceOf(MissingAmbientContextError)
      expect(error).toMatchObject({ variable: name })
    },
  )

  test('missing AB_PHASE names the expected format', () => {
    const env: Record<string, string | undefined> = { ...FULL_ENV }
    delete env.AB_PHASE
    expect(() => resolveCliEnv(env)).toThrow(/'<phase>\[@<round>\]'/)
  })

  test('a fully populated malformed AB_PHASE remains an ordinary parse error', () => {
    const error = thrownBy(() => resolveCliEnv({ ...FULL_ENV, AB_PHASE: 'implement@nope' }))
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MissingAmbientContextError)
    expect((error as Error).message).toMatch(
      /AB_PHASE "implement@nope" has a malformed round "nope"/,
    )
  })
})

describe('resolveHarvestCliEnv', () => {
  test('resolves the complete harvest session environment', () => {
    expect(resolveHarvestCliEnv(FULL_HARVEST_ENV)).toEqual({
      store: '/home/user/.autobuild',
      repo: '/home/user/app',
      run: 'h_123',
      phase: 'review',
      round: 3,
      session: 'hs_9f2',
      token: 'tok_harvest',
    })
  })

  test.each(['AB_STORE', 'AB_REPO', 'AB_HARVEST', 'AB_PHASE', 'AB_SESSION'] as const)(
    'missing %s raises typed harvest-context feedback',
    (name) => {
      const env: Record<string, string | undefined> = { ...FULL_HARVEST_ENV }
      delete env[name]
      const error = thrownBy(() => resolveHarvestCliEnv(env))
      expect(error).toBeInstanceOf(MissingAmbientContextError)
      expect(error).toMatchObject({ variable: name })
      expect((error as Error).message).toMatch(new RegExp(`${name} is not set`))
    },
  )

  test.each(['AB_STORE', 'AB_REPO', 'AB_HARVEST', 'AB_PHASE', 'AB_SESSION'] as const)(
    'empty %s raises the same typed missing-context error',
    (name) => {
      const error = thrownBy(() => resolveHarvestCliEnv({ ...FULL_HARVEST_ENV, [name]: '' }))
      expect(error).toBeInstanceOf(MissingAmbientContextError)
      expect(error).toMatchObject({ variable: name })
    },
  )

  test('a complete malformed harvest phase is not missing context', () => {
    const error = thrownBy(() => resolveHarvestCliEnv({ ...FULL_HARVEST_ENV, AB_PHASE: 'review' }))
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MissingAmbientContextError)
    expect((error as Error).message).toMatch(/AB_PHASE "review" is not a harvest session phase/)
  })
})

describe('parseAbPhase — malformations (D6: precise, named errors)', () => {
  test('unknown phase names the known phases and the verify:<step> form', () => {
    expect(() => parseAbPhase('deploy')).toThrow(
      /unknown phase "deploy".*plan, plan-review, implement, code-review, finalize, reconcile.*verify:<step>/s,
    )
  })

  test('round 0 is malformed (rounds are 1-based)', () => {
    expect(() => parseAbPhase('implement@0')).toThrow(/malformed round "0".*positive integer/s)
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
