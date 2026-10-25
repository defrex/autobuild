import { test, expect } from 'bun:test'
import { checkUnicodeValidationFixtures } from './protocol-unicode-validation-fixtures'
test('lossless schema cases match executable Zod', async () => {
  expect(await checkUnicodeValidationFixtures()).toBeGreaterThan(5000)
})
