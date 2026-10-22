import { expect, test } from 'bun:test'
import { KERNEL, DISPATCHER, humanActor } from '../events/envelope'
import { prepareEventWrite, validateEventWrite } from '../events/catalog'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { reportIntegrationFailures } from './integration-attention'
import { missingIntegrationFailures } from './integration-state'
import { effectiveStatus } from '../cli/dashboard/model'
import { matchState, parseConditions } from '../cli/wait'

async function seed(kind: 'node' | 'work' = 'node') {
  const store = new MemoryBuildStore()
  await store.createBuild({
    slug: 'node',
    repo: '/repo',
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: { source: 'file', id: 'NODE' }, repo: '/repo', baseBranch: 'main', kind },
    },
  })
  await cycle(store, 'first')
  return store
}
async function cycle(
  store: MemoryBuildStore,
  id: string,
  head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parent = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
) {
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.compared',
    payload: { headSha: head, parentSha: parent, ahead: 1 },
  })
  await store.append('node', {
    actor: DISPATCHER,
    type: 'integration.prepared',
    payload: { id, head, parent, config: '{"verify":{"steps":["unit"]}}' },
  })
}
async function receipt(store: MemoryBuildStore, extra = {}) {
  await store.append('node', {
    actor: KERNEL,
    type: 'verify.completed',
    payload: {
      step: 'unit',
      attempt: 1,
      outcome: 'fail',
      restackId: 'first',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ...extra,
    },
  })
}
const facts = async (store: MemoryBuildStore) => (await readBuildFacts(store, 'node')).value.state
const reports = async (store: MemoryBuildStore) =>
  (await store.getEvents('node')).filter(
    (event) => event.type === 'integration.verification-failed',
  )

test('attention payload is strict, unique, nonblank and kernel-owned decisive evidence', () => {
  const payload = {
    id: 'cycle',
    head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    steps: ['unit'],
    guidance: 'repair',
  }
  const write = { actor: KERNEL, type: 'integration.verification-failed', payload }
  expect(validateEventWrite(write)).toMatchObject({ payload })
  expect(prepareEventWrite(write)).toMatchObject({
    compatibility: { classification: 'decisive' },
  })
  for (const invalid of [{ id: ' ' }, { steps: [] }, { steps: ['unit', 'unit'] }, { extra: true }])
    expect(() => validateEventWrite({ ...write, payload: { ...payload, ...invalid } })).toThrow()
  expect(() => validateEventWrite({ ...write, actor: humanActor('operator') })).toThrow()
})

test('CAS contention and restarts report each failed cycle once, retaining historical failures', async () => {
  const store = await seed()
  await receipt(store)
  await receipt(store, { step: 'agent' })
  const append = store.appendIfCurrent.bind(store)
  let contended = false
  store.appendIfCurrent = async (...args) => {
    if (!contended) {
      contended = true
      await store.append('node', {
        actor: DISPATCHER,
        type: 'node.parent-distance',
        payload: {
          base: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          parent: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          branch: 'main',
          count: 0,
        },
      })
    }
    return append(...args)
  }
  await Promise.all([
    reportIntegrationFailures(store, 'node'),
    reportIntegrationFailures(store, 'node'),
  ])
  await reportIntegrationFailures(store, 'node')
  expect(await reports(store)).toHaveLength(1)
  expect((await reports(store))[0]!.payload).toEqual({
    id: 'first',
    head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    steps: ['unit', 'agent'],
    guidance: 'file a repair child targeting this node: node',
  })
  // Identical SHAs still define a separate episode.
  await cycle(store, 'second')
  await receipt(store, { restackId: 'second' })
  // Move again before recovery: neither historical failure may be lost.
  await cycle(
    store,
    'third',
    'cccccccccccccccccccccccccccccccccccccccc',
    'dddddddddddddddddddddddddddddddddddddddd',
  )
  await receipt(store, {
    restackId: 'third',
    headSha: 'cccccccccccccccccccccccccccccccccccccccc',
    baseSha: 'dddddddddddddddddddddddddddddddddddddddd',
  })
  await reportIntegrationFailures(store, 'node')
  expect(await reports(store)).toHaveLength(3)
  expect((await facts(store)).integration?.failures).toHaveLength(3)
})

test('receipts must match cycle, head, parent, ordering and failure outcome; leaves stay silent', async () => {
  for (const extra of [
    { outcome: 'pass' },
    { outcome: 'skipped', reason: 'not applicable' },
    { restackId: 'other' },
    { headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    { baseSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
  ]) {
    const store = await seed()
    await receipt(store, extra)
    expect(missingIntegrationFailures(await facts(store), 'node')).toEqual([])
  }
  const store = await seed('work')
  await receipt(store)
  await reportIntegrationFailures(store, 'node')
  expect(await reports(store)).toEqual([])
  const state = await facts(await seed())
  state.verify.results = [
    {
      step: 'unit',
      attempt: 1,
      outcome: 'fail',
      seq: 1,
      restackId: 'first',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  ]
  expect(missingIntegrationFailures(state, 'node')).toEqual([])
})

test('current state attention precedes reporting and clears after repair; terminal precedence wins', async () => {
  const store = await seed()
  await receipt(store)
  const conditions = parseConditions(['attention'], []).conditions
  let state = await facts(store)
  expect(matchState(conditions, state)).toBe('attention')
  expect(effectiveStatus(state)).toBe('blocked')
  state.status = 'paused'
  expect(effectiveStatus(state)).toBe('blocked')
  state.status = 'done'
  expect(effectiveStatus(state)).toBe('done')
  expect(missingIntegrationFailures(state, 'node')).toEqual([])
  await reportIntegrationFailures(store, 'node')
  await cycle(store, 'repair', 'ffffffffffffffffffffffffffffffffffffffff')
  await receipt(store, {
    restackId: 'repair',
    headSha: 'ffffffffffffffffffffffffffffffffffffffff',
    outcome: 'pass',
  })
  state = await facts(store)
  expect(matchState(conditions, state)).toBeNull()
  expect(effectiveStatus(state)).not.toBe('blocked')
  expect(state.integration?.failures).toHaveLength(1)
})

test('shared dashboard exposes repair text and vocabulary, then removes it after repair', async () => {
  const { parseConfig } = await import('../config/load')
  const { projectBuild } = await import('../cli/dashboard/model')
  const store = await seed()
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'b'.repeat(40) },
  })
  await receipt(store)
  const config = parseConfig('[tickets]\nsource="file"\nreadyState="Ready"\n')
  const record = (await store.getBuild('node'))!
  const row = async () =>
    projectBuild(record, await facts(store), config, await store.getEvents('node'))
  expect(await row()).toMatchObject({
    status: 'blocked',
    integration: 'verification failed',
    blockers: ['verification failed: file a repair child targeting this node'],
  })
  await reportIntegrationFailures(store, 'node')
  await cycle(store, 'repaired', 'f'.repeat(40))
  expect((await row())?.blockers).toEqual([])
})
