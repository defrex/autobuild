import { expect, test } from 'bun:test'
import { apiReadScenarios, checkApiReadCorpus } from './api-read-fixtures'

test('API read fixtures retain all four read surfaces and concrete failure/metadata states', () => {
  const cases = apiReadScenarios()
  for (const path of ['dashboard', 'status', 'harvest/status'])
    expect(cases.some((c) => c.path === path)).toBe(true)
  for (const id of [
    'detail-missing',
    'detail-foreign',
    'detail-done',
    'detail-cleaning',
    'detail-pinned',
    'detail-cycle-pin',
    'dashboard-cycle-pin',
    'detail-bad-pin',
    'detail-sessions',
    'detail-verify-cycle',
    'detail-integration',
    'status-held',
    'status-expired',
    'status-older-holder',
    'harvest-harvest-exhausted',
    'harvest-harvest-multi',
    'harvest-harvest-suspended',
  ])
    expect(cases.some((c) => c.id === id)).toBe(true)
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
})
test('API read corpus matches exact current TypeScript response bytes and source hashes', async () => {
  const corpus = await checkApiReadCorpus()
  expect(corpus.fixtures).toHaveLength(apiReadScenarios().length)
  for (const fixture of corpus.fixtures)
    if (fixture.scenario.id === 'status-held-bad-config') expect(fixture.status).toBe(500)
    else expect(fixture.status).not.toBe(500)
})
