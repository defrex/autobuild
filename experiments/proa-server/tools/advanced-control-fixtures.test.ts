import { expect, test } from 'bun:test'
import { checkAdvancedCorpus, advancedScenarios } from './advanced-control-fixtures'
test('node landing and ticket spec revisions have complete immutable artifact oracles', async () => {
  const corpus = await checkAdvancedCorpus()
  expect(corpus.fixtures).toHaveLength(advancedScenarios.length)
  for (const fixture of corpus.fixtures) {
    if (
      [
        'node-land-open-source-child',
        'node-land-frozen-child',
        'node-land-uncovered-frozen-child',
        'node-land-empty',
        'node-land-source-mismatch',
      ].includes(fixture.id)
    )
      expect(fixture.status).toBe(500)
    else if (fixture.id === 'revise-no-ticket') expect(fixture.status).toBe(409)
    else expect(fixture.status).toBe(200)
  }
  const pinned = corpus.fixtures.find((f) => f.id === 'revise-hosted-file')!
  expect(pinned.after.repositoryArtifacts.map((a) => a.encoding)).toEqual(['base64', 'gzip-json'])
  expect(pinned.after.builds[0]!.state).toHaveProperty('pinnedAssets')
})
