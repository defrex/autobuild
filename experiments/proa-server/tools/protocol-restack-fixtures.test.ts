import { test, expect } from 'bun:test'
import { checkRestackFixtures, restackFixtures } from './protocol-restack-fixtures'
test('node and leaf restack prefix/semantic refusal fixtures stay fresh', () => {
  checkRestackFixtures()
  expect(restackFixtures().cases.length).toBeGreaterThan(200)
})
