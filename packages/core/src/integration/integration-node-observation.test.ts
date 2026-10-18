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
      h.clock.advance(10_000)
      await h.dispatcher.tick()
    }
    expect(scans).toBe(1)
    const a = nodes.find((record) => record.ticket?.id === 'A')!
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.openChildren).toEqual([
      'OPEN',
    ])
    await h.tickets.transition('OPEN', 'Done')
    h.clock.advance(300_000)
    await h.dispatcher.tick()
    expect(scans).toBe(2)
    expect(reduceBuild(await h.events(a.slug)).integration?.observation?.openChildren).toEqual([])
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
