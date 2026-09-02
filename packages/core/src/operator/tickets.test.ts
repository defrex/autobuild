import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { getOperatorTicket, listOperatorTickets, mutateOperatorTicket } from './tickets'

const repo = 'acme/widgets'
const clock = () => new Date('2026-09-02T00:00:00Z')
const config = parseConfig(`
[tickets]
source = "hosted"
teamKey = "AUT"
readyState = "Ready"
readyLabels = ["autobuild"]
[verify]
steps = []
[finalize]
steps = []
`)

async function configuredStore() {
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(repo)
  const { verify, finalize, ...root } = config
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  return store
}

const seed = {
  ref: { source: 'fake', id: 'AUT-1', title: 'Ticket' },
  title: 'Ticket',
  body: 'body\r\nwithout-final-newline',
  state: 'Ready',
  labels: ['autobuild'],
  blockedBy: ['AUT-2', 'AUT-404'],
}
const blocker = {
  ref: { source: 'fake', id: 'AUT-2', title: 'Done' },
  title: 'Done',
  body: 'done',
  state: 'Done',
  labels: [],
}

function backend(source: FakeTicketSource) {
  return {
    sourceFor: async () => source,
    statesFor: async () => ['Inbox', 'Ready', 'Doing', 'Done'],
  }
}

describe('operator ticket projections', () => {
  test('uses effective ready criteria and explicit filters', async () => {
    const store = await configuredStore()
    const source = new FakeTicketSource([seed, blocker], { doneState: 'Done' })
    const ready = await listOperatorTickets({ store, repo, backend: backend(source) })
    expect(ready.criteria).toEqual({ state: 'Ready', labels: ['autobuild'] })
    expect(ready.tickets.map((ticket) => ticket.ref.id)).toEqual(['AUT-1'])
    expect(ready.states).toEqual(['Inbox', 'Ready', 'Doing', 'Done'])
    const done = await listOperatorTickets({ store, repo, backend: backend(source), state: 'Done' })
    expect(done.criteria).toEqual({ state: 'Done' })
  })

  test('projects blockers and prefers an active matching repository build', async () => {
    const store = await configuredStore()
    await store.createBuild({ slug: 'old', repo, ticket: { source: 'linear', id: 'AUT-1' } })
    await store.append('old', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    await store.createBuild({ slug: 'active', repo, ticket: { source: 'linear', id: 'AUT-1' } })
    const detail = await getOperatorTicket({
      store,
      repo,
      backend: backend(new FakeTicketSource([seed, blocker], { doneState: 'Done' })),
      id: 'AUT-1',
    })
    expect(detail.blockers).toEqual([
      { id: 'AUT-2', exists: true, resolved: true, blockedBy: [] },
      { id: 'AUT-404', exists: false, resolved: false, blockedBy: [] },
    ])
    expect(detail.build?.slug).toBe('active')
  })

  test('round-trips exact update bodies and refuses invented states verbatim', async () => {
    const store = await configuredStore()
    const source = new FakeTicketSource([seed, blocker], { doneState: 'Done' })
    const body = 'changed\r\ntrailing  \nno-final-newline'
    const updated = await mutateOperatorTicket({
      store,
      repo,
      backend: backend(source),
      operation: { kind: 'update', id: 'AUT-1', patch: { body } },
    })
    expect(updated.ticket.body).toBe(body)
    source.transition = async () => {
      throw new Error('provider says transition is forbidden')
    }
    await expect(
      mutateOperatorTicket({
        store,
        repo,
        backend: backend(source),
        operation: { kind: 'move', id: 'AUT-1', state: 'Invented' },
      }),
    ).rejects.toThrow('provider says transition is forbidden')
  })
})
