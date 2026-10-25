import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket } from './harness'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'

// Model a large source using native resolved tickets. One scan corresponds to
// many provider pages; increasing the node count must not multiply those pages.
test('collecting nodes share bounded exhaustive scans, discover external changes, and skip paused nodes', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('A', { title: 'Collecting alpha' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Collecting beta' }), kind: 'node' },
      {
        ...readyTicket('OPEN', { title: 'External backlog child' }),
        target: 'A',
        state: 'Backlog',
      },
      ...Array.from({ length: 800 }, (_, i) => ({
        ...readyTicket(`OLD-${i}`, { title: 'Historical work' }),
        state: 'Done',
      })),
    ],
  })
  let scans = 0
  const listAll = h.tickets.listAll.bind(h.tickets)
  h.tickets.listAll = async () => {
    scans++
    return listAll()
  }
  try {
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    const nodes = (await h.store.listBuilds()).filter((record) =>
      record.branch?.startsWith('ab-node/'),
    )
    expect(nodes).toHaveLength(2)
    expect(scans).toBe(1)
    for (let i = 0; i < 20; i++) {
      h.clock.advance(1_000)
      await h.dispatcher.tick()
    }
    expect(scans).toBe(1)
    const a = nodes.find((record) => record.ticket?.id === 'A')!
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.openChildren).toEqual([
      'OPEN',
    ])
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.children).toEqual([
      { source: 'fake', id: 'OPEN', title: 'External backlog child' },
    ])
    await h.tickets.transition('OPEN', 'Done')
    h.clock.advance(300_000)
    await h.dispatcher.tick()
    expect(scans).toBe(2)
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.openChildren).toEqual([])
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.children).toEqual([])
    for (const node of nodes)
      await controlBuild({
        store: h.store,
        repo: h.origin,
        slug: node.slug,
        action: { kind: 'pause' },
      })
    await h.dispatcher.tick()
    h.clock.advance(600_000)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(scans).toBe(2)
  } finally {
    await h.cleanup()
  }
})

test('display metadata follows membership authorities, survives failed scans, and publishes idempotently', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { FakeTicketSource } = await import('../ports/tickets/fake')
  const { observeIntegration } = await import('../kernel/integration-completeness')
  const { integrationComplete } = await import('../kernel/integration-state')
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
  const inputs = async () => ({ listing, builds: records })
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

test('collecting stale nodes observe distance and inventory without replay; operator demand is independent', async () => {
  const { git, commitAll } = await import('./harness')
  const { requestNodeRestack } = await import('../operator/restack')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('A', { title: 'Lazy parent' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Lazy nested child' }), kind: 'node', target: 'A' },
      { ...readyTicket('OPEN', { title: 'Pending work', state: 'Backlog' }), target: 'B' },
    ],
  })
  try {
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const a = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'A')!
    const b = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'B')!
    const original = await h.forgeAdapter.remoteBranchSha!(a.branch!)
    const parent = await git(['commit', '--allow-empty', '-m', 'Parent movement'], h.origin)
    void parent
    const head = await git(['rev-parse', 'HEAD'], h.origin)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const events = await h.events(a.slug)
    expect(events.filter((e) => e.type === 'target.moved' && e.payload.sha === head)).toHaveLength(
      1,
    )
    expect(events.filter((e) => e.type === 'node.writer-reserved')).toHaveLength(0)
    expect(reduceBuild(events).nodeRestack?.distance?.count).toBe(1)
    expect(await h.forgeAdapter.remoteBranchSha!(a.branch!)).toBe(original)
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: a.slug, user: 'operator' })
    await h.dispatcher.tick()
    expect(await h.forgeAdapter.remoteBranchSha!(a.branch!)).toBe(head)
    expect(await h.forgeAdapter.remoteBranchSha!(b.branch!)).toBe(original)
    expect((await h.events(b.slug)).filter((e) => e.type === 'node.writer-reserved')).toHaveLength(
      0,
    )
    // Hand-pushed inventory refresh must not force freshness.
    await git(['worktree', 'add', `${h.tmp}/foreign-node`, b.branch!], h.origin)
    await Bun.write(`${h.tmp}/foreign-node/foreign`, 'owned')
    await commitAll(`${h.tmp}/foreign-node`, 'Owned foreign change')
    await git(['worktree', 'remove', `${h.tmp}/foreign-node`], h.origin)
    await h.dispatcher.tick()
    const state = reduceBuild(await h.events(b.slug))
    expect(state.nodeRestack?.inventory?.foreign).toHaveLength(1)
    expect(state.nodeRestack?.contributionBase).toBe(original)
    expect(state.nodeRestack?.active).toBeUndefined()
  } finally {
    await h.cleanup()
  }
})

test('recorded remaps join frozen children to current membership and isolate unrelated history', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { FakeTicketSource } = await import('../ports/tickets/fake')
  const { observeIntegration } = await import('../kernel/integration-completeness')
  const { recordTicketMigration } = await import('../kernel/ticket-migrations')
  const { newestTicketBuild } = await import('../kernel/node-parent')
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
  const inputs = async () => ({ listing: await source.listAll(), builds: [child, unrelated] })
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
