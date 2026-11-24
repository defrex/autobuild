import { expect, test } from 'bun:test'
import { controlBuild } from '../cli/build-control'
import type { EventWrite } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { TicketListing } from '../ports/types'
import { readyTicket } from '../scenarios/harness'
import { MemoryBuildStore } from '../store/memory'
import type { BuildRecord } from '../store/types'
import { integrationObservationInputs, observeIntegration } from './integration-completeness'
import { integrationComplete } from './integration-state'
import { newestTicketBuild } from './node-parent'
import { reduceBuild, type BuildState } from './reducer'
import { recordTicketMigration } from './ticket-migrations'

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

/** Supplied observation inputs from full entries, naming each entry's target
 * and parent moves the way its digest would. */
function inputsOf(listing: TicketListing, entries: { record: BuildRecord; state: BuildState }[]) {
  return {
    listing,
    builds: entries.map(({ record, state }) => ({
      record,
      nodeTargets: [
        state.target?.build,
        ...[state.nodeRestack?.parentRequest, state.nodeRestack?.parentChange].flatMap((move) =>
          move ? [move.old.target?.build, move.next.target?.build] : [],
        ),
      ].filter((build): build is string => build !== undefined),
    })),
    state: async (slug: string) => entries.find((entry) => entry.record.slug === slug)!.state,
  }
}

test('display metadata follows membership authorities, survives failed scans, and publishes idempotently', async () => {
  const store = new MemoryBuildStore()
  const ticket = { source: 'fake', id: 'NODE' }
  await store.createBuild({
    slug: 'node',
    repo: 'repo',
    ticket,
    created: {
      actor: { kind: 'dispatcher' },
      type: 'build.created',
      payload: { repo: 'repo', ticket, kind: 'node', baseBranch: 'main' },
    },
  })
  const source = new FakeTicketSource([])
  const records = ['landed', 'frozen'].map((slug) => ({
    record: {
      slug,
      repo: 'repo',
      ticket: { source: 'fake', id: slug.toUpperCase(), title: `Frozen ${slug}` },
      createdAt: '',
      updatedAt: '',
    },
    state: {
      ...reduceBuild([]),
      status: slug === 'landed' ? ('done' as const) : ('running' as const),
      prState: slug === 'landed' ? ('merged' as const) : undefined,
      target: { ticket, build: 'node' },
    },
  }))
  const listed = (id: string, title: string, resolved = false) => ({
    ...readyTicket(id, { title }),
    target: 'NODE',
    resolved,
  })
  let listing = {
    tickets: [
      listed('QUEUED', 'Queued title'),
      listed('CANCELLED', 'Cancelled', true),
      listed('LANDED', 'Renamed merged', true),
    ],
    diagnostics: [] as string[],
  }
  const inputs = async () => inputsOf(listing, records)
  const first = await observeIntegration(store, source, 'node', inputs)
  expect(first.openChildren).toEqual(['FROZEN', 'QUEUED'])
  expect(first.contributions).toEqual(['landed'])
  expect(first.children).toEqual([
    { source: 'fake', id: 'FROZEN', title: 'Frozen frozen' },
    { source: 'fake', id: 'LANDED', title: 'Renamed merged', builds: ['landed'] },
    { source: 'fake', id: 'QUEUED', title: 'Queued title' },
  ])
  const count = (await store.getEvents('node')).length
  await observeIntegration(store, source, 'node', inputs)
  expect((await store.getEvents('node')).length).toBe(count)
  expect(integrationComplete(reduceBuild(await store.getEvents('node')))).toBe(false)
  listing = { tickets: [listed('LANDED', 'Reopened title')], diagnostics: [] }
  const reopened = await observeIntegration(store, source, 'node', inputs)
  expect(reopened.children?.filter((c) => c.id === 'LANDED')).toEqual([
    { source: 'fake', id: 'LANDED', title: 'Reopened title', builds: ['landed'] },
  ])
  expect(reopened.openChildren).toContain('LANDED')
  const failed = await observeIntegration(store, source, 'node', async () => {
    throw new Error('offline')
  })
  expect(failed.children).toEqual(reopened.children)
  expect(failed.diagnostics).toEqual(['offline'])
  expect(integrationComplete(reduceBuild(await store.getEvents('node')))).toBe(false)
  listing = { tickets: [], diagnostics: [] }
  const recovered = await observeIntegration(store, source, 'node', inputs)
  expect(recovered.children?.find((c) => c.id === 'LANDED')?.title).toBe('Reopened title')
  records.push({ ...records[0]!, record: { ...records[0]!.record, slug: 'landed-again' } })
  const repeated = await observeIntegration(store, source, 'node', inputs)
  expect(repeated.children?.filter((c) => c.id === 'LANDED')).toHaveLength(1)
  expect(repeated.children?.find((c) => c.id === 'LANDED')?.builds).toEqual([
    'landed',
    'landed-again',
  ])
  const membership = { openChildren: repeated.openChildren, contributions: repeated.contributions }
  listing = { tickets: [listed('FROZEN', 'New source title')], diagnostics: [] }
  const renamed = await observeIntegration(store, source, 'node', inputs)
  expect({ openChildren: renamed.openChildren, contributions: renamed.contributions }).toEqual(
    membership,
  )
  expect(renamed.children?.find((c) => c.id === 'FROZEN')?.title).toBe('New source title')
  listing = { tickets: [], diagnostics: ['partial scan'] }
  const partial = await observeIntegration(store, source, 'node', inputs)
  expect(partial.children?.find((c) => c.id === 'FROZEN')?.title).toBe('New source title')
})

