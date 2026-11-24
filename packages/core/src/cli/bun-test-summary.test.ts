import { describe, expect, test } from 'bun:test'
import { bunTestSummary, expectBunContractPassed } from './testkit'

const ordinary = `bun test v1.4.4

contract-entry.ts:
(pass) ticket-source contract > create/get round-trips common fields [1.00ms]
(pass) ticket-source contract > list filters by state [0.50ms]

 23 pass
 0 fail
 112 expect() calls
Ran 23 tests across 1 file. [80.00ms]`

const agent = `bun test v1.4.4
 23 pass
 0 fail
 112 expect() calls
Ran 23 tests across 1 file. [80.00ms]`

describe('bunTestSummary', () => {
  test('reads the same counts with and without per-test lines', () => {
    expect(bunTestSummary(ordinary)).toEqual({ pass: 23, fail: 0 })
    expect(bunTestSummary(agent)).toEqual({ pass: 23, fail: 0 })
  })

  test('reads failures and does not mistake 10 fail for 0 fail', () => {
    expect(bunTestSummary(' 0 pass\n 1 fail\n')).toEqual({ pass: 0, fail: 1 })
    expect(bunTestSummary(' 3 pass\n 10 fail\n')).toEqual({ pass: 3, fail: 10 })
  })

  test('uses the last summary so earlier forwarded text cannot spoof it', () => {
    expect(bunTestSummary(' 5 pass\n 0 fail\nplugin log\n 4 pass\n 1 fail\n')).toEqual({
      pass: 4,
      fail: 1,
    })
  })

  test('is undefined without both summary lines', () => {
    expect(bunTestSummary('error: no tests found')).toBeUndefined()
    expect(bunTestSummary(' 3 pass\n')).toBeUndefined()
    expect(bunTestSummary('see 0 fail above')).toBeUndefined()
  })
})

describe('expectBunContractPassed', () => {
  test('accepts a zero exit with passes and no failures in either reporter mode', () => {
    expectBunContractPassed(0, ordinary)
    expectBunContractPassed(0, agent)
  })

  test('rejects a nonzero exit, no passes, any failure, or a missing summary', () => {
    expect(() => expectBunContractPassed(1, agent)).toThrow()
    expect(() => expectBunContractPassed(0, ' 0 pass\n 0 fail\n')).toThrow()
    expect(() => expectBunContractPassed(0, ' 22 pass\n 1 fail\n')).toThrow()
    expect(() => expectBunContractPassed(0, 'no summary')).toThrow()
  })
})
