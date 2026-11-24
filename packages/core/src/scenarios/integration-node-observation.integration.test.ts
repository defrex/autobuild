import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket } from './harness'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'

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
}, 30_000)

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
}, 30_000)