test('recorded remaps join frozen children to current membership and isolate unrelated history', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const old = { source: 'linear', id: 'OLD-NODE' }
  await store.createBuild({
    slug: 'node',
    repo: 'repo',
    ticket: old,
    created: {
      actor: { kind: 'dispatcher' },
      type: 'build.created',
      payload: { repo: 'repo', ticket: old, kind: 'node', baseBranch: 'main' },
    },
  })
  const source = new FakeTicketSource([
    { ...readyTicket('NODE'), kind: 'node' },
    { ...readyTicket('CHILD'), target: 'NODE' },
  ])
  const child = {
    record: {
      slug: 'child',
      repo: 'repo',
      ticket: { source: 'linear', id: 'OLD-CHILD' },
      createdAt: '',
      updatedAt: '',
    },
    state: {
      ...reduceBuild([]),
      status: 'running' as const,
      target: { ticket: old, build: 'node' },
    },
  }
  const unrelated = {
    record: { ...child.record, slug: 'unrelated', ticket: { source: 'foreign', id: 'OTHER' } },
    state: reduceBuild([]),
  }
  const inputs = async () => inputsOf(await source.listAll(), [child, unrelated])
  const absent = await observeIntegration(store, source, 'node', inputs)
  expect(absent.diagnostics.join()).toContain('ab ticket migration record')
  await recordTicketMigration(
    store,
    'repo',
    { kind: 'human', user: 'operator' },
    {
      identity: 'cutover',
      from: 'linear',
      to: 'fake',
      mapping: { 'OLD-NODE': 'NODE', 'OLD-CHILD': 'CHILD' },
    },
  )
  const current = await observeIntegration(store, source, 'node', inputs)
  expect(current.diagnostics).toEqual([])
  expect(current.openChildren).toEqual(['CHILD'])
  expect(current.children?.map(({ source, id }) => ({ source, id }))).toEqual([
    { source: 'fake', id: 'CHILD' },
  ])
  expect(
    (
      await newestTicketBuild(
        { store, repo: 'repo', source, root: 'main', supportsRetarget: async () => true },
        (await source.get('NODE'))!,
      )
    )?.slug,
  ).toBe('node')
  expect((await store.getBuild('node'))?.ticket).toEqual(old)
  child.state.status = 'done' as 'running'
  child.state.prState = 'merged' as never
  await source.transition('CHILD', 'Done')
  const complete = await observeIntegration(store, source, 'node', inputs)
  expect(complete.openChildren).toEqual([])
  expect(complete.contributions).toEqual(['child'])
  child.record.ticket.id = 'UNCOVERED'
  const missing = await observeIntegration(store, source, 'node', inputs)
  expect(missing.diagnostics.join()).toContain('build child ticket linear:UNCOVERED')
})

test('a rejected child no longer keeps its node incomplete; a backlog child does', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const node = { source: 'fake', id: 'NODE' }
  await store.createBuild({
    slug: 'node',
    repo: 'repo',
    ticket: node,
    created: {
      actor: { kind: 'dispatcher' },
      type: 'build.created',
      payload: { repo: 'repo', ticket: node, kind: 'node', baseBranch: 'main' },
    },
  })
  const source = new FakeTicketSource([
    { ...readyTicket('NODE'), kind: 'node' },
    { ...readyTicket('DECLINED'), target: 'NODE', state: 'Rejected' },
    { ...readyTicket('DEFERRED'), target: 'NODE', state: 'backlog' },
  ])
  const inputs = async () => inputsOf(await source.listAll(), [])
  const roles = { rejectedState: 'rejected' }
  expect((await observeIntegration(store, source, 'node', inputs, roles)).openChildren).toEqual([
    'DEFERRED',
  ])
  // With the role unset, a state named rejected is just another open state.
  expect((await observeIntegration(store, source, 'node', inputs)).openChildren).toEqual([
    'DECLINED',
    'DEFERRED',
  ])
  // Moving it back restores ordinary behavior with no other step.
  await source.transition('DECLINED', 'Ready')
  expect((await observeIntegration(store, source, 'node', inputs, roles)).openChildren).toEqual([
    'DECLINED',
    'DEFERRED',
  ])
})

