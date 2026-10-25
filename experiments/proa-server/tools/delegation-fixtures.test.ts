import { expect, test } from 'bun:test'
import { checkDelegationCorpus } from './delegation-fixtures'

test('delegation issuance oracle pins lifecycle refusals and exact signed grants', async () => {
  const corpus = await checkDelegationCorpus()
  expect(corpus.fixtures).toHaveLength(16)
  for (const id of [
    'admin-build-runner',
    'admin-build-phase',
    'runner-narrows',
    'admin-harvest-runner',
    'harvest-runner-narrows',
  ])
    expect(corpus.fixtures.find((fixture) => fixture.scenario.id === id)?.status).toBe(200)
  for (const id of [
    'foreign-project',
    'internal-refused',
    'session-predates',
    'terminal-build',
    'harvest-suspended',
  ])
    expect(corpus.fixtures.find((fixture) => fixture.scenario.id === id)?.status).toBe(403)
})
