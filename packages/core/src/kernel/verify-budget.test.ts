import { describe, expect, test } from 'bun:test'
import { verifyBudgetExhaustedQuestion } from './verify-budget'

const fail = (step: string, attempt: number) => ({ step, attempt })

describe('verifyBudgetExhaustedQuestion', () => {
  test('a step that failed in every counted cycle is named as such', () => {
    expect(
      verifyBudgetExhaustedQuestion(3, [fail('unit', 1), fail('unit', 2), fail('unit', 3)]),
    ).toBe(
      'maxVerifyAttempts (3) exhausted: 3 failed verify cycles count against the build-wide budget: ' +
        'attempt 1 (verify:unit), attempt 2 (verify:unit), attempt 3 (verify:unit). ' +
        'verify:unit failed in every counted cycle.',
    )
  })

  test('AUT-841: failures on different steps name the latest cycle, not a repeated step', () => {
    expect(
      verifyBudgetExhaustedQuestion(3, [fail('postgres', 1), fail('website', 2), fail('unit', 4)]),
    ).toBe(
      'maxVerifyAttempts (3) exhausted: 3 failed verify cycles count against the build-wide budget: ' +
        'attempt 1 (verify:postgres), attempt 2 (verify:website), attempt 4 (verify:unit). ' +
        'No single step failed in every counted cycle; the latest failed cycle, attempt 4, failed verify:unit.',
    )
  })

  test('a step that recurs without failing every cycle is not called repeated', () => {
    const question = verifyBudgetExhaustedQuestion(3, [
      fail('unit', 1),
      fail('website', 2),
      fail('unit', 4),
    ])
    expect(question).not.toContain('failed in every counted cycle.')
    expect(question).toEndWith(
      'No single step failed in every counted cycle; the latest failed cycle, attempt 4, failed verify:unit.',
    )
  })

  test('a multi-member failing stage lists every failed step of the attempt', () => {
    expect(
      verifyBudgetExhaustedQuestion(2, [fail('lint', 1), fail('types', 2), fail('unit', 2)]),
    ).toBe(
      'maxVerifyAttempts (2) exhausted: 2 failed verify cycles count against the build-wide budget: ' +
        'attempt 1 (verify:lint), attempt 2 (verify:types, verify:unit). ' +
        'No single step failed in every counted cycle; the latest failed cycle, attempt 2, failed verify:types, verify:unit.',
    )
  })

  test('steps common to every multi-member attempt are named in latest-attempt order', () => {
    expect(
      verifyBudgetExhaustedQuestion(2, [
        fail('types', 1),
        fail('unit', 1),
        fail('lint', 1),
        fail('unit', 2),
        fail('types', 2),
      ]),
    ).toEndWith(
      'attempt 2 (verify:unit, verify:types). verify:unit, verify:types failed in every counted cycle.',
    )
  })

  test('duplicate records render once and count one cycle', () => {
    expect(
      verifyBudgetExhaustedQuestion(2, [
        fail('unit', 1),
        fail('unit', 1),
        fail('unit', 2),
        fail('unit', 2),
      ]),
    ).toBe(
      'maxVerifyAttempts (2) exhausted: 2 failed verify cycles count against the build-wide budget: ' +
        'attempt 1 (verify:unit), attempt 2 (verify:unit). verify:unit failed in every counted cycle.',
    )
  })

  test('a single counted cycle uses singular wording', () => {
    expect(verifyBudgetExhaustedQuestion(1, [fail('test', 1)])).toBe(
      'maxVerifyAttempts (1) exhausted: 1 failed verify cycle counts against the build-wide budget: ' +
        'attempt 1 (verify:test). verify:test failed in every counted cycle.',
    )
  })

  test('records out of log order still render by attempt, latest by attempt number', () => {
    expect(
      verifyBudgetExhaustedQuestion(3, [fail('unit', 4), fail('postgres', 1), fail('website', 2)]),
    ).toBe(
      'maxVerifyAttempts (3) exhausted: 3 failed verify cycles count against the build-wide budget: ' +
        'attempt 1 (verify:postgres), attempt 2 (verify:website), attempt 4 (verify:unit). ' +
        'No single step failed in every counted cycle; the latest failed cycle, attempt 4, failed verify:unit.',
    )
  })
})