test('a targeting source is observed per node, memoized per pass, and never scanned exhaustively', async () => {
  const store = new MemoryBuildStore()
  for (const id of ['A', 'B']) {
    const ticket = { source: 'fake', id }
    await store.createBuild({
      slug: `node-${id.toLowerCase()}`,
      repo: 'repo',
      ticket,
      created: {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: { repo: 'repo', ticket, kind: 'node', baseBranch: 'main' },
      },
    })
  }
  const source = new FakeTicketSource([
    { ...readyTicket('A'), kind: 'node' },
    { ...readyTicket('B'), kind: 'node' },
    { ...readyTicket('A1'), target: 'A' },
    { ...readyTicket('A2'), target: 'A', state: 'Done' },
    { ...readyTicket('B1'), target: 'B' },
  ])
  const exhaustive = FakeTicketSource.prototype.listAll.bind(source)
  const calls: string[] = []
  let offline = false
  const targeting = Object.assign(source, {
    async listAll(): Promise<never> {
      throw new Error('listAll must not be called')
    },
    async listTargeting(nodeId: string) {
      calls.push(nodeId)
      if (offline) throw new Error('offline')
      const all = await exhaustive()
      return { ...all, tickets: all.tickets.filter((ticket) => ticket.target === nodeId) }
    },
  })

  expect((await observeIntegration(store, targeting, 'node-a')).openChildren).toEqual(['A1'])
  expect(calls).toEqual(['A'])

  calls.length = 0
  const inputs = await integrationObservationInputs(store, targeting, 'repo')
  const pass = async () => inputs
  expect((await observeIntegration(store, targeting, 'node-a', pass)).openChildren).toEqual(['A1'])
  expect((await observeIntegration(store, targeting, 'node-b', pass)).openChildren).toEqual(['B1'])
  await observeIntegration(store, targeting, 'node-a', pass)
  expect(calls).toEqual(['A', 'B'])

  calls.length = 0
  offline = true
  const failing = await integrationObservationInputs(store, targeting, 'repo')
  const failed = await observeIntegration(store, targeting, 'node-a', async () => failing)
  expect(failed.diagnostics).toEqual(['offline'])
  expect(integrationComplete(reduceBuild(await store.getEvents('node-a')))).toBe(false)
  offline = false
  const retried = await observeIntegration(store, targeting, 'node-a', async () => failing)
  expect(retried.diagnostics).toEqual([])
  expect(retried.openChildren).toEqual(['A1'])
  expect(calls).toEqual(['A', 'A'])

  // The targeting decision is captured with the inputs: a source withdrawing
  // it mid-pass keeps that pass targeted rather than falling back to listAll.
  calls.length = 0
  const captured = await integrationObservationInputs(store, targeting, 'repo')
  const withdrawn = Object.assign(targeting, { listTargeting: undefined })
  const kept = await observeIntegration(store, withdrawn, 'node-b', async () => captured)
  expect(kept.diagnostics).toEqual([])
  expect(kept.openChildren).toEqual(['B1'])
  expect(calls).toEqual(['B'])
})

test('native terminal states, partial listings and reopening govern completeness', async () => {
  const store = new MemoryBuildStore()
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
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'parent' },
  })
  const source = new FakeTicketSource([
    { ...readyTicket('NODE', { title: 'Release integration' }), kind: 'node' },
    { ...readyTicket('TRIAGE', { title: 'Unfinished child' }), target: 'NODE', state: 'Triage' },
  ])
  expect((await observeIntegration(store, source, 'node')).openChildren).toEqual(['TRIAGE'])
  await source.transition('TRIAGE', 'Done')
  expect((await observeIntegration(store, source, 'node')).openChildren).toEqual([])
  await expect(
    controlBuild({
      store,
      repo: 'repo',
      slug: 'node',
      action: { kind: 'land' },
      ticketSource: async () => source,
      user: 'operator',
      env: {},
    }),
  ).rejects.toThrow('Merge is not ready')
  await source.transition('TRIAGE', 'Ready')
  expect((await observeIntegration(store, source, 'node')).openChildren).toEqual(['TRIAGE'])
  const broken: import('../ports/types').TicketSource = Object.create(source)
  broken.listAll = async () => {
    throw new Error('listing unavailable')
  }
  const observed = await observeIntegration(store, broken, 'node')
  expect(observed.diagnostics).toEqual(['listing unavailable'])
})
