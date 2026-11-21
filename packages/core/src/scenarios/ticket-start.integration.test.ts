/**
 * Single-ticket start while intake is off (AUT-1293), as an operator sees it:
 * `ab start` / MCP `tickets.start` records a durable request, the running
 * dispatcher admits exactly that ticket through the ordinary gates on its
 * next tick with a free slot, and settles the request once with an outcome
 * visible in `ab repository status` and the default `ab watch` filter.
 */
import { expect, test } from 'bun:test'
import { projectRepositoryStatus, renderRepositoryStatus } from '../cli/repository-status'
import { abTicketStart } from '../cli/ticket-start'
import { abWatch, summarizeEvent } from '../cli/watch'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { sequentialIds } from '../ids'
import { buildRegistry } from '../operator/registry'
import { ticketBackendFromSource } from '../operator/ticket-source-backend'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket, TicketSource } from '../ports/types'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { Dispatcher } from '../processes/dispatcher'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { CONFORMING_BODY } from './harness'

const REPO = '/ticket-start/repo'
const FILE_CONFIG = '[tickets]\nsource = "file"\nreadyState = "Ready"\n'
const HOSTED_CONFIG = '[tickets]\nsource = "hosted"\nteamKey = "ENG"\n'

const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : { stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`, stderr: '', exitCode: 0 }

function ticket(
  id: string,
  state = 'Ready',
  opts: { body?: string; blockedBy?: string[]; source?: string } = {},
): Ticket {
  return {
    revision: 'fixture',
    ref: { source: opts.source ?? 'fake', id, title: `Work ${id}` },
    title: `Work ${id}`,
    body: opts.body ?? CONFORMING_BODY,
    state,
    resolved: false,
    labels: ['autobuild'],
    ...(opts.blockedBy ? { blockedBy: opts.blockedBy } : {}),
  }
}

/** Count `get`/`listReady`/`claim` calls on a source, optionally renamed and
 * with a `get` override (to model hosted aliases and failures). */
function counted(
  source: FakeTicketSource,
  opts: { name?: string; get?: (id: string) => Promise<Ticket | null> | undefined } = {},
) {
  const calls = { get: [] as string[], listReady: 0, claim: [] as string[] }
  const tickets = new Proxy(source, {
    get(target, key) {
      if (key === 'name' && opts.name !== undefined) return opts.name
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (key === 'get') {
          calls.get.push(args[0] as string)
          const override = opts.get?.(args[0] as string)
          if (override !== undefined) return override
        }
        if (key === 'listReady') calls.listReady += 1
        if (key === 'claim') calls.claim.push(args[0] as string)
        return value.apply(target, args)
      }
    },
  }) as unknown as TicketSource
  return { tickets, calls }
}

async function world(
  seed: Ticket[],
  opts: {
    config?: string
    name?: string
    get?: (id: string) => Promise<Ticket | null> | undefined
  } = {},
) {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(REPO)
  const source = new FakeTicketSource(seed, opts.name === 'hosted' ? { doneState: 'done' } : {})
  const { tickets, calls } = counted(source, opts)
  let config: Config = parseConfig(opts.config ?? FILE_CONFIG)
  const launches: string[] = []
  const dispatcher = () =>
    new Dispatcher({
      store,
      tickets,
      workspaces: new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' }),
      forge: new FakeForge(),
      config,
      getConfig: () => config,
      repo: REPO,
      exec: fakeExec,
      launchRunner: async (slug: string) => {
        launches.push(slug)
        return 'scheduled'
      },
      ids: sequentialIds(),
      clock,
    })
  let current = dispatcher()
  const registry = buildRegistry({
    store,
    clock,
    tickets: {
      ...ticketBackendFromSource({ source: tickets, config }),
      // No dispatcher run publishes an effective config in this world.
      contextFor: async (repo: string) => ({ repo, tickets: config.tickets, teamKey: '' }),
    },
  })
  const start = (id: string, cancel = false) =>
    registry.call(
      'tickets.start',
      { repo: REPO, id, ...(cancel ? { cancel } : {}) },
      {
        identity: 'operator',
      },
    )
  const tick = async (acceptNewWork = false) => {
    clock.advance(60_000)
    return current.tick({ acceptNewWork })
  }
  const events = async () => (await store.getRepoEvents(REPO)) as RepositoryEvent[]
  const settled = async () =>
    (await events()).filter((event) => event.type === 'ticket.start-settled')
  const status = async () =>
    (await registry.call('repository.status', { repo: REPO })) as {
      ticketStarts?: {
        pending: { ticket: { id: string } }[]
        recent: { ticket: { id: string }; outcome: string; slug?: string; detail?: string }[]
      }
    }
  return {
    clock,
    store,
    source,
    tickets,
    calls,
    launches,
    registry,
    start,
    tick,
    events,
    settled,
    status,
    setConfig(next: string) {
      config = parseConfig(next)
    },
    fresh() {
      current = dispatcher()
    },
  }
}

async function seedBuild(store: MemoryBuildStore, slug: string, ref: Ticket['ref']) {
  await store.createBuild({
    slug,
    repo: REPO,
    ticket: ref,
    branch: `ab/${slug}`,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: ref, repo: REPO, baseBranch: 'main' },
    },
  })
}

test('with intake off, a start request claims only the named ticket', async () => {
  const w = await world([ticket('T-1'), ticket('T-2')])
  const requested = (await w.start('T-1')) as { status: string; existing: boolean }
  expect(requested).toMatchObject({ status: 'pending', existing: false })
  // A repeat is idempotent and writes nothing.
  const length = (await w.events()).length
  expect(await w.start('T-1')).toMatchObject({ status: 'pending', existing: true })
  expect((await w.events()).length).toBe(length)
  expect((await w.status()).ticketStarts?.pending.map((entry) => entry.ticket.id)).toEqual(['T-1'])

  const report = await w.tick()
  expect(report.dispatched).toBe(1)
  expect(w.calls.listReady).toBe(0)
  expect(w.calls.claim).toEqual(['T-1'])
  const builds = await w.store.listBuilds()
  expect(builds.map((record) => record.ticket?.id)).toEqual(['T-1'])
  expect((await w.tickets.get('T-2'))?.state).toBe('Ready')
  const [settlement] = await w.settled()
  expect(settlement?.payload).toMatchObject({ outcome: 'started', slug: builds[0]!.slug })
  const status = await w.status()
  expect(status.ticketStarts?.pending).toEqual([])
  expect(status.ticketStarts?.recent).toMatchObject([
    { ticket: { id: 'T-1' }, outcome: 'started', slug: builds[0]!.slug },
  ])
  // A targeted tick never publishes a scan.
  expect(
    (await w.events()).some((event) => event.type === 'dispatcher.ticket-scan-completed'),
  ).toBe(false)
  // Settled: the next tick neither settles nor claims again.
  await w.tick()
  expect(await w.settled()).toHaveLength(1)
  expect(w.calls.claim).toEqual(['T-1'])
  expect(await w.store.listBuilds()).toHaveLength(1)
})

test('a request waits for a free slot and starts once one opens', async () => {
  const w = await world([ticket('T-1'), ticket('T-2')], {
    config: `capacity = 1\n${FILE_CONFIG}`,
  })
  await seedBuild(w.store, 'occupant', { source: 'fake', id: 'T-9' })
  await w.start('T-1')
  for (let i = 0; i < 3; i++) {
    const report = await w.tick()
    expect(report.dispatched).toBe(0)
  }
  expect(await w.settled()).toEqual([])
  expect((await w.status()).ticketStarts?.pending.map((entry) => entry.ticket.id)).toEqual(['T-1'])
  w.setConfig(`capacity = 2\n${FILE_CONFIG}`)
  expect((await w.tick()).dispatched).toBe(1)
  expect((await w.settled()).map((event) => event.payload)).toMatchObject([{ outcome: 'started' }])
})

test('a waiting request starts on the tick after an occupant frees its slot', async () => {
  const w = await world([ticket('T-1')], { config: `capacity = 1\n${FILE_CONFIG}` })
  await seedBuild(w.store, 'occupant', { source: 'fake', id: 'T-9' })
  await w.start('T-1')
  // The second waiting tick skips re-measuring capacity; nothing has changed.
  for (let i = 0; i < 2; i++) expect((await w.tick()).dispatched).toBe(0)
  await w.store.append('occupant', { actor: DISPATCHER, type: 'build.aborted', payload: {} })
  expect((await w.tick()).dispatched).toBe(1)
  expect((await w.settled()).map((event) => event.payload)).toMatchObject([{ outcome: 'started' }])
})

test('refusals settle once with an explicit outcome and are never re-read', async () => {
  const w = await world(
    [
      ticket('T-1', 'Ready', { blockedBy: ['T-9'] }),
      ticket('T-9', 'Triage'),
      ticket('T-2', 'Ready', { body: 'make it faster' }),
      ticket('T-3', 'Triage'),
      ticket('T-4', 'Done'),
      ticket('T-5'),
      ticket('T-6', 'Doing'),
    ],
    // Blocked and invalid outcomes are reached only with a free slot.
    { config: `capacity = 4\n${FILE_CONFIG}` },
  )
  await seedBuild(w.store, 'existing', { source: 'fake', id: 'T-6' })
  for (const id of ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6']) await w.start(id)
  w.source.remove('T-5')
  await w.tick()
  const outcomes = Object.fromEntries(
    (await w.settled()).map((event) => [
      (event.payload as { ticket: { id: string } }).ticket.id,
      event.payload,
    ]),
  )
  expect(outcomes).toMatchObject({
    'T-1': { outcome: 'blocked', detail: expect.stringContaining('T-9') },
    'T-2': { outcome: 'invalid', detail: expect.stringContaining('missing') },
    'T-3': { outcome: 'not-ready', detail: expect.stringContaining('Triage') },
    'T-4': { outcome: 'terminal' },
    'T-5': { outcome: 'missing' },
    'T-6': { outcome: 'already-building', slug: 'existing' },
  })
  // The nonconforming ticket was bounced to triage as usual; nothing was built.
  expect((await w.tickets.get('T-2'))?.state).toBe('Triage')
  expect(w.calls.claim).toEqual(['T-2'])
  expect((await w.store.listBuilds()).map((record) => record.slug)).toEqual(['existing'])
  w.calls.get.length = 0
  await w.tick()
  // The existing build's own stages may read T-6; no refused request is read.
  expect(w.calls.get.filter((id) => id !== 'T-6')).toEqual([])
  expect(await w.settled()).toHaveLength(6)
})

test('cancel through MCP records a cancelled entry and the next tick does nothing', async () => {
  const w = await world([ticket('T-1')])
  await w.start('T-1')
  expect(await w.start('T-1', true)).toMatchObject({ cancelled: true })
  expect(await w.start('T-1', true)).toMatchObject({ cancelled: false })
  await w.tick()
  expect(w.calls.claim).toEqual([])
  expect((await w.status()).ticketStarts?.recent).toMatchObject([
    { ticket: { id: 'T-1' }, outcome: 'cancelled' },
  ])
})

test('a cancellation landing while the pass reads the ticket prevents the claim', async () => {
  let armed = false
  // The operator cancels during the dispatcher's targeted `get`.
  const w: Awaited<ReturnType<typeof world>> = await world([ticket('T-1')], {
    get: (id) => {
      if (!armed) return undefined
      armed = false
      return (async () => {
        await w.start(id, true)
        return w.source.get(id)
      })()
    },
  })
  await w.start('T-1')
  armed = true
  await w.tick()
  expect(w.calls.claim).toEqual([])
  expect(await w.store.listBuilds()).toEqual([])
  expect(await w.settled()).toEqual([])
  expect((await w.status()).ticketStarts?.recent).toMatchObject([
    { ticket: { id: 'T-1' }, outcome: 'cancelled' },
  ])
})

test('a repository pause leaves the request pending', async () => {
  const w = await world([ticket('T-1')])
  await w.store.appendRepo(REPO, {
    actor: humanActor('operator'),
    type: 'dispatcher.pause-set',
    payload: { enabled: true },
  })
  await w.start('T-1')
  await w.tick()
  expect(w.calls.get.filter((id) => id === 'T-1')).toHaveLength(1)
  expect(await w.settled()).toEqual([])
  expect(await w.store.listBuilds()).toEqual([])
})

test('with intake on, the request takes the only free slot ahead of ready order', async () => {
  const w = await world([ticket('T-0'), ticket('T-1')], {
    config: `capacity = 1\n${FILE_CONFIG}`,
  })
  await w.start('T-1')
  expect((await w.tick(true)).dispatched).toBe(1)
  expect((await w.store.listBuilds()).map((record) => record.ticket?.id)).toEqual(['T-1'])
  expect((await w.tickets.get('T-0'))?.state).toBe('Ready')
})

test('the CLI records the request and ab watch delivers the settlement', async () => {
  const w = await world([ticket('T-1')])
  const out: string[] = []
  const cli = (cancel = false) =>
    abTicketStart({
      targetRepo: REPO,
      env: { USER: 'operator' },
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => w.store,
      id: 'T-1',
      cancel,
      ticketSource: async () => w.tickets,
    })
  await cli()
  await cli()
  expect(out[0]).toMatch(/^start requested for T-1 \(request \d+\); the dispatcher claims it/)
  expect(out[1]).toMatch(/^start request for T-1 already pending since /)
  await expect(
    abTicketStart({
      targetRepo: REPO,
      env: { AB_SESSION: 's1' },
      exec: fakeExec,
      stdout: () => {},
      openStore: () => w.store,
      id: 'T-1',
      ticketSource: async () => w.tickets,
    }),
  ).rejects.toThrow('outside a build or harvest session')

  const lines: string[] = []
  await abWatch({
    targetRepo: REPO,
    env: {},
    exec: fakeExec,
    stdout: (line) => lines.push(line),
    stderr: () => {},
    openStore: () => w.store,
    now: w.clock,
    delay: async () => {
      await w.tick()
    },
    json: true,
    count: 1,
    timeout: '60',
  })
  const [record] = lines
    .map((line) => JSON.parse(line) as { event?: RepositoryEvent })
    .filter((entry) => entry.event !== undefined)
  expect(record?.event?.type).toBe('ticket.start-settled')
  const settled = record!.event!
  expect(summarizeEvent(settled, undefined as never)).toMatch(/^ticket T-1 start started → build /)
  const rendered = renderRepositoryStatus(projectRepositoryStatus(REPO, await w.events()))
  expect(rendered.some((line) => /^start request T-1: started → build /.test(line))).toBe(true)
})

function hostedTicket(id: string, state: string): Ticket {
  return ticket(id, state, { source: 'hosted' })
}

test('a hosted legacy-alias build moved back to ready settles already-building without a claim', async () => {
  // The source resolves the legacy alias `ticket-1111` to the readable AB-1.
  const alias = (source: FakeTicketSource) => (id: string) =>
    id === 'ticket-1111' ? source.get('AB-1') : undefined
  let failing = true
  let source: FakeTicketSource | undefined
  const w = await world([hostedTicket('AB-1', 'ready'), hostedTicket('AB-2', 'ready')], {
    config: HOSTED_CONFIG,
    name: 'hosted',
    get: (id) => {
      if (id === 'ticket-1111' && failing) return Promise.reject(new Error('source offline'))
      return source ? alias(source)(id) : undefined
    },
  })
  source = w.source
  await seedBuild(w.store, 'legacy', { source: 'hosted', id: 'ticket-1111' })
  await seedBuild(w.store, 'other', { source: 'hosted', id: 'ab-2' })
  await w.start('AB-1')
  // The identity projection fails closed: no admission, no decision.
  await w.tick()
  expect(await w.settled()).toEqual([])
  expect(w.calls.claim).toEqual([])
  failing = false
  await w.tick()
  expect((await w.settled()).map((event) => event.payload)).toMatchObject([
    { outcome: 'already-building', slug: 'legacy' },
  ])
  expect(w.calls.claim).toEqual([])
  expect(await w.store.listBuilds()).toHaveLength(2)

  // The projection is durable: a fresh dispatcher and a second request for
  // another ticket resolve no build identity again.
  const identityRecords = async () =>
    (await w.events()).filter((event) => event.type === 'ticket.identity-recorded').length
  const recorded = await identityRecords()
  await w.start('AB-2')
  w.fresh()
  w.calls.get.length = 0
  await w.tick()
  expect(await identityRecords()).toBe(recorded)
  expect(w.calls.get.filter((id) => id === 'AB-2')).toHaveLength(1)
  expect((await w.settled()).at(-1)?.payload).toMatchObject({
    outcome: 'already-building',
    slug: 'other',
  })
})

test('start requests cost one targeted read per pending request and none while idle', async () => {
  const { ticketStartReadBudget } = await import('../testing/reduced-read-budget')
  const steady = await ticketStartReadBudget()
  expect(steady.gets).toBe(1)
}, 120_000)
