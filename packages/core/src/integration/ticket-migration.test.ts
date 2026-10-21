import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket } from './harness'
import { FakeTicketSource } from '../ports/tickets/fake'
import { Dispatcher, type DispatcherDeps } from '../processes/dispatcher'
import { recordTicketMigration } from '../kernel/ticket-migrations'
import { reduceBuild } from '../kernel/reducer'
import { controlBuild } from '../cli/build-control'

test.each([false, true])(
  'cutover admits new children, deduplicates live claims, checks targets and aborts through mapped IDs (remap=%s)',
  async (remap) => {
    const h = await makeHarness({
      localGitForge: true,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('N', { title: 'Migration node' }), kind: 'node' },
        { ...readyTicket('C', { title: 'Migration child' }), target: 'N' },
      ],
    })
    try {
      for (let i = 0; i < 3; i++) await h.dispatcher.tick()
      const before = await h.store.listBuilds()
      const node = before.find((record) => record.ticket?.id === 'N')!
      const child = before.find((record) => record.ticket?.id === 'C')!
      expect(child).toBeDefined()
      const mapping = { N: remap ? 'NEW-N' : 'N', C: remap ? 'NEW-C' : 'C' }
      const destination = new FakeTicketSource(
        (await h.tickets.listAll()).tickets.map((ticket) => ({
          ...ticket,
          ref: { ...ticket.ref, source: 'file', id: mapping[ticket.ref.id as 'N' | 'C'] },
          target: ticket.target ? mapping[ticket.target as 'N' | 'C'] : undefined,
        })),
      )
      Object.defineProperty(destination, 'name', { value: 'file' })
      await h.store.ensureRepo(h.origin)
      await recordTicketMigration(
        h.store,
        h.origin,
        { kind: 'human', user: 'operator' },
        { identity: 'cutover', from: 'fake', to: 'file', mapping },
      )
      h.dispatcher = new Dispatcher({
        ...(h.dispatcher as unknown as { deps: DispatcherDeps }).deps,
        tickets: destination,
      })
      // A source may leave claimed tickets in its ready listing.
      await destination.transition(mapping.N, 'Ready')
      await h.dispatcher.tick()
      expect(
        (await h.store.listBuilds()).filter(
          (record) => record.ticket?.id === mapping.N && record.ticket.source === 'file',
        ),
      ).toHaveLength(0)
      expect(reduceBuild(await h.events(child.slug)).nodeRestack?.parentRejection).toBeUndefined()
      await controlBuild({
        store: h.store,
        repo: h.origin,
        slug: child.slug,
        action: { kind: 'abort' },
      })
      await h.dispatcher.tick()
      expect(destination.transitions).toContainEqual({ id: mapping.C, state: 'Triage' })
      expect(reduceBuild(await h.events(child.slug)).status).toBe('done')
      await destination.create(
        {
          title: 'New current child',
          body: readyTicket('W').body,
          labels: ['autobuild'],
          target: mapping.N,
        },
        { requestedId: 'W', state: 'Ready' },
      )
      await h.dispatcher.tick()
      h.clock.advance(300_000)
      await h.dispatcher.tick()
      const work = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'W')!
      expect(work).toBeDefined()
      const state = reduceBuild(await h.events(work.slug))
      expect(state.target).toMatchObject({
        build: node.slug,
        ticket: { source: 'file', id: mapping.N },
      })
      expect(state.baseBranch).toBe(node.branch)
      const { observeIntegration } = await import('../kernel/integration-completeness')
      const observed = await observeIntegration(h.store, destination, node.slug)
      expect(observed.children?.find((entry) => entry.id === 'W')?.claims).toContain(work.slug)
      expect((await h.store.getBuild(node.slug))?.ticket?.source).toBe('fake')
    } finally {
      await h.cleanup()
    }
  },
)

test('uncovered cleanup leaves no completion and retries after new durable evidence in the same dispatcher', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [readyTicket('C', { title: 'Unmapped cleanup' })],
  })
  try {
    await h.dispatcher.tick()
    const record = (await h.store.listBuilds())[0]!
    const destination = new FakeTicketSource([
      { ...readyTicket('NEW-C'), ref: { source: 'file', id: 'NEW-C' } },
    ])
    Object.defineProperty(destination, 'name', { value: 'file' })
    await h.store.ensureRepo(h.origin)
    await recordTicketMigration(
      h.store,
      h.origin,
      { kind: 'human', user: 'operator' },
      { identity: 'partial-inventory', from: 'fake', to: 'file', mapping: {} },
    )
    h.dispatcher = new Dispatcher({
      ...(h.dispatcher as unknown as { deps: DispatcherDeps }).deps,
      tickets: destination,
    })
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: record.slug,
      action: { kind: 'abort' },
    })
    const blocked = await h.dispatcher.tick({ acceptNewWork: false })
    expect(blocked.janitorDiagnostics.join()).toContain(`build ${record.slug} ticket fake:C`)
    expect(destination.transitions).toEqual([])
    expect((await h.events(record.slug)).some((event) => event.type === 'build.completed')).toBe(
      false,
    )
    await recordTicketMigration(
      h.store,
      h.origin,
      { kind: 'human', user: 'operator' },
      { identity: 'remaining-inventory', from: 'fake', to: 'file', mapping: { C: 'NEW-C' } },
    )
    h.clock.advance(60_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(destination.transitions).toContainEqual({ id: 'NEW-C', state: 'Triage' })
    expect(
      destination.comments.some(
        (notice) => notice.id === 'NEW-C' && notice.body.includes('aborted'),
      ),
    ).toBe(true)
    expect((await h.events(record.slug)).some((event) => event.type === 'build.completed')).toBe(
      true,
    )
  } finally {
    await h.cleanup()
  }
})
