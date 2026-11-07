import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { readyTicket } from '../scenarios/harness'
import { integrationObservationInputs, observeIntegration } from './integration-completeness'

const node = { source: 'fake', id: 'NODE' }

/** One node with a running child, a merged child whose issue links the node has
 * not recorded, a node restacking onto it, and many unrelated builds. */
async function seed() {
  const store = new MemoryBuildStore()
  const create = async (
    slug: string,
    payload: Partial<EventWrite<'build.created'>['payload']> = {},
    ...events: EventWrite[]
  ) => {
    const ticket = { source: 'fake', id: slug.toUpperCase(), title: slug }
    await store.createBuild({
      slug,
      repo: 'repo',
      ticket,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: 'repo', ticket, baseBranch: 'main', ...payload },
      },
    })
    for (const event of events) await store.append(slug, event)
  }
  const target = (build: string) => ({ target: { ticket: node, build } })
  await store.createBuild({
    slug: 'node',
    repo: 'repo',
    ticket: node,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo: 'repo', ticket: node, kind: 'node', baseBranch: 'main' },
    },
  })
  await create('running', target('node'))
  await create(
    'merged',
    { ...target('node'), issueLinks: [{ issue: 7, intent: 'closes' }] },
    { actor: DISPATCHER, type: 'pr.merged', payload: { sha: 'a'.repeat(40) } },
  )
  const move = {
    id: 'move',
    old: { target: { ticket: node, build: 'elsewhere' }, branch: 'ab-node/elsewhere' },
    next: { target: { ticket: node, build: 'node' }, branch: 'ab-node/node' },
    revision: 'r',
  }
  await create(
    'restacked',
    { kind: 'node', ...target('elsewhere') },
    {
      actor: DISPATCHER,
      type: 'node.parent-requested',
      payload: move,
    },
  )
  for (let i = 0; i < 50; i++)
    await create(`unrelated-${i}`, i % 2 ? target('elsewhere') : {}, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  return store
}

test('digest-filtered observation equals observing every build, reading facts only for related builds', async () => {
  const source = new FakeTicketSource([{ ...readyTicket('NODE'), kind: 'node' }])
  // The oracle relates every build, so it reads and tests all of them as before.
  const oracleStore = await seed()
  const oracle = await observeIntegration(oracleStore, source, 'node', async () => {
    const inputs = await integrationObservationInputs(oracleStore, source, 'repo')
    return { ...inputs, builds: inputs.builds.map((b) => ({ ...b, nodeTargets: ['node'] })) }
  })
  const store = await seed()
  const read: string[] = []
  const observed = await observeIntegration(store, source, 'node', async () => {
    const inputs = await integrationObservationInputs(store, source, 'repo')
    return {
      ...inputs,
      state: (slug) => {
        read.push(slug)
        return inputs.state(slug)
      },
    }
  })
  expect(observed).toEqual(oracle)
  expect(observed.openChildren).toEqual(['MERGED', 'RESTACKED', 'RUNNING'])
  expect(observed.contributions).toEqual(['merged'])
  expect(read.sort()).toEqual(['merged', 'restacked', 'running'])
})

test('an observation failure is reported through onFailure and still recorded as a diagnostic', async () => {
  const source = new FakeTicketSource([{ ...readyTicket('NODE'), kind: 'node' }])
  const failing = async () => {
    throw new Error('ticket service offline')
  }
  const reported: unknown[] = []
  const observed = await observeIntegration(await seed(), source, 'node', failing, {
    onFailure: (error) => reported.push(error),
  })
  expect(reported).toHaveLength(1)
  expect((reported[0] as Error).message).toBe('ticket service offline')
  expect(observed.diagnostics).toContain('ticket service offline')
  const silent = await observeIntegration(await seed(), source, 'node', failing)
  expect(silent.diagnostics).toContain('ticket service offline')
})
