import { describe, expect, test } from 'bun:test'
import { agentActor, KERNEL } from '../events/envelope'
import { reduceHarvest } from '../kernel/harvest'
import { MemoryBuildStore } from '../store/memory'
import { artifactRef, scanUnclaimedObservations } from './harvest'

async function observation(store: MemoryBuildStore, build: string, id: string): Promise<void> {
  if ((await store.getBuild(build)) === null) {
    await store.createBuild({ slug: build, repo: '/repo' })
  }
  await store.append(build, {
    actor: agentActor('implement', `s-${build}`),
    type: 'observation.recorded',
    payload: { id, kind: 'followup', summary: id },
  })
}

async function claim(
  store: MemoryBuildStore,
  run: string,
  observations: Array<{ build: string; seq: number }>,
): Promise<void> {
  await store.ensureRepo('/repo')
  await store.appendRepoWithArtifacts(
    '/repo',
    [{ kind: 'harvest-scan', content: '{}' }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: { run, observations, scan: artifactRef(deposited[0]!) },
    }),
  )
}

describe('harvest deterministic scan and ledger', () => {
  test('per-build seq collisions are distinct; a started snapshot claims only its immutable members', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    await observation(store, 'b', 'b1')
    const first = await scanUnclaimedObservations(store, '/repo')
    expect(first.observations.map((item) => item.occurrence)).toEqual([
      { build: 'a', seq: 1 },
      { build: 'b', seq: 1 },
    ])
    await claim(store, 'h_1', [{ build: 'a', seq: 1 }])
    await observation(store, 'a', 'a2-late')
    const next = await scanUnclaimedObservations(store, '/repo')
    expect(next.observations.map((item) => item.occurrence)).toEqual([
      { build: 'a', seq: 2 },
      { build: 'b', seq: 1 },
    ])
  })

  test('terminal dispositions reduce into the authoritative ledger and never rescan', async () => {
    const store = new MemoryBuildStore()
    await observation(store, 'a', 'a1')
    await claim(store, 'h_1', [{ build: 'a', seq: 1 }])
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-report', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.completed',
        payload: {
          run: 'h_1',
          dispositions: [
            {
              occurrence: { build: 'a', seq: 1 },
              action: 'suppressed',
              proposalKey: 'key',
              reason: 'duplicate',
            },
          ],
          report: artifactRef(deposited[0]!),
        },
      }),
    )
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('completed')
    expect(state.ledger).toHaveLength(1)
    expect((await scanUnclaimedObservations(store, '/repo')).observations).toEqual([])
  })
})
