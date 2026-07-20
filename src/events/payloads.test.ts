import { describe, expect, test } from 'bun:test'
import { validateEventWrite, type EventWrite } from './catalog'
import { KERNEL } from './envelope'
import { normalizeVerifyCompletion } from './payloads'

function verify(payload: unknown): EventWrite<'verify.completed'> {
  return validateEventWrite({
    actor: KERNEL,
    type: 'verify.completed',
    payload,
  }) as EventWrite<'verify.completed'>
}

describe('verify.completed payload compatibility', () => {
  test('accepts canonical pass and fail outcomes', () => {
    expect(verify({ step: 'types', attempt: 1, outcome: 'pass' }).payload).toEqual({
      step: 'types',
      attempt: 1,
      outcome: 'pass',
    })
    expect(
      verify({
        step: 'unit',
        attempt: 2,
        outcome: 'fail',
        report: { kind: 'verify-report:unit', rev: 0 },
      }).payload,
    ).toEqual({
      step: 'unit',
      attempt: 2,
      outcome: 'fail',
      report: { kind: 'verify-report:unit', rev: 0 },
    })
  })

  test('accepts skipped only with a trimmed, non-blank reason', () => {
    expect(
      verify({ step: 'e2e', attempt: 1, outcome: 'skipped', reason: '  no UI changes  ' })
        .payload,
    ).toEqual({
      step: 'e2e',
      attempt: 1,
      outcome: 'skipped',
      reason: 'no UI changes',
    })

    for (const reason of [undefined, '', '   ']) {
      expect(() =>
        verify({ step: 'e2e', attempt: 1, outcome: 'skipped', reason }),
      ).toThrow(/invalid payload for "verify\.completed"/)
    }
  })

  test('strict branches reject mixed or contradictory outcome shapes', () => {
    for (const payload of [
      { step: 'e2e', attempt: 1, outcome: 'skipped', reason: 'not applicable', pass: true },
      { step: 'e2e', attempt: 1, outcome: 'pass', pass: true },
      { step: 'e2e', attempt: 1, outcome: 'fail', reason: 'not applicable' },
      {
        step: 'e2e',
        attempt: 1,
        outcome: 'skipped',
        reason: 'not applicable',
        report: { kind: 'verify-report:e2e', rev: 0 },
      },
    ]) {
      expect(() => verify(payload)).toThrow(/invalid payload for "verify\.completed"/)
    }
  })

  test('historical booleans remain valid and normalize without reinterpretation', () => {
    const pass = verify({ step: 'types', attempt: 1, pass: true }).payload
    const fail = verify({
      step: 'unit',
      attempt: 2,
      pass: false,
      report: { kind: 'verify-report:unit', rev: 3 },
    }).payload

    expect(normalizeVerifyCompletion(pass)).toEqual({
      step: 'types',
      attempt: 1,
      outcome: 'pass',
    })
    expect(normalizeVerifyCompletion(fail)).toEqual({
      step: 'unit',
      attempt: 2,
      outcome: 'fail',
      report: { kind: 'verify-report:unit', rev: 3 },
    })
  })
})
