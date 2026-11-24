import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { sampleBuildInput } from '../store/contract'
import { readBuildFacts } from '../store/reduced-reads'
import { humanActor } from '../events/envelope'
import { IntegrationStackViolation, raiseIntegrationStackAttention } from './integration-stack'

test('stack attention is raised once per head and again only after an answer', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('node'))
  const v = new IntegrationStackViolation('merge-commit', 'p', 'h', 'commit x is a merge', 'x')
  const state = async () => (await readBuildFacts(store, 'node')).value.state
  await raiseIntegrationStackAttention(store, 'node', await state(), v)
  await raiseIntegrationStackAttention(store, 'node', await state(), v)
  let current = await state()
  expect(current.openEscalations.map((e) => e.id)).toEqual(['integration-stack:h:1'])
  expect(current.openEscalations[0]!.question).toContain('commit x is a merge')
  await store.append('node', {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: 'integration-stack:h:1', answer: 'retry', resolution: 'retry' },
  })
  await raiseIntegrationStackAttention(store, 'node', await state(), v)
  current = await state()
  expect(current.openEscalations.map((e) => e.id)).toEqual(['integration-stack:h:2'])
})
