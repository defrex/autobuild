import { expect, test } from 'bun:test'
import { checkNumericFixtures, numericFixtures } from './protocol-numeric-fixtures'

test('raw exponent overflow and IEEE rounding are checked against actual Zod schemas', () => {
  checkNumericFixtures()
  const cases = numericFixtures().cases
  expect(cases.length).toBeGreaterThan(200)
  expect(cases.find((item) => item.id === 'number/1e400')!.oracle).toEqual({
    rejected:
      '[\n  {\n    "expected": "number",\n    "code": "invalid_type",\n    "received": "Infinity",\n    "path": [],\n    "message": "Invalid input: expected number, received number"\n  }\n]',
  })
  expect(cases.find((item) => item.id === 'null/1e400')!.oracle).toHaveProperty('rejected')
  expect(cases.find((item) => item.id === 'unknown/1e400')!.oracle).toEqual({ accepted: null })
})
