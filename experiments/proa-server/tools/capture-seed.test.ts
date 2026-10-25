import { expect, test } from 'bun:test'
import { validateProvenance, replay, type SeedEvidence } from './capture-seed'
import type { E2eHarness } from '../../../packages/core/src/scenarios/harness'
import type { BuildStore } from '../../../packages/core/src/store/types'

test('capture cannot accept missing producer or incomplete replay provenance', () => {
  expect(() =>
    validateProvenance({
      completedBeforeServerStart: true,
      loopback: true,
      producers: [],
    } as unknown as SeedEvidence),
  ).toThrow('Incomplete seed provenance')
})
test('capture producer adapter refuses unsupported empty producers', async () => {
  const harness = {
    store: { listBuilds: async () => [] },
    origin: 'source',
  } as unknown as E2eHarness
  await expect(
    replay(
      harness,
      {} as BuildStore,
      'target',
      'prepareScenario',
      Object.assign(() => new Date(), { set: () => {} }),
    ),
  ).rejects.toThrow('no builds')
})
test('capture producer adapter fails closed when an artifact disappears', async () => {
  const harness = {
    origin: 'source',
    store: {
      listBuilds: async () => [{ slug: 'build', repo: 'source' }],
      getEvents: async () => [],
      getRepoEvents: async () => [],
      listRepoArtifacts: async () => [{ kind: 'spec', revision: 0 }],
      getRepoArtifact: async () => null,
    },
  } as unknown as E2eHarness
  await expect(
    replay(
      harness,
      { ensureRepo: async () => {} } as unknown as BuildStore,
      'target',
      'prepareScenario',
      Object.assign(() => new Date(), { set: () => {} }),
    ),
  ).rejects.toThrow('artifact missing')
})
